//! Contract tests for the desktop portfolio store (S13, D25): the same
//! semantics `tests/store.test.ts` holds the Node store to — CRUD round-trips,
//! the on-disk file-tree shape (D17), the name gate that makes traversal
//! impossible, the `.excalidraw`-only write gate, and 404 semantics — plus the
//! two things only the desktop has: an atomic write that leaves no `.tmp`
//! behind and a CORS allowlist, because here the store is cross-origin.
//!
//! The desktop also owns four endpoints with no self-host counterpart —
//! `/desktop/import` and `/desktop/export`, which raise a native file dialog,
//! and `/desktop/confirm` and `/desktop/alert`, which raise a native message
//! box because the system webview implements neither `window.confirm` nor
//! `window.alert` — so those are exercised here too, with the dialogs stubbed:
//! CI has no display, and the plumbing under test is the HTTP half either way.
//!
//! Each test gets its own data directory, its own ephemeral port, and its own
//! stubbed dialog answer, so they run in parallel without sharing state.

use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use docent_lib::store::{self, AskKind, Asked, StoreHandle, StubDialog};

const SCENE: &str = r#"{"type":"excalidraw","version":2,"elements":[]}"#;
const WEBVIEW_ORIGIN: &str = "tauri://localhost";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Fixture {
    store: Option<StoreHandle>,
    /// The same stub the store holds, kept here so a test can read back which
    /// message boxes the store would have put on screen.
    dialogs: Arc<StubDialog>,
    data_dir: PathBuf,
    secrets_file: PathBuf,
}

impl Fixture {
    /// A store whose dialogs always cancel and always decline — the answers no
    /// test that never opens one can be surprised by.
    fn new() -> Self {
        Self::with_dialog("cancel")
    }

    /// `answer` is what the stubbed file dialog returns: `cancel`, or the path
    /// the user would have picked.
    fn with_dialog(answer: &str) -> Self {
        Self::build(answer, false)
    }

    /// A store whose message boxes are answered with OK, for the flows that
    /// only continue when the user says yes.
    fn confirming() -> Self {
        Self::build("cancel", true)
    }

    fn build(answer: &str, confirms: bool) -> Self {
        let data_dir = std::env::temp_dir().join(unique_name("docent-store"));
        // Outside the data directory, as D27 requires of every deployment.
        let secrets_file = std::env::temp_dir()
            .join(unique_name("docent-secrets"))
            .with_extension("json");
        let dialogs = Arc::new(StubDialog::new(answer).confirming(confirms));
        let store = store::spawn(
            data_dir.clone(),
            secrets_file.clone(),
            Arc::clone(&dialogs) as Arc<dyn store::Dialogs>,
        )
        .expect("store binds loopback");
        Self {
            store: Some(store),
            dialogs,
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

    /// Every message box the store raised, oldest first.
    fn asked(&self) -> Vec<Asked> {
        self.dialogs.asked()
    }
}

/// A name no other test in this process (or a leftover from a previous run)
/// can collide with.
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

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.store.take());
        let _ = fs::remove_dir_all(&self.data_dir);
        let _ = fs::remove_file(&self.secrets_file);
    }
}

