//! Contract tests for the update check (S13's notify tier, D25).
//!
//! The check reaches the network and ends in a native dialog, so both ends are
//! stubbed and the middle is exercised for real: a `tiny_http` server on
//! loopback stands in for `api.github.com`, and `RecordingDialog` stands in for
//! the message box, recording which dialog *would* have appeared. Nothing here
//! needs a display, a network, or a GitHub account.
//!
//! What is actually under test is the etiquette, which is the part that is easy
//! to get wrong and impossible to notice: the start-up check must not ask more
//! than once a day, must not announce the same release twice, and must say
//! nothing at all when it fails — while the menu check must always ask and
//! always answer. Each case gets its own server, its own state directory, and
//! its own dialog, so they run in parallel without sharing anything.

use std::fs;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use docent_lib::updates::{check_and_notify, Outcome, RecordingDialog, Trigger};

/// The version the tests pretend to be running.
const RUNNING: &str = "0.0.1";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// a stand-in for the releases API
// ---------------------------------------------------------------------------

/// What one request looked like from the server's side.
#[derive(Clone)]
struct Seen {
    user_agent: Option<String>,
    accept: Option<String>,
}

struct MockApi {
    server: Arc<tiny_http::Server>,
    worker: Option<JoinHandle<()>>,
    seen: Arc<Mutex<Vec<Seen>>>,
    url: String,
}

impl MockApi {
    /// A server that answers every request with `body` and remembers the
    /// headers each one carried.
    fn serving(body: String) -> Self {
        let server =
            tiny_http::Server::http((Ipv4Addr::LOCALHOST, 0)).expect("mock binds loopback");
        let port = server
            .server_addr()
            .to_ip()
            .expect("mock bound a TCP port")
            .port();
        let server = Arc::new(server);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let server = Arc::clone(&server);
            let seen = Arc::clone(&seen);
            thread::spawn(move || {
                for request in server.incoming_requests() {
                    seen.lock().expect("request log").push(Seen {
                        user_agent: header(&request, "User-Agent"),
                        accept: header(&request, "Accept"),
                    });
                    let response = tiny_http::Response::from_string(body.clone()).with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .expect("static header"),
                    );
                    let _ = request.respond(response);
                }
            })
        };
        Self {
            server,
            worker: Some(worker),
            seen,
            url: format!("http://127.0.0.1:{port}/repos/happyren/Docent/releases/latest"),
        }
    }

    /// A server answering with a release tagged `tag`.
    fn tagged(tag: &str) -> Self {
        Self::serving(release_payload(tag))
    }

    fn url(&self) -> &str {
        &self.url
    }

    fn hits(&self) -> usize {
        self.seen.lock().expect("request log").len()
    }

    fn request(&self, index: usize) -> Seen {
        self.seen
            .lock()
            .expect("request log")
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("no request #{index} was made"))
    }
}

