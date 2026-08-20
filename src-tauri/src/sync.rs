//! The working copy and the sync verbs (S14, D29, D33) for the desktop store —
//! the mirror of the sync half of `server/docent-store.mjs`. Same state file,
//! byte for byte; same decision per scene; same answers and the same error
//! strings. `tests/store_github.rs` mirrors the Node suite so a divergence
//! fails there rather than in someone's portfolio.
//!
//! The shape of the thing: a bound project's directory *is* its working copy,
//! so opening and saving a scene are file operations that never reach the
//! network (they do not even pass through this module). What a binding adds is
//! four explicit verbs — status, pull, resolve, push — and one recorded fact
//! per scene: the blob sha it had at the last synchronization, and the hash of
//! the content that came with it. Everything else is derived from those two by
//! comparison, which is why a pull can never silently lose a drawing.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::github::{self, Binding, Cache, Failure};
use crate::store::valid_name;

const EXT: &str = ".excalidraw";

type Result<T> = std::result::Result<T, Failure>;

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

/// The content hash the working copy is measured against. Any stable hash
/// would do; sha-256 is the one both implementations already have without a
/// dependency — `ring` is linked for TLS here, `node:crypto` is built in there
/// — and writing it down means the state file is comparable by eye.
pub fn sha256(text: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// ---------------------------------------------------------------------------
// the sync state file
// ---------------------------------------------------------------------------

/// A scene's base. An empty `base_sha` means "the remote has never had this
/// scene" — different from "the remote deleted it", and the difference is what
/// stops a pull from deleting a file GitHub never carried. `conflict_sha` is
/// present only while a scene is conflicted: it is the remote sha the author
/// has yet to accept or reject, and an empty string there means the remote
/// deleted the scene while it was being edited here.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SceneBase {
    #[serde(rename = "baseSha", default)]
    pub base_sha: String,
    #[serde(rename = "baseHash", default)]
    pub base_hash: String,
    #[serde(
        rename = "conflictSha",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub conflict_sha: Option<String>,
}

/// Field order and nesting are the reference store's, so the file is
/// byte-identical across the two implementations for the same state.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct SyncFile {
    #[serde(default)]
    scenes: BTreeMap<String, SceneBase>,
}

/// D27's exception again, for the other half of a binding. Derived state:
/// delete it and the next pull rebuilds it conservatively, keeping every local
/// file. No secrets, ever.
pub fn sync_file(data_dir: &Path, project: &str) -> PathBuf {
    data_dir
        .join(".docent")
        .join("sync")
        .join(format!("{project}.json"))
}

pub fn read_state(data_dir: &Path, project: &str) -> BTreeMap<String, SceneBase> {
    // Missing, unreadable, or malformed all mean the same thing here: nothing
    // has been synced yet, which is the state that keeps every local file.
    fs::read_to_string(sync_file(data_dir, project))
        .ok()
        .and_then(|raw| serde_json::from_str::<SyncFile>(&raw).ok())
        .unwrap_or_default()
        .scenes
}

fn write_state(data_dir: &Path, project: &str, scenes: &BTreeMap<String, SceneBase>) -> Result<()> {
    let file = sync_file(data_dir, project);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let mut json = serde_json::to_string_pretty(&SyncFile {
        scenes: scenes.clone(),
    })
    .map_err(|err| Failure::new(500, err.to_string()))?;
    json.push('\n');
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(internal)?;
    fs::rename(&tmp, &file).map_err(internal)
}

pub fn remove_state(data_dir: &Path, project: &str) {
    let _ = fs::remove_file(sync_file(data_dir, project));
}

fn internal(err: std::io::Error) -> Failure {
    Failure::new(500, err.to_string())
}

// ---------------------------------------------------------------------------
// the working copy
// ---------------------------------------------------------------------------

fn project_dir(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join(project)
}

fn scene_file(data_dir: &Path, project: &str, scene: &str) -> PathBuf {
    project_dir(data_dir, project).join(format!("{scene}{EXT}"))
}

/// Every addressable scene in the project directory, by content hash. A
/// `.excalidraw` file whose name this store could not address round-trip is
/// left out of sync entirely — it stays on disk, and no verb ever claims to
/// have pushed it.
pub fn working_copy(data_dir: &Path, project: &str) -> BTreeMap<String, String> {
    let mut copy = BTreeMap::new();
    let Ok(entries) = fs::read_dir(project_dir(data_dir, project)) else {
        return copy;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = file_name.strip_suffix(EXT) else {
            continue;
        };
        if !valid_name(name) {
            continue;
        }
        if let Ok(text) = fs::read_to_string(entry.path()) {
            copy.insert(name.to_string(), sha256(&text));
        }
    }
    copy
}

