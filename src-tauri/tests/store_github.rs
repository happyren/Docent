//! Per-project GitHub sync on the desktop store (S14, D27, D28, D29, D33) —
//! the mirror of `tests/store-github.test.ts`. Same scenarios, same assertions,
//! same expected strings, so a divergence between the two store
//! implementations fails here instead of in someone's portfolio.
//!
//! GitHub is a `tiny_http` server in this file, the way the update check's
//! tests stand in for the releases API. It answers only the calls the store
//! makes, but it answers them the way GitHub does: base64 contents, ETag
//! revalidation on the listing, Git-Data blobs/trees/commits, and a
//! non-fast-forward ref update refused the way GitHub refuses one. `apiBase` is
//! part of the binding, so pointing the store at it needs no environment
//! variable — it is the same mechanism that makes GitHub Enterprise work.
//!
//! Every case gets its own store, its own mock, its own data directory and its
//! own secrets file, so they run in parallel without sharing anything.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use docent_lib::store::{self, StoreHandle, StubDialog};
use docent_lib::sync::sha256;

const SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
const OTHER_SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[{"id":"a"}]}"#;
const THIRD_SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[{"id":"b"}]}"#;
const WEBVIEW_ORIGIN: &str = "tauri://localhost";
const TOKEN: &str = "github_pat_11ABCDEF0_docenttest";

const TOKEN_MESSAGE: &str =
    "GitHub token missing or rejected for this project — set it in the binding";
const WRITE_MESSAGE: &str = "GitHub rejected the write — the token needs Contents: Read and write on acme/diagrams (organization repos may also require fine-grained token approval)";
const UNVERIFIED_MESSAGE: &str =
    "could not verify access to acme/diagrams — check the repo name and token";
const MOVED_MESSAGE: &str = "the remote branch moved — pull first";
const BASE_BRANCH_MESSAGE: &str =
    "pushing to the base branch is disabled — create a branch and open a pull request";

// ---------------------------------------------------------------------------
// the mock GitHub API
// ---------------------------------------------------------------------------

/// A content hash that stands in for a git blob sha. The store only ever
/// echoes what the API gave it, so this needs to be stable and unique, not
/// genuinely sha1 — which would be a dependency for no gain.
fn blob_sha(content: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}{:016x}", content.len())
}

#[derive(Clone)]
struct Seen {
    method: String,
    url: String,
    body: String,
    if_none_match: Option<String>,
}

#[derive(Clone, Default)]
struct MockCommit {
    tree: String,
    parents: Vec<String>,
}

#[derive(Default)]
struct Repository {
    /// The repository's files, as the active branch sees them. One set rather
    /// than one per branch: the store never reads two branches at once, and a
    /// push replaces this wholesale with the tree it just committed.
    files: BTreeMap<String, String>,
    /// Blobs created through the Git Data API, by their sha.
    blobs: BTreeMap<String, String>,
    /// Trees created through the Git Data API: sha → path → content.
    trees: BTreeMap<String, BTreeMap<String, String>>,
    commits: BTreeMap<String, MockCommit>,
    seen: Vec<Seen>,
    /// Branch name → head sha, which is all the ref endpoints need (D28).
    branches: BTreeMap<String, String>,
    /// Pull request numbers, handed out in order like GitHub's.
    pulls: i64,
    /// What `GET /repos/acme/diagrams` calls the repository's default branch.
    default_branch: String,
    /// Bumped by every write, so the listing's ETag changes when it should.
    version: u64,
    /// Handed out to every Git-Data object this mock creates.
    objects: u64,
    /// A token that may read and not write — what a fine-grained PAT is by
    /// default. Reads answer normally; every write answers GitHub's own 403,
    /// and the repository probe reports `push: false`.
    read_only: bool,
    /// `GET /repos/acme/diagrams` answers 404 — a wrong name, or a private repo.
    repo_missing: bool,
    /// Advance the branch the moment its head is read: the race a push is
    /// supposed to lose. The commit it then builds names a parent that is no
    /// longer the head, so the ref update is not a fast-forward.
    move_head_on_ref_read: bool,
}

struct MockGitHub {
    server: Arc<tiny_http::Server>,
    worker: Option<JoinHandle<()>>,
    repo: Arc<Mutex<Repository>>,
    url: String,
}

impl MockGitHub {
    fn start() -> Self {
        let server =
            tiny_http::Server::http((Ipv4Addr::LOCALHOST, 0)).expect("mock binds loopback");
        let port = server
            .server_addr()
            .to_ip()
            .expect("mock bound a TCP port")
            .port();
        let server = Arc::new(server);
        let repo = Arc::new(Mutex::new(Repository {
            version: 1,
            // One branch, which is also the repository's default.
            branches: BTreeMap::from([("main".to_string(), "sha-main".to_string())]),
            default_branch: "main".to_string(),
            ..Repository::default()
        }));
        let worker = {
            let server = Arc::clone(&server);
            let repo = Arc::clone(&repo);
            thread::spawn(move || {
                for mut request in server.incoming_requests() {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let (status, payload) = answer(&repo, &request, &body);
                    let mut response = tiny_http::Response::from_string(payload.body)
                        .with_status_code(status)
                        .with_header(head("Content-Type", "application/json"));
                    if let Some(etag) = payload.etag {
                        response = response.with_header(head("ETag", &etag));
                    }
                    let _ = request.respond(response);
                }
            })
        };
        Self {
            server,
            worker: Some(worker),
            repo,
            url: format!("http://127.0.0.1:{port}"),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Repository> {
        self.repo.lock().expect("repository")
    }

    /// Someone else's commit: a file changes and the listing's ETag moves.
    fn write(&self, path: &str, content: &str) {
        let mut repo = self.lock();
        repo.files.insert(path.to_string(), content.to_string());
        repo.version += 1;
    }

    fn remove(&self, path: &str) {
        let mut repo = self.lock();
        repo.files.remove(path);
        repo.version += 1;
    }

    fn file(&self, path: &str) -> Option<String> {
        self.lock().files.get(path).cloned()
    }

    fn file_count(&self) -> usize {
        self.lock().files.len()
    }

    fn set_read_only(&self, read_only: bool) {
        self.lock().read_only = read_only;
    }

    fn set_repo_missing(&self, missing: bool) {
        self.lock().repo_missing = missing;
    }

    fn set_move_head_on_ref_read(&self, moving: bool) {
        self.lock().move_head_on_ref_read = moving;
    }

    /// Put a branch at a sha — creating it, or moving it so a pull request
    /// has something to review (D28).
    fn set_branch(&self, name: &str, sha: &str) {
        self.lock()
            .branches
            .insert(name.to_string(), sha.to_string());
    }

    fn branch_head(&self, name: &str) -> Option<String> {
        self.lock().branches.get(name).cloned()
    }

    fn has_branch(&self, name: &str) -> bool {
        self.lock().branches.contains_key(name)
    }

    /// What the repository calls its default branch, which is where a
    /// binding's base comes from.
    fn set_default_branch(&self, name: &str) {
        self.lock().default_branch = name.to_string();
    }

    fn seen(&self) -> Vec<Seen> {
        self.lock().seen.clone()
    }

    fn requests_to(&self, fragment: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|entry| entry.url.contains(fragment))
            .collect()
    }

    /// The last body sent to a matching endpoint, as JSON.
    fn body_of(&self, fragment: &str, method: &str) -> serde_json::Value {
        let sent = self
            .seen()
            .into_iter()
            .filter(|entry| entry.url.contains(fragment) && entry.method == method)
            .next_back();
        serde_json::from_str(&sent.map(|entry| entry.body).unwrap_or_default())
            .unwrap_or(serde_json::Value::Null)
    }
}

impl Drop for MockGitHub {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Payload {
    body: String,
    etag: Option<String>,
}

impl Payload {
    fn json(value: serde_json::Value) -> Self {
        Self {
            body: value.to_string(),
            etag: None,
        }
    }

    fn empty() -> Self {
        Self {
            body: String::new(),
            etag: None,
        }
    }

