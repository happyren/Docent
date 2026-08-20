//! Per-project GitHub sync on the desktop store (S14, D27) — the mirror of
//! `tests/store-github.test.ts`. Same scenarios, same assertions, same expected
//! strings, so a divergence between the two store implementations fails here
//! instead of in someone's portfolio.
//!
//! GitHub is a `tiny_http` server in this file, the way the update check's
//! tests stand in for the releases API. It answers only the six calls the store
//! makes, but it answers them the way GitHub does: base64 contents, SHA-checked
//! writes, 409 on a stale SHA, ETag revalidation on the listing, and no content
//! inline for a file past the size ceiling. `apiBase` is part of the binding,
//! so pointing the store at it needs no environment variable — it is the same
//! mechanism that makes GitHub Enterprise work.
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

const SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
const OTHER_SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[{"id":"a"}]}"#;
const WEBVIEW_ORIGIN: &str = "tauri://localhost";
const TOKEN: &str = "github_pat_11ABCDEF0_docenttest";
const COMMIT_DATE: &str = "2026-08-20T12:00:00Z";
/// Anything larger answers like GitHub does past 1 MB: no inline content.
const INLINE_LIMIT: usize = 256;

const CONFLICT_MESSAGE: &str =
    "scene changed on GitHub since it was loaded — reload it to get the latest";
const TOKEN_MESSAGE: &str =
    "GitHub token missing or rejected for this project — set it in the binding";

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

#[derive(Default)]
struct Repository {
    files: BTreeMap<String, String>,
    seen: Vec<Seen>,
    /// Bumped by every write, so the listing's ETag changes when it should.
    version: u64,
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

    fn put_file(&self, path: &str, content: &str) {
        self.repo
            .lock()
            .expect("repository")
            .files
            .insert(path.to_string(), content.to_string());
    }

    fn file(&self, path: &str) -> Option<String> {
        self.repo
            .lock()
            .expect("repository")
            .files
            .get(path)
            .cloned()
    }

    fn file_count(&self) -> usize {
        self.repo.lock().expect("repository").files.len()
    }

    fn seen(&self) -> Vec<Seen> {
        self.repo.lock().expect("repository").seen.clone()
    }

    fn requests_to(&self, fragment: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|entry| entry.url.contains(fragment))
            .collect()
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
    let not_found = || {
        (
            404,
            Payload::json(serde_json::json!({ "message": "Not Found" })),
        )
    };
    if segments.first().map(String::as_str) != Some("repos")
        || segments.get(1).map(String::as_str) != Some("acme")
        || segments.get(2).map(String::as_str) != Some("diagrams")
    {
        return not_found();
    }
    let rest: Vec<&str> = segments[3..].iter().map(String::as_str).collect();

    match rest.first() {
        Some(&"commits") if method == "GET" => (
            200,
            Payload::json(serde_json::json!([
                { "sha": "c0ffee", "commit": { "committer": { "date": COMMIT_DATE } } }
            ])),
        ),
        Some(&"git") if rest.get(1) == Some(&"blobs") && method == "GET" => {
            let wanted = rest.get(2).copied().unwrap_or_default();
            match repo
                .files
                .values()
                .find(|content| blob_sha(content) == wanted)
            {
                Some(content) => (
                    200,
                    Payload::json(serde_json::json!({
                        "sha": wanted,
                        "encoding": "base64",
                        "content": base64_encode(content.as_bytes()),
                    })),
                ),
                None => not_found(),
            }
        }
        Some(&"contents") => {
            let repo_path = rest[1..].join("/");
            match method.as_str() {
                "GET" => get_contents(&repo, &repo_path, if_none_match.as_deref()),
                "PUT" => put_contents(&mut repo, &repo_path, body),
                "DELETE" => delete_contents(&mut repo, &repo_path, body),
                _ => not_found(),
            }
        }
        _ => not_found(),
    }
}