/// What happened to one scene since the last sync, from this side alone. No
/// network, by construction: it is a file hash against a recorded one.
fn scene_state(hash: Option<&String>, base: Option<&SceneBase>) -> &'static str {
    if base.is_some_and(|base| base.conflict_sha.is_some()) {
        return "conflicted";
    }
    match (hash, base) {
        (None, Some(_)) => "deleted",
        (None, None) => "clean",
        (Some(_), None) => "new",
        (Some(hash), Some(base)) => {
            if *hash == base.base_hash {
                "clean"
            } else {
                "modified"
            }
        }
    }
}

/// Every scene the project knows about — on disk, recorded, or both — in the
/// order the reference store lists names in. Callers gather the keys, because
/// the maps they come from hold different things.
fn sorted_names(names: BTreeSet<&String>) -> Vec<String> {
    let mut names: Vec<String> = names.into_iter().cloned().collect();
    crate::store::sort_by(&mut names, |name| name);
    names
}

#[derive(serde::Serialize)]
pub struct SceneState {
    pub name: String,
    pub state: &'static str,
}

pub fn local_states(data_dir: &Path, project: &str) -> Vec<SceneState> {
    let copy = working_copy(data_dir, project);
    let bases = read_state(data_dir, project);
    let mut names: BTreeSet<&String> = copy.keys().collect();
    names.extend(bases.keys());
    sorted_names(names)
        .into_iter()
        .map(|name| SceneState {
            state: scene_state(copy.get(&name), bases.get(&name)),
            name,
        })
        .collect()
}

/// The scenes a branch switch would have to overwrite: everything that is not
/// clean, named so the refusal can say which (D29).
pub fn dirty_scenes(data_dir: &Path, project: &str) -> Vec<String> {
    local_states(data_dir, project)
        .into_iter()
        .filter(|scene| scene.state != "clean")
        .map(|scene| scene.name)
        .collect()
}

// ---------------------------------------------------------------------------
// the verbs
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct PullAnswer {
    pub ok: bool,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    pub conflicts: Vec<String>,
}

/// Write one scene of the working copy, atomically, as a save would.
fn write_working_file(data_dir: &Path, project: &str, scene: &str, text: &str) -> Result<()> {
    let file = scene_file(data_dir, project, scene);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(internal)?;
    }
    let mut tmp = file.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text).map_err(internal)?;
    fs::rename(&tmp, &file).map_err(internal)
}

/// Fast-forward the working copy from the branch. Every scene is decided on
/// its own, and the rule never varies: when only one side moved, that side
/// wins; when both moved, nothing is touched and the author is asked (D29).
/// There is no merge, because there is no meaningful line-merge for a drawing.
///
/// A scene that has never been synced — a project bound before any of this
/// existed, or a file drawn before the first pull — has no recorded base, so it
/// is local-new and kept. That is what makes the first pull of a legacy
/// binding safe: it can add and it can flag, but it cannot delete.
pub fn pull(
    data_dir: &Path,
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
) -> Result<PullAnswer> {
    let remote = github::list(project, binding, token, cache)?;
    let mut bases = read_state(data_dir, project);
    let copy = working_copy(data_dir, project);
    let mut answer = PullAnswer {
        ok: true,
        updated: Vec::new(),
        removed: Vec::new(),
        kept: Vec::new(),
        conflicts: Vec::new(),
    };

    let mut names: BTreeSet<&String> = copy.keys().collect();
    names.extend(bases.keys());
    names.extend(remote.keys());
    for name in sorted_names(names) {
        let hash = copy.get(&name);
        let base = bases.get(&name).cloned();
        let remote_sha = remote.get(&name);
        let state = scene_state(hash, base.as_ref());
        // "Changed" is measured against the recorded base, never against the
        // file: a scene the remote has never carried (empty base sha) is
        // absent, not deleted, and absence is not a change.
        let remote_changed = match remote_sha {
            None => base.as_ref().is_some_and(|base| !base.base_sha.is_empty()),
            Some(sha) => !base.as_ref().is_some_and(|base| *sha == base.base_sha),
        };

        if !remote_changed {
            if state != "clean" {
                answer.kept.push(name);
            }
            continue;
        }
        if state == "clean" {
            match remote_sha {
                None => {
                    let _ = fs::remove_file(scene_file(data_dir, project, &name));
                    bases.remove(&name);
                    answer.removed.push(name);
                }
                Some(sha) => {
                    let text = github::blob(binding, token, sha)?;
                    write_working_file(data_dir, project, &name, &text)?;
                    bases.insert(
                        name.clone(),
                        SceneBase {
                            base_sha: sha.clone(),
                            base_hash: sha256(&text),
                            conflict_sha: None,
                        },
                    );
                    answer.updated.push(name);
                }
            }
            continue;
        }
        if state == "deleted" && remote_sha.is_none() {
            // Both sides deleted it: there is nothing to reconcile and nothing
            // to ask about — the copy and the branch already agree.
            bases.remove(&name);
            answer.removed.push(name);
            continue;
        }
        if state == "new" {
            if let (Some(sha), Some(hash)) = (remote_sha, hash) {
                // A file and a blob that have never met. Identical content is
                // the common case — a project bound to a repository that
                // already held its scenes — and it is an agreement rather than
                // a conflict.
                let text = github::blob(binding, token, sha)?;
                if sha256(&text) == *hash {
                    bases.insert(
                        name.clone(),
                        SceneBase {
                            base_sha: sha.clone(),
                            base_hash: hash.clone(),
                            conflict_sha: None,
                        },
                    );
                    answer.updated.push(name);
                    continue;
                }
            }
        }
        // Both sides moved. The file on disk is not touched — the author's work
        // is never overwritten by a pull — and the remote sha is recorded as
        // the question to answer. An empty one means the remote deleted it.
        let previous = base.unwrap_or_default();
        bases.insert(
            name.clone(),
            SceneBase {
                base_sha: previous.base_sha,
                base_hash: previous.base_hash,
                conflict_sha: Some(remote_sha.cloned().unwrap_or_default()),
            },
        );
        answer.conflicts.push(name);
    }

    write_state(data_dir, project, &bases)?;
    Ok(answer)
}