    fn with_etag(mut self, etag: String) -> Self {
        self.etag = Some(etag);
        self
    }
}

fn head(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn header_of(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

fn base64_encode(bytes: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let triple = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((triple >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits = 0_u32;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() || byte == b'=' {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    out
}

fn entry_json(path: &str, content: &str) -> serde_json::Value {
    serde_json::json!({
        "name": path.rsplit('/').next().unwrap_or(path),
        "path": path,
        "sha": blob_sha(content),
        "size": content.len(),
        "type": "file",
    })
}

fn not_found() -> (u16, Payload) {
    (
        404,
        Payload::json(serde_json::json!({ "message": "Not Found" })),
    )
}

/// GitHub's own words when the token authenticates but may not write.
fn refused() -> (u16, Payload) {
    (
        403,
        Payload::json(
            serde_json::json!({ "message": "Resource not accessible by personal access token" }),
        ),
    )
}

fn answer(
    repo: &Arc<Mutex<Repository>>,
    request: &tiny_http::Request,
    body: &str,
) -> (u16, Payload) {
    let url = request.url().to_string();
    let if_none_match = header_of(request, "If-None-Match");
    let method = request.method().as_str().to_string();
    let mut repo = repo.lock().expect("repository");
    repo.seen.push(Seen {
        method: method.clone(),
        url: url.clone(),
        body: body.to_string(),
        if_none_match: if_none_match.clone(),
    });

    if header_of(request, "Authorization").as_deref() != Some(&format!("Bearer {TOKEN}")) {
        return (
            401,
            Payload::json(serde_json::json!({ "message": "Bad credentials" })),
        );
    }

    let path = url.split('?').next().unwrap_or("");
    let segments: Vec<String> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(decode)
        .collect();
    if segments.first().map(String::as_str) != Some("repos")
        || segments.get(1).map(String::as_str) != Some("acme")
        || segments.get(2).map(String::as_str) != Some("diagrams")
    {
        return not_found();
    }
    let rest: Vec<&str> = segments[3..].iter().map(String::as_str).collect();

    // The repository itself: what the bind-time capability probe asks for. The
    // permissions object is the shape the REST API answers an authenticated
    // caller with, `push` being the write bit.
    if rest.is_empty() && method == "GET" {
        if repo.repo_missing {
            return not_found();
        }
        return (
            200,
            Payload::json(serde_json::json!({
                "full_name": "acme/diagrams",
                // The same answer names the branch a pull request should
                // target, which is where a binding's base comes from (D28).
                "default_branch": repo.default_branch,
                "permissions": {
                    "admin": false,
                    "maintain": false,
                    "push": !repo.read_only,
                    "triage": false,
                    "pull": true,
                },
            })),
        );
    }

    match rest.first() {
        // Alphabetical, as GitHub answers it — which a BTreeMap already is.
        Some(&"branches") if rest.len() == 1 && method == "GET" => (
            200,
            Payload::json(serde_json::Value::Array(
                repo.branches
                    .iter()
                    .map(
                        |(name, sha)| serde_json::json!({ "name": name, "commit": { "sha": sha } }),
                    )
                    .collect(),
            )),
        ),
        Some(&"git") => git_data(&mut repo, &rest[1..], &method, body),
        Some(&"pulls") if rest.len() == 1 && method == "POST" => {
            if repo.read_only {
                return refused();
            }
            let payload: serde_json::Value =
                serde_json::from_str(body).expect("the store sends JSON");
            let head = payload
                .get("head")
                .and_then(|head| head.as_str())
                .unwrap_or_default()
                .to_string();
            let base = payload
                .get("base")
                .and_then(|base| base.as_str())
                .unwrap_or_default()
                .to_string();
            // A branch that has not moved since it was cut has nothing to
            // merge, and GitHub says so inside the Validation-Failed envelope
            // rather than at its top level.
            if repo.branches.get(&head) == repo.branches.get(&base) {
                return (
                    422,
                    Payload::json(serde_json::json!({
                        "message": "Validation Failed",
                        "errors": [{
                            "resource": "PullRequest",
                            "field": "base",
                            "code": "invalid",
                            "message": format!("No commits between {base} and {head}"),
                        }],
                    })),
                );
            }
            repo.pulls += 1;
            let number = repo.pulls;
            (
                201,
                Payload::json(serde_json::json!({
                    "number": number,
                    "html_url": format!("https://github.com/acme/diagrams/pull/{number}"),
                    "head": { "ref": head },
                    "base": { "ref": base },
                })),
            )
        }
        Some(&"contents") if method == "GET" => {
            let repo_path = rest[1..].join("/");
            list_contents(&repo, &repo_path, if_none_match.as_deref())
        }
        _ => not_found(),
    }
}

/// Everything under `/git/…` — refs, blobs, trees and commits.
fn git_data(repo: &mut Repository, rest: &[&str], method: &str, body: &str) -> (u16, Payload) {
    // The head of a branch, which is where both a new branch and a push start.
    if rest.first() == Some(&"ref") && rest.get(1) == Some(&"heads") && method == "GET" {
        let wanted = rest[2..].join("/");
        let Some(sha) = repo.branches.get(&wanted).cloned() else {
            return not_found();
        };
        if repo.move_head_on_ref_read {
            repo.objects += 1;
            let moved = format!("commit-{}", repo.objects);
            let tree = format!("tree-of-{moved}");
            repo.commits.insert(
                moved.clone(),
                MockCommit {
                    tree,
                    parents: vec![sha.clone()],
                },
            );
            repo.branches.insert(wanted.clone(), moved);
            repo.version += 1;
        }
        return (
            200,
            Payload::json(serde_json::json!({
                "ref": format!("refs/heads/{wanted}"),
                "object": { "sha": sha, "type": "commit" },
            })),
        );
    }
    if rest.first() == Some(&"refs") && rest.len() == 1 && method == "POST" {
        if repo.read_only {
            return refused();
        }
        let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
        let reference = payload
            .get("ref")
            .and_then(|reference| reference.as_str())
            .unwrap_or_default()
            .to_string();
        let sha = payload
            .get("sha")
            .and_then(|sha| sha.as_str())
            .unwrap_or_default()
            .to_string();
        let name = reference
            .strip_prefix("refs/heads/")
            .unwrap_or(&reference)
            .to_string();
        if repo.branches.contains_key(&name) {
            return (
                422,
                Payload::json(serde_json::json!({ "message": "Reference already exists" })),
            );
        }
        repo.branches.insert(name, sha.clone());
        return (
            201,
            Payload::json(serde_json::json!({
                "ref": reference,
                "object": { "sha": sha, "type": "commit" },
            })),
        );
    }
    // Moving a branch: accepted only when the new commit descends from the head
    // this branch currently has, which is what "non-force" means.
    if rest.first() == Some(&"refs") && rest.get(1) == Some(&"heads") && method == "PATCH" {
        if repo.read_only {
            return refused();
        }
        let name = rest[2..].join("/");
        let Some(current) = repo.branches.get(&name).cloned() else {
            return not_found();
        };
        let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
        let sha = payload
            .get("sha")
            .and_then(|sha| sha.as_str())
            .unwrap_or_default()
            .to_string();
        let forced = payload
            .get("force")
            .and_then(|force| force.as_bool())
            .unwrap_or(false);
        let commit = repo.commits.get(&sha).cloned().unwrap_or_default();
        if !forced && !commit.parents.contains(&current) {
            return (
                422,
                Payload::json(serde_json::json!({ "message": "Update is not a fast forward" })),
            );
        }
        repo.branches.insert(name.clone(), sha.clone());
        if let Some(snapshot) = repo.trees.get(&commit.tree).cloned() {
            repo.files = snapshot;
        }
        repo.version += 1;
        return (
            200,
            Payload::json(serde_json::json!({
                "ref": format!("refs/heads/{name}"),
                "object": { "sha": sha, "type": "commit" },
            })),
        );
    }
    if rest.first() == Some(&"blobs") && rest.len() == 2 && method == "GET" {
        let wanted = rest[1];
        let known = repo.blobs.get(wanted).cloned().or_else(|| {
            repo.files
                .values()
                .find(|content| blob_sha(content) == wanted)
                .cloned()
        });
        return match known {
            Some(content) => (
                200,
                Payload::json(serde_json::json!({
                    "sha": wanted,
                    "encoding": "base64",
                    "content": format!("{}\n", base64_encode(content.as_bytes())),
                })),
            ),
            None => not_found(),
        };
    }
    if rest.first() == Some(&"blobs") && rest.len() == 1 && method == "POST" {
        if repo.read_only {
            return refused();
        }
        let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
        let encoded = payload
            .get("content")
            .and_then(|content| content.as_str())
            .unwrap_or_default();
        let text = String::from_utf8(base64_decode(encoded)).expect("the store sends UTF-8");
        let sha = blob_sha(&text);
        repo.blobs.insert(sha.clone(), text);
        return (201, Payload::json(serde_json::json!({ "sha": sha })));
    }
    if rest.first() == Some(&"trees") && rest.len() == 1 && method == "POST" {
        if repo.read_only {
            return refused();
        }
        let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
        // The base tree is whatever the branch holds now; the entries are laid
        // over it, and a null sha removes a path exactly as the API documents.
        let mut snapshot = repo.files.clone();
        for entry in payload
            .get("tree")
            .and_then(|tree| tree.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let path = entry
                .get("path")
                .and_then(|path| path.as_str())
                .unwrap_or_default()
                .to_string();
            match entry.get("sha").and_then(|sha| sha.as_str()) {
                None => {
                    snapshot.remove(&path);
                }
                Some(sha) => {
                    let content = repo.blobs.get(sha).cloned().unwrap_or_default();
                    snapshot.insert(path, content);
                }
            }
        }
        repo.objects += 1;
        let sha = format!("tree-{}", repo.objects);
        repo.trees.insert(sha.clone(), snapshot);
        return (201, Payload::json(serde_json::json!({ "sha": sha })));
    }
    if rest.first() == Some(&"commits") && rest.len() == 1 && method == "POST" {
        if repo.read_only {
            return refused();
        }
        let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
        let tree = payload
            .get("tree")
            .and_then(|tree| tree.as_str())
            .unwrap_or_default()
            .to_string();
        let parents: Vec<String> = payload
            .get("parents")
            .and_then(|parents| parents.as_array())
            .map(|parents| {
                parents
                    .iter()
                    .filter_map(|parent| parent.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        repo.objects += 1;
        let sha = format!("commit-{}", repo.objects);
        repo.commits.insert(
            sha.clone(),
            MockCommit {
                tree: tree.clone(),
                parents,
            },
        );
        return (
            201,
            Payload::json(serde_json::json!({ "sha": sha, "tree": { "sha": tree } })),
        );
    }
    if rest.first() == Some(&"commits") && rest.len() == 2 && method == "GET" {
        let known = repo.commits.get(rest[1]).cloned();
        // A commit this mock never created still points at *a* tree: the seeded
        // head is one, and a push has to be able to start there.
        let tree = known
            .map(|commit| commit.tree)
            .unwrap_or_else(|| format!("tree-of-{}", rest[1]));
        return (
            200,
            Payload::json(serde_json::json!({ "sha": rest[1], "tree": { "sha": tree } })),
        );
    }
    not_found()
}

fn list_contents(
    repo: &Repository,
    repo_path: &str,
    if_none_match: Option<&str>,
) -> (u16, Payload) {
    let prefix = if repo_path.is_empty() {
        String::new()
    } else {
        format!("{repo_path}/")
    };
    let children: Vec<&String> = repo
        .files
        .keys()
        .filter(|key| key.starts_with(&prefix) && !key[prefix.len()..].contains('/'))
        .collect();
    if children.is_empty() {
        return not_found();
    }
    let etag = format!("W/\"listing-{}\"", repo.version);
    if if_none_match == Some(etag.as_str()) {
        return (304, Payload::empty().with_etag(etag));
    }
    let listing: Vec<serde_json::Value> = children
        .into_iter()
        .map(|key| entry_json(key, &repo.files[key]))
        .collect();
    (
        200,
        Payload::json(serde_json::Value::Array(listing)).with_etag(etag),
    )
}

fn decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&segment[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Fixture {
    store: Option<StoreHandle>,
    github: MockGitHub,
    data_dir: PathBuf,
    secrets_file: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let data_dir = std::env::temp_dir().join(unique_name("docent-gh-data"));
        // Outside the data directory, as D27 requires of every deployment.
        let secrets_file = std::env::temp_dir()
            .join(unique_name("docent-gh-secrets"))
            .with_extension("json");
        let store = store::spawn(
            data_dir.clone(),
            secrets_file.clone(),
            Arc::new(StubDialog::new("cancel")),
        )
        .expect("store binds loopback");
        Self {
            store: Some(store),
            github: MockGitHub::start(),
            data_dir,
            secrets_file,
        }
    }

    fn port(&self) -> u16 {
        self.store.as_ref().expect("store running").port()
    }

    fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// A project, created and bound to the mock repository.
    fn bound_project(&self, project: &str) -> &Self {
        assert_eq!(
            put(self.port(), &format!("/api/projects/{project}"), None).status,
            201
        );
        let res = self.bind(project, serde_json::json!({}));
        assert_eq!(res.status, 200, "{}", res.body);
        self
    }

    fn bind(&self, project: &str, overrides: serde_json::Value) -> Res {
        let mut body = serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "docs/diagrams",
            "branch": "main",
            "apiBase": self.github.url,
            "token": TOKEN,
        });
        for (key, value) in overrides.as_object().expect("an object of overrides") {
            if value.is_null() {
                body.as_object_mut().expect("object").remove(key);
            } else {
                body[key] = value.clone();
            }
        }
        put(
            self.port(),
            &format!("/api/projects/{project}/binding"),
            Some(&body.to_string()),
        )
    }

    // -- the scene routes, which never reach the network (D29) --------------

    fn put_scene(&self, project: &str, scene: &str, body: &str) -> Res {
        put(
            self.port(),
            &format!("/api/projects/{project}/scenes/{}", encode(scene)),
            Some(body),
        )
    }

    fn get_scene(&self, project: &str, scene: &str) -> Res {
        get(
            self.port(),
            &format!("/api/projects/{project}/scenes/{}", encode(scene)),
        )
    }

    fn delete_scene(&self, project: &str, scene: &str) -> Res {
        delete(
            self.port(),
            &format!("/api/projects/{project}/scenes/{}", encode(scene)),
        )
    }

    fn scene_names(&self, project: &str) -> Vec<String> {
        let res = get(self.port(), &format!("/api/projects/{project}/scenes"));
        assert_eq!(res.status, 200, "{}", res.body);
        res.json()
            .as_array()
            .expect("a listing")
            .iter()
            .map(|scene| scene["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    // -- the sync verbs -----------------------------------------------------

    fn sync_status(&self, project: &str) -> Res {
        get(self.port(), &format!("/api/projects/{project}/sync-status"))
    }

    fn status(&self, project: &str) -> serde_json::Value {
        let res = self.sync_status(project);
        assert_eq!(res.status, 200, "{}", res.body);
        res.json()
    }

    /// What the working copy says one scene did since the last sync.
    fn state_of(&self, project: &str, scene: &str) -> String {
        self.status(project)["local"]
            .as_array()
            .expect("local states")
            .iter()
            .find(|entry| entry["name"] == scene)
            .map(|entry| entry["state"].as_str().unwrap_or_default().to_string())
            .unwrap_or_else(|| "absent".to_string())
    }

    fn pull(&self, project: &str) -> Res {
        post(self.port(), &format!("/api/projects/{project}/pull"), None)
    }

    fn pulled(&self, project: &str) -> serde_json::Value {
        let res = self.pull(project);
        assert_eq!(res.status, 200, "{}", res.body);
        res.json()
    }

    fn resolve(&self, project: &str, body: serde_json::Value) -> Res {
        post(
            self.port(),
            &format!("/api/projects/{project}/pull/resolve"),
            Some(&body.to_string()),
        )
    }

    fn push(&self, project: &str) -> Res {
        post(self.port(), &format!("/api/projects/{project}/push"), None)
    }

    /// Draft on a branch: the base branch is protected (D33), so every case
    /// that pushes has to be somewhere else first.
    fn draft_on(&self, project: &str, branch: &str) {
        let res = post(
            self.port(),
            &format!("/api/projects/{project}/branches"),
            Some(&serde_json::json!({ "name": branch }).to_string()),
        );
        assert_eq!(res.status, 201, "{}", res.body);
    }

    // -- what is on disk ----------------------------------------------------

    fn sync_file(&self, project: &str) -> PathBuf {
        self.data_dir
            .join(".docent")
            .join("sync")
            .join(format!("{project}.json"))
    }

    fn sync_state(&self, project: &str) -> serde_json::Value {
        serde_json::from_str(
            &fs::read_to_string(self.sync_file(project)).expect("a sync state file"),
        )
        .expect("valid JSON")
    }

    fn local_file(&self, project: &str, scene: &str) -> PathBuf {
        self.data_dir
            .join(project)
            .join(format!("{scene}.excalidraw"))
    }

    fn local_scene(&self, project: &str, scene: &str) -> Option<String> {
        fs::read_to_string(self.local_file(project, scene)).ok()
    }

    fn bindings(&self) -> serde_json::Value {
        serde_json::from_str(
            &fs::read_to_string(self.data_dir.join(".docent").join("bindings.json"))
                .expect("the bindings dotfile is where D27 says"),
        )
        .expect("valid JSON")
    }

    fn secrets(&self) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(&self.secrets_file).unwrap_or_default())
            .unwrap_or(serde_json::json!({}))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.store.take());
        let _ = fs::remove_dir_all(&self.data_dir);
        let _ = fs::remove_file(&self.secrets_file);
    }
}

fn unique_name(prefix: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

/// Every file under `dir`, as absolute paths.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            out.extend(walk(&entry.path()));
        } else {
            out.push(entry.path());
        }
    }
    out
}

/// `encodeURIComponent` for the one character a scene name may carry that a
/// URL may not.
fn encode(scene: &str) -> String {
    scene.replace(' ', "%20")
}

fn names(value: &serde_json::Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|name| name.as_str().unwrap_or_default().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// a request client small enough to not need a dependency
// ---------------------------------------------------------------------------

struct Res {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Res {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|err| panic!("expected JSON, got {:?} ({err})", self.body))
    }

    fn error(&self) -> String {
        self.json()["error"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }
}

fn send(port: u16, method: &str, path: &str, body: Option<&str>, extra: &[(&str, &str)]) -> Res {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("store accepts connections");
    // The webview's origin unless the case states another one: the store reads
    // the first Origin header it finds, so this may never be sent twice.
    let origin = extra
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("Origin"))
        .map_or(WEBVIEW_ORIGIN, |(_, value)| value);
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nOrigin: {origin}\r\n"
    );
    for (name, value) in extra {
        if name.eq_ignore_ascii_case("Origin") {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\n\r\n",
        body.map_or(0, str::len)
    ));
    stream.write_all(head.as_bytes()).unwrap();
    if let Some(body) = body {
        stream.write_all(body.as_bytes()).unwrap();
    }
    stream.flush().unwrap();
    stream.shutdown(Shutdown::Write).unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("malformed response: {text:?}"));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("no status line in {head:?}"));
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    Res {
        status,
        headers,
        body: body.to_string(),
    }
}

fn get(port: u16, path: &str) -> Res {
    send(port, "GET", path, None, &[])
}

fn put(port: u16, path: &str, body: Option<&str>) -> Res {
    send(port, "PUT", path, body, &[])
}

fn post(port: u16, path: &str, body: Option<&str>) -> Res {
    send(port, "POST", path, body, &[])
}

fn delete(port: u16, path: &str) -> Res {
    send(port, "DELETE", path, None, &[])
}

// ---------------------------------------------------------------------------
// binding metadata and the secrets boundary
// ---------------------------------------------------------------------------

#[test]
fn binds_a_project_and_the_token_never_comes_back_out() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    let res = get(fixture.port(), "/api/projects/work/binding");
    assert_eq!(res.status, 200);
    assert_eq!(
        res.json(),
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "docs/diagrams",
            "branch": "main",
            // The repository's default branch, learned by the same bind-time
            // probe that learned the write bit (D28).
            "baseBranch": "main",
            "apiBase": fixture.github.url,
            "hasToken": true,
            // The bind-time probe found a token that can write, and says so.
            "canWrite": true,
        })
    );
    // Not merely absent from the typed shape — absent from the bytes.
    assert!(!res.body.contains(TOKEN));
}