fn get_contents(repo: &Repository, repo_path: &str, if_none_match: Option<&str>) -> (u16, Payload) {
    if let Some(content) = repo.files.get(repo_path) {
        // Past the ceiling GitHub answers with the metadata and no content; the
        // bytes are only reachable through the blob API.
        if content.len() > INLINE_LIMIT {
            let mut entry = entry_json(repo_path, content);
            entry["encoding"] = serde_json::Value::String("none".into());
            entry["content"] = serde_json::Value::String(String::new());
            return (200, Payload::json(entry));
        }
        let mut entry = entry_json(repo_path, content);
        entry["encoding"] = serde_json::Value::String("base64".into());
        entry["content"] =
            serde_json::Value::String(format!("{}\n", base64_encode(content.as_bytes())));
        return (200, Payload::json(entry));
    }
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
        return (
            404,
            Payload::json(serde_json::json!({ "message": "Not Found" })),
        );
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

fn put_contents(repo: &mut Repository, repo_path: &str, body: &str) -> (u16, Payload) {
    let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
    let sha = payload.get("sha").and_then(|sha| sha.as_str());
    let existing = repo.files.get(repo_path).cloned();
    match (&existing, sha) {
        (Some(current), Some(sha)) if sha != blob_sha(current) => {
            return (
                409,
                Payload::json(serde_json::json!({ "message": "does not match" })),
            );
        }
        (Some(_), None) => {
            return (
                409,
                Payload::json(serde_json::json!({ "message": "does not match" })),
            );
        }
        (None, Some(_)) => {
            return (
                422,
                Payload::json(serde_json::json!({ "message": "sha does not match" })),
            );
        }
        _ => {}
    }
    let content = String::from_utf8(base64_decode(
        payload
            .get("content")
            .and_then(|content| content.as_str())
            .unwrap_or_default(),
    ))
    .expect("the store sends UTF-8");
    repo.files.insert(repo_path.to_string(), content.clone());
    repo.version += 1;
    let status = if existing.is_some() { 200 } else { 201 };
    (
        status,
        Payload::json(serde_json::json!({
            "content": entry_json(repo_path, &content),
            "commit": { "sha": format!("commit-{}", repo.version) },
        })),
    )
}

fn delete_contents(repo: &mut Repository, repo_path: &str, body: &str) -> (u16, Payload) {
    let payload: serde_json::Value = serde_json::from_str(body).expect("the store sends JSON");
    let Some(existing) = repo.files.get(repo_path).cloned() else {
        return (
            404,
            Payload::json(serde_json::json!({ "message": "Not Found" })),
        );
    };
    if payload.get("sha").and_then(|sha| sha.as_str()) != Some(blob_sha(&existing).as_str()) {
        return (
            409,
            Payload::json(serde_json::json!({ "message": "does not match" })),
        );
    }
    repo.files.remove(repo_path);
    repo.version += 1;
    (
        200,
        Payload::json(
            serde_json::json!({ "commit": { "sha": format!("commit-{}", repo.version) } }),
        ),
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
}

fn send(port: u16, method: &str, path: &str, body: Option<&str>, extra: &[(&str, &str)]) -> Res {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("store accepts connections");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nOrigin: {WEBVIEW_ORIGIN}\r\n"
    );
    for (name, value) in extra {
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
            "apiBase": fixture.github.url,
            "hasToken": true,
        })
    );
    // Not merely absent from the typed shape — absent from the bytes.
    assert!(!res.body.contains(TOKEN));
}