impl Drop for MockApi {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn header(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

/// The shape GitHub actually answers with, trimmed but not simplified — the
/// extra fields are here on purpose, to prove the parse ignores them.
fn release_payload(tag: &str) -> String {
    serde_json::json!({
        "url": "https://api.github.com/repos/happyren/Docent/releases/373428408",
        "id": 373_428_408,
        "tag_name": tag,
        "name": format!("Docent {tag}"),
        "html_url": format!("https://github.com/happyren/Docent/releases/tag/{tag}"),
        "draft": false,
        "prerelease": false,
        "author": { "login": "github-actions[bot]", "id": 41_898_282 },
        "assets": [{
            "name": "Docent_macos_universal_portable.zip",
            "browser_download_url": "https://github.com/happyren/Docent/releases/download/x.zip"
        }],
        "body": "Release notes go here.\n\n- something\n- something else"
    })
    .to_string()
}

/// A URL with nothing behind it: a port is bound to learn a free one, then
/// released, so connecting to it is refused rather than merely slow.
fn closed_endpoint() -> String {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a free port");
    let port = listener.local_addr().expect("bound address").port();
    drop(listener);
    format!("http://127.0.0.1:{port}/repos/happyren/Docent/releases/latest")
}

// ---------------------------------------------------------------------------
// a stand-in for the app-data directory
// ---------------------------------------------------------------------------

struct StateDir {
    path: PathBuf,
}

impl StateDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(unique_name("docent-updates"));
        fs::create_dir_all(&path).expect("state directory is creatable");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn file(&self) -> PathBuf {
        self.path.join("update-check.json")
    }

    /// Seed the file the way a previous check would have left it.
    fn seed(&self, last_checked_at: u64, last_seen_tag: Option<&str>) {
        let state = serde_json::json!({
            "lastCheckedAt": last_checked_at,
            "lastSeenTag": last_seen_tag,
        });
        fs::write(self.file(), state.to_string()).expect("state file is writable");
    }

    fn read(&self) -> serde_json::Value {
        let raw = fs::read_to_string(self.file()).expect("state file was written");
        serde_json::from_str(&raw).expect("state file is JSON")
    }

    fn exists(&self) -> bool {
        self.file().exists()
    }
}

impl Drop for StateDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
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
            .expect("a clock after 1970")
            .as_nanos()
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_millis() as u64
}

/// The release page for a tag, which is what the "there is an update" dialog
/// offers to open.
fn page_for(tag: &str) -> String {
    format!("https://github.com/happyren/Docent/releases/tag/{tag}")
}

// ---------------------------------------------------------------------------
// what the check finds
// ---------------------------------------------------------------------------

#[test]
fn a_newer_release_offers_the_download_page() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

    assert_eq!(api.hits(), 1);
    assert_eq!(
        dialogs.shown(),
        vec![Outcome::Newer {
            version: "9.9.9".to_string(),
            current: "0.0.1".to_string(),
            url: page_for("v9.9.9"),
        }]
    );
    // The exact sentence the user reads, and the page the button opens.
    assert_eq!(
        dialogs.shown()[0].message(),
        "Docent 9.9.9 is available (you have 0.0.1)."
    );
    assert_eq!(
        dialogs.shown()[0].download_url(),
        Some(page_for("v9.9.9").as_str())
    );
}

#[test]
fn the_request_identifies_itself_the_way_github_requires() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();

    check_and_notify(
        &RecordingDialog::new(),
        api.url(),
        RUNNING,
        state.path(),
        Trigger::Menu,
    );

    let request = api.request(0);
    // GitHub answers a request with no User-Agent with a 403, so this header
    // is load-bearing rather than polite.
    assert_eq!(request.user_agent.as_deref(), Some("docent-updater"));
    assert_eq!(
        request.accept.as_deref(),
        Some("application/vnd.github+json")
    );
}

#[test]
fn the_current_release_reports_up_to_date() {
    let api = MockApi::tagged("v0.0.1");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

    assert_eq!(
        dialogs.shown(),
        vec![Outcome::UpToDate {
            current: "0.0.1".to_string()
        }]
    );
    assert_eq!(
        dialogs.shown()[0].message(),
        "You're on the latest version (0.0.1)."
    );
}

#[test]
fn an_older_release_is_not_an_update() {
    // A tag behind the running build — what a local build off master sees.
    let api = MockApi::tagged("v0.0.0");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

    assert_eq!(
        dialogs.shown(),
        vec![Outcome::UpToDate {
            current: "0.0.1".to_string()
        }]
    );
}

#[test]
fn a_tag_that_is_not_a_version_is_tolerated() {
    // A `nightly` or `v1.2.3-rc1` tag is not something to compare against, and
    // the check answers "up to date" rather than failing or chasing the user.
    for tag in ["nightly", "v9.9.9-rc1", "latest"] {
        let api = MockApi::tagged(tag);
        let state = StateDir::new();
        let dialogs = RecordingDialog::new();

        check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

        assert_eq!(
            dialogs.shown(),
            vec![Outcome::UpToDate {
                current: "0.0.1".to_string()
            }],
            "the {tag} tag should be inert"
        );
        // It was still seen, so the state file records it.
        assert_eq!(state.read()["lastSeenTag"], tag);
    }
}