#[test]
fn keeps_metadata_in_the_dotfile_and_the_token_out_of_the_data_tree() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    assert_eq!(
        fixture.bindings()["work"],
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "docs/diagrams",
            "branch": "main",
            "baseBranch": "main",
            "apiBase": fixture.github.url,
            // The probe's verdict is metadata, not a secret, so it lives here too.
            "canWrite": true,
        })
    );

    // Walk the whole data tree: nothing in it may carry the credential.
    for file in walk(fixture.data_dir()) {
        let contents = fs::read_to_string(&file).unwrap_or_default();
        assert!(!contents.contains(TOKEN), "{}", file.display());
    }

    assert_eq!(fixture.secrets()["work"], TOKEN);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&fixture.secrets_file)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the token file is the owner's alone");
    }
}

#[test]
fn keeps_the_stored_token_when_an_update_omits_it() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    let update = fixture.bind(
        "work",
        serde_json::json!({ "token": serde_json::Value::Null, "path": "docs" }),
    );
    assert_eq!(update.status, 200);
    let binding = get(fixture.port(), "/api/projects/work/binding").json();
    assert_eq!(binding["path"], "docs");
    assert_eq!(binding["hasToken"], true);
}

#[test]
fn defaults_the_branch_and_the_api_base() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/defaults", None).status,
        201
    );
    let res = put(
        fixture.port(),
        "/api/projects/defaults/binding",
        Some(r#"{"owner":"acme","repo":"diagrams"}"#),
    );
    assert_eq!(res.status, 200);
    // No token anywhere, so nothing was probed and nothing is claimed — and in
    // particular no request left the machine for the default API base.
    // …and with nothing to ask, the base falls back to the bound branch.
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "canWrite": serde_json::Value::Null, "baseBranch": "main" })
    );

    assert_eq!(
        get(fixture.port(), "/api/projects/defaults/binding").json(),
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "",
            "branch": "main",
            "baseBranch": "main",
            "apiBase": "https://api.github.com",
            "hasToken": false,
            "canWrite": serde_json::Value::Null,
        })
    );
}

#[test]
fn refuses_bindings_it_cannot_trust() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/work", None).status, 201);

    for (body, expected) in [
        (r#"{"owner":"-bad","repo":"diagrams"}"#, "invalid owner"),
        (r#"{"owner":"acme","repo":""}"#, "invalid repo"),
        (
            r#"{"owner":"acme","repo":"diagrams","path":"../etc"}"#,
            "invalid path",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","path":"a/../b"}"#,
            "invalid path",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","branch":"no spaces"}"#,
            "invalid branch",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","branch":"a/../b"}"#,
            "invalid branch",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","baseBranch":"a/../b"}"#,
            "invalid branch",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","apiBase":"ftp://example.com"}"#,
            "invalid apiBase",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","apiBase":"not a url"}"#,
            "invalid apiBase",
        ),
        (
            r#"{"owner":"acme","repo":"diagrams","token":"has space"}"#,
            "invalid token",
        ),
    ] {
        let res = put(fixture.port(), "/api/projects/work/binding", Some(body));
        assert_eq!(res.status, 400, "{expected}: {}", res.body);
        assert!(res.error().starts_with(expected), "{}", res.body);
    }

    let not_json = put(
        fixture.port(),
        "/api/projects/work/binding",
        Some("not json"),
    );
    assert_eq!(not_json.status, 400);
    assert_eq!(not_json.error(), "body is not JSON");
}

#[test]
fn four_oh_fours_the_binding_of_an_unbound_project() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let res = get(fixture.port(), "/api/projects/plain/binding");
    assert_eq!(res.status, 404);
    assert_eq!(res.error(), "no GitHub binding for project: plain");
}

// ---------------------------------------------------------------------------
// the working copy (D29): a bound project's scenes are files, and nothing else
// ---------------------------------------------------------------------------