/// A path outside the portfolio, for the dialog endpoints to read from or
/// write to. Removed with the test that made it, whether or not it existed.
struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        Self {
            path: std::env::temp_dir().join(unique_name(name)),
        }
    }

    fn with_contents(name: &str, contents: &str) -> Self {
        let scratch = Self::new(name);
        fs::write(&scratch.path, contents).expect("scratch file is writable");
        scratch
    }

    fn as_str(&self) -> &str {
        self.path.to_str().expect("temp paths are UTF-8 here")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
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

fn send(port: u16, method: &str, path: &str, body: Option<&str>, origin: Option<&str>) -> Res {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("store accepts connections");
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(origin) = origin {
        head.push_str(&format!("Origin: {origin}\r\n"));
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
    // Half-close: the connection is single-use, and an explicit EOF frees the
    // server from waiting on a body that will never grow.
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
    send(port, "GET", path, None, Some(WEBVIEW_ORIGIN))
}

fn put(port: u16, path: &str, body: Option<&str>) -> Res {
    send(port, "PUT", path, body, Some(WEBVIEW_ORIGIN))
}

fn delete(port: u16, path: &str) -> Res {
    send(port, "DELETE", path, None, Some(WEBVIEW_ORIGIN))
}

fn post(port: u16, path: &str, body: Option<&str>) -> Res {
    send(port, "POST", path, body, Some(WEBVIEW_ORIGIN))
}

fn encode(name: &str) -> String {
    name.bytes()
        .map(|byte| match byte {
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
            | b')' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

#[test]
fn reports_health() {
    let fixture = Fixture::new();
    let res = get(fixture.port(), "/api/health");
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "ok": true }));
}

#[test]
fn starts_empty() {
    let fixture = Fixture::new();
    let res = get(fixture.port(), "/api/projects");
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!([]));
}

#[test]
fn creates_projects_and_scenes_as_a_plain_file_tree() {
    let fixture = Fixture::new();
    let port = fixture.port();

    let create = put(port, "/api/projects/work", None);
    assert_eq!(create.status, 201);
    assert_eq!(create.json(), serde_json::json!({ "id": "work" }));

    let write = put(port, "/api/projects/work/scenes/checkout", Some(SCENE));
    assert_eq!(write.status, 200);
    assert_eq!(write.json(), serde_json::json!({ "ok": true }));

    // The store adds no format of its own: the scene is a plain .excalidraw
    // file at <data>/<project>/<scene>.excalidraw (D17).
    let on_disk = fs::read_to_string(fixture.data_dir().join("work").join("checkout.excalidraw"))
        .expect("scene is a plain file on disk");
    assert_eq!(on_disk, SCENE);
    assert_eq!(entries(fixture.data_dir()), vec!["work".to_string()]);

    let projects = get(port, "/api/projects").json();
    assert_eq!(projects.as_array().expect("array").len(), 1);
    assert_eq!(projects[0]["id"], "work");
    assert_eq!(projects[0]["scenes"], 1);
    assert!(
        projects[0]["updatedAt"].as_str().unwrap().ends_with('Z'),
        "updatedAt is an ISO timestamp: {:?}",
        projects[0]["updatedAt"]
    );

    let scenes = get(port, "/api/projects/work/scenes").json();
    assert_eq!(
        scenes
            .as_array()
            .expect("array")
            .iter()
            .map(|scene| scene["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["checkout".to_string()]
    );
    assert_eq!(scenes[0]["size"], SCENE.len());

    let round_trip = get(port, "/api/projects/work/scenes/checkout");
    assert_eq!(round_trip.status, 200);
    assert_eq!(round_trip.body, SCENE);
    assert_eq!(round_trip.header("content-type"), Some("application/json"));
}

#[test]
fn rejects_path_escaping_and_malformed_names() {
    let fixture = Fixture::new();
    let port = fixture.port();

    for name in ["..", "a/b", ".hidden", "-flag", &"a".repeat(65)] {
        let res = put(port, &format!("/api/projects/{}", encode(name)), None);
        assert!(
            [400, 404].contains(&res.status),
            "{name} should be refused, got {}",
            res.status
        );
    }

    put(port, "/api/projects/work", None);
    let res = put(
        port,
        &format!("/api/projects/work/scenes/{}", encode("../escape")),
        Some(SCENE),
    );
    assert_eq!(res.status, 400);

    // Nothing escaped: the project directory holds no scene, and the data
    // root holds nothing but the project.
    assert_eq!(entries(fixture.data_dir()), vec!["work".to_string()]);
    assert!(entries(&fixture.data_dir().join("work")).is_empty());
}

#[test]
fn scenes_address_by_path_and_folders_come_and_go_with_them() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    // The routes do not change (D92): the whole path rides in the scene's own
    // URL segment, encoded.
    let deep = encode("Team notes/2026/Q1 plan");
    let nested = put(
        port,
        &format!("/api/projects/work/scenes/{deep}"),
        Some(SCENE),
    );
    assert_eq!(nested.status, 200, "{}", nested.body);
    assert_eq!(
        put(port, "/api/projects/work/scenes/flat", Some(SCENE)).status,
        200
    );

    // The PUT created the folders on the way to it, and the scene is a plain
    // file at the end of them.
    assert_eq!(
        fs::read_to_string(
            fixture
                .data_dir()
                .join("work")
                .join("Team notes")
                .join("2026")
                .join("Q1 plan.excalidraw")
        )
        .expect("the nested scene"),
        SCENE
    );

    // It reads back by the same path…
    let round_trip = get(port, &format!("/api/projects/work/scenes/{deep}"));
    assert_eq!(round_trip.status, 200);
    assert_eq!(round_trip.body, SCENE);

    // …and lists as a relative path, folders before files.
    let scenes = get(port, "/api/projects/work/scenes").json();
    assert_eq!(
        scenes
            .as_array()
            .expect("array")
            .iter()
            .map(|scene| scene["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        ["Team notes/2026/Q1 plan", "flat"]
    );
    // The project's own count is recursive, so the modal says two.
    let projects = get(port, "/api/projects").json();
    assert_eq!(projects[0]["scenes"], 2);

    // DELETE takes the folders it emptied with it, ancestor by ancestor, and
    // stops at the project.
    assert_eq!(
        delete(port, &format!("/api/projects/work/scenes/{deep}")).status,
        200
    );
    assert_eq!(
        entries(&fixture.data_dir().join("work")),
        ["flat.excalidraw".to_string()]
    );
}

#[test]
fn rejects_scene_paths_that_are_not_paths() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    for path in [
        "a/b/c/d/e/f/g/h/i",
        "work/../escape",
        "work/.docent/notes",
        ".docent",
        "work//checkout",
        "work/",
    ] {
        let res = put(
            port,
            &format!("/api/projects/work/scenes/{}", encode(path)),
            Some(SCENE),
        );
        assert_eq!(res.status, 400, "{path} should be refused");
        assert_eq!(
            res.json()["error"],
            "invalid scene path — up to 8 folders of letters, digits, spaces, - or _ (max 64 each, no leading symbol)"
        );
    }
    // Nothing escaped, and eight segments is the depth that is allowed.
    assert!(entries(&fixture.data_dir().join("work")).is_empty());
    assert_eq!(
        put(
            port,
            &format!("/api/projects/work/scenes/{}", encode("a/b/c/d/e/f/g/h")),
            Some(SCENE),
        )
        .status,
        200
    );
    assert_eq!(entries(&fixture.data_dir().join("work")), ["a".to_string()]);
}

#[test]
fn only_persists_excalidraw_scenes() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    let not_json = put(port, "/api/projects/work/scenes/bad", Some("not json"));
    assert_eq!(not_json.status, 400);
    assert_eq!(not_json.json()["error"], "body is not JSON");

    let wrong_type = put(
        port,
        "/api/projects/work/scenes/bad",
        Some(r#"{"type":"other"}"#),
    );
    assert_eq!(wrong_type.status, 400);
    assert_eq!(
        wrong_type.json()["error"],
        "body is not an .excalidraw scene"
    );

    assert!(entries(&fixture.data_dir().join("work")).is_empty());
}

#[test]
fn four_oh_fours_on_missing_projects_and_scenes() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    assert_eq!(get(port, "/api/projects/nope/scenes").status, 404);
    assert_eq!(get(port, "/api/projects/work/scenes/nope").status, 404);
    assert_eq!(
        put(port, "/api/projects/nope/scenes/x", Some(SCENE)).status,
        404
    );
    assert_eq!(delete(port, "/api/projects/work/scenes/nope").status, 404);
    assert_eq!(get(port, "/api/nonsense").status, 404);
    assert_eq!(get(port, "/nothing").status, 404);
}

#[test]
fn deletes_scenes_and_projects() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);
    put(port, "/api/projects/work/scenes/checkout", Some(SCENE));

    let scene = delete(port, "/api/projects/work/scenes/checkout");
    assert_eq!(scene.status, 200);
    assert_eq!(
        get(port, "/api/projects/work/scenes").json(),
        serde_json::json!([])
    );

    let project = delete(port, "/api/projects/work");
    assert_eq!(project.status, 200);
    assert_eq!(get(port, "/api/projects").json(), serde_json::json!([]));
    assert!(entries(fixture.data_dir()).is_empty());
}

