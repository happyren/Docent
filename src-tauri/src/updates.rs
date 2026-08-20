//! Update checking (S13, D25) — the notify tier, and deliberately only that.
//! S13 puts auto-update out of scope for desktop v1, and staying at "notify"
//! keeps that literally true: nothing here downloads a build, verifies a
//! signature, or replaces a binary. The whole module is one GET against the
//! GitHub Releases API, a three-number comparison, and a message box.
//!
//! Two triggers, different in how loud they are:
//!
//!   * **Help → Check for Updates…** always asks and always answers, including
//!     "you're current" and "that didn't work" — the user pressed a button and
//!     is owed a result.
//!   * **Start-up** asks at most once a day and says nothing unless there is a
//!     release it has not already announced. A release nags once, not every
//!     morning, and a failed check at start-up is silent, because a laptop
//!     opened on a plane is not something to raise a modal about (S12's
//!     graceful degradation, applied to the network).
//!
//! Tauri is absent from this module for the same reason it is absent from
//! `store.rs`: the app-data directory, the running version, and the native
//! dialog all arrive as arguments, so the whole thing is drivable from a test
//! with a temporary directory and a loopback server, on a machine with no
//! display and no route to GitHub.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Where releases are published. `tag_name` and `html_url` are the only two
/// fields read out of the answer.
pub const GITHUB_LATEST_RELEASE: &str =
    "https://api.github.com/repos/happyren/Docent/releases/latest";

/// GitHub answers a request without a `User-Agent` with a 403, so this header
/// is a requirement of the API rather than a courtesy.
const USER_AGENT: &str = "docent-updater";

/// The file the last check is remembered in, under the app-data directory
/// beside the portfolio.
const STATE_FILE: &str = "update-check.json";

/// How stale the last start-up check has to be before another one runs.
const CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// A hung network must not hold the checking thread forever — nothing joins
/// it, but a thread parked on a dead socket for the life of the process is
/// still a leak.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// A release payload with every asset listed runs to a few tens of kilobytes.
/// The ceiling is the same discipline the store applies to bodies: an endpoint
/// that answers with something enormous is refused rather than buffered.
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

/// The label on the affirmative button of the "there is an update" box, and
/// the string the platform hands back when it is pressed. It lives here with
/// the rest of the user-facing text; the shell renders it.
pub const OPEN_LABEL: &str = "Open Download Page";

/// The label that dismisses the same box.
pub const LATER_LABEL: &str = "Later";

/// Where to ask. `DOCENT_UPDATE_URL` replaces the GitHub endpoint so a test or
/// a dry run can point the check at a local server. It is resolved once, by the
/// shell, and passed in from there — the checking code itself never reads the
/// environment, so parallel tests never contend over one process-wide value.
pub fn endpoint() -> String {
    std::env::var("DOCENT_UPDATE_URL").unwrap_or_else(|_| GITHUB_LATEST_RELEASE.to_string())
}

// ---------------------------------------------------------------------------
// what the user is told
// ---------------------------------------------------------------------------

/// Which of the two checks this is. They differ only in how much they say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// Help → Check for Updates…: always fetches, always answers.
    Menu,
    /// App start: at most once a day, and only when there is news.
    Startup,
}

/// The result of a check, as the thing the user would see. Returning it rather
/// than raising it inline is what lets a test assert on which dialog *would*
/// have appeared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A newer release exists. `version` and `current` are display forms, with
    /// the tag's leading `v` already stripped.
    Newer {
        version: String,
        current: String,
        url: String,
    },
    UpToDate {
        current: String,
    },
    Failed {
        error: String,
    },
}