#[derive(serde::Serialize)]
pub struct ResolveAnswer {
    pub ok: bool,
    pub scene: String,
    pub resolution: String,
}

/// Answer one conflicted scene. Keeping the local copy does not write anything
/// — it records that the remote sha has been seen and rejected, so the next
/// push overwrites it deliberately rather than tripping the same conflict
/// again. Taking the remote's copy overwrites the file, which is why it is the
/// one resolution that has to be asked for explicitly.
pub fn resolve(
    data_dir: &Path,
    project: &str,
    binding: &Binding,
    token: &str,
    body: &serde_json::Value,
) -> Result<ResolveAnswer> {
    let scene = match body.get("scene").and_then(|scene| scene.as_str()) {
        Some(scene) if valid_name(scene) => scene.to_string(),
        Some(_) => return Err(Failure::new(
            400,
            "invalid scene name — use letters, digits, spaces, - or _ (max 64, no leading symbol)",
        )),
        None => {
            return Err(Failure::new(
                400,
                "body is not a resolution — name the scene to resolve",
            ))
        }
    };
    let resolution = body
        .get("resolution")
        .and_then(|resolution| resolution.as_str())
        .unwrap_or_default()
        .to_string();
    if resolution != "keep-local" && resolution != "take-remote" {
        return Err(Failure::new(
            400,
            r#"invalid resolution — use "keep-local" or "take-remote""#,
        ));
    }
    let mut bases = read_state(data_dir, project);
    let base = bases
        .get(&scene)
        .cloned()
        .filter(|base| base.conflict_sha.is_some());
    let Some(base) = base else {
        return Err(Failure::new(
            400,
            format!("scene is not conflicted: {project}/{scene}"),
        ));
    };
    let conflict = base.conflict_sha.clone().unwrap_or_default();
    if resolution == "keep-local" {
        bases.insert(
            scene.clone(),
            SceneBase {
                base_sha: conflict,
                base_hash: base.base_hash,
                conflict_sha: None,
            },
        );
    } else if conflict.is_empty() {
        // The remote deleted it and the author accepts that, so the local file
        // goes too and the scene stops being tracked.
        let _ = fs::remove_file(scene_file(data_dir, project, &scene));
        bases.remove(&scene);
    } else {
        let text = github::blob(binding, token, &conflict)?;
        write_working_file(data_dir, project, &scene, &text)?;
        bases.insert(
            scene.clone(),
            SceneBase {
                base_sha: conflict,
                base_hash: sha256(&text),
                conflict_sha: None,
            },
        );
    }
    write_state(data_dir, project, &bases)?;
    Ok(ResolveAnswer {
        ok: true,
        scene,
        resolution,
    })
}