#[test]
fn writes_atomically_and_leaves_no_temporary_file() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    let updated = r#"{"type":"excalidraw","version":2,"elements":[{"id":"a"}]}"#;
    for body in [SCENE, updated] {
        assert_eq!(
            put(port, "/api/projects/work/scenes/checkout", Some(body)).status,
            200
        );
        // The rename target is the only thing left behind; a half-written
        // .tmp would mean a crash could truncate an existing scene.
        assert_eq!(
            entries(&fixture.data_dir().join("work")),
            vec!["checkout.excalidraw".to_string()]
        );
    }

    assert_eq!(
        get(port, "/api/projects/work/scenes/checkout").body,
        updated
    );
}

#[test]
fn overlong_bodies_are_refused_before_they_land() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/work", None);

    // Declared over the 50 MB ceiling: refused on the header, without the
    // body ever being read.
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!(
        "PUT /api/projects/work/scenes/huge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n",
        50 * 1024 * 1024 + 1
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.flush().unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut raw = String::new();
    let _ = stream.read_to_string(&mut raw);
    assert!(
        raw.starts_with("HTTP/1.1 413"),
        "expected 413, got {:?}",
        raw.lines().next()
    );
    assert!(entries(&fixture.data_dir().join("work")).is_empty());
}

#[test]
fn answers_cors_for_the_webview_origin_only() {
    let fixture = Fixture::new();
    let port = fixture.port();

    for origin in [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:3000",
    ] {
        let preflight = send(port, "OPTIONS", "/api/projects/work", None, Some(origin));
        assert_eq!(preflight.status, 204);
        assert_eq!(
            preflight.header("access-control-allow-origin"),
            Some(origin),
            "preflight for {origin}"
        );
        assert_eq!(
            preflight.header("access-control-allow-methods"),
            Some("GET, POST, PUT, DELETE, OPTIONS")
        );

        let res = send(port, "GET", "/api/health", None, Some(origin));
        assert_eq!(res.header("access-control-allow-origin"), Some(origin));
    }

    // A page the user happened to open elsewhere gets no allowance, so its
    // preflight fails and it can never PUT or DELETE the portfolio.
    let hostile = send(
        port,
        "OPTIONS",
        "/api/projects/work",
        None,
        Some("https://example.com"),
    );
    assert_eq!(hostile.status, 204);
    assert_eq!(hostile.header("access-control-allow-origin"), None);
    assert_eq!(hostile.header("vary"), Some("Origin"));

    let hostile_read = send(
        port,
        "GET",
        "/api/health",
        None,
        Some("https://example.com"),
    );
    assert_eq!(hostile_read.header("access-control-allow-origin"), None);
}