#[test]
fn keeps_metadata_in_the_dotfile_and_the_token_out_of_the_data_tree() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    let bindings: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(fixture.data_dir().join(".docent").join("bindings.json"))
            .expect("the bindings dotfile is where D27 says"),
    )
    .expect("valid JSON");
    assert_eq!(
        bindings["work"],
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "docs/diagrams",
            "branch": "main",
            "apiBase": fixture.github.url,
        })
    );

    // Walk the whole data tree: nothing in it may carry the credential.
    for file in walk(fixture.data_dir()) {
        let contents = fs::read_to_string(&file).unwrap_or_default();
        assert!(!contents.contains(TOKEN), "{}", file.display());
    }

    let secrets: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&fixture.secrets_file).expect("secrets file"))
            .expect("valid JSON");
    assert_eq!(secrets["work"], TOKEN);

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
    assert_eq!(res.json(), serde_json::json!({ "ok": true }));

    assert_eq!(
        get(fixture.port(), "/api/projects/defaults/binding").json(),
        serde_json::json!({
            "owner": "acme",
            "repo": "diagrams",
            "path": "",
            "branch": "main",
            "apiBase": "https://api.github.com",
            "hasToken": false,
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
        assert!(
            res.json()["error"]
                .as_str()
                .expect("an error message")
                .starts_with(expected),
            "{expected}: {}",
            res.body
        );
    }

    let not_json = put(
        fixture.port(),
        "/api/projects/work/binding",
        Some("not json"),
    );
    assert_eq!(not_json.status, 400);
    assert_eq!(not_json.json()["error"], "body is not JSON");
    // Nothing was written: the project is still unbound.
    assert_eq!(
        get(fixture.port(), "/api/projects/work/binding").status,
        404
    );
}

#[test]
fn four_oh_fours_the_binding_of_an_unbound_project() {
    let fixture = Fixture::new();
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    let res = get(fixture.port(), "/api/projects/plain/binding");
    assert_eq!(res.status, 404);
    assert_eq!(
        res.json(),
        serde_json::json!({ "error": "no GitHub binding for project: plain" })
    );
}

// ---------------------------------------------------------------------------
// bound scenes
// ---------------------------------------------------------------------------

#[test]
fn lists_the_repositorys_scenes_with_shas_and_the_branchs_timestamp() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);
    fixture
        .github
        .put_file("docs/diagrams/README.md", "not a scene");
    fixture
        .github
        .put_file("docs/diagrams/other/nested.excalidraw", SCENE);

    let res = get(fixture.port(), "/api/projects/work/scenes");
    assert_eq!(res.status, 200);
    let scenes = res.json();
    // Only .excalidraw files, only at the bound path.
    assert_eq!(scenes.as_array().expect("array").len(), 1);
    assert_eq!(scenes[0]["name"], "checkout");
    assert_eq!(scenes[0]["sha"], blob_sha(SCENE));
    assert_eq!(scenes[0]["size"], SCENE.len());
    assert_eq!(scenes[0]["updatedAt"], COMMIT_DATE);
}

#[test]
fn revalidates_the_listing_with_if_none_match_rather_than_refetching_it() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);

    let first = get(fixture.port(), "/api/projects/work/scenes");
    let again = get(fixture.port(), "/api/projects/work/scenes");
    assert_eq!(first.body, again.body);
    let listings = fixture.github.requests_to("/contents/docs/diagrams?");
    assert_eq!(listings.len(), 2);
    assert!(
        listings[1]
            .if_none_match
            .as_deref()
            .is_some_and(|etag| etag.contains("listing-")),
        "the second listing revalidates: {:?}",
        listings[1].if_none_match
    );
}

#[test]
fn flags_bound_projects_in_the_projects_listing_without_calling_github() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    assert_eq!(put(fixture.port(), "/api/projects/plain", None).status, 201);
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);
    get(fixture.port(), "/api/projects/work/scenes");

    let before = fixture.github.seen().len();
    let projects = get(fixture.port(), "/api/projects").json();
    assert_eq!(
        fixture.github.seen().len(),
        before,
        "the projects listing never blocks on GitHub"
    );
    let work = projects
        .as_array()
        .expect("array")
        .iter()
        .find(|project| project["id"] == "work")
        .expect("the bound project");
    assert_eq!(work["bound"], true);
    // The count is whatever the last listing saw.
    assert_eq!(work["scenes"], 1);

    // The bindings dotfile is not a project, and an unbound project carries no
    // flag at all.
    let plain = projects
        .as_array()
        .expect("array")
        .iter()
        .find(|project| project["id"] == "plain")
        .expect("the local project");
    assert!(plain.get("bound").is_none());
    assert!(!projects
        .as_array()
        .expect("array")
        .iter()
        .any(|project| project["id"].as_str().unwrap_or_default().starts_with('.')));
}