#[derive(serde::Serialize)]
pub struct PushAnswer {
    pub ok: bool,
    pub commit: String,
    pub pushed: Vec<String>,
    #[serde(rename = "removedRemotely")]
    pub removed_remotely: Vec<String>,
}

/// Where a scene lives inside the repository, from the repository's root.
fn repo_file(binding: &Binding, scene: &str) -> String {
    if binding.path.is_empty() {
        format!("{scene}{EXT}")
    } else {
        format!("{}/{scene}{EXT}", binding.path)
    }
}

/// Land every local change on the branch as **one** commit, built through the
/// Git Data API: a blob per changed scene, one tree over the head's tree with
/// deletions as null-sha entries, one commit, and a non-force ref update. One
/// commit rather than one per scene because a drawing session is one change to
/// a reader of the repository's history, and because a half-applied push is not
/// a state anyone should have to reason about.
pub fn push(
    data_dir: &Path,
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
) -> Result<PushAnswer> {
    // The trunk is protected (D33): through Docent the base branch only ever
    // changes by a pull request someone merged. Checked before anything else,
    // because it is a fact about the branch rather than about the changes —
    // saving stays local and unblocked either way.
    if binding.branch == binding.base() {
        return Err(Failure::new(409, github::BASE_BRANCH_ERROR));
    }
    let mut bases = read_state(data_dir, project);
    let copy = working_copy(data_dir, project);
    let mut conflicted = Vec::new();
    let mut changed = Vec::new();
    let mut deleted = Vec::new();
    let mut names: BTreeSet<&String> = copy.keys().collect();
    names.extend(bases.keys());
    for name in sorted_names(names) {
        match scene_state(copy.get(&name), bases.get(&name)) {
            "conflicted" => conflicted.push(name),
            "new" | "modified" => changed.push(name),
            "deleted" => deleted.push(name),
            _ => {}
        }
    }
    // Pushing over an unanswered question would silently pick a side, which is
    // exactly what D29 forbids.
    if !conflicted.is_empty() {
        return Err(Failure::new(409, github::unresolved_error(&conflicted)));
    }
    if changed.is_empty() && deleted.is_empty() {
        return Err(Failure::new(400, "nothing to push"));
    }

    // The branch may have moved since the last pull. Everything this push
    // would write or delete is checked against what the last synchronization
    // recorded — a scene someone else changed meanwhile must be pulled and
    // answered (D29), never silently overwritten. Scenes this push does not
    // touch are the base tree's business and ride through unchanged, so
    // unrelated remote work never blocks a push.
    let remote = github::list(project, binding, token, cache)?;
    let scene_moved = changed.iter().chain(deleted.iter()).any(|name| {
        let base = bases.get(name).map(|b| b.base_sha.as_str()).unwrap_or("");
        remote.get(name).map(String::as_str).unwrap_or("") != base
    });
    if scene_moved {
        return Err(Failure::new(409, github::MOVED_ERROR));
    }

    // Read the branch before creating anything: a push at a branch that is not
    // there costs no objects at all.
    let head = github::head(binding, token)?;
    let mut entries = Vec::new();
    let mut written = Vec::new();
    for name in &changed {
        let text = fs::read_to_string(scene_file(data_dir, project, name)).map_err(internal)?;
        let sha = github::create_blob(binding, token, &text)?;
        written.push((name.clone(), sha.clone(), sha256(&text)));
        entries.push(serde_json::json!({
            "path": repo_file(binding, name),
            "mode": "100644",
            "type": "blob",
            "sha": sha,
        }));
    }
    for name in &deleted {
        // A null sha in a tree entry is how the Git Data API spells "remove
        // this path from the base tree".
        entries.push(serde_json::json!({
            "path": repo_file(binding, name),
            "mode": "100644",
            "type": "blob",
            "sha": serde_json::Value::Null,
        }));
    }
    let tree = github::create_object(
        binding,
        token,
        "/git/trees",
        &serde_json::json!({ "base_tree": head.tree, "tree": entries }),
    )?;
    let total = changed.len() + deleted.len();
    let commit = github::create_object(
        binding,
        token,
        "/git/commits",
        &serde_json::json!({
            "message": format!("docent: update {project} ({total} scene(s))"),
            "tree": tree,
            "parents": [head.commit],
        }),
    )?;
    github::update_ref(binding, token, &commit)?;

    for (name, sha, hash) in written {
        bases.insert(
            name,
            SceneBase {
                base_sha: sha,
                base_hash: hash,
                conflict_sha: None,
            },
        );
    }
    for name in &deleted {
        bases.remove(name);
    }
    write_state(data_dir, project, &bases)?;
    cache.forget(project);
    Ok(PushAnswer {
        ok: true,
        commit,
        pushed: changed,
        removed_remotely: deleted,
    })
}