#[test]
fn an_answer_that_is_not_a_release_is_reported_not_panicked_on() {
    let api = MockApi::serving("<html>rate limited</html>".to_string());
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

    let shown = dialogs.shown();
    assert!(
        matches!(shown.as_slice(), [Outcome::Failed { .. }]),
        "expected a failure, got {shown:?}"
    );
    assert!(shown[0]
        .message()
        .starts_with("Couldn't check for updates."));
}

// ---------------------------------------------------------------------------
// when it cannot ask
// ---------------------------------------------------------------------------

#[test]
fn a_refused_connection_is_reported_to_whoever_asked() {
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(
        &dialogs,
        &closed_endpoint(),
        RUNNING,
        state.path(),
        Trigger::Menu,
    );

    let shown = dialogs.shown();
    assert!(
        matches!(shown.as_slice(), [Outcome::Failed { .. }]),
        "expected a failure, got {shown:?}"
    );
    let message = shown[0].message();
    assert!(message.starts_with("Couldn't check for updates."));
    // The one-line detail is what makes it actionable rather than a shrug.
    assert!(
        message.len() > "Couldn't check for updates.".len() + 2,
        "the failure should carry a reason: {message:?}"
    );
    assert_eq!(shown[0].download_url(), None);
}

#[test]
fn a_failure_at_startup_says_nothing_but_still_counts_as_a_check() {
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    check_and_notify(
        &dialogs,
        &closed_endpoint(),
        RUNNING,
        state.path(),
        Trigger::Startup,
    );

    // Silence: a laptop opened without a network is not a modal.
    assert_eq!(dialogs.shown(), vec![]);
    // But the attempt is stamped, so an offline machine retries tomorrow
    // rather than on every single launch.
    assert!(state.exists());
    assert!(state.read()["lastCheckedAt"].as_u64().unwrap_or(0) > 0);
    assert_eq!(state.read()["lastSeenTag"], serde_json::Value::Null);
}

// ---------------------------------------------------------------------------
// how often it asks, and how often it says so
// ---------------------------------------------------------------------------

#[test]
fn a_fresh_state_file_stops_the_startup_check_before_the_request() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();
    state.seed(now_millis(), Some("v0.0.1"));

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Startup);

    // The throttle is a decision not to ask, not a filter on the answer: no
    // request left the machine at all.
    assert_eq!(api.hits(), 0);
    assert_eq!(dialogs.shown(), vec![]);
}

#[test]
fn a_day_old_state_file_lets_the_startup_check_through() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();
    state.seed(now_millis() - DAY_MS - 1, Some("v0.5.0"));

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Startup);

    assert_eq!(api.hits(), 1);
    assert_eq!(
        dialogs.shown(),
        vec![Outcome::Newer {
            version: "9.9.9".to_string(),
            current: "0.0.1".to_string(),
            url: page_for("v9.9.9"),
        }]
    );
}

#[test]
fn the_menu_check_ignores_the_throttle() {
    let api = MockApi::tagged("v0.0.1");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();
    state.seed(now_millis(), Some("v0.0.1"));

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);

    // The user pressed a button and is owed an answer, however recently the
    // start-up check ran.
    assert_eq!(api.hits(), 1);
    assert_eq!(
        dialogs.shown(),
        vec![Outcome::UpToDate {
            current: "0.0.1".to_string()
        }]
    );
}

#[test]
fn a_release_already_announced_does_not_nag_again() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();
    // Long enough ago to check, but this exact release has been announced.
    state.seed(now_millis() - DAY_MS - 1, Some("v9.9.9"));

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Startup);

    // It asked — and said nothing, because the user already knows.
    assert_eq!(api.hits(), 1);
    assert_eq!(dialogs.shown(), vec![]);
    // The menu is still how you get told again on demand.
    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Menu);
    assert_eq!(dialogs.shown().len(), 1);
}