#[test]
fn loads_a_scene_with_its_conflict_token() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);

    let res = get(fixture.port(), "/api/projects/work/scenes/checkout");
    assert_eq!(res.status, 200);
    assert_eq!(res.body, SCENE);
    assert_eq!(
        res.header("x-docent-scene-sha"),
        Some(blob_sha(SCENE).as_str())
    );
    // The webview is a different origin, so the header has to be exposed or the
    // page could never read what it just received.
    assert_eq!(
        res.header("access-control-expose-headers"),
        Some("X-Docent-Scene-Sha")
    );

    let missing = get(fixture.port(), "/api/projects/work/scenes/missing");
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.json(),
        serde_json::json!({ "error": "no such scene: work/missing" })
    );
}

#[test]
fn saves_a_scene_as_a_commit_and_answers_with_the_new_sha() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);

    let res = send(
        fixture.port(),
        "PUT",
        "/api/projects/work/scenes/checkout",
        Some(OTHER_SCENE),
        &[("X-Docent-Scene-Sha", &blob_sha(SCENE))],
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "sha": blob_sha(OTHER_SCENE) })
    );
    assert_eq!(
        fixture
            .github
            .file("docs/diagrams/checkout.excalidraw")
            .as_deref(),
        Some(OTHER_SCENE)
    );

    let write = fixture
        .github
        .requests_to("/contents/docs/diagrams/checkout.excalidraw")
        .into_iter()
        .rfind(|entry| entry.method == "PUT")
        .expect("a write");
    let payload: serde_json::Value = serde_json::from_str(&write.body).expect("JSON");
    assert_eq!(payload["message"], "docent: update work/checkout");
    assert_eq!(payload["branch"], "main");
    assert_eq!(payload["sha"], blob_sha(SCENE));
}

#[test]
fn creates_a_scene_the_repository_does_not_have_yet() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    let res = put(
        fixture.port(),
        "/api/projects/work/scenes/fresh",
        Some(SCENE),
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(
        res.json(),
        serde_json::json!({ "ok": true, "sha": blob_sha(SCENE) })
    );
    let write = fixture
        .github
        .requests_to("/contents/docs/diagrams/fresh.excalidraw")
        .into_iter()
        .rfind(|entry| entry.method == "PUT")
        .expect("a write");
    let payload: serde_json::Value = serde_json::from_str(&write.body).expect("JSON");
    assert_eq!(payload["message"], "docent: create work/fresh");
    assert!(payload.get("sha").is_none(), "nothing to conflict with yet");
}

#[test]
fn refuses_a_stale_write_with_a_409_that_says_what_to_do() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", OTHER_SCENE);

    let res = send(
        fixture.port(),
        "PUT",
        "/api/projects/work/scenes/checkout",
        Some(SCENE),
        // The sha the scene had before someone else moved first.
        &[("X-Docent-Scene-Sha", &blob_sha(SCENE))],
    );
    assert_eq!(res.status, 409);
    assert_eq!(res.json(), serde_json::json!({ "error": CONFLICT_MESSAGE }));
    // Nothing was overwritten.
    assert_eq!(
        fixture
            .github
            .file("docs/diagrams/checkout.excalidraw")
            .as_deref(),
        Some(OTHER_SCENE)
    );
}

