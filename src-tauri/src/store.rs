//! Desktop portfolio store (S13, D25) — the second implementation of the one
//! store *contract*: the D17 file tree (`<data>/<project>/<scene>.excalidraw`)
//! behind the D18 `/api` routes. Route shapes, status codes, error bodies, the
//! name gate, and the `.excalidraw`-only write gate match
//! `server/docent-store.mjs` byte for byte; `tests/store_contract.rs` is what
//! keeps the two honest.
//!
//! It binds loopback on an ephemeral port and the shell injects the base URL
//! into the page, because the webview origin (`tauri://localhost`) is not an
//! origin an HTTP server can answer on. That makes the store cross-origin for
//! the first time, so the CORS allowlist below is load-bearing rather than
//! decorative: PUT and DELETE are preflighted, and a preflight from any origin
//! that is not this app's is refused. A hostile page in the user's browser
//! therefore cannot write the portfolio even if it guesses the port.

use std::fs;
use std::io::{ErrorKind, Read};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::UNIX_EPOCH;

use tiny_http::{Header, Method, Request, Response, Server};

const MAX_SCENE_BYTES: usize = 50 * 1024 * 1024;
const EXT: &str = ".excalidraw";

/// Origins this store answers CORS for: the webview in a packaged build
/// (`tauri://` on macOS and Linux, `http(s)://tauri.localhost` on Windows) and
/// the Vite dev server when the shell runs under `tauri dev`.
const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

/// The running store. Dropping it stops the listener and joins its thread.
pub struct StoreHandle {
    port: u16,
    server: Arc<Server>,
    worker: Option<JoinHandle<()>>,
}

impl StoreHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// What the shell injects as `window.__DOCENT_API_BASE__`.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for StoreHandle {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Bind loopback on an ephemeral port and serve `data_dir` until dropped.
pub fn spawn(data_dir: PathBuf) -> std::io::Result<StoreHandle> {
    fs::create_dir_all(&data_dir)?;
    let server = Server::http((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| std::io::Error::other("store did not bind a TCP port"))?
        .port();
    let server = Arc::new(server);
    let worker = {
        let server = Arc::clone(&server);
        thread::spawn(move || {
            // One request at a time: every handler is a stat, a read, or a
            // rename against the local disk, and a single user's canvas never
            // queues deep enough for a pool to pay for itself.
            for request in server.incoming_requests() {
                serve(&data_dir, request);
            }
        })
    };
    Ok(StoreHandle {
        port,
        server,
        worker: Some(worker),
    })
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

struct HttpError {
    status: u16,
    message: String,
}

impl HttpError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, HttpError>;

/// A successful reply: a status plus a body that is already JSON text.
struct Reply {
    status: u16,
    json: String,
}

impl Reply {
    fn ok(json: impl Into<String>) -> Self {
        Self {
            status: 200,
            json: json.into(),
        }
    }
}

fn serve(data_dir: &Path, mut request: Request) {
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());

    // Preflight for the PUT/DELETE the client uses; answered before routing so
    // an unknown origin never learns which paths exist.
    if *request.method() == Method::Options {
        let mut response = Response::from_string("")
            .with_status_code(204)
            .with_header(header(
                "Access-Control-Allow-Methods",
                "GET, PUT, DELETE, OPTIONS",
            ))
            .with_header(header("Access-Control-Allow-Headers", "content-type"))
            .with_header(header("Access-Control-Max-Age", "86400"));
        for extra in cors_headers(origin.as_deref()) {
            response = response.with_header(extra);
        }
        let _ = request.respond(response);
        return;
    }

    let (status, body) = match dispatch(data_dir, &mut request) {
        Ok(reply) => (reply.status, reply.json),
        Err(err) => (
            err.status,
            serde_json::json!({ "error": err.message }).to_string(),
        ),
    };

    let mut response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    for extra in cors_headers(origin.as_deref()) {
        response = response.with_header(extra);
    }
    let _ = request.respond(response);
}

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    let mut headers = vec![header("Vary", "Origin")];
    if let Some(origin) = origin {
        if ALLOWED_ORIGINS.contains(&origin) {
            headers.push(header("Access-Control-Allow-Origin", origin));
        }
    }
    headers
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header name and value are valid")
}