#[test]
fn listings_are_ordered_and_count_only_scenes() {
    let fixture = Fixture::new();
    let port = fixture.port();

    for project in ["zeta", "Alpha", "middle"] {
        assert_eq!(
            put(port, &format!("/api/projects/{project}"), None).status,
            201
        );
    }
    for scene in ["gamma", "Beta", "alpha"] {
        assert_eq!(
            put(
                port,
                &format!("/api/projects/zeta/scenes/{scene}"),
                Some(SCENE)
            )
            .status,
            200
        );
    }
    // A stray file the store did not write is not a scene.
    fs::write(fixture.data_dir().join("zeta").join("notes.txt"), "hello").unwrap();

    let projects = get(port, "/api/projects").json();
    assert_eq!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["Alpha", "middle", "zeta"]
    );
    assert_eq!(projects[0]["scenes"], 0);
    assert_eq!(projects[0]["updatedAt"], serde_json::Value::Null);
    assert_eq!(projects[2]["scenes"], 3);

    let scenes = get(port, "/api/projects/zeta/scenes").json();
    assert_eq!(
        scenes
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["alpha", "Beta", "gamma"]
    );
}

#[test]
fn scene_names_may_carry_spaces_and_round_trip() {
    let fixture = Fixture::new();
    let port = fixture.port();
    put(port, "/api/projects/My%20Work", None);
    assert_eq!(
        put(
            port,
            "/api/projects/My%20Work/scenes/check%20out",
            Some(SCENE)
        )
        .status,
        200
    );
    assert_eq!(
        entries(&fixture.data_dir().join("My Work")),
        vec!["check out.excalidraw".to_string()]
    );
    assert_eq!(
        get(port, "/api/projects/My%20Work/scenes/check%20out").body,
        SCENE
    );
}

