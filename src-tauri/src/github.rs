//! Per-project GitHub sync (S14, D27) for the desktop store — the second
//! implementation of the binding half of the one store contract. Every rule
//! here is the same rule `server/docent-store.mjs` states: the same validation,
//! the same error strings, the same status codes, the same commit messages, the
//! same on-disk shape for `.docent/bindings.json`. When the two disagree, one
//! of them is the bug; `tests/store_github.rs` mirrors the Node suite so the
//! disagreement surfaces here rather than in someone's portfolio.
//!
//! Everything speaks GitHub's HTTP API — Contents and Git-Data — and nothing
//! shells out to `git` (D27). The one HTTP client is `ureq`, already carried
//! for the update check, so the desktop gains no dependency for this.
//!
//! Tokens never touch the data tree: the caller passes the path of a secrets
//! file that lives in the app's *config* directory, and it is written 0600
//! where the platform has such a thing. Nothing in this module ever puts a
//! token in a response, a log line, or a file under `<data>`.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::store::valid_name;

pub const DEFAULT_API_BASE: &str = "https://api.github.com";
pub const DEFAULT_BRANCH: &str = "main";

/// Every GitHub answer that means "your credential is the problem".
pub const TOKEN_ERROR: &str =
    "GitHub token missing or rejected for this project — set it in the binding";
/// The one message a losing write gets, on both stores, word for word.
pub const CONFLICT_ERROR: &str =
    "scene changed on GitHub since it was loaded — reload it to get the latest";

/// The other half of a 403: GitHub authenticated the token and refused the
/// write anyway. A fine-grained PAT defaults to Contents: Read, and an
/// organization can block writes by policy — either way the scenes list and
/// open, and only saving fails, so the credential message ("missing or
/// rejected") reads as nonsense. This one names what to change instead. It
/// answers writes only; a read that is refused keeps `TOKEN_ERROR`.
pub fn write_rejected(owner: &str, repo: &str) -> String {
    format!(
        "GitHub rejected the write — the token needs Contents: Read and write on {owner}/{repo} (organization repos may also require fine-grained token approval)"
    )
}

/// What the bind-time probe says when it could not find out (see `probe_access`).
fn unverified_access(owner: &str, repo: &str) -> String {
    format!("could not verify access to {owner}/{repo} — check the repo name and token")
}

const USER_AGENT: &str = "docent-store";
const TIMEOUT: Duration = Duration::from_secs(30);
/// Base64 inflates by a third and GitHub wraps it in JSON, so the ceiling on a
/// response is the store's own scene ceiling with room to spare.
const MAX_RESPONSE_BYTES: u64 = 80 * 1024 * 1024;
const EXT: &str = ".excalidraw";

const PATH_ERROR: &str =
    "invalid path — a repository directory prefix, no \"..\", no backslashes (max 512)";
pub const BRANCH_ERROR: &str =
    "invalid branch — letters, digits, ., _, - or / (max 255, no \"..\")";
pub const BRANCH_NAME_ERROR: &str = "invalid branch name — letters, digits, ., _, - or / (max 200, no \"..\", no \"//\", no leading or trailing \"/\")";

// ---------------------------------------------------------------------------
// the binding
// ---------------------------------------------------------------------------

/// What a bound project points at. Field order is the order the reference
/// store writes them in, so `bindings.json` is byte-comparable across the two
/// implementations. No secrets — that is the whole point of D27's exception.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Binding {
    pub owner: String,
    pub repo: String,
    pub path: String,
    pub branch: String,
    /// The branch a draft is measured against (D28). Absent on a binding
    /// written before branch-aware sync existed, and that binding keeps
    /// behaving exactly as it did: base and branch are then the same thing,
    /// nothing is a draft, and no pull request is offered. No migration step.
    #[serde(
        rename = "baseBranch",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub base_branch: Option<String>,
    #[serde(rename = "apiBase")]
    pub api_base: String,
    /// What the last bind-time probe learned about writing to this repository.
    /// Absent means nothing has been learned — a binding written before this
    /// existed, one stored without a token, or a probe that could not reach
    /// GitHub — and absent rather than `null` so the dotfile stays byte-equal
    /// to what the reference store writes for the same binding.
    #[serde(rename = "canWrite", default, skip_serializing_if = "Option::is_none")]
    pub can_write: Option<bool>,
}

/// A binding as the API states it — never with the token, in either direction.
/// `canWrite` is the probe's verdict, null whenever it is unknown; it is
/// metadata, not a secret.
#[derive(serde::Serialize)]
pub struct PublicBinding<'a> {
    owner: &'a str,
    repo: &'a str,
    path: &'a str,
    branch: &'a str,
    #[serde(rename = "baseBranch")]
    base_branch: &'a str,
    #[serde(rename = "apiBase")]
    api_base: &'a str,
    #[serde(rename = "hasToken")]
    has_token: bool,
    #[serde(rename = "canWrite")]
    can_write: Option<bool>,
}

impl Binding {
    pub fn public(&self, has_token: bool) -> PublicBinding<'_> {
        PublicBinding {
            owner: &self.owner,
            repo: &self.repo,
            path: &self.path,
            branch: &self.branch,
            base_branch: self.base(),
            api_base: &self.api_base,
            has_token,
            can_write: self.can_write,
        }
    }

    /// The branch a pull request would target: what was recorded, or — for a
    /// binding written before D28 — the branch itself.
    pub fn base(&self) -> &str {
        match &self.base_branch {
            Some(base) if !base.is_empty() => base,
            _ => &self.branch,
        }
    }
}