#[test]
fn opens_saves_and_deletes_scenes_without_one_request_to_github() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let before = fixture.github.seen().len();

    assert_eq!(fixture.put_scene("work", "checkout", SCENE).status, 200);
    let saved = fixture.put_scene("work", "checkout", OTHER_SCENE);
    assert_eq!(saved.json(), serde_json::json!({ "ok": true }));

    let loaded = fixture.get_scene("work", "checkout");
    assert_eq!(loaded.status, 200);
    assert_eq!(loaded.body, OTHER_SCENE);
    // The conflict token S14 used to carry is gone with the network round-trip
    // it guarded.
    assert_eq!(loaded.header("X-Docent-Scene-Sha"), None);

    // A bound scene lists exactly as a local one does — same fields in the
    // same order, and no sha. Asserted on the bytes, because parsing them into
    // a map would sort the keys and lose the very thing under test.
    let listed = get(fixture.port(), "/api/projects/work/scenes");
    assert!(
        listed
            .body
            .starts_with(r#"[{"name":"checkout","updatedAt":"#),
        "{}",
        listed.body
    );
    assert!(listed.body.contains(r#","size":"#), "{}", listed.body);
    assert!(!listed.body.contains("sha"), "{}", listed.body);

    assert_eq!(fixture.delete_scene("work", "checkout").status, 200);
    assert_eq!(fixture.get_scene("work", "checkout").status, 404);

    assert_eq!(
        fixture.github.seen().len(),
        before,
        "not one call left the machine"
    );
}

#[test]
fn keeps_the_files_that_were_already_there_when_the_binding_arrives() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/adopted", None).status,
        201
    );
    assert_eq!(
        fixture.put_scene("adopted", "drawn here", SCENE).status,
        200
    );
    fixture.bound_project("adopted");

    // Binding wipes nothing: the file is still the project's, and still open.
    assert_eq!(fixture.get_scene("adopted", "drawn here").body, SCENE);
    // …and it is local-new until a pull decides what to do with it.
    assert_eq!(fixture.state_of("adopted", "drawn here"), "new");
}

#[test]
fn counts_a_bound_projects_scenes_without_calling_github() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    assert_eq!(fixture.put_scene("work", "checkout", SCENE).status, 200);

    let before = fixture.github.seen().len();
    let projects = get(fixture.port(), "/api/projects").json();
    assert_eq!(
        fixture.github.seen().len(),
        before,
        "the projects listing never blocks on GitHub"
    );
    let work = projects
        .as_array()
        .expect("a listing")
        .iter()
        .find(|project| project["id"] == "work")
        .expect("the bound project");
    assert_eq!(work["bound"], true);
    // The count is the working copy's, and it has a timestamp like any other.
    assert_eq!(work["scenes"], 1);
    assert!(work["updatedAt"].is_string());
    // An unbound project carries no flag at all.
    let plain = projects
        .as_array()
        .expect("a listing")
        .iter()
        .find(|project| project["id"] == "plain")
        .expect("the plain project");
    assert!(plain.get("bound").is_none());
}

#[test]
fn still_refuses_bodies_that_are_not_excalidraw_scenes() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    assert_eq!(
        fixture.put_scene("work", "checkout", "not json").status,
        400
    );
    assert_eq!(
        fixture
            .put_scene("work", "checkout", r#"{"type":"other"}"#)
            .status,
        400
    );
}

#[test]
fn unbinds_without_touching_the_working_copy_and_forgets_the_sync_state() {
    let fixture = Fixture::new();
    fixture.bound_project("released");
    fixture
        .github
        .write("docs/diagrams/remote.excalidraw", SCENE);
    fixture.pulled("released");
    assert!(fixture.sync_state("released")["scenes"]["remote"].is_object());

    let unbind = delete(fixture.port(), "/api/projects/released/binding");
    assert_eq!(unbind.status, 200);
    assert_eq!(unbind.json(), serde_json::json!({ "ok": true }));

    // The pulled file stays; the sync state and the token go.
    assert_eq!(
        fixture.local_scene("released", "remote").as_deref(),
        Some(SCENE)
    );
    assert!(!fixture.sync_file("released").exists());
    assert!(fixture.secrets().get("released").is_none());
    assert!(fixture
        .github
        .file("docs/diagrams/remote.excalidraw")
        .is_some());

    // Unbinding twice is a success, not a 404.
    assert_eq!(
        delete(fixture.port(), "/api/projects/released/binding").status,
        200
    );
}

#[test]
fn deleting_a_bound_project_removes_its_sync_state_and_leaves_github_alone() {
    let fixture = Fixture::new();
    fixture.bound_project("doomed");
    fixture
        .github
        .write("docs/diagrams/remote.excalidraw", SCENE);
    fixture.pulled("doomed");
    let before = fixture.github.file_count();

    assert_eq!(delete(fixture.port(), "/api/projects/doomed").status, 200);
    assert!(!fixture.data_dir().join("doomed").exists());
    assert!(!fixture.sync_file("doomed").exists());
    assert_eq!(
        get(fixture.port(), "/api/projects/doomed/binding").status,
        404,
        "the binding went with it"
    );
    assert!(fixture.secrets().get("doomed").is_none());
    assert_eq!(
        fixture.github.file_count(),
        before,
        "the repository is untouched"
    );
}

// ---------------------------------------------------------------------------
// sync status
// ---------------------------------------------------------------------------

#[test]
fn names_what_every_scene_did_since_the_last_sync() {
    let fixture = Fixture::new();
    fixture.bound_project("states");
    fixture
        .github
        .write("docs/diagrams/clean.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/edited.excalidraw", SCENE);
    fixture.github.write("docs/diagrams/gone.excalidraw", SCENE);
    fixture.pulled("states");

    // …then the three things an author can do to a working copy.
    assert_eq!(
        fixture.put_scene("states", "edited", OTHER_SCENE).status,
        200
    );
    assert_eq!(fixture.delete_scene("states", "gone").status, 200);
    assert_eq!(fixture.put_scene("states", "fresh", SCENE).status, 200);

    let status = fixture.status("states");
    assert_eq!(status["branch"], "main");
    assert_eq!(status["baseBranch"], "main");
    assert_eq!(
        status["local"],
        serde_json::json!([
            { "name": "clean", "state": "clean" },
            { "name": "edited", "state": "modified" },
            { "name": "fresh", "state": "new" },
            { "name": "gone", "state": "deleted" },
        ])
    );
    // Nothing moved on the branch, so the remote half is empty and reachable.
    assert_eq!(
        status["remote"],
        serde_json::json!({ "reachable": true, "changed": [], "removed": [] })
    );
}

#[test]
fn names_what_the_branch_did_on_one_listing_call() {
    let fixture = Fixture::new();
    fixture.bound_project("states");
    fixture
        .github
        .write("docs/diagrams/clean.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/edited.excalidraw", SCENE);
    fixture.pulled("states");

    fixture
        .github
        .write("docs/diagrams/clean.excalidraw", OTHER_SCENE);
    fixture
        .github
        .write("docs/diagrams/added.excalidraw", SCENE);
    fixture.github.remove("docs/diagrams/edited.excalidraw");
    let before = fixture.github.requests_to("/contents/docs/diagrams").len();

    let status = fixture.status("states");
    assert_eq!(status["remote"]["reachable"], true);
    // A blob that moved, and one the branch never had before.
    assert_eq!(names(&status["remote"], "changed"), ["added", "clean"]);
    // A scene the branch dropped, which the working copy still has.
    assert_eq!(names(&status["remote"], "removed"), ["edited"]);
    let listings = fixture.github.requests_to("/contents/docs/diagrams");
    assert_eq!(
        listings.len() - before,
        1,
        "one listing call, and nothing else"
    );
    // …and it revalidates rather than refetching blind: the previous listing's
    // ETag rides along, so an unchanged branch costs the rate limit nothing.
    assert!(
        listings
            .last()
            .and_then(|entry| entry.if_none_match.clone())
            .is_some_and(|etag| etag.contains("listing-")),
        "the listing carried no If-None-Match"
    );
}

#[test]
fn says_plainly_when_the_remote_cannot_be_reached_and_still_answers_locally() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/offline", None).status,
        201
    );
    assert_eq!(fixture.put_scene("offline", "sketch", SCENE).status, 200);
    // A binding whose API base answers nothing at all — the bind is stored
    // regardless, which is what makes an offline machine usable.
    let bound = fixture.bind(
        "offline",
        serde_json::json!({ "apiBase": "http://127.0.0.1:1" }),
    );
    assert_eq!(bound.status, 200, "{}", bound.body);

    let status = fixture.status("offline");
    assert_eq!(
        status["remote"],
        serde_json::json!({ "reachable": false, "changed": [], "removed": [] })
    );
    assert_eq!(
        status["local"],
        serde_json::json!([{ "name": "sketch", "state": "new" }])
    );
}

#[test]
fn sync_status_four_oh_fours_on_an_unbound_project() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let res = fixture.sync_status("plain");
    assert_eq!(res.status, 404);
    assert_eq!(res.error(), "no GitHub binding for project: plain");
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

#[test]
fn brings_a_legacy_bindings_scenes_in_without_losing_local_work() {
    let fixture = Fixture::new();
    // Exactly the state a project bound before D29 is in: files on disk, scenes
    // in the repository, and no sync state anywhere.
    assert_eq!(
        put(fixture.port(), "/api/projects/legacy", None).status,
        201
    );
    assert_eq!(fixture.put_scene("legacy", "only here", SCENE).status, 200);
    fixture.bound_project("legacy");
    fixture
        .github
        .write("docs/diagrams/only there.excalidraw", OTHER_SCENE);
    fixture
        .github
        .write("docs/diagrams/README.md", "not a scene");
    fixture
        .github
        .write("docs/diagrams/nested/deep.excalidraw", SCENE);

    let answer = fixture.pulled("legacy");
    assert_eq!(
        answer,
        serde_json::json!({
            "ok": true,
            "updated": ["only there"],
            "removed": [],
            "kept": ["only here"],
            "conflicts": [],
        })
    );
    // The remote scene arrived, the local one stayed, and nothing outside the
    // bound directory's own .excalidraw files was touched.
    assert_eq!(
        fixture.local_scene("legacy", "only there").as_deref(),
        Some(OTHER_SCENE)
    );
    assert_eq!(
        fixture.local_scene("legacy", "only here").as_deref(),
        Some(SCENE)
    );
    assert_eq!(fixture.scene_names("legacy"), ["only here", "only there"]);
}

#[test]
fn adopts_a_local_file_that_already_matches_the_remote() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/same", None).status, 201);
    assert_eq!(fixture.put_scene("same", "shared", SCENE).status, 200);
    fixture.bound_project("same");
    fixture
        .github
        .write("docs/diagrams/shared.excalidraw", SCENE);

    // Same bytes on both sides is an agreement, not a conflict: the scene
    // simply becomes tracked.
    assert_eq!(
        fixture.pulled("same"),
        serde_json::json!({
            "ok": true,
            "updated": ["shared"],
            "removed": [],
            "kept": [],
            "conflicts": [],
        })
    );
    assert_eq!(fixture.state_of("same", "shared"), "clean");
}