fn dispatch(data_dir: &Path, request: &mut Request) -> Result<Reply> {
    let method = request.method().clone();
    let segments = path_segments(request.url());
    let part = |i: usize| segments.get(i).map(String::as_str);

    if part(0) != Some("api") {
        return Err(HttpError::new(404, "not found"));
    }

    if part(1) == Some("health") && method == Method::Get {
        return Ok(Reply::ok(r#"{"ok":true}"#));
    }

    if part(1) != Some("projects") {
        return Err(HttpError::new(404, "not found"));
    }

    if segments.len() == 2 && method == Method::Get {
        return list_projects(data_dir);
    }

    if segments.len() == 3 {
        let project = &segments[2];
        if method == Method::Put {
            fs::create_dir_all(project_dir(data_dir, project)?).map_err(internal)?;
            return Ok(Reply {
                status: 201,
                json: serde_json::json!({ "id": project }).to_string(),
            });
        }
        if method == Method::Delete {
            let dir = project_dir(data_dir, project)?;
            match fs::remove_dir_all(&dir) {
                Ok(()) => {}
                // `force: true` in the reference store — deleting what is
                // already gone is a success, not a 404.
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(internal(err)),
            }
            return Ok(Reply::ok(r#"{"ok":true}"#));
        }
    }

    if segments.len() == 4 && part(3) == Some("scenes") && method == Method::Get {
        return list_scenes(data_dir, &segments[2]);
    }

    if segments.len() == 5 && part(3) == Some("scenes") {
        let (project, scene) = (&segments[2], &segments[4]);
        let file = scene_path(data_dir, project, scene)?;

        if method == Method::Get {
            return match fs::read_to_string(&file) {
                Ok(raw) => Ok(Reply::ok(raw)),
                Err(_) => Err(HttpError::new(
                    404,
                    format!("no such scene: {project}/{scene}"),
                )),
            };
        }

        if method == Method::Put {
            let body = read_body(request)?;
            // The store persists .excalidraw files and nothing else (D17) —
            // reject anything that isn't one, loudly.
            let parsed: serde_json::Value =
                serde_json::from_str(&body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
            if parsed.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
                return Err(HttpError::new(400, "body is not an .excalidraw scene"));
            }
            let dir = project_dir(data_dir, project)?;
            if !dir.is_dir() {
                return Err(HttpError::new(404, format!("no such project: {project}")));
            }
            // Atomic: a crash mid-write must never truncate an existing scene.
            let mut tmp = file.clone().into_os_string();
            tmp.push(".tmp");
            let tmp = PathBuf::from(tmp);
            fs::write(&tmp, &body).map_err(internal)?;
            fs::rename(&tmp, &file).map_err(internal)?;
            return Ok(Reply::ok(r#"{"ok":true}"#));
        }

        if method == Method::Delete {
            return match fs::remove_file(&file) {
                Ok(()) => Ok(Reply::ok(r#"{"ok":true}"#)),
                Err(_) => Err(HttpError::new(
                    404,
                    format!("no such scene: {project}/{scene}"),
                )),
            };
        }
    }

    Err(HttpError::new(404, "not found"))
}

fn internal(err: std::io::Error) -> HttpError {
    HttpError::new(500, err.to_string())
}

// ---------------------------------------------------------------------------
// paths and names
// ---------------------------------------------------------------------------

/// The reference store's `^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$`, spelled out. One
/// flat rule keeps traversal impossible: every project and scene name must
/// match this before it ever touches a path. No dots means no ".." and no
/// extension games; the store adds .excalidraw itself.
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'-'))
}

fn check_name(name: &str, what: &str) -> Result<()> {
    if valid_name(name) {
        return Ok(());
    }
    Err(HttpError::new(
        400,
        format!(
            "invalid {what} name — use letters, digits, spaces, - or _ (max 64, no leading symbol)"
        ),
    ))
}

fn project_dir(data_dir: &Path, project: &str) -> Result<PathBuf> {
    check_name(project, "project")?;
    Ok(data_dir.join(project))
}

fn scene_path(data_dir: &Path, project: &str, scene: &str) -> Result<PathBuf> {
    let dir = project_dir(data_dir, project)?;
    check_name(scene, "scene")?;
    Ok(dir.join(format!("{scene}{EXT}")))
}

/// Split the request target into decoded path segments. Decoding happens
/// *after* splitting, so an encoded separator (`a%2Fb`) arrives at the name
/// gate as one segment and is rejected there rather than silently becoming a
/// subdirectory.
pub fn path_segments(url: &str) -> Vec<String> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(percent_decode)
        .collect()
}

fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Undecodable bytes become replacement characters, which the name gate
    // rejects — the same outcome as a malformed name.
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------

// Derived rather than `json!`-built so the serialized key order matches the
// reference store's object literals; `json!` would sort them alphabetically.
#[derive(serde::Serialize)]
struct ProjectInfo {
    id: String,
    scenes: usize,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(serde::Serialize)]
struct SceneInfo {
    name: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    size: u64,
}

fn list_projects(data_dir: &Path) -> Result<Reply> {
    // Created on demand so a fresh profile lists empty instead of erroring.
    fs::create_dir_all(data_dir).map_err(internal)?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(data_dir).map_err(internal)? {
        let entry = entry.map_err(internal)?;
        if !entry.file_type().map_err(internal)?.is_dir() {
            continue;
        }
        let mut scenes = 0_usize;
        let mut updated_at: Option<u128> = None;
        for scene in fs::read_dir(entry.path()).map_err(internal)? {
            let scene = scene.map_err(internal)?;
            if !scene.file_name().to_string_lossy().ends_with(EXT) {
                continue;
            }
            scenes += 1;
            if let Some(ms) = modified_millis(&scene.path()) {
                updated_at = Some(updated_at.map_or(ms, |current| current.max(ms)));
            }
        }
        projects.push(ProjectInfo {
            id: entry.file_name().to_string_lossy().into_owned(),
            scenes,
            updated_at: updated_at.map(iso8601),
        });
    }
    sort_by(&mut projects, |project| &project.id);
    Ok(Reply::ok(serde_json::to_string(&projects).map_err(json)?))
}

fn list_scenes(data_dir: &Path, project: &str) -> Result<Reply> {
    let dir = project_dir(data_dir, project)?;
    let entries = fs::read_dir(&dir)
        .map_err(|_| HttpError::new(404, format!("no such project: {project}")))?;
    let mut scenes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(internal)?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(EXT) {
            continue;
        }
        let meta = entry.metadata().map_err(internal)?;
        scenes.push(SceneInfo {
            name: file_name[..file_name.len() - EXT.len()].to_string(),
            updated_at: modified_millis(&entry.path()).map(iso8601),
            size: meta.len(),
        });
    }
    sort_by(&mut scenes, |scene| &scene.name);
    Ok(Reply::ok(serde_json::to_string(&scenes).map_err(json)?))
}

/// `localeCompare` order, approximated: case-insensitive first so `apples`
/// sorts before `Bananas` as it does in the reference store, with the raw
/// string breaking ties so the result stays deterministic (I3 habits).
fn sort_by<T>(values: &mut [T], key: impl Fn(&T) -> &String) {
    values.sort_by(|a, b| {
        let (a, b) = (key(a), key(b));
        a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b))
    });
}

fn json(err: serde_json::Error) -> HttpError {
    HttpError::new(500, err.to_string())
}

fn modified_millis(path: &Path) -> Option<u128> {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis())
}