#[derive(serde::Serialize)]
pub struct RemoteStatus {
    pub reachable: bool,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct StatusAnswer {
    pub branch: String,
    #[serde(rename = "baseBranch")]
    pub base_branch: String,
    pub local: Vec<SceneState>,
    pub remote: RemoteStatus,
}

/// Where this project stands, in one answer: what the working copy did, and
/// what the branch did. The local half never touches the network — it is file
/// hashes against recorded ones — so a project with no token, or a machine with
/// no route to GitHub, still gets the truth about its own scenes and a remote
/// half that says plainly it could not be reached.
pub fn status(
    data_dir: &Path,
    project: &str,
    binding: &Binding,
    token: Option<&str>,
    cache: &Cache,
) -> StatusAnswer {
    let local = local_states(data_dir, project);
    let mut remote = RemoteStatus {
        reachable: false,
        changed: Vec::new(),
        removed: Vec::new(),
    };
    if let Some(token) = token {
        // Unreachable, refused, rate-limited: the local half is still true, and
        // saying so beats failing the whole answer.
        if let Ok(listing) = github::list(project, binding, token, cache) {
            let bases = read_state(data_dir, project);
            let mut changed = Vec::new();
            let mut removed = Vec::new();
            for (name, sha) in &listing {
                if !bases.get(name).is_some_and(|base| base.base_sha == *sha) {
                    changed.push(name.clone());
                }
            }
            for (name, base) in &bases {
                if !base.base_sha.is_empty() && !listing.contains_key(name) {
                    removed.push(name.clone());
                }
            }
            crate::store::sort_by(&mut changed, |name| name);
            crate::store::sort_by(&mut removed, |name| name);
            remote = RemoteStatus {
                reachable: true,
                changed,
                removed,
            };
        }
    }
    StatusAnswer {
        branch: binding.branch.clone(),
        base_branch: binding.base().to_string(),
        local,
        remote,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_content_hash_is_the_one_node_crypto_computes() {
        // The published sha-256 vectors, which is what `createHash("sha256")`
        // answers for the same input — the two stores have to agree on these
        // bytes or their state files diverge.
        assert_eq!(
            sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256(r#"{"type":"excalidraw","version":2,"elements":[]}"#).len(),
            64
        );
    }

    #[test]
    fn a_scene_is_new_modified_deleted_or_clean_by_comparison_alone() {
        let base = SceneBase {
            base_sha: "blob".into(),
            base_hash: sha256("drawn"),
            conflict_sha: None,
        };
        let same = sha256("drawn");
        let other = sha256("redrawn");
        assert_eq!(scene_state(Some(&same), Some(&base)), "clean");
        assert_eq!(scene_state(Some(&other), Some(&base)), "modified");
        assert_eq!(scene_state(None, Some(&base)), "deleted");
        assert_eq!(scene_state(Some(&same), None), "new");
        // A recorded conflict outranks every one of them: it is the one state
        // the author has to answer before anything else can happen.
        let conflicted = SceneBase {
            conflict_sha: Some("theirs".into()),
            ..base.clone()
        };
        assert_eq!(scene_state(Some(&same), Some(&conflicted)), "conflicted");
        assert_eq!(scene_state(None, Some(&conflicted)), "conflicted");
    }

    #[test]
    fn the_state_file_is_the_bytes_the_reference_store_writes() {
        let mut scenes = BTreeMap::new();
        scenes.insert(
            "beta".to_string(),
            SceneBase {
                base_sha: "sha-b".into(),
                base_hash: "hash-b".into(),
                conflict_sha: None,
            },
        );
        scenes.insert(
            "alpha".to_string(),
            SceneBase {
                base_sha: "sha-a".into(),
                base_hash: "hash-a".into(),
                conflict_sha: Some("theirs".into()),
            },
        );
        let json = serde_json::to_string_pretty(&SyncFile { scenes }).unwrap() + "\n";
        assert_eq!(
            json,
            r#"{
  "scenes": {
    "alpha": {
      "baseSha": "sha-a",
      "baseHash": "hash-a",
      "conflictSha": "theirs"
    },
    "beta": {
      "baseSha": "sha-b",
      "baseHash": "hash-b"
    }
  }
}
"#
        );
        // …and an empty one is still an object with a scenes map, not null.
        assert_eq!(
            serde_json::to_string_pretty(&SyncFile::default()).unwrap(),
            "{\n  \"scenes\": {}\n}"
        );
    }
}