#[test]
fn fast_forwards_a_clean_scene_and_creates_one_the_remote_added() {
    let fixture = Fixture::new();
    fixture.bound_project("forward");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled("forward");

    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", OTHER_SCENE);
    fixture
        .github
        .write("docs/diagrams/added.excalidraw", THIRD_SCENE);
    assert_eq!(
        fixture.pulled("forward"),
        serde_json::json!({
            "ok": true,
            "updated": ["added", "checkout"],
            "removed": [],
            "kept": [],
            "conflicts": [],
        })
    );
    assert_eq!(
        fixture.local_scene("forward", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
    assert_eq!(
        fixture.local_scene("forward", "added").as_deref(),
        Some(THIRD_SCENE)
    );
    // Both are now clean against the branch, so a second pull says nothing.
    assert_eq!(
        fixture.pulled("forward"),
        serde_json::json!({
            "ok": true,
            "updated": [],
            "removed": [],
            "kept": [],
            "conflicts": [],
        })
    );
}

#[test]
fn removes_a_scene_the_remote_deleted() {
    let fixture = Fixture::new();
    fixture.bound_project("dropped");
    fixture
        .github
        .write("docs/diagrams/leaving.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/staying.excalidraw", SCENE);
    fixture.pulled("dropped");

    fixture.github.remove("docs/diagrams/leaving.excalidraw");
    assert_eq!(
        fixture.pulled("dropped"),
        serde_json::json!({
            "ok": true,
            "updated": [],
            "removed": ["leaving"],
            "kept": [],
            "conflicts": [],
        })
    );
    assert_eq!(fixture.get_scene("dropped", "leaving").status, 404);
    assert_eq!(fixture.get_scene("dropped", "staying").status, 200);
    // …and it is out of the sync state entirely, not remembered as deleted.
    assert!(fixture.sync_state("dropped")["scenes"]
        .get("leaving")
        .is_none());
}

#[test]
fn keeps_a_scene_changed_here_that_the_branch_did_not_touch() {
    let fixture = Fixture::new();
    fixture.bound_project("mine");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/other.excalidraw", SCENE);
    fixture.pulled("mine");
    assert_eq!(
        fixture.put_scene("mine", "checkout", OTHER_SCENE).status,
        200
    );
    assert_eq!(
        fixture.put_scene("mine", "brand new", THIRD_SCENE).status,
        200
    );

    fixture
        .github
        .write("docs/diagrams/other.excalidraw", THIRD_SCENE);
    assert_eq!(
        fixture.pulled("mine"),
        serde_json::json!({
            "ok": true,
            "updated": ["other"],
            "removed": [],
            "kept": ["brand new", "checkout"],
            "conflicts": [],
        })
    );
    assert_eq!(
        fixture.local_scene("mine", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
}

#[test]
fn flags_a_scene_both_sides_changed_and_touches_nothing() {
    let fixture = Fixture::new();
    fixture.bound_project("clash");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled("clash");
    assert_eq!(
        fixture.put_scene("clash", "checkout", OTHER_SCENE).status,
        200
    );
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", THIRD_SCENE);

    assert_eq!(
        fixture.pulled("clash"),
        serde_json::json!({
            "ok": true,
            "updated": [],
            "removed": [],
            "kept": [],
            "conflicts": ["checkout"],
        })
    );
    // The author's file is exactly as they left it.
    assert_eq!(
        fixture.local_scene("clash", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
    // The base still points at what was last synced; the question is recorded
    // beside it.
    assert_eq!(
        fixture.sync_state("clash")["scenes"]["checkout"],
        serde_json::json!({
            "baseSha": blob_sha(SCENE),
            "baseHash": sha256(SCENE),
            "conflictSha": blob_sha(THIRD_SCENE),
        })
    );
    assert_eq!(fixture.state_of("clash", "checkout"), "conflicted");
}

#[test]
fn flags_a_scene_the_remote_deleted_while_it_was_being_edited_here() {
    let fixture = Fixture::new();
    fixture.bound_project("vanished");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/other.excalidraw", SCENE);
    fixture.pulled("vanished");
    assert_eq!(
        fixture
            .put_scene("vanished", "checkout", OTHER_SCENE)
            .status,
        200
    );
    fixture.github.remove("docs/diagrams/checkout.excalidraw");

    assert_eq!(
        fixture.pulled("vanished"),
        serde_json::json!({
            "ok": true,
            "updated": [],
            "removed": [],
            "kept": [],
            "conflicts": ["checkout"],
        })
    );
    assert_eq!(
        fixture.local_scene("vanished", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
    // An empty conflict sha is how "the remote deleted it" is written down.
    assert_eq!(
        fixture.sync_state("vanished")["scenes"]["checkout"]["conflictSha"],
        ""
    );
}

#[test]
fn agrees_when_both_sides_deleted_the_same_scene() {
    let fixture = Fixture::new();
    fixture.bound_project("agreed");
    fixture
        .github
        .write("docs/diagrams/leaving.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/staying.excalidraw", SCENE);
    fixture.pulled("agreed");
    assert_eq!(fixture.delete_scene("agreed", "leaving").status, 200);
    fixture.github.remove("docs/diagrams/leaving.excalidraw");

    assert_eq!(
        fixture.pulled("agreed"),
        serde_json::json!({
            "ok": true,
            "updated": [],
            "removed": ["leaving"],
            "kept": [],
            "conflicts": [],
        })
    );
    assert!(fixture.sync_state("agreed")["scenes"]
        .get("leaving")
        .is_none());
}

#[test]
fn pull_four_oh_fours_unbound_and_four_oh_ones_without_a_token() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let unbound = fixture.pull("plain");
    assert_eq!(unbound.status, 404);
    assert_eq!(unbound.error(), "no GitHub binding for project: plain");

    assert_eq!(
        put(fixture.port(), "/api/projects/tokenless", None).status,
        201
    );
    let bound = fixture.bind(
        "tokenless",
        serde_json::json!({ "token": serde_json::Value::Null }),
    );
    assert_eq!(bound.status, 200);
    let missing = fixture.pull("tokenless");
    assert_eq!(missing.status, 401);
    assert_eq!(missing.error(), TOKEN_MESSAGE);
    // …and its scenes still list, because those never needed a credential.
    assert_eq!(
        get(fixture.port(), "/api/projects/tokenless/scenes").status,
        200
    );
}

// ---------------------------------------------------------------------------
// resolving conflicts
// ---------------------------------------------------------------------------

/// A project sitting on one conflicted scene, on a branch it may push to.
fn conflicted(fixture: &Fixture, project: &str, branch: &str) {
    fixture.bound_project(project);
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled(project);
    fixture.draft_on(project, branch);
    assert_eq!(
        fixture.put_scene(project, "checkout", OTHER_SCENE).status,
        200
    );
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", THIRD_SCENE);
    assert_eq!(names(&fixture.pulled(project), "conflicts"), ["checkout"]);
}

#[test]
fn keeps_the_local_copy_and_the_next_push_overwrites_the_remote() {
    let fixture = Fixture::new();
    conflicted(&fixture, "keepmine", "docent/keepmine");

    let res = fixture.resolve(
        "keepmine",
        serde_json::json!({ "scene": "checkout", "resolution": "keep-local" }),
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "scene": "checkout", "resolution": "keep-local" })
    );
    // The file is untouched and the scene reads as a plain local change again:
    // the remote sha has been seen and rejected.
    assert_eq!(
        fixture.local_scene("keepmine", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
    assert_eq!(
        fixture.sync_state("keepmine")["scenes"]["checkout"],
        serde_json::json!({
            "baseSha": blob_sha(THIRD_SCENE),
            "baseHash": sha256(SCENE),
        })
    );
    assert_eq!(fixture.state_of("keepmine", "checkout"), "modified");

    let pushed = fixture.push("keepmine");
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    assert_eq!(
        fixture.github.file("docs/diagrams/checkout.excalidraw"),
        Some(OTHER_SCENE.to_string())
    );
    assert_eq!(fixture.state_of("keepmine", "checkout"), "clean");
}

#[test]
fn takes_the_remote_copy_overwriting_the_working_copy() {
    let fixture = Fixture::new();
    conflicted(&fixture, "takeirs", "docent/takeirs");

    let res = fixture.resolve(
        "takeirs",
        serde_json::json!({ "scene": "checkout", "resolution": "take-remote" }),
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(
        fixture.local_scene("takeirs", "checkout").as_deref(),
        Some(THIRD_SCENE)
    );
    assert_eq!(
        fixture.sync_state("takeirs")["scenes"]["checkout"],
        serde_json::json!({
            "baseSha": blob_sha(THIRD_SCENE),
            "baseHash": sha256(THIRD_SCENE),
        })
    );
    assert_eq!(fixture.state_of("takeirs", "checkout"), "clean");
}

#[test]
fn takes_a_remote_deletion_by_removing_the_scene() {
    let fixture = Fixture::new();
    fixture.bound_project("accepted");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/other.excalidraw", SCENE);
    fixture.pulled("accepted");
    assert_eq!(
        fixture
            .put_scene("accepted", "checkout", OTHER_SCENE)
            .status,
        200
    );
    fixture.github.remove("docs/diagrams/checkout.excalidraw");
    fixture.pulled("accepted");

    let res = fixture.resolve(
        "accepted",
        serde_json::json!({ "scene": "checkout", "resolution": "take-remote" }),
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(fixture.get_scene("accepted", "checkout").status, 404);
    assert!(fixture.sync_state("accepted")["scenes"]
        .get("checkout")
        .is_none());
}

#[test]
fn refuses_a_resolution_it_does_not_know_and_a_scene_that_is_not_conflicted() {
    let fixture = Fixture::new();
    conflicted(&fixture, "picky", "docent/picky");

    let unknown = fixture.resolve(
        "picky",
        serde_json::json!({ "scene": "checkout", "resolution": "merge" }),
    );
    assert_eq!(unknown.status, 400);
    assert_eq!(
        unknown.error(),
        r#"invalid resolution — use "keep-local" or "take-remote""#
    );

    let calm = fixture.resolve(
        "picky",
        serde_json::json!({ "scene": "other", "resolution": "keep-local" }),
    );
    assert_eq!(calm.status, 400);
    assert_eq!(calm.error(), "scene is not conflicted: picky/other");

    let nameless = fixture.resolve("picky", serde_json::json!({ "resolution": "keep-local" }));
    assert_eq!(nameless.status, 400);
    assert!(
        nameless.error().starts_with("body is not a resolution"),
        "{}",
        nameless.body
    );
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

#[test]
fn lands_every_local_change_as_one_commit() {
    let fixture = Fixture::new();
    fixture.bound_project("landing");
    fixture
        .github
        .write("docs/diagrams/edited.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/removed.excalidraw", SCENE);
    fixture.pulled("landing");
    fixture.draft_on("landing", "docent/landing");

    assert_eq!(
        fixture.put_scene("landing", "edited", OTHER_SCENE).status,
        200
    );
    assert_eq!(
        fixture.put_scene("landing", "added", THIRD_SCENE).status,
        200
    );
    assert_eq!(fixture.delete_scene("landing", "removed").status, 200);

    let commits_before = fixture
        .github
        .requests_to("/git/commits")
        .into_iter()
        .filter(|entry| entry.method == "POST")
        .count();
    let res = fixture.push("landing");
    assert_eq!(res.status, 200, "{}", res.body);
    let answer = res.json();
    assert_eq!(answer["ok"], true);
    assert_eq!(names(&answer, "pushed"), ["added", "edited"]);
    assert_eq!(names(&answer, "removedRemotely"), ["removed"]);
    let commit_sha = answer["commit"].as_str().expect("a commit sha").to_string();
    assert!(commit_sha.starts_with("commit-"), "{commit_sha}");

    // Exactly one commit, on top of the branch's head, with one tree carrying
    // every change — the deletion as a null sha, which is how the Git Data API
    // spells "drop this path".
    let commits: Vec<Seen> = fixture
        .github
        .requests_to("/git/commits")
        .into_iter()
        .filter(|entry| entry.method == "POST")
        .collect();
    assert_eq!(commits.len() - commits_before, 1);
    let commit: serde_json::Value =
        serde_json::from_str(&commits.last().expect("a commit").body).expect("JSON");
    assert_eq!(commit["message"], "docent: update landing (3 scene(s))");
    assert_eq!(commit["parents"], serde_json::json!(["sha-main"]));

    let tree = fixture.github.body_of("/git/trees", "POST");
    assert_eq!(tree["base_tree"], "tree-of-sha-main");
    assert_eq!(
        tree["tree"],
        serde_json::json!([
            {
                "path": "docs/diagrams/added.excalidraw",
                "mode": "100644",
                "type": "blob",
                "sha": blob_sha(THIRD_SCENE),
            },
            {
                "path": "docs/diagrams/edited.excalidraw",
                "mode": "100644",
                "type": "blob",
                "sha": blob_sha(OTHER_SCENE),
            },
            {
                "path": "docs/diagrams/removed.excalidraw",
                "mode": "100644",
                "type": "blob",
                "sha": serde_json::Value::Null,
            },
        ])
    );

    // The branch now holds what the working copy holds…
    assert_eq!(
        fixture.github.file("docs/diagrams/edited.excalidraw"),
        Some(OTHER_SCENE.to_string())
    );
    assert_eq!(
        fixture.github.file("docs/diagrams/added.excalidraw"),
        Some(THIRD_SCENE.to_string())
    );
    assert!(fixture
        .github
        .file("docs/diagrams/removed.excalidraw")
        .is_none());
    assert_eq!(
        fixture.github.branch_head("docent/landing").as_deref(),
        Some(commit_sha.as_str())
    );
    // …and every base moved with it, so nothing is left looking dirty.
    let status = fixture.status("landing");
    assert_eq!(
        status["local"],
        serde_json::json!([
            { "name": "added", "state": "clean" },
            { "name": "edited", "state": "clean" },
        ])
    );
    assert_eq!(
        status["remote"],
        serde_json::json!({ "reachable": true, "changed": [], "removed": [] })
    );
}

#[test]
fn refuses_the_base_branch_outright() {
    let fixture = Fixture::new();
    fixture.bound_project("trunk");
    assert_eq!(fixture.put_scene("trunk", "sketch", SCENE).status, 200);

    let res = fixture.push("trunk");
    assert_eq!(res.status, 409);
    assert_eq!(res.error(), BASE_BRANCH_MESSAGE);
    // Nothing was created on the way to the refusal.
    assert!(fixture
        .github
        .file("docs/diagrams/sketch.excalidraw")
        .is_none());
    // The save itself was never blocked — local-first means the work is safe
    // whether or not it may be published.
    assert_eq!(
        fixture.local_scene("trunk", "sketch").as_deref(),
        Some(SCENE)
    );

    // …and a branch of its own is all it takes.
    fixture.draft_on("trunk", "docent/trunk");
    let pushed = fixture.push("trunk");
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    assert_eq!(
        fixture.github.file("docs/diagrams/sketch.excalidraw"),
        Some(SCENE.to_string())
    );
}

#[test]
fn refuses_while_a_conflict_is_unresolved() {
    let fixture = Fixture::new();
    conflicted(&fixture, "unresolved", "docent/unresolved");

    let res = fixture.push("unresolved");
    assert_eq!(res.status, 409);
    assert_eq!(res.error(), "resolve the conflicted scenes first: checkout");
}

#[test]
fn refuses_when_there_is_nothing_to_push() {
    let fixture = Fixture::new();
    fixture.bound_project("quiet");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled("quiet");
    fixture.draft_on("quiet", "docent/quiet");

    let res = fixture.push("quiet");
    assert_eq!(res.status, 400);
    assert_eq!(res.error(), "nothing to push");
}

#[test]
fn refuses_when_the_branch_moved_under_it() {
    let fixture = Fixture::new();
    fixture.bound_project("raced");
    assert_eq!(fixture.put_scene("raced", "sketch", SCENE).status, 200);
    fixture.draft_on("raced", "docent/raced");

    fixture.github.set_move_head_on_ref_read(true);
    let res = fixture.push("raced");
    fixture.github.set_move_head_on_ref_read(false);
    assert_eq!(res.status, 409);
    assert_eq!(res.error(), MOVED_MESSAGE);
    // Nothing landed, and the scene is still waiting to be pushed.
    assert!(fixture
        .github
        .file("docs/diagrams/sketch.excalidraw")
        .is_none());
    assert_eq!(fixture.state_of("raced", "sketch"), "new");

    // With the race over, the same push succeeds.
    let again = fixture.push("raced");
    assert_eq!(again.status, 200, "{}", again.body);
    assert_eq!(
        fixture.github.file("docs/diagrams/sketch.excalidraw"),
        Some(SCENE.to_string())
    );
}

#[test]
fn refuses_when_a_pushed_scene_changed_remotely_since_the_last_pull() {
    let fixture = Fixture::new();
    fixture.bound_project("stale");
    fixture.github.write("docs/diagrams/plan.excalidraw", SCENE);
    assert_eq!(fixture.pull("stale").status, 200);
    fixture.draft_on("stale", "docent/stale");
    // Someone else lands on the branch after the pull; the local author edits
    // the same scene without knowing.
    fixture.github.write("docs/diagrams/plan.excalidraw", OTHER_SCENE);
    let local = SCENE.replace("[]", r#"[{"id":"z"}]"#);
    assert_eq!(fixture.put_scene("stale", "plan", &local).status, 200);

    let res = fixture.push("stale");
    assert_eq!(res.status, 409);
    assert_eq!(res.error(), MOVED_MESSAGE);
    // Their change is still there, ours is still local, and a pull is what
    // reconciles them — never a silent overwrite.
    assert_eq!(
        fixture.github.file("docs/diagrams/plan.excalidraw"),
        Some(OTHER_SCENE.to_string())
    );
    assert_eq!(fixture.state_of("stale", "plan"), "modified");
}

#[test]
fn pushes_scenes_the_remote_never_touched_even_while_another_scene_changed_there() {
    let fixture = Fixture::new();
    fixture.bound_project("aside");
    fixture.github.write("docs/diagrams/plan.excalidraw", SCENE);
    fixture.github.write("docs/diagrams/notes.excalidraw", SCENE);
    assert_eq!(fixture.pull("aside").status, 200);
    fixture.draft_on("aside", "docent/aside");
    fixture.github.write("docs/diagrams/plan.excalidraw", OTHER_SCENE);
    let local = SCENE.replace("[]", r#"[{"id":"n"}]"#);
    assert_eq!(fixture.put_scene("aside", "notes", &local).status, 200);

    let res = fixture.push("aside");
    assert_eq!(res.status, 200, "{}", res.body);
    // The pushed scene landed; the scene someone else changed rode through
    // the base tree untouched.
    assert_eq!(
        fixture.github.file("docs/diagrams/notes.excalidraw"),
        Some(local)
    );
    assert_eq!(
        fixture.github.file("docs/diagrams/plan.excalidraw"),
        Some(OTHER_SCENE.to_string())
    );
}

#[test]
fn refuses_a_push_with_the_permission_that_is_missing() {
    let fixture = Fixture::new();
    fixture.bound_project("locked");
    assert_eq!(fixture.put_scene("locked", "sketch", SCENE).status, 200);
    fixture.draft_on("locked", "docent/locked");

    fixture.github.set_read_only(true);
    let res = fixture.push("locked");
    fixture.github.set_read_only(false);
    assert_eq!(res.status, 403);
    assert_eq!(res.error(), WRITE_MESSAGE);
    assert!(fixture
        .github
        .file("docs/diagrams/sketch.excalidraw")
        .is_none());
}

#[test]
fn push_four_oh_fours_on_an_unbound_project() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let res = fixture.push("plain");
    assert_eq!(res.status, 404);
    assert_eq!(res.error(), "no GitHub binding for project: plain");
}

#[test]
fn sync_writes_refuse_an_origin_that_is_not_the_app() {
    let fixture = Fixture::new();
    fixture.bound_project("guarded");
    assert_eq!(fixture.put_scene("guarded", "sketch", SCENE).status, 200);

    // A page in the user's browser could fire a POST at the loopback port
    // without a preflight, so the app's own origin is required outright.
    for path in ["pull", "push", "pull/resolve"] {
        let res = send(
            fixture.port(),
            "POST",
            &format!("/api/projects/guarded/{path}"),
            Some("{}"),
            &[("Origin", "https://evil.example")],
        );
        assert_eq!(res.status, 403, "{path}: {}", res.body);
        assert_eq!(res.error(), "forbidden");
    }
    assert!(fixture
        .github
        .file("docs/diagrams/sketch.excalidraw")
        .is_none());
}

// ---------------------------------------------------------------------------
// the sync state file (D17's `.docent/` exception, D29)
// ---------------------------------------------------------------------------

#[test]
fn the_sync_state_file_is_sorted_two_space_json_with_a_trailing_newline() {
    let fixture = Fixture::new();
    fixture.bound_project("bytes");
    fixture.github.write("docs/diagrams/beta.excalidraw", SCENE);
    fixture
        .github
        .write("docs/diagrams/alpha.excalidraw", OTHER_SCENE);
    fixture.pulled("bytes");

    let raw = fs::read_to_string(fixture.sync_file("bytes")).expect("a sync state file");
    assert_eq!(
        raw,
        format!(
            "{{\n  \"scenes\": {{\n    \"alpha\": {{\n      \"baseSha\": \"{}\",\n      \"baseHash\": \"{}\"\n    }},\n    \"beta\": {{\n      \"baseSha\": \"{}\",\n      \"baseHash\": \"{}\"\n    }}\n  }}\n}}\n",
            blob_sha(OTHER_SCENE),
            sha256(OTHER_SCENE),
            blob_sha(SCENE),
            sha256(SCENE),
        )
    );
    assert!(!raw.contains(TOKEN));
}

// ---------------------------------------------------------------------------
// a token that reads but does not write
// ---------------------------------------------------------------------------

#[test]
fn a_read_only_token_is_named_at_bind_time_and_remembered() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/readonly", None).status,
        201
    );
    fixture.github.set_read_only(true);
    let put_binding = fixture.bind("readonly", serde_json::json!({}));
    fixture.github.set_read_only(false);
    assert_eq!(put_binding.status, 200);
    assert_eq!(
        put_binding.json(),
        serde_json::json!({ "ok": true, "canWrite": false, "baseBranch": "main" })
    );

    // Persisted as metadata (not a secret), echoed by the binding route, and
    // carried by the projects listing so the modal can mark it without asking.
    assert_eq!(fixture.bindings()["readonly"]["canWrite"], false);
    let binding = get(fixture.port(), "/api/projects/readonly/binding").json();
    assert_eq!(binding["hasToken"], true);
    assert_eq!(binding["canWrite"], false);
    let projects = get(fixture.port(), "/api/projects").json();
    let readonly = projects
        .as_array()
        .expect("a listing")
        .iter()
        .find(|project| project["id"] == "readonly")
        .expect("the bound project");
    assert_eq!(readonly["bound"], true);
    assert_eq!(readonly["canWrite"], false);

    // …and a token that can write clears the mark again, which is the loop the
    // message asks the user to close.
    let again = fixture.bind("readonly", serde_json::json!({}));
    assert_eq!(
        again.json(),
        serde_json::json!({ "ok": true, "canWrite": true, "baseBranch": "main" })
    );
    assert_eq!(fixture.bindings()["readonly"]["canWrite"], true);
}

#[test]
fn a_read_only_token_never_blocks_a_save_because_a_save_is_a_local_file() {
    let fixture = Fixture::new();
    fixture.bound_project("readonly");
    fixture.github.set_read_only(true);
    let saved = fixture.put_scene("readonly", "drawn anyway", SCENE);
    fixture.github.set_read_only(false);
    assert_eq!(saved.status, 200);
    assert_eq!(saved.json(), serde_json::json!({ "ok": true }));
    assert_eq!(
        fixture.local_scene("readonly", "drawn anyway").as_deref(),
        Some(SCENE)
    );
}

#[test]
fn a_read_only_token_still_lists_and_opens_scenes() {
    let fixture = Fixture::new();
    fixture.bound_project("readonly");
    assert_eq!(
        fixture.put_scene("readonly", "drawn anyway", SCENE).status,
        200
    );
    fixture
        .github
        .write("docs/diagrams/theirs.excalidraw", OTHER_SCENE);

    fixture.github.set_read_only(true);
    let pulled = fixture.pull("readonly");
    let listed = fixture.scene_names("readonly");
    let opened = fixture.get_scene("readonly", "theirs");
    fixture.github.set_read_only(false);

    assert_eq!(pulled.status, 200, "{}", pulled.body);
    assert_eq!(listed, ["drawn anyway", "theirs"]);
    assert_eq!(opened.body, OTHER_SCENE);
}

#[test]
fn an_unreachable_repository_still_binds_and_says_why() {
    let fixture = Fixture::new();
    fixture.github.set_repo_missing(true);
    assert_eq!(
        put(fixture.port(), "/api/projects/unverified", None).status,
        201
    );
    let res = fixture.bind("unverified", serde_json::json!({}));
    fixture.github.set_repo_missing(false);
    assert_eq!(res.status, 200);
    assert_eq!(
        res.json(),
        serde_json::json!({
            "ok": true,
            "canWrite": serde_json::Value::Null,
            // Unreachable means the default branch could not be read either, so
            // the base falls back to the branch being bound.
            "baseBranch": "main",
            "warning": UNVERIFIED_MESSAGE,
        })
    );
    // Unknown is stored as an absent field, never as a claim either way.
    assert!(fixture.bindings()["unverified"].get("canWrite").is_none());
    let binding = get(fixture.port(), "/api/projects/unverified/binding").json();
    assert!(binding["canWrite"].is_null());
}

#[test]
fn no_token_means_no_probe_at_all() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/unprobed", None).status,
        201
    );
    let before = fixture.github.requests_to("/repos/acme/diagrams").len();
    let res = fixture.bind(
        "unprobed",
        serde_json::json!({ "token": serde_json::Value::Null }),
    );
    assert_eq!(res.status, 200);
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "canWrite": serde_json::Value::Null, "baseBranch": "main" })
    );
    assert_eq!(
        fixture.github.requests_to("/repos/acme/diagrams").len(),
        before,
        "nothing to ask with, so nothing was asked"
    );
}

// ---------------------------------------------------------------------------
// regression: an unbound project is exactly what it was before S14
// ---------------------------------------------------------------------------

#[test]
fn unbound_projects_stay_a_plain_file_tree() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);

    let saved = fixture.put_scene("plain", "local", SCENE);
    assert_eq!(saved.status, 200);
    assert_eq!(saved.json(), serde_json::json!({ "ok": true }));
    assert_eq!(
        fixture.local_scene("plain", "local").as_deref(),
        Some(SCENE)
    );

    let listed = get(fixture.port(), "/api/projects/plain/scenes");
    assert!(
        listed.body.starts_with(r#"[{"name":"local","updatedAt":"#),
        "{}",
        listed.body
    );
    assert!(!listed.body.contains("sha"), "{}", listed.body);

    let loaded = fixture.get_scene("plain", "local");
    assert_eq!(loaded.body, SCENE);
    assert_eq!(loaded.header("X-Docent-Scene-Sha"), None);

    assert_eq!(fixture.delete_scene("plain", "local").status, 200);
    assert_eq!(fixture.put_scene("nope", "x", SCENE).status, 404);
    assert_eq!(fixture.github.seen().len(), 0, "no binding, no network");
}

// ---------------------------------------------------------------------------
// branch-aware sync (D28): drafting on a branch, and the pull request back
// ---------------------------------------------------------------------------

#[test]
fn lists_the_repositorys_branches_marking_the_base_and_the_active_one() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture.github.set_branch("docent/older", "sha-older");

    let res = get(fixture.port(), "/api/projects/work/branches");
    assert_eq!(res.status, 200);
    assert_eq!(
        res.json(),
        serde_json::json!([
            { "name": "docent/older", "isBase": false, "isActive": false },
            { "name": "main", "isBase": true, "isActive": true },
        ])
    );
    // One page, and the store says so rather than walking the repository's
    // release history to fill a select.
    assert!(!fixture
        .github
        .requests_to("/branches?per_page=100")
        .is_empty());
}

#[test]
fn creates_a_branch_switches_to_it_and_keeps_the_base_the_token_and_the_copy() {
    let fixture = Fixture::new();
    fixture.bound_project("drafts");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled("drafts");

    let created = post(
        fixture.port(),
        "/api/projects/drafts/branches",
        Some(r#"{"name":"docent/diagrams-2026-08-20"}"#),
    );
    assert_eq!(created.status, 201, "{}", created.body);
    assert_eq!(
        created.json(),
        serde_json::json!({ "ok": true, "branch": "docent/diagrams-2026-08-20" })
    );
    // Cut from the branch the project was on, at that branch's head.
    assert_eq!(
        fixture.github.body_of("/git/refs", "POST"),
        serde_json::json!({
            "ref": "refs/heads/docent/diagrams-2026-08-20",
            "sha": "sha-main",
        })
    );

    // The binding moved, and nothing else about it did.
    let binding = get(fixture.port(), "/api/projects/drafts/binding").json();
    assert_eq!(binding["branch"], "docent/diagrams-2026-08-20");
    assert_eq!(binding["baseBranch"], "main");
    assert_eq!(binding["hasToken"], true);
    assert_eq!(binding["canWrite"], true);
    assert_eq!(
        fixture.bindings()["drafts"],
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "docs/diagrams",
            "branch": "docent/diagrams-2026-08-20",
            "baseBranch": "main",
            "apiBase": fixture.github.url,
            "canWrite": true,
        })
    );
    assert_eq!(
        fixture.secrets()["drafts"],
        TOKEN,
        "the token is untouched by a branch switch"
    );

    // A branch cut here starts at the same head, so nothing was pulled and
    // every recorded base is still true: the copy reads clean on the new
    // branch, and the next push lands there.
    assert_eq!(fixture.state_of("drafts", "checkout"), "clean");
    assert_eq!(
        fixture.put_scene("drafts", "checkout", OTHER_SCENE).status,
        200
    );
    let pushed = fixture.push("drafts");
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    assert_eq!(
        fixture.github.branch_head("docent/diagrams-2026-08-20"),
        pushed.json()["commit"].as_str().map(str::to_string)
    );

    // The listing now says which branch is which.
    assert_eq!(
        get(fixture.port(), "/api/projects/drafts/branches").json(),
        serde_json::json!([
            { "name": "docent/diagrams-2026-08-20", "isBase": false, "isActive": true },
            { "name": "main", "isBase": true, "isActive": false },
        ])
    );
}

#[test]
fn switches_to_another_branch_by_binding_put_and_pulls_its_content_in() {
    let fixture = Fixture::new();
    fixture.bound_project("switcher");
    fixture
        .github
        .write("docs/diagrams/onmain.excalidraw", SCENE);
    fixture.pulled("switcher");

    // Another branch, holding a different set of scenes.
    fixture.github.set_branch("docent/existing", "sha-existing");
    fixture.github.remove("docs/diagrams/onmain.excalidraw");
    fixture
        .github
        .write("docs/diagrams/onbranch.excalidraw", OTHER_SCENE);

    // Exactly what the client sends: the binding it already has, on another
    // branch. No base, no token.
    let switched = put(
        fixture.port(),
        "/api/projects/switcher/binding",
        Some(
            &serde_json::json!({
                "owner": "acme",
                "repo": "diagrams",
                "path": "docs/diagrams",
                "branch": "docent/existing",
                "apiBase": fixture.github.url,
            })
            .to_string(),
        ),
    );
    assert_eq!(switched.status, 200, "{}", switched.body);
    assert_eq!(
        switched.json(),
        serde_json::json!({
            "ok": true,
            "canWrite": true,
            "baseBranch": "main",
            // One scene arrived and one went: the working copy is now that
            // branch's.
            "pulled": 2,
        })
    );
    let binding = get(fixture.port(), "/api/projects/switcher/binding").json();
    assert_eq!(binding["branch"], "docent/existing");
    assert_eq!(binding["baseBranch"], "main");
    assert_eq!(binding["hasToken"], true);
    assert_eq!(fixture.scene_names("switcher"), ["onbranch"]);
}

#[test]
fn refuses_to_switch_branches_while_the_working_copy_is_not_clean() {
    let fixture = Fixture::new();
    fixture.bound_project("dirty");
    fixture
        .github
        .write("docs/diagrams/checkout.excalidraw", SCENE);
    fixture.pulled("dirty");
    assert_eq!(
        fixture.put_scene("dirty", "checkout", OTHER_SCENE).status,
        200
    );
    assert_eq!(
        fixture.put_scene("dirty", "another", THIRD_SCENE).status,
        200
    );
    fixture
        .github
        .set_branch("docent/elsewhere", "sha-elsewhere");

    let res = put(
        fixture.port(),
        "/api/projects/dirty/binding",
        Some(
            &serde_json::json!({
                "owner": "acme",
                "repo": "diagrams",
                "path": "docs/diagrams",
                "branch": "docent/elsewhere",
                "apiBase": fixture.github.url,
            })
            .to_string(),
        ),
    );
    assert_eq!(res.status, 409);
    assert_eq!(
        res.error(),
        "push or resolve local changes before switching branches: another, checkout"
    );
    // The project did not half-move.
    let binding = get(fixture.port(), "/api/projects/dirty/binding").json();
    assert_eq!(binding["branch"], "main");
    assert_eq!(
        fixture.local_scene("dirty", "checkout").as_deref(),
        Some(OTHER_SCENE)
    );
}

#[test]
fn refuses_a_branch_that_already_exists() {
    let fixture = Fixture::new();
    fixture.bound_project("dupes");
    fixture.draft_on("dupes", "docent/taken");

    let again = post(
        fixture.port(),
        "/api/projects/dupes/branches",
        Some(r#"{"name":"docent/taken"}"#),
    );
    assert_eq!(again.status, 409);
    assert_eq!(
        again.error(),
        "branch docent/taken already exists on acme/diagrams"
    );
    // The project stays where it was rather than half-moving.
    let binding = get(fixture.port(), "/api/projects/dupes/binding").json();
    assert_eq!(binding["branch"], "docent/taken");
}

#[test]
fn refuses_branch_names_it_cannot_address() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let before = fixture.github.requests_to("/git/refs").len();

    let long = "x".repeat(201);
    for name in [
        serde_json::json!(""),
        serde_json::json!("-nope"),
        serde_json::json!("docent/a..b"),
        serde_json::json!("docent//b"),
        serde_json::json!("docent/trailing/"),
        serde_json::json!(long),
        serde_json::json!(42),
        serde_json::Value::Null,
    ] {
        let res = post(
            fixture.port(),
            "/api/projects/work/branches",
            Some(&serde_json::json!({ "name": name }).to_string()),
        );
        assert_eq!(res.status, 400, "{name}: {}", res.body);
        assert!(
            res.error().starts_with("invalid branch name"),
            "{}",
            res.body
        );
    }
    // A source branch is held to the gate every branch is held to.
    let bad_from = post(
        fixture.port(),
        "/api/projects/work/branches",
        Some(r#"{"name":"docent/ok","from":"a/../b"}"#),
    );
    assert_eq!(bad_from.status, 400);
    assert!(bad_from.error().starts_with("invalid branch"));
    assert_eq!(
        fixture.github.requests_to("/git/refs").len(),
        before,
        "nothing reached the repository"
    );
}

#[test]
fn names_a_source_branch_the_repository_does_not_have() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let res = post(
        fixture.port(),
        "/api/projects/work/branches",
        Some(r#"{"name":"docent/orphan","from":"nope"}"#),
    );
    assert_eq!(res.status, 404);
    assert_eq!(res.error(), "no branch named nope on acme/diagrams");
}

#[test]
fn opens_a_pull_request_from_the_active_branch_onto_the_base() {
    let fixture = Fixture::new();
    fixture.bound_project("review");
    fixture.draft_on("review", "docent/review-me");
    // The branch has moved since it was cut, so there is something to review.
    fixture.github.set_branch("docent/review-me", "sha-review");

    let res = post(
        fixture.port(),
        "/api/projects/review/pull-request",
        Some(r#"{"title":"Diagrams: the checkout flow"}"#),
    );
    assert_eq!(res.status, 201, "{}", res.body);
    assert_eq!(
        res.json(),
        serde_json::json!({
            "ok": true,
            "url": "https://github.com/acme/diagrams/pull/1",
            "number": 1,
        })
    );
    assert_eq!(
        fixture.github.body_of("/pulls", "POST"),
        serde_json::json!({
            "title": "Diagrams: the checkout flow",
            "head": "docent/review-me",
            "base": "main",
            "body": "",
        })
    );

    // Without a title it says what it is, which is all a diagram commit needs.
    fixture
        .github
        .set_branch("docent/review-me", "sha-review-2");
    assert_eq!(
        post(
            fixture.port(),
            "/api/projects/review/pull-request",
            Some("{}")
        )
        .status,
        201
    );
    assert_eq!(
        fixture.github.body_of("/pulls", "POST")["title"],
        "docent: update diagrams"
    );
}

#[test]
fn refuses_a_pull_request_from_the_base_branch_itself() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let before = fixture.github.requests_to("/pulls").len();

    let res = post(
        fixture.port(),
        "/api/projects/work/pull-request",
        Some("{}"),
    );
    assert_eq!(res.status, 400);
    assert_eq!(
        res.error(),
        "the active branch main is the base branch — create a branch first"
    );
    assert_eq!(
        fixture.github.requests_to("/pulls").len(),
        before,
        "nothing was asked of GitHub"
    );
}

#[test]
fn passes_githubs_refusal_through_when_there_is_nothing_to_merge() {
    let fixture = Fixture::new();
    fixture.bound_project("nodiff");
    fixture.draft_on("nodiff", "docent/untouched");

    let res = post(
        fixture.port(),
        "/api/projects/nodiff/pull-request",
        Some("{}"),
    );
    assert_eq!(res.status, 409);
    assert_eq!(
        res.error(),
        "GitHub: No commits between main and docent/untouched"
    );
}

#[test]
fn four_oh_fours_branch_routes_on_an_unbound_project() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let expected = "no GitHub binding for project: plain";

    let listed = get(fixture.port(), "/api/projects/plain/branches");
    assert_eq!(listed.status, 404);
    assert_eq!(listed.error(), expected);

    let created = post(
        fixture.port(),
        "/api/projects/plain/branches",
        Some(r#"{"name":"docent/nowhere"}"#),
    );
    assert_eq!(created.status, 404);
    assert_eq!(created.error(), expected);

    let pr = post(
        fixture.port(),
        "/api/projects/plain/pull-request",
        Some("{}"),
    );
    assert_eq!(pr.status, 404);
    assert_eq!(pr.error(), expected);
}

#[test]
fn records_the_repositorys_default_branch_as_the_base_at_bind_time() {
    let fixture = Fixture::new();
    fixture.github.set_default_branch("trunk");
    assert_eq!(
        put(fixture.port(), "/api/projects/trunky", None).status,
        201
    );
    let res = fixture.bind("trunky", serde_json::json!({ "branch": "docent/wip" }));
    assert_eq!(res.status, 200);
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "canWrite": true, "baseBranch": "trunk" })
    );
    let binding = get(fixture.port(), "/api/projects/trunky/binding").json();
    assert_eq!(binding["branch"], "docent/wip");
    assert_eq!(binding["baseBranch"], "trunk");
}