/// One branch as the store states it: GitHub's name, plus the two facts the
/// caller would otherwise have to work out from the binding.
#[derive(serde::Serialize)]
pub struct BranchInfo {
    name: String,
    #[serde(rename = "isBase")]
    is_base: bool,
    #[serde(rename = "isActive")]
    is_active: bool,
}

/// One scene as GitHub lists it. `sha` is the conflict token a later write
/// carries back; local scenes have no such field, which is why it is additive.
#[derive(Clone, serde::Serialize)]
pub struct RemoteScene {
    pub name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub size: u64,
    pub sha: String,
}

/// A refusal, as the status and message the store answers with.
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}

impl Failure {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
}

type Result<T> = std::result::Result<T, Failure>;

// ---------------------------------------------------------------------------
// validation — the same rules, spelled the same way, as the reference store
// ---------------------------------------------------------------------------

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, without a regex engine.
fn valid_owner(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 100 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// A repository directory prefix: "" is the root, and nothing may climb out.
fn normalize_repo_path(raw: &str) -> Result<String> {
    let cleaned = raw.trim_matches('/');
    if cleaned.len() > 512 {
        return Err(Failure::bad(PATH_ERROR));
    }
    // Backslashes and control characters, out — the rest of a repository path
    // (spaces, dots, unicode) is GitHub's business, not this store's.
    if cleaned.chars().any(|c| c == '\\' || c.is_control()) {
        return Err(Failure::bad(PATH_ERROR));
    }
    if !cleaned.is_empty()
        && cleaned
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(Failure::bad(PATH_ERROR));
    }
    Ok(cleaned.to_string())
}

/// A branch this store may address: an existing one, `^[A-Za-z0-9._/-]{1,255}$`
/// with no `..` and no leading or trailing `/`.
pub fn check_branch(branch: &str) -> Result<()> {
    let ok = !branch.is_empty()
        && branch.len() <= 255
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        && !branch.contains("..")
        && !branch.starts_with('/')
        && !branch.ends_with('/');
    if ok {
        Ok(())
    } else {
        Err(Failure::bad(BRANCH_ERROR))
    }
}

/// A branch this store may *create* (D28) — `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`
/// with no `..`, no `//` and no trailing `/`. Stricter than one it merely
/// addresses: it must start with a letter or a digit and stay short enough to
/// read in a select.
pub fn check_new_branch(name: &str) -> Result<()> {
    let bytes = name.as_bytes();
    let ok = !bytes.is_empty()
        && bytes.len() <= 200
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with('/');
    if ok {
        Ok(())
    } else {
        Err(Failure::bad(BRANCH_NAME_ERROR))
    }
}