// ---------------------------------------------------------------------------
// native dialogs — the desktop-only half
// ---------------------------------------------------------------------------

#[test]
fn imports_the_file_the_dialog_returned() {
    let source = Scratch::with_contents("docent-import", SCENE);
    let fixture = Fixture::with_dialog(source.as_str());

    let res = post(fixture.port(), "/desktop/import", None);
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(body["content"], SCENE);
    // The name is the file's own, so the page can title the canvas with it.
    assert_eq!(
        body["name"],
        source.path.file_name().unwrap().to_str().unwrap()
    );
    assert!(body.get("canceled").is_none());
}

#[test]
fn import_reports_a_cancelled_dialog_rather_than_an_error() {
    let fixture = Fixture::new();
    let res = post(fixture.port(), "/desktop/import", None);
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "canceled": true }));
}

#[test]
fn import_refuses_a_file_past_the_read_ceiling() {
    let source = Scratch::with_contents("docent-import-huge", &"a".repeat(20 * 1024 * 1024 + 1));
    let fixture = Fixture::with_dialog(source.as_str());

    let res = post(fixture.port(), "/desktop/import", None);
    assert_eq!(res.status, 413);
    assert_eq!(res.json()["error"], "file too large");
}

#[test]
fn exports_exactly_the_text_the_page_generated() {
    let target = Scratch::new("docent-export");
    let fixture = Fixture::with_dialog(target.as_str());

    let content = "graph TD;\n  a-->b;\n";
    let body = serde_json::json!({ "name": "diagram.mmd", "content": content }).to_string();
    let res = post(fixture.port(), "/desktop/export", Some(&body));
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "saved": target.as_str() }));

    // Byte for byte: the export is the page's text, not a re-serialization.
    assert_eq!(
        fs::read_to_string(&target.path).expect("export landed"),
        content
    );
}

#[test]
fn export_reports_a_cancelled_dialog_and_writes_nothing() {
    let fixture = Fixture::new();

    let body = serde_json::json!({ "name": "scene.excalidraw", "content": SCENE }).to_string();
    let res = post(fixture.port(), "/desktop/export", Some(&body));
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "canceled": true }));
    // Not into the portfolio either: a cancelled export writes nowhere.
    assert!(entries(fixture.data_dir()).is_empty());
}