#[test]
fn binds_onto_the_repositorys_default_branch_when_no_branch_is_stated() {
    let fixture = Fixture::new();
    fixture.github.set_default_branch("trunk");
    assert_eq!(
        put(fixture.port(), "/api/projects/trunkless", None).status,
        201
    );
    let res = fixture.bind(
        "trunkless",
        serde_json::json!({ "path": "docs/trunkless", "branch": null }),
    );
    assert_eq!(res.status, 200, "{}", res.body);
    let binding = get(fixture.port(), "/api/projects/trunkless/binding").json();
    // The active branch is the repository's own default — never a guessed
    // name the repository may simply not have.
    assert_eq!(binding["branch"], "trunk");
    assert_eq!(binding["baseBranch"], "trunk");
}

#[test]
fn falls_back_to_the_bound_branch_when_the_default_cannot_be_read() {
    let fixture = Fixture::new();
    fixture.github.set_repo_missing(true);
    assert_eq!(
        put(fixture.port(), "/api/projects/nobase", None).status,
        201
    );
    let res = fixture.bind("nobase", serde_json::json!({ "branch": "release/1" }));
    fixture.github.set_repo_missing(false);
    assert_eq!(
        res.json(),
        serde_json::json!({
            "ok": true,
            "canWrite": serde_json::Value::Null,
            "baseBranch": "release/1",
            "warning": UNVERIFIED_MESSAGE,
        })
    );
    let binding = get(fixture.port(), "/api/projects/nobase/binding").json();
    assert_eq!(binding["baseBranch"], "release/1");
}