#[test]
fn still_refuses_bodies_that_are_not_excalidraw_scenes() {
    let fixture = Fixture::new();
    fixture.bound_project("work");

    let not_json = put(
        fixture.port(),
        "/api/projects/work/scenes/checkout",
        Some("not json"),
    );
    assert_eq!(not_json.status, 400);
    assert_eq!(not_json.json()["error"], "body is not JSON");

    let wrong_type = put(
        fixture.port(),
        "/api/projects/work/scenes/checkout",
        Some(r#"{"type":"other"}"#),
    );
    assert_eq!(wrong_type.status, 400);
    assert_eq!(
        wrong_type.json()["error"],
        "body is not an .excalidraw scene"
    );
    assert_eq!(
        fixture.github.file_count(),
        0,
        "nothing reached the repository"
    );
}

#[test]
fn reads_a_scene_too_large_for_the_contents_api_through_the_blob_api() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    let big = format!(
        "{{\"type\":\"excalidraw\",\"version\":2,\"elements\":[{{\"id\":\"{}\"}}]}}",
        "x".repeat(INLINE_LIMIT)
    );
    fixture
        .github
        .put_file("docs/diagrams/big.excalidraw", &big);

    let res = get(fixture.port(), "/api/projects/work/scenes/big");
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(res.body, big);
    assert_eq!(
        res.header("x-docent-scene-sha"),
        Some(blob_sha(&big).as_str())
    );
    assert!(!fixture.github.requests_to("/git/blobs/").is_empty());
}

#[test]
fn deletes_a_scene_as_a_commit() {
    let fixture = Fixture::new();
    fixture.bound_project("work");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);

    let res = delete(fixture.port(), "/api/projects/work/scenes/checkout");
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "ok": true }));
    assert!(fixture
        .github
        .file("docs/diagrams/checkout.excalidraw")
        .is_none());

    let remove = fixture
        .github
        .requests_to("/contents/docs/diagrams/checkout.excalidraw")
        .into_iter()
        .rfind(|entry| entry.method == "DELETE")
        .expect("a delete");
    let payload: serde_json::Value = serde_json::from_str(&remove.body).expect("JSON");
    assert_eq!(payload["message"], "docent: delete work/checkout");
    assert_eq!(payload["sha"], blob_sha(SCENE));

    // Deleting what is not there is a 404, exactly as for a local scene.
    assert_eq!(
        delete(fixture.port(), "/api/projects/work/scenes/checkout").status,
        404
    );
}

#[test]
fn four_oh_ones_when_the_token_is_missing_or_rejected() {
    let fixture = Fixture::new();
    assert_eq!(
        put(fixture.port(), "/api/projects/tokenless", None).status,
        201
    );
    assert_eq!(
        fixture
            .bind(
                "tokenless",
                serde_json::json!({ "token": serde_json::Value::Null })
            )
            .status,
        200
    );

    let missing = get(fixture.port(), "/api/projects/tokenless/scenes");
    assert_eq!(missing.status, 401);
    assert_eq!(
        missing.json(),
        serde_json::json!({ "error": TOKEN_MESSAGE })
    );

    // A token GitHub itself refuses reads the same way to the user.
    assert_eq!(
        fixture
            .bind("tokenless", serde_json::json!({ "token": "wrong-token" }))
            .status,
        200
    );
    let rejected = get(fixture.port(), "/api/projects/tokenless/scenes/checkout");
    assert_eq!(rejected.status, 401);
    assert_eq!(
        rejected.json(),
        serde_json::json!({ "error": TOKEN_MESSAGE })
    );
}