/// `new Date(ms).toISOString()` without a date crate: days-since-epoch to a
/// civil date by the standard proleptic-Gregorian conversion.
pub fn iso8601(millis: u128) -> String {
    let millis = millis as i64;
    let days = millis.div_euclid(86_400_000);
    let time_of_day = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (seconds, subsecond) = (time_of_day / 1000, time_of_day % 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{subsecond:03}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153; // [0, 11], March-based
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    let year = year_of_era as i64 + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

fn read_body(request: &mut Request) -> Result<String> {
    if let Some(declared) = request.body_length() {
        if declared > MAX_SCENE_BYTES {
            return Err(HttpError::new(413, "scene too large"));
        }
    }
    let mut buffer = Vec::new();
    request
        .as_reader()
        .take(MAX_SCENE_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|_| HttpError::new(400, "body is not JSON"))?;
    if buffer.len() > MAX_SCENE_BYTES {
        return Err(HttpError::new(413, "scene too large"));
    }
    String::from_utf8(buffer).map_err(|_| HttpError::new(400, "body is not JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_gate_matches_the_allowlist() {
        for name in ["a", "work", "Check out 2", "a-b_c", &"a".repeat(64)] {
            assert!(valid_name(name), "{name} should pass");
        }
        for name in [
            "",
            "..",
            "a/b",
            ".hidden",
            "-flag",
            "a.b",
            "é",
            &"a".repeat(65),
        ] {
            assert!(!valid_name(name), "{name} should fail");
        }
    }

    #[test]
    fn segments_decode_after_splitting() {
        assert_eq!(path_segments("/api/health"), ["api", "health"]);
        assert_eq!(
            path_segments("/api/projects/a%2Fb"),
            ["api", "projects", "a/b"]
        );
        assert_eq!(
            path_segments("/api/projects/work/scenes/check%20out?x=1"),
            ["api", "projects", "work", "scenes", "check out"]
        );
    }

    #[test]
    fn timestamps_match_to_iso_string() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(86_400_000), "1970-01-02T00:00:00.000Z");
        assert_eq!(iso8601(1_600_000_000_000), "2020-09-13T12:26:40.000Z");
        assert_eq!(iso8601(1_755_648_000_123), "2025-08-20T00:00:00.123Z");
    }
}