#[test]
fn a_binding_written_before_branch_aware_sync_is_its_own_base() {
    let fixture = Fixture::new();
    fixture.bound_project("older");
    // Rewrite the dotfile the way the store wrote it before D28 existed: no
    // baseBranch at all. Nothing migrates it, and nothing has to.
    let mut bindings = fixture.bindings();
    bindings["older"]
        .as_object_mut()
        .expect("a binding")
        .remove("baseBranch");
    fs::write(
        fixture.data_dir().join(".docent").join("bindings.json"),
        serde_json::to_string_pretty(&bindings).unwrap() + "\n",
    )
    .expect("rewrite the dotfile");

    let binding = get(fixture.port(), "/api/projects/older/binding").json();
    assert_eq!(binding["branch"], "main");
    assert_eq!(
        binding["baseBranch"], "main",
        "the branch it points at is its own base"
    );
    let listed = get(fixture.port(), "/api/projects/older/branches").json();
    assert!(listed
        .as_array()
        .expect("branches")
        .iter()
        .any(|entry| entry["isBase"] == true));

    // So nothing is a draft, no pull request is on offer, and the trunk gate
    // stands (D33).
    let pr = post(
        fixture.port(),
        "/api/projects/older/pull-request",
        Some("{}"),
    );
    assert_eq!(pr.status, 400);
    assert_eq!(
        pr.error(),
        "the active branch main is the base branch — create a branch first"
    );
    assert_eq!(fixture.put_scene("older", "sketch", SCENE).status, 200);
    assert_eq!(fixture.push("older").error(), BASE_BRANCH_MESSAGE);

    // …and the next binding PUT records a base without being asked to.
    assert_eq!(fixture.bind("older", serde_json::json!({})).status, 200);
    let binding = get(fixture.port(), "/api/projects/older/binding").json();
    assert_eq!(binding["baseBranch"], "main");
}