#[test]
fn one_release_is_announced_once_and_the_next_one_again() {
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();

    // First launch ever: nothing is known, so the check runs and announces.
    let first = MockApi::tagged("v9.9.9");
    check_and_notify(
        &dialogs,
        first.url(),
        RUNNING,
        state.path(),
        Trigger::Startup,
    );
    assert_eq!(dialogs.shown().len(), 1);

    // Relaunching the same day does not even ask.
    check_and_notify(
        &dialogs,
        first.url(),
        RUNNING,
        state.path(),
        Trigger::Startup,
    );
    assert_eq!(first.hits(), 1);
    assert_eq!(dialogs.shown().len(), 1);

    // A day later, the same release is still latest — and still silent.
    state.seed(now_millis() - DAY_MS - 1, Some("v9.9.9"));
    check_and_notify(
        &dialogs,
        first.url(),
        RUNNING,
        state.path(),
        Trigger::Startup,
    );
    assert_eq!(first.hits(), 2);
    assert_eq!(dialogs.shown().len(), 1);

    // A *different* release is news again.
    let second = MockApi::tagged("v10.0.0");
    state.seed(now_millis() - DAY_MS - 1, Some("v9.9.9"));
    check_and_notify(
        &dialogs,
        second.url(),
        RUNNING,
        state.path(),
        Trigger::Startup,
    );
    assert_eq!(
        dialogs.shown().last(),
        Some(&Outcome::Newer {
            version: "10.0.0".to_string(),
            current: "0.0.1".to_string(),
            url: page_for("v10.0.0"),
        })
    );
}

// ---------------------------------------------------------------------------
// what it remembers
// ---------------------------------------------------------------------------

#[test]
fn every_completed_check_records_the_tag_and_the_time() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let before = now_millis();

    check_and_notify(
        &RecordingDialog::new(),
        api.url(),
        RUNNING,
        state.path(),
        Trigger::Menu,
    );

    let recorded = state.read();
    assert_eq!(recorded["lastSeenTag"], "v9.9.9");
    let stamp = recorded["lastCheckedAt"]
        .as_u64()
        .expect("lastCheckedAt is a number of milliseconds");
    assert!(
        stamp >= before && stamp <= now_millis(),
        "the stamp should be the moment of the check: {stamp}"
    );
    // Exactly the two documented keys, nothing else to keep in step.
    let object = recorded.as_object().expect("the state file is an object");
    assert_eq!(object.len(), 2, "unexpected keys in {recorded}");
}

#[test]
fn a_corrupt_state_file_is_treated_as_a_first_run() {
    let api = MockApi::tagged("v9.9.9");
    let state = StateDir::new();
    let dialogs = RecordingDialog::new();
    fs::write(state.file(), "{ this is not json").expect("state file is writable");

    check_and_notify(&dialogs, api.url(), RUNNING, state.path(), Trigger::Startup);

    // Unreadable means unknown, and unknown means ask — the only cost is one
    // request, and the alternative is a check that never runs again.
    assert_eq!(api.hits(), 1);
    assert_eq!(dialogs.shown().len(), 1);
    assert_eq!(state.read()["lastSeenTag"], "v9.9.9");
}

#[test]
fn a_state_directory_that_does_not_exist_yet_is_created() {
    let api = MockApi::tagged("v9.9.9");
    let parent = StateDir::new();
    // A profile whose app-data directory has never been written to.
    let nested = parent.path().join("not-created-yet");

    check_and_notify(
        &RecordingDialog::new(),
        api.url(),
        RUNNING,
        &nested,
        Trigger::Startup,
    );

    let raw = fs::read_to_string(nested.join("update-check.json"))
        .expect("the check created its own directory");
    assert!(raw.contains("v9.9.9"));
}