impl Outcome {
    /// The dialog's headline.
    pub fn title(&self) -> &'static str {
        match self {
            Self::Newer { .. } => "Update Available",
            Self::UpToDate { .. } => "Up to Date",
            Self::Failed { .. } => "Update Check Failed",
        }
    }

    /// The dialog's body.
    pub fn message(&self) -> String {
        match self {
            Self::Newer {
                version, current, ..
            } => format!("Docent {version} is available (you have {current})."),
            Self::UpToDate { current } => format!("You're on the latest version ({current})."),
            // One line of detail, so "that didn't work" is actionable — a
            // refused connection and an unparseable answer are different
            // problems and the user can only tell them apart if we say so.
            Self::Failed { error } => format!("Couldn't check for updates.\n\n{error}"),
        }
    }

    /// The page to open if the user asks for it. `None` is what makes the
    /// dialog a plain OK box rather than a two-button one.
    pub fn download_url(&self) -> Option<&str> {
        match self {
            Self::Newer { url, .. } => Some(url),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------

/// How the updater says something to the user — the message-box sibling of
/// `store::FileDialog`, and behind a trait for the same two reasons: the native
/// implementation has to hop to the main thread and needs the shell's handle to
/// do it, and a test has no display to raise a box on.
pub trait MessageDialog: Send + Sync + 'static {
    /// Show `outcome`, and answer whether the user asked for the download page.
    /// Always `false` for an outcome that offers no such button.
    fn show(&self, outcome: &Outcome) -> bool;
}

/// A dialog stand-in that raises nothing and remembers everything, so a test
/// can assert on which dialog would have appeared. It doubles as the sink for
/// `DOCENT_DIALOG_STUB` runs — the same variable the store's file dialogs
/// answer to — so an app started without a display records the outcome instead
/// of blocking on a box nobody can dismiss.
#[derive(Default)]
pub struct RecordingDialog {
    shown: Mutex<Vec<Outcome>>,
}

impl RecordingDialog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_env() -> Option<Self> {
        std::env::var("DOCENT_DIALOG_STUB")
            .ok()
            .map(|_| Self::new())
    }

    /// Every outcome shown so far, oldest first.
    pub fn shown(&self) -> Vec<Outcome> {
        self.log().clone()
    }

    fn log(&self) -> std::sync::MutexGuard<'_, Vec<Outcome>> {
        // A poisoned lock means a test already panicked; recovering the log is
        // more useful than a second panic on top of the first.
        self.shown.lock().unwrap_or_else(|err| err.into_inner())
    }
}