#[test]
fn refuses_branch_work_with_the_permission_that_is_missing() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture.github.set_read_only(true);
    let created = post(
        fixture.port(),
        "/api/projects/work/branches",
        Some(r#"{"name":"docent/read-only"}"#),
    );
    fixture.github.set_read_only(false);
    assert_eq!(created.status, 403);
    assert_eq!(created.error(), WRITE_MESSAGE);
    assert!(!fixture.github.has_branch("docent/read-only"));
}

#[test]
fn branch_writes_refuse_an_origin_that_is_not_the_app() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let before = fixture.github.requests_to("/git/refs").len();

    // A POST with a text/plain body is a "simple request": no preflight, so the
    // CORS answer alone would not stop a page in the user's browser from
    // firing one at this store's loopback port.
    for (path, body) in [
        ("/api/projects/work/branches", r#"{"name":"docent/sneaky"}"#),
        ("/api/projects/work/pull-request", "{}"),
    ] {
        let res = send(
            fixture.port(),
            "POST",
            path,
            Some(body),
            &[("Origin", "https://evil.example")],
        );
        assert_eq!(res.status, 403, "{path}");
        assert_eq!(res.error(), "forbidden");
    }
    assert_eq!(fixture.github.requests_to("/git/refs").len(), before);
    assert!(!fixture.github.has_branch("docent/sneaky"));
}