#[test]
fn unbinds_without_touching_the_local_directory_or_the_repository() {
    let fixture = Fixture::new();
    let port = fixture.port();
    // A stale local scene from before the binding: it survives, unread.
    assert_eq!(put(port, "/api/projects/stale", None).status, 201);
    assert_eq!(
        put(port, "/api/projects/stale/scenes/local", Some(SCENE)).status,
        200
    );
    fixture.bound_project("stale");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);

    // Bound: the local scene is invisible, the repository's scenes are not.
    let bound = get(port, "/api/projects/stale/scenes").json();
    assert_eq!(bound[0]["name"], "checkout");
    assert_eq!(bound.as_array().expect("array").len(), 1);

    let unbind = delete(port, "/api/projects/stale/binding");
    assert_eq!(unbind.status, 200);
    assert_eq!(unbind.json(), serde_json::json!({ "ok": true }));

    // The local directory is back in charge, with its file untouched.
    let local = get(port, "/api/projects/stale/scenes").json();
    assert_eq!(local[0]["name"], "local");
    assert_eq!(
        fs::read_to_string(fixture.data_dir().join("stale").join("local.excalidraw"))
            .expect("the local scene survived"),
        SCENE
    );
    // The token went with the binding, and GitHub still has everything.
    let secrets: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&fixture.secrets_file).unwrap_or_default())
            .unwrap_or(serde_json::json!({}));
    assert!(secrets.get("stale").is_none());
    assert!(fixture
        .github
        .file("docs/diagrams/checkout.excalidraw")
        .is_some());

    // Unbinding twice is a success, not a 404.
    assert_eq!(delete(port, "/api/projects/stale/binding").status, 200);
}

#[test]
fn deleting_a_bound_project_unbinds_it_and_leaves_github_alone() {
    let fixture = Fixture::new();
    let port = fixture.port();
    fixture.bound_project("doomed");
    fixture
        .github
        .put_file("docs/diagrams/checkout.excalidraw", SCENE);
    let before = fixture.github.file_count();

    assert_eq!(delete(port, "/api/projects/doomed").status, 200);
    assert!(!fixture.data_dir().join("doomed").exists());
    assert_eq!(
        get(port, "/api/projects/doomed/binding").status,
        404,
        "the binding went with it"
    );
    let secrets: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&fixture.secrets_file).unwrap_or_default())
            .unwrap_or(serde_json::json!({}));
    assert!(secrets.get("doomed").is_none());
    assert_eq!(
        fixture.github.file_count(),
        before,
        "the repository is untouched"
    );
}

// ---------------------------------------------------------------------------
// regression: an unbound project is exactly what it was before S14
// ---------------------------------------------------------------------------

#[test]
fn unbound_projects_stay_a_plain_file_tree() {
    let fixture = Fixture::new();
    let port = fixture.port();
    assert_eq!(put(port, "/api/projects/plain", None).status, 201);

    let write = put(port, "/api/projects/plain/scenes/local", Some(SCENE));
    assert_eq!(write.status, 200);
    assert_eq!(write.json(), serde_json::json!({ "ok": true }));
    assert_eq!(
        fs::read_to_string(fixture.data_dir().join("plain").join("local.excalidraw"))
            .expect("a plain file on disk"),
        SCENE
    );

    let listed = get(port, "/api/projects/plain/scenes");
    assert_eq!(listed.json().as_array().expect("array").len(), 1);
    // On the wire, not as a parsed map: `serde_json` sorts an object's keys on
    // the way in, so only the raw body shows the field order the reference
    // store emits — and shows that no `sha` is among them.
    assert!(
        listed.body.starts_with(r#"[{"name":"local","updatedAt":"#),
        "{}",
        listed.body
    );
    assert!(!listed.body.contains("\"sha\""), "no sha on a local scene");

    let loaded = get(port, "/api/projects/plain/scenes/local");
    assert_eq!(loaded.body, SCENE);
    assert_eq!(loaded.header("x-docent-scene-sha"), None);

    assert_eq!(delete(port, "/api/projects/plain/scenes/local").status, 200);
    assert_eq!(
        put(port, "/api/projects/nope/scenes/x", Some(SCENE)).status,
        404
    );
    // Not one request left the machine for any of it.
    assert!(fixture.github.seen().is_empty());
}