#[test]
fn export_refuses_bodies_past_the_scene_ceiling() {
    let target = Scratch::new("docent-export-huge");
    let fixture = Fixture::with_dialog(target.as_str());

    // Declared over the ceiling: refused on the header, before the dialog
    // could ever be raised.
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port())).unwrap();
    let head = format!(
        "POST /desktop/export HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {WEBVIEW_ORIGIN}\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n",
        50 * 1024 * 1024 + 1
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.flush().unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut raw = String::new();
    let _ = stream.read_to_string(&mut raw);
    assert!(
        raw.starts_with("HTTP/1.1 413"),
        "expected 413, got {:?}",
        raw.lines().next()
    );
    assert!(!target.path.exists());
}

#[test]
fn dialog_endpoints_answer_the_app_only() {
    let target = Scratch::new("docent-export-foreign");
    let fixture = Fixture::with_dialog(target.as_str());
    let port = fixture.port();
    let export = serde_json::json!({ "name": "scene.excalidraw", "content": SCENE }).to_string();
    let message = serde_json::json!({ "message": "Delete everything?" }).to_string();

    // A simple POST needs no preflight, so the origin has to be checked on the
    // request itself — otherwise any page could raise a dialog on the user's
    // screen, write a file wherever they clicked, or put words in a box wearing
    // this app's name.
    for origin in [Some("https://example.com"), None] {
        for (path, body) in [
            ("/desktop/import", None),
            ("/desktop/export", Some(&export)),
            ("/desktop/confirm", Some(&message)),
            ("/desktop/alert", Some(&message)),
        ] {
            let res = send(port, "POST", path, body.map(String::as_str), origin);
            assert_eq!(res.status, 403, "{path} from {origin:?}");
            assert_eq!(res.json()["error"], "forbidden");
        }
    }
    assert!(!target.path.exists());
    assert!(
        fixture.asked().is_empty(),
        "a refused request must never reach the screen"
    );

    // Only POST: a GET must not be able to raise a dialog from a plain link.
    assert_eq!(get(port, "/desktop/import").status, 404);
    assert_eq!(get(port, "/desktop/confirm").status, 404);
    assert_eq!(post(port, "/desktop/nonsense", None).status, 404);
}

// ---------------------------------------------------------------------------
// message boxes — the other desktop-only half
// ---------------------------------------------------------------------------

#[test]
fn a_confirmed_question_answers_true() {
    let fixture = Fixture::confirming();
    let question = "Delete project \"work\" and its 2 scenes? This cannot be undone.";
    let body = serde_json::json!({ "title": "Delete project", "message": question }).to_string();

    let res = post(fixture.port(), "/desktop/confirm", Some(&body));
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "confirmed": true }));

    // The page's own wording reaches the box unaltered — the desktop asks the
    // question the web asks, in the platform's own dialog.
    assert_eq!(
        fixture.asked(),
        vec![Asked {
            kind: AskKind::Confirm,
            title: "Delete project".into(),
            message: question.into(),
        }]
    );
}

#[test]
fn a_declined_question_answers_false() {
    // The default stub declines, which is the answer a cancelled box gives.
    let fixture = Fixture::new();
    let body = serde_json::json!({ "message": "Overwrite scene \"work/checkout\"?" }).to_string();

    let res = post(fixture.port(), "/desktop/confirm", Some(&body));
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "confirmed": false }));
    // Asked all the same: declining is an answer, not a failure to ask.
    assert_eq!(fixture.asked().len(), 1);
    assert_eq!(fixture.asked()[0].kind, AskKind::Confirm);
}

#[test]
fn an_alert_shows_the_message_and_answers_ok() {
    let fixture = Fixture::new();
    let message = "Could not save scene: HTTP 409";
    let body = serde_json::json!({ "message": message }).to_string();

    let res = post(fixture.port(), "/desktop/alert", Some(&body));
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), serde_json::json!({ "ok": true }));

    // No title given, so the box wears the application's name.
    assert_eq!(
        fixture.asked(),
        vec![Asked {
            kind: AskKind::Alert,
            title: "Docent".into(),
            message: message.into(),
        }]
    );
}