/// `^https?://[^\s/?#]+(/[^\s?#]*)?$` — an origin, optionally with a path, and
/// nothing that could smuggle a query or a fragment into every request built
/// from it. GitHub Enterprise is `https://<host>/api/v3`.
fn check_api_base(api_base: &str) -> Result<()> {
    let invalid = || Failure::bad("invalid apiBase — must be an http(s) URL");
    if api_base.len() > 512 {
        return Err(invalid());
    }
    let rest = api_base
        .strip_prefix("https://")
        .or_else(|| api_base.strip_prefix("http://"))
        .ok_or_else(invalid)?;
    let (host, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let host_ok = !host.is_empty()
        && !host
            .chars()
            .any(|c| c.is_whitespace() || c == '?' || c == '#' || c == '/');
    let path_ok = !path
        .chars()
        .any(|c| c.is_whitespace() || c == '?' || c == '#');
    if host_ok && path_ok {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// What a JSON object holds at a key. A field that is present but not a string
/// is `Wrong` rather than absent, so it fails its own field's gate instead of
/// silently taking the default — the reference store draws the same line.
enum Field {
    Absent,
    Text(String),
    Wrong,
}

fn field(input: &serde_json::Value, key: &str) -> Field {
    match input.get(key) {
        None | Some(serde_json::Value::Null) => Field::Absent,
        Some(serde_json::Value::String(value)) => Field::Text(value.clone()),
        Some(_) => Field::Wrong,
    }
}

/// The field's text, its default when absent, or `None` when it is the wrong
/// type entirely.
fn text_or(input: &serde_json::Value, key: &str, default: &str) -> Option<String> {
    match field(input, key) {
        Field::Absent => Some(default.to_string()),
        Field::Text(value) if value.is_empty() => Some(default.to_string()),
        Field::Text(value) => Some(value),
        Field::Wrong => None,
    }
}

/// Validate what the client sent and fill in the two defaults. The token is
/// deliberately not part of the result: it goes to a different file.
pub fn normalize_binding(input: &serde_json::Value) -> Result<Binding> {
    if !input.is_object() {
        return Err(Failure::bad("body is not a binding"));
    }
    let owner_error = || {
        Failure::bad("invalid owner — use letters, digits, ., - or _ (max 100, no leading symbol)")
    };
    let repo_error = || {
        Failure::bad("invalid repo — use letters, digits, ., - or _ (max 100, no leading symbol)")
    };
    let owner = text_or(input, "owner", "").ok_or_else(owner_error)?;
    let repo = text_or(input, "repo", "").ok_or_else(repo_error)?;
    if !valid_owner(&owner) {
        return Err(owner_error());
    }
    if !valid_owner(&repo) {
        return Err(repo_error());
    }
    let path =
        normalize_repo_path(&text_or(input, "path", "").ok_or_else(|| Failure::bad(PATH_ERROR))?)?;
    let branch =
        text_or(input, "branch", DEFAULT_BRANCH).ok_or_else(|| Failure::bad(BRANCH_ERROR))?;
    check_branch(&branch)?;
    // Stating the base is allowed but never required: the caller resolves it
    // from the repository when the client leaves it out (D28).
    let stated_base = text_or(input, "baseBranch", "").ok_or_else(|| Failure::bad(BRANCH_ERROR))?;
    let base_branch = if stated_base.is_empty() {
        None
    } else {
        check_branch(&stated_base)?;
        Some(stated_base)
    };
    let api_base = text_or(input, "apiBase", DEFAULT_API_BASE)
        .ok_or_else(|| Failure::bad("invalid apiBase — must be an http(s) URL"))?
        .trim_end_matches('/')
        .to_string();
    check_api_base(&api_base)?;
    Ok(Binding {
        owner,
        repo,
        path,
        branch,
        base_branch,
        api_base,
        // Never taken from the request body: only a probe may set this.
        can_write: None,
    })
}

/// Optional on update: absent or empty means "keep whatever is stored".
pub fn normalize_token(input: &serde_json::Value) -> Result<Option<String>> {
    let token = match field(input, "token") {
        Field::Absent => return Ok(None),
        Field::Text(token) if token.is_empty() => return Ok(None),
        Field::Text(token) => token,
        Field::Wrong => return Err(Failure::bad(TOKEN_ERROR_TEXT)),
    };
    // Anything that could split a header or a line of the secrets file is out;
    // the token's own alphabet is GitHub's business.
    if token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Failure::bad(TOKEN_ERROR_TEXT));
    }
    Ok(Some(token))
}

const TOKEN_ERROR_TEXT: &str = "invalid token — no spaces or control characters (max 512)";

// ---------------------------------------------------------------------------
// the two files: metadata inside the data tree, secrets outside it
// ---------------------------------------------------------------------------

/// D27's one declared exception to D17.
pub fn bindings_file(data_dir: &Path) -> PathBuf {
    data_dir.join(".docent").join("bindings.json")
}

fn read_map<T: serde::de::DeserializeOwned>(file: &Path) -> BTreeMap<String, T> {
    // Missing, unreadable, or malformed all mean the same thing here: nothing
    // is bound yet. Being strict would lock a user out of their own portfolio.
    fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Sorted keys and a trailing newline: the file stays diffable (I3 habits).
/// `mode` is the unix permission bits the file must end up with — `None` for
/// the bindings file, `0o600` for the secrets one.
fn write_map<T: serde::Serialize>(
    file: &Path,
    map: &BTreeMap<String, T>,
    mode: Option<u32>,
) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut json = serde_json::to_string_pretty(map).map_err(io::Error::other)?;
    json.push('\n');
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    fs::rename(&tmp, file)
}

pub fn load_bindings(data_dir: &Path) -> BTreeMap<String, Binding> {
    read_map(&bindings_file(data_dir))
}

pub fn save_bindings(data_dir: &Path, bindings: &BTreeMap<String, Binding>) -> io::Result<()> {
    write_map(&bindings_file(data_dir), bindings, None)
}

pub fn load_secrets(secrets_file: &Path) -> BTreeMap<String, String> {
    read_map(secrets_file)
}

pub fn save_secrets(secrets_file: &Path, secrets: &BTreeMap<String, String>) -> io::Result<()> {
    write_map(secrets_file, secrets, Some(0o600))
}

pub fn token_for(secrets_file: &Path, project: &str) -> Option<String> {
    load_secrets(secrets_file)
        .remove(project)
        .filter(|token| !token.is_empty())
}

// ---------------------------------------------------------------------------
// per-process caches
// ---------------------------------------------------------------------------

struct CachedListing {
    etag: Option<String>,
    scenes: Vec<RemoteScene>,
}

/// Deliberately not persisted. `listings` is the If-None-Match cache for the
/// one listing call (loads always fetch fresh); `counts` is what lets
/// `GET /api/projects` name a bound project's scene count without blocking the
/// whole listing on the network — before anything has been listed a bound
/// project simply reports zero.
#[derive(Default)]
pub struct Cache {
    listings: Mutex<HashMap<String, CachedListing>>,
    counts: Mutex<HashMap<String, usize>>,
}

impl Cache {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the last listing of this project saw, or zero.
    pub fn count(&self, project: &str) -> usize {
        self.counts
            .lock()
            .map(|counts| counts.get(project).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn forget(&self, project: &str) {
        if let Ok(mut listings) = self.listings.lock() {
            listings.remove(project);
        }
    }

    /// Forget the count too — what binding and unbinding do.
    pub fn forget_all(&self, project: &str) {
        self.forget(project);
        if let Ok(mut counts) = self.counts.lock() {
            counts.remove(project);
        }
    }

    fn etag(&self, project: &str) -> Option<String> {
        self.listings
            .lock()
            .ok()?
            .get(project)
            .and_then(|cached| cached.etag.clone())
    }

    fn cached(&self, project: &str) -> Option<Vec<RemoteScene>> {
        self.listings
            .lock()
            .ok()?
            .get(project)
            .map(|cached| cached.scenes.clone())
    }

    fn store(&self, project: &str, etag: Option<String>, scenes: &[RemoteScene]) {
        if let Ok(mut listings) = self.listings.lock() {
            listings.insert(
                project.to_string(),
                CachedListing {
                    etag,
                    scenes: scenes.to_vec(),
                },
            );
        }
        self.set_count(project, scenes.len());
    }

    fn set_count(&self, project: &str, count: usize) {
        if let Ok(mut counts) = self.counts.lock() {
            counts.insert(project.to_string(), count);
        }
    }
}

// ---------------------------------------------------------------------------
// base64 — 40 lines rather than a dependency (I7 discipline)
// ---------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
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

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut bits = 0_u32;
    for byte in text.bytes() {
        // GitHub wraps its base64 at 60 characters, so whitespace is expected
        // rather than exceptional.
        if byte.is_ascii_whitespace() || byte == b'=' {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// the GitHub API client — HTTP only, no git binary (D27)
// ---------------------------------------------------------------------------

/// `encodeURIComponent`, so a scene name with a space addresses the same URL
/// from either store.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn repo_url(binding: &Binding, rest: &str) -> String {
    format!(
        "{}/repos/{}/{}{rest}",
        binding.api_base,
        encode_segment(&binding.owner),
        encode_segment(&binding.repo)
    )
}

fn contents_url(binding: &Binding, leaf: Option<&str>) -> String {
    let mut segments: Vec<String> = if binding.path.is_empty() {
        Vec::new()
    } else {
        binding.path.split('/').map(encode_segment).collect()
    };
    if let Some(leaf) = leaf {
        segments.push(encode_segment(leaf));
    }
    let suffix = if segments.is_empty() {
        String::new()
    } else {
        format!("/{}", segments.join("/"))
    };
    repo_url(binding, &format!("/contents{suffix}"))
}

struct Reply {
    status: u16,
    etag: Option<String>,
    text: String,
}

impl Reply {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

fn request(
    token: &str,
    method: &str,
    url: &str,
    body: Option<String>,
    if_none_match: Option<String>,
) -> Result<Reply> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Statuses are answers here, not errors: a 404 and a 409 both mean
        // something specific to the routes below.
        .http_status_as_error(false)
        .build()
        .into();
    let mut builder = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT);
    if body.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    if let Some(etag) = if_none_match {
        builder = builder.header("If-None-Match", etag);
    }
    let sent = match body {
        Some(body) => builder.body(body).map_err(bad_request).and_then(|request| {
            agent
                .run(request)
                .map_err(|err| Failure::new(502, format!("GitHub request failed — {err}")))
        }),
        None => builder.body(()).map_err(bad_request).and_then(|request| {
            agent
                .run(request)
                .map_err(|err| Failure::new(502, format!("GitHub request failed — {err}")))
        }),
    };
    let mut response = sent?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .unwrap_or_default();
    Ok(Reply { status, etag, text })
}

fn bad_request(err: ureq::http::Error) -> Failure {
    Failure::new(502, format!("GitHub request failed — {err}"))
}

/// Whatever GitHub said, in one line, without ever guessing a status.
fn failure(status: u16, text: &str) -> Failure {
    if status == 401 || status == 403 {
        return Failure::new(401, TOKEN_ERROR);
    }
    let detail = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(|message| message.as_str())
                .filter(|message| !message.is_empty())
                .map(|message| format!(": {message}"))
        })
        .unwrap_or_default();
    Failure::new(502, format!("GitHub API error ({status}){detail}"))
}

/// The same, for a PUT or a DELETE. GitHub's 403 on a write means "I know who
/// you are and you may not do that" — which is a different fix from a bad
/// token, and the only place a user can act on the difference. A 401 still maps
/// to `TOKEN_ERROR` here, because a credential GitHub refuses outright is
/// refused for reads too and the read message already says so.
fn write_failure(binding: &Binding, status: u16, text: &str) -> Failure {
    if status == 403 && !is_too_large(status, text) {
        return Failure::new(403, write_rejected(&binding.owner, &binding.repo));
    }
    failure(status, text)
}

/// What a bind-time probe learned: the write bit, and why it is unknown when
/// it is. `can_write: None` with no warning is "GitHub answered, but said
/// nothing about permissions"; with one, "GitHub could not be asked".
pub struct Probe {
    pub can_write: Option<bool>,
    /// The repository's own default branch, which is what a pull request
    /// should target (D28) — learned from the call the probe was already
    /// making rather than a second one.
    pub default_branch: Option<String>,
    pub warning: Option<String>,
}

impl Probe {
    /// No token, so nothing was asked and nothing is known.
    pub fn unknown() -> Self {
        Self {
            can_write: None,
            default_branch: None,
            warning: None,
        }
    }
}

/// Ask GitHub what this token may do with the repository, once, at bind time.
/// `GET /repos/{owner}/{repo}` answers an authenticated caller with a
/// `permissions` object — `{ admin, maintain, push, triage, pull }` — and
/// `push` is the bit that decides whether a save can ever work. Naming a
/// read-only token here is the whole point: otherwise the user learns it from
/// a failed save, long after the form is closed.
///
/// It never fails. A binding is worth storing even when the probe cannot reach
/// GitHub, so every unhappy answer is "unknown" plus a warning rather than a
/// refusal to bind.
pub fn probe_access(binding: &Binding, token: &str) -> Probe {
    let unverified = || Probe {
        can_write: None,
        default_branch: None,
        warning: Some(unverified_access(&binding.owner, &binding.repo)),
    };
    // Unreachable, refused, timed out: the repository may be perfectly fine
    // and this machine briefly not.
    let Ok(reply) = request(token, "GET", &repo_url(binding, ""), None, None) else {
        return unverified();
    };
    if reply.status != 200 {
        return unverified();
    }
    let body = serde_json::from_str::<serde_json::Value>(&reply.text).ok();
    // An answer without a permissions object (an unauthenticated read, some
    // Enterprise versions) says nothing either way — and guessing "writable"
    // there is exactly the lie this probe exists to stop.
    let can_write = body.as_ref().and_then(|body| {
        body.get("permissions")
            .and_then(|permissions| permissions.get("push"))
            .and_then(|push| push.as_bool())
    });
    // A default branch is only worth recording if this store could address it;
    // an Enterprise answer with something odd in it falls back like an absent
    // one.
    let default_branch = body
        .as_ref()
        .and_then(|body| body.get("default_branch"))
        .and_then(|branch| branch.as_str())
        .filter(|branch| check_branch(branch).is_ok())
        .map(str::to_string);
    Probe {
        can_write,
        default_branch,
        warning: None,
    }
}

fn parse_json(text: &str) -> Result<serde_json::Value> {
    serde_json::from_str(text)
        .map_err(|_| Failure::new(502, "GitHub API error (unparseable response)"))
}

/// Contents-API responses for files over 1 MB carry no content: older GitHub
/// refuses with a 403 naming the size, newer sets `encoding: "none"`. Either
/// way the blob API has the bytes, so both are a fallback rather than an error
/// — and the 403 is checked before the credential mapping, so a scene that is
/// merely large is never reported as a rejected token.
fn is_too_large(status: u16, text: &str) -> bool {
    status == 403 && text.to_lowercase().contains("too large")
}

pub fn list(
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
) -> Result<Vec<RemoteScene>> {
    let url = format!(
        "{}?ref={}",
        contents_url(binding, None),
        encode_segment(&binding.branch)
    );
    let reply = request(token, "GET", &url, None, cache.etag(project))?;
    if reply.status == 304 {
        if let Some(scenes) = cache.cached(project) {
            cache.set_count(project, scenes.len());
            return Ok(scenes);
        }
    }
    // A bound path that does not exist yet is the normal state right after
    // binding — the first save creates it. Listing it as empty is honest; a
    // wrong owner/repo shows the same, and then fails loudly on the first write.
    if reply.status == 404 {
        cache.set_count(project, 0);
        return Ok(Vec::new());
    }
    if !reply.is_success() {
        return Err(failure(reply.status, &reply.text));
    }
    let entries = parse_json(&reply.text)?;
    let entries = entries
        .as_array()
        .ok_or_else(|| Failure::new(502, "the bound path is a file, not a directory"))?;
    let mut scenes: Vec<RemoteScene> = entries
        .iter()
        .filter_map(|entry| {
            if entry.get("type").and_then(|t| t.as_str()) != Some("file") {
                return None;
            }
            let file_name = entry.get("name")?.as_str()?;
            let name = file_name.strip_suffix(EXT)?;
            // Only names this store can address round-trip: anything else in
            // the directory belongs to the repository, not to the portfolio.
            if !valid_name(name) {
                return None;
            }
            Some(RemoteScene {
                name: name.to_string(),
                updated_at: None,
                size: entry.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                sha: entry
                    .get("sha")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect();
    crate::store::sort_by(&mut scenes, |scene| &scene.name);

    // One extra request for the whole listing rather than one per scene: the
    // branch's last commit touching the bound path stamps every scene. Coarse
    // but honest — and it is exactly what the thumbnail cache keys on, so any
    // change to any scene re-renders them.
    if !scenes.is_empty() {
        let stamp = last_commit_date(binding, token);
        for scene in &mut scenes {
            scene.updated_at = stamp.clone();
        }
    }
    cache.store(project, reply.etag, &scenes);
    Ok(scenes)
}

fn last_commit_date(binding: &Binding, token: &str) -> Option<String> {
    let mut query = format!("per_page=1&sha={}", encode_segment(&binding.branch));
    if !binding.path.is_empty() {
        query = format!("path={}&{query}", encode_segment(&binding.path));
    }
    let reply = request(
        token,
        "GET",
        &repo_url(binding, &format!("/commits?{query}")),
        None,
        None,
    )
    .ok()?;
    if !reply.is_success() {
        return None;
    }
    // A listing is still a listing without timestamps.
    let commits: serde_json::Value = serde_json::from_str(&reply.text).ok()?;
    let commit = commits.get(0)?.get("commit")?;
    commit
        .get("committer")
        .and_then(|c| c.get("date"))
        .or_else(|| commit.get("author").and_then(|a| a.get("date")))
        .and_then(|date| date.as_str())
        .map(str::to_string)
}

/// The file's metadata, or `None` when GitHub says it isn't there.
fn file_meta(binding: &Binding, token: &str, scene: &str) -> Result<Option<serde_json::Value>> {
    let url = format!(
        "{}?ref={}",
        contents_url(binding, Some(&format!("{scene}{EXT}"))),
        encode_segment(&binding.branch)
    );
    let reply = request(token, "GET", &url, None, None)?;
    if reply.status == 404 {
        return Ok(None);
    }
    // Oversize: the metadata is unreachable this way, but the file exists.
    if is_too_large(reply.status, &reply.text) {
        return Ok(Some(serde_json::Value::Null));
    }
    if !reply.is_success() {
        return Err(failure(reply.status, &reply.text));
    }
    Ok(Some(parse_json(&reply.text)?))
}

fn sha_of(meta: &serde_json::Value) -> Option<String> {
    meta.get("sha")
        .and_then(|sha| sha.as_str())
        .filter(|sha| !sha.is_empty())
        .map(str::to_string)
}

/// The blob sha the file currently has on the branch, or `None` when there is
/// no such file. A file past the contents API's size limit answers without one,
/// so the listing — which always carries shas — is the fallback.
fn current_sha(
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
    scene: &str,
) -> Result<Option<String>> {
    let Some(meta) = file_meta(binding, token, scene)? else {
        return Ok(None);
    };
    if let Some(sha) = sha_of(&meta) {
        return Ok(Some(sha));
    }
    Ok(list(project, binding, token, cache)?
        .into_iter()
        .find(|entry| entry.name == scene)
        .map(|entry| entry.sha))
}

/// The scene's text and the sha that guards the next write of it.
pub fn load(
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
    scene: &str,
) -> Result<(String, String)> {
    let missing = || Failure::new(404, format!("no such scene: {project}/{scene}"));
    let meta = file_meta(binding, token, scene)?.ok_or_else(missing)?;
    let inline = meta
        .get("encoding")
        .and_then(|encoding| encoding.as_str())
        .filter(|encoding| *encoding == "base64")
        .and_then(|_| meta.get("content"))
        .and_then(|content| content.as_str())
        .filter(|content| !content.trim().is_empty());
    if let Some(content) = inline {
        let bytes = base64_decode(content)
            .ok_or_else(|| Failure::new(502, "GitHub API error (undecodable content)"))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| Failure::new(502, "GitHub API error (scene is not UTF-8)"))?;
        return Ok((text, sha_of(&meta).unwrap_or_default()));
    }
    // Oversize, or content withheld: read the blob itself, addressed by the sha
    // the listing knows.
    let sha = match sha_of(&meta) {
        Some(sha) => sha,
        None => current_sha(project, binding, token, cache, scene)?.ok_or_else(missing)?,
    };
    let reply = request(
        token,
        "GET",
        &repo_url(binding, &format!("/git/blobs/{}", encode_segment(&sha))),
        None,
        None,
    )?;
    if !reply.is_success() {
        return Err(failure(reply.status, &reply.text));
    }
    let blob = parse_json(&reply.text)?;
    let content = blob
        .get("content")
        .and_then(|content| content.as_str())
        .ok_or_else(|| Failure::new(502, "GitHub API error (blob carried no content)"))?;
    let bytes = base64_decode(content)
        .ok_or_else(|| Failure::new(502, "GitHub API error (undecodable content)"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| Failure::new(502, "GitHub API error (scene is not UTF-8)"))?;
    Ok((text, sha))
}

/// Commit the scene. `header_sha` is the conflict token the client kept from
/// its load; without one this is the last-write-wins path.
pub fn save(
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
    scene: &str,
    body: &str,
    header_sha: Option<&str>,
) -> Result<Option<String>> {
    let sha = match header_sha {
        Some(sha) if !sha.is_empty() => Some(sha.to_string()),
        // No conflict token: the current sha is fetched purely to satisfy
        // GitHub's own update requirement.
        _ => current_sha(project, binding, token, cache, scene)?,
    };
    let verb = if sha.is_some() { "update" } else { "create" };
    let mut payload = serde_json::json!({
        "message": format!("docent: {verb} {project}/{scene}"),
        "content": base64_encode(body.as_bytes()),
        "branch": binding.branch,
    });
    if let Some(sha) = &sha {
        payload["sha"] = serde_json::Value::String(sha.clone());
    }
    let reply = request(
        token,
        "PUT",
        &contents_url(binding, Some(&format!("{scene}{EXT}"))),
        Some(payload.to_string()),
        None,
    )?;
    // 409 is GitHub's own conflict; 422 is what it answers when the sha is
    // stale or names a file that is no longer there. Both mean the same thing
    // to a user: someone else moved first.
    if reply.status == 409 || reply.status == 422 {
        return Err(Failure::new(409, CONFLICT_ERROR));
    }
    if !reply.is_success() {
        return Err(write_failure(binding, reply.status, &reply.text));
    }
    cache.forget(project);
    let created = parse_json(&reply.text)?;
    Ok(created.get("content").and_then(sha_of))
}

pub fn delete(
    project: &str,
    binding: &Binding,
    token: &str,
    cache: &Cache,
    scene: &str,
) -> Result<()> {
    let sha = current_sha(project, binding, token, cache, scene)?
        .ok_or_else(|| Failure::new(404, format!("no such scene: {project}/{scene}")))?;
    let payload = serde_json::json!({
        "message": format!("docent: delete {project}/{scene}"),
        "sha": sha,
        "branch": binding.branch,
    });
    let reply = request(
        token,
        "DELETE",
        &contents_url(binding, Some(&format!("{scene}{EXT}"))),
        Some(payload.to_string()),
        None,
    )?;
    if reply.status == 409 || reply.status == 422 {
        return Err(Failure::new(409, CONFLICT_ERROR));
    }
    if !reply.is_success() {
        return Err(write_failure(binding, reply.status, &reply.text));
    }
    cache.forget(project);
    Ok(())
}

// ---------------------------------------------------------------------------
// branches and pull requests (D28) — the repository's own review flow
// ---------------------------------------------------------------------------

/// The repository's branches. One page of 100 is the v1 cap: GitHub paginates
/// this endpoint, and a store that fetched every page would spend a user's
/// rate limit walking release history to fill a select. A repository with more
/// branches than that shows the first hundred GitHub names.
pub fn list_branches(binding: &Binding, token: &str) -> Result<Vec<BranchInfo>> {
    let reply = request(
        token,
        "GET",
        &repo_url(binding, "/branches?per_page=100"),
        None,
        None,
    )?;
    if !reply.is_success() {
        return Err(failure(reply.status, &reply.text));
    }
    let entries = parse_json(&reply.text)?;
    let entries = entries
        .as_array()
        .ok_or_else(|| Failure::new(502, "GitHub API error (branches are not a list)"))?;
    let base = binding.base();
    // GitHub's own order, kept: it is the repository's alphabetical listing,
    // and re-sorting it here would only be a second opinion about the same data.
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let name = entry
                .get("name")
                .and_then(|name| name.as_str())
                .filter(|name| !name.is_empty())?;
            Some(BranchInfo {
                name: name.to_string(),
                is_base: name == base,
                is_active: name == binding.branch,
            })
        })
        .collect())
}

/// Create `name` off `from`, and answer nothing — the caller switches the
/// binding to it, because only the caller owns the dotfile.
pub fn create_branch(binding: &Binding, token: &str, name: &str, from: &str) -> Result<()> {
    let heads = from
        .split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    let reply = request(
        token,
        "GET",
        &repo_url(binding, &format!("/git/ref/heads/{heads}")),
        None,
        None,
    )?;
    if reply.status == 404 {
        return Err(Failure::new(
            404,
            format!(
                "no branch named {from} on {}/{}",
                binding.owner, binding.repo
            ),
        ));
    }
    if !reply.is_success() {
        return Err(failure(reply.status, &reply.text));
    }
    let sha = parse_json(&reply.text)?
        .get("object")
        .and_then(|object| object.get("sha"))
        .and_then(|sha| sha.as_str())
        .filter(|sha| !sha.is_empty())
        .ok_or_else(|| Failure::new(502, "GitHub API error (ref carried no sha)"))?
        .to_string();
    let payload = serde_json::json!({ "ref": format!("refs/heads/{name}"), "sha": sha });
    let created = request(
        token,
        "POST",
        &repo_url(binding, "/git/refs"),
        Some(payload.to_string()),
        None,
    )?;
    // GitHub answers a duplicate ref with a 422. That is not a lost race like
    // a stale scene sha — it is a name already taken, and saying so is the fix.
    if created.status == 422 && created.text.to_lowercase().contains("already exists") {
        return Err(Failure::new(
            409,
            format!(
                "branch {name} already exists on {}/{}",
                binding.owner, binding.repo
            ),
        ));
    }
    if !created.is_success() {
        return Err(write_failure(binding, created.status, &created.text));
    }
    Ok(())
}

/// GitHub's own sentence about a refusal. The Validation-Failed envelope's
/// top-level message says nothing ("Validation Failed"); the useful line — "No
/// commits between main and x", "A pull request already exists for acme:x" —
/// is the first entry of `errors`.
fn github_message(text: &str) -> String {
    let Ok(body) = serde_json::from_str::<serde_json::Value>(text) else {
        return String::new();
    };
    let detailed = body
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|errors| {
            errors
                .iter()
                .filter_map(|entry| entry.get("message").and_then(|m| m.as_str()))
                .find(|message| !message.is_empty())
        });
    detailed
        .or_else(|| body.get("message").and_then(|message| message.as_str()))
        .unwrap_or_default()
        .to_string()
}

/// Open a pull request from the active branch onto the recorded base, and
/// answer with what a user needs to go and look at it.
pub fn open_pull_request(
    binding: &Binding,
    token: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<(String, i64)> {
    let base = binding.base();
    if binding.branch == base {
        // Nothing to review: the drafts and the base are the same branch,
        // which is exactly the state a binding starts in.
        return Err(Failure::bad(format!(
            "the active branch {} is the base branch — create a branch first",
            binding.branch
        )));
    }
    // A blank title is no title: the default says what the branch holds, and
    // the reference store draws the same line.
    let title = match title {
        Some(stated) if !stated.trim().is_empty() => stated,
        _ => "docent: update diagrams",
    };
    let payload = serde_json::json!({
        "title": title,
        "head": binding.branch,
        "base": base,
        "body": body.unwrap_or_default(),
    });
    let reply = request(
        token,
        "POST",
        &repo_url(binding, "/pulls"),
        Some(payload.to_string()),
        None,
    )?;
    // No commits between the two branches, or a pull request already open for
    // them: GitHub knows which, and its sentence is the one worth relaying.
    if reply.status == 422 {
        let message = github_message(&reply.text);
        let message = if message.is_empty() {
            "the pull request was refused".to_string()
        } else {
            message
        };
        return Err(Failure::new(409, format!("GitHub: {message}")));
    }
    if !reply.is_success() {
        return Err(write_failure(binding, reply.status, &reply.text));
    }
    let created = parse_json(&reply.text)?;
    let url = created
        .get("html_url")
        .and_then(|url| url.as_str())
        .unwrap_or_default()
        .to_string();
    let number = created
        .get("number")
        .and_then(|number| number.as_i64())
        .unwrap_or_default();
    Ok((url, number))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(path: &str) -> Binding {
        Binding {
            owner: "acme".into(),
            repo: "diagrams".into(),
            path: path.into(),
            branch: "main".into(),
            base_branch: None,
            api_base: "https://api.github.com".into(),
            can_write: None,
        }
    }

    #[test]
    fn base64_round_trips_including_the_awkward_lengths() {
        for text in [
            "",
            "a",
            "ab",
            "abc",
            "abcd",
            "{\"type\":\"excalidraw\"}",
            "é☃",
        ] {
            let encoded = base64_encode(text.as_bytes());
            assert_eq!(
                base64_decode(&encoded).as_deref(),
                Some(text.as_bytes()),
                "{text:?}"
            );
        }
        // The exact strings GitHub would send, padding and all.
        assert_eq!(
            base64_encode(b"any carnal pleasure."),
            "YW55IGNhcm5hbCBwbGVhc3VyZS4="
        );
        assert_eq!(
            base64_encode(b"any carnal pleasure"),
            "YW55IGNhcm5hbCBwbGVhc3VyZQ=="
        );
        // GitHub wraps its base64; the newlines must not become bytes.
        assert_eq!(
            base64_decode("YW55IGNh\ncm5hbCBwbGVhc3VyZS4=\n").as_deref(),
            Some(&b"any carnal pleasure."[..])
        );
        assert_eq!(base64_decode("not base64!"), None);
    }

    #[test]
    fn urls_address_the_same_paths_the_reference_store_builds() {
        assert_eq!(
            contents_url(&binding("docs/diagrams"), Some("check out.excalidraw")),
            "https://api.github.com/repos/acme/diagrams/contents/docs/diagrams/check%20out.excalidraw"
        );
        // A root binding has no path segment at all.
        assert_eq!(
            contents_url(&binding(""), None),
            "https://api.github.com/repos/acme/diagrams/contents"
        );
        assert_eq!(
            repo_url(&binding(""), "/git/blobs/abc"),
            "https://api.github.com/repos/acme/diagrams/git/blobs/abc"
        );
    }

    #[test]
    fn bindings_validate_the_way_the_reference_store_validates() {
        let ok = normalize_binding(&serde_json::json!({ "owner": "acme", "repo": "diagrams" }))
            .expect("minimal binding");
        assert_eq!(ok.path, "");
        assert_eq!(ok.branch, DEFAULT_BRANCH);
        assert_eq!(ok.api_base, DEFAULT_API_BASE);

        let trimmed = normalize_binding(&serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "/docs/diagrams/",
            "apiBase": "https://ghe.example.com/api/v3/",
        }))
        .expect("normalized binding");
        assert_eq!(trimmed.path, "docs/diagrams");
        assert_eq!(trimmed.api_base, "https://ghe.example.com/api/v3");

        for (input, expected) in [
            (
                serde_json::json!({ "owner": "-bad", "repo": "r" }),
                "invalid owner",
            ),
            (
                serde_json::json!({ "owner": "acme", "repo": "" }),
                "invalid repo",
            ),
            (
                serde_json::json!({ "owner": "acme", "repo": "r", "path": "../etc" }),
                "invalid path",
            ),
            (
                serde_json::json!({ "owner": "acme", "repo": "r", "branch": "no spaces" }),
                "invalid branch",
            ),
            (
                serde_json::json!({ "owner": "acme", "repo": "r", "apiBase": "ftp://x" }),
                "invalid apiBase",
            ),
        ] {
            let err = normalize_binding(&input).expect_err("refused");
            assert_eq!(err.status, 400);
            assert!(err.message.starts_with(expected), "{}", err.message);
        }
    }

    #[test]
    fn a_new_branch_is_held_to_a_stricter_gate_than_an_existing_one() {
        for name in [
            "docent/diagrams-2026-08-20",
            "wip",
            "a",
            "v1.2_x",
            &"a".repeat(200),
        ] {
            assert!(check_new_branch(name).is_ok(), "{name} should pass");
        }
        for name in [
            "",
            "-nope",
            ".hidden",
            "/leading",
            "trailing/",
            "docent//b",
            "docent/a..b",
            "has space",
            &"a".repeat(201),
        ] {
            assert!(check_new_branch(name).is_err(), "{name} should fail");
            // …while an existing branch may still start with a dot or an
            // underscore, because GitHub allows it and this store only
            // addresses it.
        }
        assert!(check_branch(".hidden").is_ok());
        assert!(check_branch("has space").is_err());

        // A binding written before D28 is its own base; one with a base keeps it.
        let mut binding = binding("");
        assert_eq!(binding.base(), "main");
        binding.branch = "docent/wip".into();
        assert_eq!(binding.base(), "docent/wip");
        binding.base_branch = Some("trunk".into());
        assert_eq!(binding.base(), "trunk");
    }

    #[test]
    fn a_token_is_optional_but_never_sloppy() {
        assert_eq!(normalize_token(&serde_json::json!({})).unwrap(), None);
        assert_eq!(
            normalize_token(&serde_json::json!({ "token": "" })).unwrap(),
            None
        );
        assert_eq!(
            normalize_token(&serde_json::json!({ "token": "ghp_abc" })).unwrap(),
            Some("ghp_abc".to_string())
        );
        assert!(normalize_token(&serde_json::json!({ "token": "has space" })).is_err());
        assert!(normalize_token(&serde_json::json!({ "token": 42 })).is_err());
    }

    #[test]
    fn credential_answers_are_mapped_before_anything_else() {
        assert_eq!(failure(401, "{}").status, 401);
        assert_eq!(failure(403, "{}").message, TOKEN_ERROR);
        // …but a merely large file is not a credential problem.
        assert!(is_too_large(
            403,
            "{\"message\":\"This API returns blobs up to 1 MB in size. The requested blob is too large\"}"
        ));
        assert!(!is_too_large(403, "{\"message\":\"Bad credentials\"}"));

        let other = failure(500, "{\"message\":\"boom\"}");
        assert_eq!(other.status, 502);
        assert_eq!(other.message, "GitHub API error (500): boom");
        assert_eq!(failure(500, "not json").message, "GitHub API error (500)");
    }

    #[test]
    fn a_refused_write_is_a_permission_problem_not_a_credential_one() {
        let binding = binding("docs/diagrams");
        let refused = write_failure(
            &binding,
            403,
            "{\"message\":\"Resource not accessible by personal access token\"}",
        );
        assert_eq!(refused.status, 403);
        assert_eq!(
            refused.message,
            "GitHub rejected the write — the token needs Contents: Read and write on acme/diagrams (organization repos may also require fine-grained token approval)"
        );
        // A credential GitHub refuses outright is refused for reads too, and
        // that message already says what to do.
        let rejected = write_failure(&binding, 401, "{\"message\":\"Bad credentials\"}");
        assert_eq!(rejected.status, 401);
        assert_eq!(rejected.message, TOKEN_ERROR);
        // …and a 403 that names a size is not a permission problem either, so
        // it keeps whatever mapping it had rather than gaining a new claim.
        let oversize = write_failure(&binding, 403, "{\"message\":\"blob is too large\"}");
        assert_eq!(oversize.message, TOKEN_ERROR);
    }
}