impl MessageDialog for RecordingDialog {
    fn show(&self, outcome: &Outcome) -> bool {
        self.log().push(outcome.clone());
        // Declining keeps a headless run from launching a browser.
        false
    }
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

/// A release tag as three numbers. Docent tags releases `vX.Y.Z` and nothing
/// else, so anything that is not exactly three numeric components — `nightly`,
/// `v1.2.3-rc1`, an empty string — parses to `None`. Refusing to guess is the
/// safe direction: the cost is a missed notification, where the alternative is
/// chasing a user toward something that is not a release.
fn parse_version(raw: &str) -> Option<[u64; 3]> {
    let trimmed = raw.trim();
    let mut parts = trimmed.strip_prefix('v').unwrap_or(trimmed).split('.');
    let mut version = [0_u64; 3];
    for component in &mut version {
        *component = parts.next()?.parse().ok()?;
    }
    // A fourth component means this is not the shape we know how to order.
    parts.next().is_none().then_some(version)
}

/// Whether `tag` names a release newer than the running `current` version.
/// Array ordering is component-wise and left-to-right, which is exactly the
/// major/minor/patch comparison — no semver crate needed for three integers.
pub fn is_newer(tag: &str, current: &str) -> bool {
    match (parse_version(tag), parse_version(current)) {
        (Some(latest), Some(running)) => latest > running,
        // Either side unparseable: see `parse_version`.
        _ => false,
    }
}

/// Tags carry a leading `v`; the version the user is shown does not.
fn without_v(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

// ---------------------------------------------------------------------------
// the state file
// ---------------------------------------------------------------------------

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct State {
    /// Milliseconds since the epoch — the same clock the store stamps scenes
    /// with. Zero means "never checked".
    last_checked_at: u64,
    /// The tag the last completed check saw, which is what keeps one release
    /// from being announced again at every launch for as long as it is latest.
    last_seen_tag: Option<String>,
}

impl State {
    fn load(dir: &Path) -> Self {
        // A missing file is a first run, and an unreadable or malformed one is
        // treated identically: the only cost of deciding to check again is one
        // request, so there is nothing to gain by being strict here.
        fs::read_to_string(dir.join(STATE_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: &Path) {
        // Best effort by design: a read-only app-data directory should cost the
        // user a repeated check, not an error they have to dismiss.
        let written = fs::create_dir_all(dir)
            .and_then(|()| serde_json::to_string(self).map_err(std::io::Error::other))
            .and_then(|json| fs::write(dir.join(STATE_FILE), json));
        if let Err(err) = written {
            eprintln!("docent: could not record the update check — {err}");
        }
    }

    fn is_fresh(&self, now: u64) -> bool {
        // A stamp in the future means the clock moved, not that a check just
        // ran — treat it as stale and check, rather than never checking again.
        now >= self.last_checked_at && now - self.last_checked_at < CHECK_INTERVAL_MS
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

/// The two fields this app reads out of a release. Everything else GitHub
/// returns — assets, authors, release notes — is ignored by serde, so the rest
/// of the payload's shape is not something that can break the check.
#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
}

fn fetch_latest(endpoint: &str) -> Result<Release, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(FETCH_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(endpoint)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(one_line)?;
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(one_line)?;
    serde_json::from_str(&body).map_err(|err| format!("unexpected response — {err}"))
}

/// Dialogs get one line, not a stack trace.
fn one_line(err: impl std::fmt::Display) -> String {
    err.to_string().replace('\n', " ")
}

// ---------------------------------------------------------------------------
// the browser hand-off
// ---------------------------------------------------------------------------

/// Only a plain `https` URL is ever handed to the platform opener. The URL
/// arrives in an HTTP response, and on Windows `cmd /C start` re-parses its
/// argument, where `&` separates a second command rather than a query
/// parameter — so the characters that could mean something to a shell are
/// refused outright rather than escaped. Docent's own release URLs are
/// `https://github.com/happyren/Docent/releases/tag/vX.Y.Z`, which is well
/// inside this.
fn is_openable(url: &str) -> bool {
    url.len() <= 2048
        && url.starts_with("https://")
        && url.bytes().all(|byte| {
            byte.is_ascii_graphic()
                && !matches!(
                    byte,
                    b'&' | b'|' | b'^' | b'<' | b'>' | b'"' | b'\'' | b'`' | b'%' | b'$' | b'\\'
                )
        })
}

/// The one command each platform has for "open this in whatever handles it".
/// Built rather than run, so the argv is assertable in a test; no opener crate,
/// because this is the entirety of what one would do.
fn open_command(url: &str) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(url);
        command
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        // The empty argument is `start`'s window-title parameter: without it,
        // `start` reads the URL as the title and opens nothing.
        command.args(["/C", "start", "", url]);
        command
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    }
}

fn open_url(url: &str) {
    if !is_openable(url) {
        eprintln!("docent: refusing to open an unexpected release URL — {url}");
        return;
    }
    // Spawned and not waited on: the opener hands off to the browser and this
    // thread has nothing left to do.
    if let Err(err) = open_command(url).spawn() {
        eprintln!("docent: could not open the release page — {err}");
    }
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

/// Decide whether to ask, ask, record what was learned, and answer with what
/// the user should be told — `None` when the answer is "nothing".
fn check(endpoint: &str, current: &str, state_dir: &Path, trigger: Trigger) -> Option<Outcome> {
    let state = State::load(state_dir);
    let now = now_millis();

    // The throttle is a decision, not a filter on the result: a fresh state
    // file means no request leaves the machine at all.
    if trigger == Trigger::Startup && state.is_fresh(now) {
        return None;
    }

    let release = match fetch_latest(endpoint) {
        Ok(release) => release,
        Err(error) => {
            // A failed check still happened, so it still stamps — an offline
            // machine retries tomorrow rather than on every launch. The tag is
            // left as it was, because nothing was learned about it.
            State {
                last_checked_at: now,
                last_seen_tag: state.last_seen_tag,
            }
            .save(state_dir);
            return match trigger {
                Trigger::Menu => Some(Outcome::Failed { error }),
                Trigger::Startup => {
                    eprintln!("docent: update check failed — {error}");
                    None
                }
            };
        }
    };

    let newer = is_newer(&release.tag_name, current);
    // Read before the stamp overwrites it: this is what makes one release
    // announce itself once rather than every day it stays latest.
    let already_announced = state.last_seen_tag.as_deref() == Some(release.tag_name.as_str());
    State {
        last_checked_at: now,
        last_seen_tag: Some(release.tag_name.clone()),
    }
    .save(state_dir);

    let running = without_v(current).to_string();
    let announcement = Outcome::Newer {
        version: without_v(&release.tag_name).to_string(),
        current: running.clone(),
        url: release.html_url,
    };
    match trigger {
        Trigger::Menu if newer => Some(announcement),
        Trigger::Menu => Some(Outcome::UpToDate { current: running }),
        Trigger::Startup if newer && !already_announced => Some(announcement),
        Trigger::Startup => None,
    }
}

/// The whole flow behind both triggers: check, show whatever the user is owed,
/// and open the release page if they asked for it.
pub fn check_and_notify(
    dialogs: &dyn MessageDialog,
    endpoint: &str,
    current: &str,
    state_dir: &Path,
    trigger: Trigger,
) {
    let Some(outcome) = check(endpoint, current, state_dir, trigger) else {
        return;
    };
    if !dialogs.show(&outcome) {
        return;
    }
    let Some(url) = outcome.download_url() else {
        return;
    };
    open_url(url);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_ordered_component_by_component() {
        assert!(is_newer("v0.1.0", "0.0.1"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(is_newer("v0.2.0", "0.1.99"));
        assert!(is_newer("v0.0.2", "0.0.1"));
        // Ten sorts after nine, which is the whole reason this is not a string
        // comparison.
        assert!(is_newer("v0.10.0", "0.9.0"));

        assert!(!is_newer("v0.0.1", "0.0.1"));
        assert!(!is_newer("v0.0.1", "0.1.0"));
        assert!(!is_newer("v0.9.0", "0.10.0"));
    }

    #[test]
    fn the_leading_v_is_optional_on_both_sides() {
        assert!(is_newer("1.0.0", "v0.1.0"));
        assert!(is_newer("v1.0.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "v1.0.0"));
    }

    #[test]
    fn a_tag_that_is_not_three_numbers_is_never_newer() {
        for tag in [
            "nightly",
            "",
            "v",
            "v1",
            "v1.2",
            "v1.2.3.4",
            "v1.2.3-rc1",
            "v1.2.x",
            "latest",
            "v-1.0.0",
        ] {
            assert!(!is_newer(tag, "0.0.1"), "{tag:?} should not be newer");
        }
        // …and an unparseable *running* version is just as inert, so a fork
        // that versions itself differently is never nagged.
        assert!(!is_newer("v9.9.9", "nightly"));
    }

    #[test]
    fn only_plain_https_urls_reach_the_platform_opener() {
        assert!(is_openable(
            "https://github.com/happyren/Docent/releases/tag/v1.2.3"
        ));

        for url in [
            "http://github.com/happyren/Docent",
            "file:///etc/passwd",
            "javascript:alert(1)",
            // Every one of these means something to `cmd /C start`.
            "https://example.com/?a=1&calc",
            "https://example.com/%USERPROFILE%",
            "https://example.com/a|b",
            "https://example.com/a b",
            "",
        ] {
            assert!(!is_openable(url), "{url:?} should not be opened");
        }
        assert!(!is_openable(&format!(
            "https://example.com/{}",
            "a".repeat(2048)
        )));
    }

    #[test]
    fn the_opener_passes_the_url_as_one_argument() {
        let url = "https://github.com/happyren/Docent/releases/tag/v1.2.3";
        let command = open_command(url);
        let args: Vec<_> = command.get_args().collect();
        // Whatever the platform's opener is, the URL is its own argv entry and
        // never part of a string a shell gets to re-split.
        assert_eq!(
            args.last().map(|arg| arg.to_string_lossy()),
            Some(url.into())
        );
        assert!(!command.get_program().is_empty());
    }

    #[test]
    fn the_throttle_survives_a_clock_that_moved_backwards() {
        let day = CHECK_INTERVAL_MS;
        let state = State {
            last_checked_at: 10 * day,
            last_seen_tag: None,
        };
        assert!(state.is_fresh(10 * day));
        assert!(state.is_fresh(10 * day + day - 1));
        assert!(!state.is_fresh(10 * day + day));
        // The stamp is in the future: check anyway, rather than never again.
        assert!(!state.is_fresh(day));
        // A first run has never checked.
        assert!(!State::default().is_fresh(now_millis()));
    }

    #[test]
    fn outcomes_read_the_way_the_dialogs_should() {
        let newer = Outcome::Newer {
            version: "1.2.0".into(),
            current: "0.0.1".into(),
            url: "https://github.com/happyren/Docent/releases/tag/v1.2.0".into(),
        };
        assert_eq!(
            newer.message(),
            "Docent 1.2.0 is available (you have 0.0.1)."
        );
        assert_eq!(
            newer.download_url(),
            Some("https://github.com/happyren/Docent/releases/tag/v1.2.0")
        );

        let current = Outcome::UpToDate {
            current: "0.0.1".into(),
        };
        assert_eq!(current.message(), "You're on the latest version (0.0.1).");
        // No URL is what makes this a one-button box.
        assert_eq!(current.download_url(), None);

        let failed = Outcome::Failed {
            error: "connection refused".into(),
        };
        assert!(failed.message().starts_with("Couldn't check for updates."));
        assert!(failed.message().ends_with("connection refused"));
        assert_eq!(failed.download_url(), None);
    }

    #[test]
    fn the_recording_dialog_remembers_and_declines() {
        let dialogs = RecordingDialog::new();
        let outcome = Outcome::UpToDate {
            current: "0.0.1".into(),
        };
        assert!(!dialogs.show(&outcome), "a stub must never open a browser");
        assert_eq!(dialogs.shown(), vec![outcome]);
    }
}