#[test]
fn message_boxes_refuse_a_body_that_carries_no_message() {
    let fixture = Fixture::new();
    let port = fixture.port();

    for path in ["/desktop/confirm", "/desktop/alert"] {
        let not_json = post(port, path, Some("not json"));
        assert_eq!(not_json.status, 400, "{path} with a non-JSON body");
        assert_eq!(not_json.json()["error"], "body is not JSON");

        for body in [
            r#"{"title":"Docent"}"#,
            r#"{"message":42}"#,
            r#"{"message":null}"#,
            "[]",
        ] {
            let res = post(port, path, Some(body));
            assert_eq!(res.status, 400, "{path} with {body}");
            assert_eq!(res.json()["error"], "body is not a message");
        }
    }

    // Nothing was raised: a malformed ask is refused before it reaches the
    // screen, so no box appears that the user cannot make sense of.
    assert!(fixture.asked().is_empty());
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|read| {
            read.filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// linked projects (S25, D145-D147)
// ---------------------------------------------------------------------------

/// A directory playing the part of the person's code repo: outside the
/// portfolio, cleaned up with the test.
fn repo_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(unique_name(name));
    fs::create_dir_all(&dir).expect("repo dir");
    dir
}

#[test]
fn linked_project_lives_with_its_code() {
    let fixture = Fixture::new();
    let port = fixture.port();
    let repo = repo_dir("docent-repo");
    let root = repo.to_string_lossy().into_owned();

    // Link, read the link back, and see the project in the listing.
    let linked = put(
        port,
        "/api/projects/myrepo/link",
        Some(&format!(r#"{{"root":{}}}"#, serde_json::to_string(&root).unwrap())),
    );
    assert_eq!(linked.status, 201, "{}", linked.body);
    let told = get(port, "/api/projects/myrepo/link");
    assert_eq!(told.status, 200);
    assert!(told.body.contains("root"), "{}", told.body);
    let listing = get(port, "/api/projects");
    assert!(listing.body.contains(r#""id":"myrepo""#), "{}", listing.body);
    assert!(listing.body.contains(r#""linked":"#), "{}", listing.body);

    // Scenes flow through the one resolution door (D145): the file lands in
    // the repo, nested per D92, and reads back through the same routes.
    let saved = put(
        port,
        "/api/projects/myrepo/scenes/docs%2Farchitecture",
        Some(SCENE),
    );
    assert_eq!(saved.status, 200, "{}", saved.body);
    assert!(
        repo.join("docs").join("architecture.excalidraw").is_file(),
        "scene lands where the code lives"
    );
    let read = get(port, "/api/projects/myrepo/scenes/docs%2Farchitecture");
    assert_eq!(read.status, 200);

    // Deleting a linked project IS unlinking it (D145): the entry goes, the
    // person's files do not.
    let gone = delete(port, "/api/projects/myrepo");
    assert_eq!(gone.status, 200);
    assert!(gone.body.contains("unlinked"), "{}", gone.body);
    assert!(
        repo.join("docs").join("architecture.excalidraw").is_file(),
        "unlink touches nothing"
    );
    assert_eq!(get(port, "/api/projects/myrepo/link").status, 404);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn a_link_refuses_what_it_must() {
    let fixture = Fixture::new();
    let port = fixture.port();
    let repo = repo_dir("docent-repo-refuse");
    let root_json = serde_json::to_string(&repo.to_string_lossy().into_owned()).unwrap();

    // A directory that does not exist — an absolute path on every platform
    // (the Windows train lesson: a path is only absolute with its drive).
    let ghost = std::env::temp_dir().join(unique_name("docent-ghost"));
    let missing = put(
        port,
        "/api/projects/ghost/link",
        Some(&format!(
            r#"{{"root":{}}}"#,
            serde_json::to_string(&ghost.to_string_lossy().into_owned()).unwrap()
        )),
    );
    assert_eq!(missing.status, 400);
    assert!(missing.body.contains("not a directory"), "{}", missing.body);

    // A relative path.
    let relative = put(port, "/api/projects/rel/link", Some(r#"{"root":"docs"}"#));
    assert_eq!(relative.status, 400);
    assert!(relative.body.contains("absolute"), "{}", relative.body);

    // Inside the portfolio: no aliasing (D145).
    let inside = fixture.data_dir().join("plain");
    fs::create_dir_all(&inside).unwrap();
    let aliased = put(
        port,
        "/api/projects/alias/link",
        Some(&format!(
            r#"{{"root":{}}}"#,
            serde_json::to_string(&inside.to_string_lossy().into_owned()).unwrap()
        )),
    );
    assert_eq!(aliased.status, 400);
    assert!(aliased.body.contains("inside the portfolio"), "{}", aliased.body);

    // A name that already is a portfolio project.
    let collided = put(port, "/api/projects/plain/link", Some(&format!(r#"{{"root":{root_json}}}"#)));
    assert_eq!(collided.status, 400);
    assert!(collided.body.contains("already a portfolio project"), "{}", collided.body);

    // A linked project refuses a GitHub binding, loudly (D147).
    assert_eq!(
        put(port, "/api/projects/myrepo2/link", Some(&format!(r#"{{"root":{root_json}}}"#))).status,
        201
    );
    let bound = put(
        port,
        "/api/projects/myrepo2/binding",
        Some(r#"{"owner":"o","repo":"r","branch":"main","token":"t"}"#),
    );
    assert_eq!(bound.status, 400, "{}", bound.body);
    assert!(bound.body.contains("git stays your own"), "{}", bound.body);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn the_person_links_through_the_folder_picker() {
    let repo = repo_dir("MyService");
    // The stub answers the picker with the repo the person "chose".
    let fixture = Fixture::with_dialog(&repo.to_string_lossy());
    let port = fixture.port();

    let linked = post(port, "/desktop/link-project", None);
    assert_eq!(linked.status, 201, "{}", linked.body);
    // The project takes the folder's name (D146).
    assert!(linked.body.contains(r#""project":"MyService"#), "{}", linked.body);

    // Cancelling answers like every other dialog route.
    let cancelled = Fixture::new();
    let answer = post(cancelled.port(), "/desktop/link-project", None);
    assert_eq!(answer.status, 200);
    assert!(answer.body.contains("canceled"), "{}", answer.body);

    let _ = fs::remove_dir_all(&repo);
}

#[test]
fn repicking_a_linked_folder_is_idempotent() {
    let fixture = Fixture::new();
    let port = fixture.port();
    let repo = repo_dir("docent-repo-again");
    let other = repo_dir("docent-repo-other");
    let root_json = serde_json::to_string(&repo.to_string_lossy().into_owned()).unwrap();

    assert_eq!(
        put(port, "/api/projects/again/link", Some(&format!(r#"{{"root":{root_json}}}"#))).status,
        201
    );
    // The same folder again: same project, no fuss (D148).
    let again = put(port, "/api/projects/again/link", Some(&format!(r#"{{"root":{root_json}}}"#)));
    assert_eq!(again.status, 200, "{}", again.body);
    assert!(again.body.contains("existing"), "{}", again.body);
    // The same name for a different folder: refused, loudly.
    let stolen = put(
        port,
        "/api/projects/again/link",
        Some(&format!(
            r#"{{"root":{}}}"#,
            serde_json::to_string(&other.to_string_lossy().into_owned()).unwrap()
        )),
    );
    assert_eq!(stolen.status, 400, "{}", stolen.body);
    assert!(stolen.body.contains("already linked"), "{}", stolen.body);

    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&other);
}
