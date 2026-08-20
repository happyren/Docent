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
//!
//! `/desktop/import` and `/desktop/export` are the one part with no self-host
//! counterpart: the system webview has no File System Access API and ignores
//! anchor downloads, so reading or writing a file outside the portfolio has to
//! happen here, behind a native dialog. `/desktop/confirm` and `/desktop/alert`
//! join them for the same reason one step further out: the webview implements
//! none of `window.confirm`, `window.alert` or `window.prompt` — confirm()
//! answers false instantly with no box on screen, alert() vanishes — so a page
//! that asks the user anything has to ask through here or not at all.
//!
//! A project may be bound to a GitHub repository instead (S14, D27), in which
//! case its scenes are read and written over GitHub's HTTP API and its local
//! directory is left alone. The rules for that live in `github.rs`; this file
//! only routes to them, and holds the one thing the desktop must decide for
//! itself: where the token file goes (the app's config directory, never the
//! portfolio).

use std::fs;
use std::io::{ErrorKind, Read};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::UNIX_EPOCH;

use tiny_http::{Header, Method, Request, Response, Server};

use crate::github::{self, Binding, Cache};

const MAX_SCENE_BYTES: usize = 50 * 1024 * 1024;
/// Import reads whatever file the user pointed at. The scene ceiling would let
/// one mis-click pull a video into memory, so this direction stops earlier.
const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
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

/// The conflict token a bound scene carries in both directions (S14). Because
/// the desktop store is cross-origin, it has to be named twice in the CORS
/// answer — allowed on the way in, exposed on the way out — or the page could
/// send it and never read it back.
const SCENE_SHA_HEADER: &str = "X-Docent-Scene-Sha";

/// The title every message box wears unless the page names one. It is the
/// application's name because that is what a native box is expected to say
/// where the web's `window.confirm` says the origin.
const DIALOG_TITLE: &str = "Docent";

/// How the store asks the user something the page cannot ask for itself: for a
/// path, or for a plain yes/no. The native implementations live in the shell
/// (`src/lib.rs`) rather than here, because a macOS dialog may only be raised
/// on the main thread and only the shell holds the handle that can hop onto it.
/// Behind a trait, the HTTP plumbing is also testable where there is no display
/// at all.
pub trait Dialogs: Send + Sync + 'static {
    /// The open dialog. `None` is a cancelled dialog, not a failure.
    fn pick_open(&self) -> Option<PathBuf>;
    /// The save dialog, seeded with `suggested_name`.
    fn pick_save(&self, suggested_name: &str) -> Option<PathBuf>;
    /// A question with two answers. `true` is the affirmative, exactly as
    /// `window.confirm` returns it on the web — the page's destructive actions
    /// read this the same way in both places.
    fn confirm(&self, title: &str, message: &str) -> bool;
    /// A message with one button. There is nothing to answer, only to read.
    fn alert(&self, title: &str, message: &str);
}

/// One message box the stub swallowed: which kind it was, and exactly what it
/// would have said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asked {
    pub kind: AskKind,
    pub title: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskKind {
    Confirm,
    Alert,
}

/// A dialog stand-in for environments that have no display: `cancel` answers
/// as a cancelled file dialog, any other value is the path the user "picked",
/// and every message box is recorded rather than raised — so a test can assert
/// on what the user would have been asked.
/// `DOCENT_DIALOG_STUB` selects it in a running app; tests construct it
/// directly, so parallel cases never contend over one process-wide variable.
pub struct StubDialog {
    answer: String,
    confirms: bool,
    asked: Mutex<Vec<Asked>>,
}

impl StubDialog {
    pub fn new(answer: impl Into<String>) -> Self {
        Self {
            answer: answer.into(),
            // Declining by default, the way `updates::RecordingDialog` declines
            // to launch a browser: a run with no display must not let a
            // destructive action through on an answer nobody gave.
            confirms: false,
            asked: Mutex::new(Vec::new()),
        }
    }

    /// How this stub answers confirmations. Builder rather than a constructor
    /// argument so `new("cancel")` keeps reading as "the file dialogs cancel".
    pub fn confirming(mut self, confirms: bool) -> Self {
        self.confirms = confirms;
        self
    }

    pub fn from_env() -> Option<Self> {
        std::env::var("DOCENT_DIALOG_STUB").ok().map(Self::new)
    }

    /// Every message box raised so far, oldest first.
    pub fn asked(&self) -> Vec<Asked> {
        self.log().clone()
    }

    fn log(&self) -> std::sync::MutexGuard<'_, Vec<Asked>> {
        // A poisoned lock means a test already panicked; recovering the log is
        // more useful than a second panic on top of the first.
        self.asked.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn answer(&self) -> Option<PathBuf> {
        if self.answer == "cancel" {
            None
        } else {
            Some(PathBuf::from(&self.answer))
        }
    }

    fn record(&self, kind: AskKind, title: &str, message: &str) {
        self.log().push(Asked {
            kind,
            title: title.to_string(),
            message: message.to_string(),
        });
    }
}

impl Dialogs for StubDialog {
    fn pick_open(&self) -> Option<PathBuf> {
        self.answer()
    }

    fn pick_save(&self, _suggested_name: &str) -> Option<PathBuf> {
        self.answer()
    }

    fn confirm(&self, title: &str, message: &str) -> bool {
        self.record(AskKind::Confirm, title, message);
        self.confirms
    }

    fn alert(&self, title: &str, message: &str) {
        self.record(AskKind::Alert, title, message);
    }
}

/// Everything a request needs that is not the request: where the portfolio
/// lives, where tokens live (deliberately somewhere else), and the process's
/// GitHub caches.
struct Context {
    data_dir: PathBuf,
    secrets_file: PathBuf,
    cache: Cache,
}

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
/// `secrets_file` is where GitHub tokens are kept — the caller passes a path
/// outside `data_dir`, because D27 forbids secrets in the data tree.
pub fn spawn(
    data_dir: PathBuf,
    secrets_file: PathBuf,
    dialogs: Arc<dyn Dialogs>,
) -> std::io::Result<StoreHandle> {
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
        let context = Context {
            data_dir,
            secrets_file,
            cache: Cache::new(),
        };
        thread::spawn(move || {
            // One request at a time: every handler is a stat, a read, or a
            // rename against the local disk, and a single user's canvas never
            // queues deep enough for a pool to pay for itself. A dialog holds
            // the thread for as long as it is open, which is the point — the
            // user is answering it, and nothing else should proceed meanwhile.
            // A bound project's handlers reach GitHub instead, which is the
            // one case where the queue is worth knowing about: a save waits on
            // the network, and the next request waits on the save.
            for request in server.incoming_requests() {
                serve(&context, dialogs.as_ref(), request);
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

/// A successful reply: a status, a body that is already JSON text, and the
/// headers this particular route adds (only the scene sha, so far).
struct Reply {
    status: u16,
    json: String,
    headers: Vec<(&'static str, String)>,
}

impl Reply {
    fn ok(json: impl Into<String>) -> Self {
        Self::new(200, json)
    }

    fn new(status: u16, json: impl Into<String>) -> Self {
        Self {
            status,
            json: json.into(),
            headers: Vec::new(),
        }
    }

    fn with_header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

impl From<github::Failure> for HttpError {
    fn from(failure: github::Failure) -> Self {
        Self::new(failure.status, failure.message)
    }
}

fn serve(context: &Context, dialogs: &dyn Dialogs, mut request: Request) {
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
                "GET, POST, PUT, DELETE, OPTIONS",
            ))
            .with_header(header(
                "Access-Control-Allow-Headers",
                &format!("content-type, {SCENE_SHA_HEADER}"),
            ))
            .with_header(header("Access-Control-Max-Age", "86400"));
        for extra in cors_headers(origin.as_deref()) {
            response = response.with_header(extra);
        }
        let _ = request.respond(response);
        return;
    }

    let (status, body, extra_headers) =
        match dispatch(context, dialogs, origin.as_deref(), &mut request) {
            Ok(reply) => (reply.status, reply.json, reply.headers),
            Err(err) => (
                err.status,
                serde_json::json!({ "error": err.message }).to_string(),
                Vec::new(),
            ),
        };

    let mut response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    for (name, value) in extra_headers {
        response = response.with_header(header(name, &value));
    }
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
            // Without this the page can send the conflict token but never read
            // the new one back, and every second save would be a false
            // conflict.
            headers.push(header("Access-Control-Expose-Headers", SCENE_SHA_HEADER));
        }
    }
    headers
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header name and value are valid")
}

fn dispatch(
    context: &Context,
    dialogs: &dyn Dialogs,
    origin: Option<&str>,
    request: &mut Request,
) -> Result<Reply> {
    let data_dir = context.data_dir.as_path();
    let method = request.method().clone();
    let segments = path_segments(request.url());
    let part = |i: usize| segments.get(i).map(String::as_str);

    // The endpoints that raise something on the user's screen: two that reach
    // outside the portfolio into whatever file the dialog points at, and two
    // that put a message box in front of them. They are POSTs a page can send
    // without a preflight, so CORS alone would not stop one — the app's own
    // origin is required outright, and an unknown or absent one never raises a
    // dialog.
    if part(0) == Some("desktop") {
        if method != Method::Post {
            return Err(HttpError::new(404, "not found"));
        }
        if !origin.is_some_and(|origin| ALLOWED_ORIGINS.contains(&origin)) {
            return Err(HttpError::new(403, "forbidden"));
        }
        return match part(1) {
            Some("import") if segments.len() == 2 => import_file(dialogs),
            Some("export") if segments.len() == 2 => export_file(dialogs, request),
            Some("confirm") if segments.len() == 2 => ask(dialogs, request, AskKind::Confirm),
            Some("alert") if segments.len() == 2 => ask(dialogs, request, AskKind::Alert),
            _ => Err(HttpError::new(404, "not found")),
        };
    }

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
        return list_projects(context);
    }

    if segments.len() == 3 {
        let project = &segments[2];
        if method == Method::Put {
            fs::create_dir_all(project_dir(data_dir, project)?).map_err(internal)?;
            return Ok(Reply::new(
                201,
                serde_json::json!({ "id": project }).to_string(),
            ));
        }
        if method == Method::Delete {
            let dir = project_dir(data_dir, project)?;
            // Deleting a bound project unbinds it and removes the local
            // directory. Nothing on GitHub is touched — the repository is the
            // user's, and a portfolio operation must never reach into it
            // destructively.
            remove_binding(context, project)?;
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

    // Binding routes (S14). Every one of them validates the project name
    // first, so a malformed name never reaches the bindings file either.
    if segments.len() == 4 && part(3) == Some("binding") {
        let project = &segments[2];
        check_name(project, "project")?;
        if method == Method::Get {
            let binding = github::load_bindings(data_dir)
                .remove(project)
                .ok_or_else(|| {
                    HttpError::new(404, format!("no GitHub binding for project: {project}"))
                })?;
            let has_token = github::token_for(&context.secrets_file, project).is_some();
            return Ok(Reply::ok(
                serde_json::to_string(&binding.public(has_token)).map_err(json)?,
            ));
        }
        if method == Method::Put {
            return put_binding(context, project, &read_body(request)?);
        }
        // Idempotent, like the project delete above: unbinding what is already
        // unbound is a success.
        if method == Method::Delete {
            remove_binding(context, project)?;
            return Ok(Reply::ok(r#"{"ok":true}"#));
        }
    }

    // Branch routes (S14, D28). Only a bound project has branches at all, so
    // an unbound one answers the same 404 its binding does.
    if segments.len() == 4 && part(3) == Some("branches") {
        let project = &segments[2];
        check_name(project, "project")?;
        if method == Method::Get {
            let (binding, token) = bound_or_404(context, project)?;
            let branches = github::list_branches(&binding, &token)?;
            return Ok(Reply::ok(serde_json::to_string(&branches).map_err(json)?));
        }
        if method == Method::Post {
            require_app_origin(origin)?;
            let (binding, token) = bound_or_404(context, project)?;
            let body = read_body(request)?;
            return create_branch(context, project, &binding, &token, &body);
        }
    }

    if segments.len() == 4 && part(3) == Some("pull-request") && method == Method::Post {
        let project = &segments[2];
        check_name(project, "project")?;
        require_app_origin(origin)?;
        let (binding, token) = bound_or_404(context, project)?;
        let body = read_body(request)?;
        return open_pull_request(&binding, &token, &body);
    }

    if segments.len() == 4 && part(3) == Some("scenes") && method == Method::Get {
        let project = &segments[2];
        if let Some((binding, token)) = bound(context, project)? {
            let scenes = github::list(project, &binding, &token, &context.cache)?;
            return Ok(Reply::ok(serde_json::to_string(&scenes).map_err(json)?));
        }
        return list_scenes(data_dir, project);
    }

    if segments.len() == 5 && part(3) == Some("scenes") {
        let (project, scene) = (&segments[2], &segments[4]);
        let file = scene_path(data_dir, project, scene)?;
        // A bound project's scenes live in the repository; the local directory
        // stays on disk but is not read, not written, and not listed.
        let bound = bound(context, project)?;

        if method == Method::Get {
            if let Some((binding, token)) = &bound {
                let (raw, sha) = github::load(project, binding, token, &context.cache, scene)?;
                return Ok(Reply::ok(raw).with_header(SCENE_SHA_HEADER, sha));
            }
            return match fs::read_to_string(&file) {
                Ok(raw) => Ok(Reply::ok(raw)),
                Err(_) => Err(HttpError::new(
                    404,
                    format!("no such scene: {project}/{scene}"),
                )),
            };
        }

        if method == Method::Put {
            let header_sha = request
                .headers()
                .iter()
                .find(|h| h.field.equiv(SCENE_SHA_HEADER))
                .map(|h| h.value.as_str().to_string());
            let body = read_body(request)?;
            // The store persists .excalidraw files and nothing else (D17) —
            // reject anything that isn't one, loudly. Bound or not.
            let parsed: serde_json::Value =
                serde_json::from_str(&body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
            if parsed.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
                return Err(HttpError::new(400, "body is not an .excalidraw scene"));
            }
            if let Some((binding, token)) = &bound {
                let sha = github::save(
                    project,
                    binding,
                    token,
                    &context.cache,
                    scene,
                    &body,
                    header_sha.as_deref(),
                )?;
                return Ok(Reply::ok(
                    serde_json::json!({ "ok": true, "sha": sha }).to_string(),
                ));
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
            if let Some((binding, token)) = &bound {
                github::delete(project, binding, token, &context.cache, scene)?;
                return Ok(Reply::ok(r#"{"ok":true}"#));
            }
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

// ---------------------------------------------------------------------------
// bindings
// ---------------------------------------------------------------------------

/// Everything a GitHub call needs, or `None` when the project is a plain local
/// one. A binding with no token is refused here rather than at GitHub, so the
/// answer is the same 401 either way and no pointless request leaves the
/// machine.
fn bound(context: &Context, project: &str) -> Result<Option<(Binding, String)>> {
    let Some(binding) = github::load_bindings(&context.data_dir).remove(project) else {
        return Ok(None);
    };
    let token = github::token_for(&context.secrets_file, project)
        .ok_or_else(|| HttpError::new(401, github::TOKEN_ERROR))?;
    Ok(Some((binding, token)))
}

/// The same, for routes that only exist on a bound project (D28).
fn bound_or_404(context: &Context, project: &str) -> Result<(Binding, String)> {
    bound(context, project)?
        .ok_or_else(|| HttpError::new(404, format!("no GitHub binding for project: {project}")))
}

/// A POST with a `text/plain` body is a "simple request": no preflight, so the
/// CORS answer alone would not stop a page in the user's browser from firing
/// one at this store's loopback port. It could not read the reply — but the
/// branch would exist, and the pull request would be open. So a request that
/// names an origin has to name this app's, exactly as `/desktop` requires.
/// An absent Origin is not a browser at all (curl, the parity harness).
fn require_app_origin(origin: Option<&str>) -> Result<()> {
    match origin {
        Some(origin) if !ALLOWED_ORIGINS.contains(&origin) => Err(HttpError::new(403, "forbidden")),
        _ => Ok(()),
    }
}

/// Create a branch off another one and start drafting on it. Creating without
/// switching would leave the user editing the base they just branched away
/// from, which is the mistake this route exists to prevent.
fn create_branch(
    context: &Context,
    project: &str,
    binding: &Binding,
    token: &str,
    body: &str,
) -> Result<Reply> {
    let input = object_body(body, "a branch")?;
    let name = match input.get("name") {
        Some(serde_json::Value::String(name)) => name.clone(),
        _ => return Err(HttpError::new(400, github::BRANCH_NAME_ERROR)),
    };
    github::check_new_branch(&name)?;
    let from = match input.get("from") {
        None | Some(serde_json::Value::Null) => binding.branch.clone(),
        Some(serde_json::Value::String(from)) if from.is_empty() => binding.branch.clone(),
        Some(serde_json::Value::String(from)) => {
            github::check_branch(from)?;
            from.clone()
        }
        Some(_) => return Err(HttpError::new(400, github::BRANCH_ERROR)),
    };
    github::create_branch(binding, token, &name, &from)?;
    set_active_branch(context, project, &name)?;
    Ok(Reply::new(
        201,
        serde_json::to_string(&BranchAnswer {
            ok: true,
            branch: name,
        })
        .map_err(json)?,
    ))
}

fn open_pull_request(binding: &Binding, token: &str, body: &str) -> Result<Reply> {
    let input = object_body(body, "a pull request")?;
    let title = input.get("title").and_then(|title| title.as_str());
    let description = input.get("body").and_then(|body| body.as_str());
    let (url, number) = github::open_pull_request(binding, token, title, description)?;
    Ok(Reply::new(
        201,
        serde_json::to_string(&PullRequestAnswer {
            ok: true,
            url,
            number,
        })
        .map_err(json)?,
    ))
}

/// The body of a POST, as an object; anything else is the client's mistake.
fn object_body(body: &str, what: &str) -> Result<serde_json::Value> {
    if body.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
    if !parsed.is_object() {
        return Err(HttpError::new(400, format!("body is not {what}")));
    }
    Ok(parsed)
}

/// Point the binding at another branch, keeping everything else exactly as it
/// is — the base, the probe's verdict, the token (which lives elsewhere
/// entirely).
fn set_active_branch(context: &Context, project: &str, branch: &str) -> Result<()> {
    let mut bindings = github::load_bindings(&context.data_dir);
    if let Some(binding) = bindings.get_mut(project) {
        binding.branch = branch.to_string();
        github::save_bindings(&context.data_dir, &bindings).map_err(internal)?;
    }
    // A different branch is a different set of scenes: whatever this process
    // remembered about the old one is now wrong rather than merely stale.
    context.cache.forget_all(project);
    Ok(())
}

/// What a stored binding answers with. A struct rather than a `json!` literal
/// so the key order is the reference store's, which sorts nothing.
#[derive(serde::Serialize)]
struct BindingAnswer {
    ok: bool,
    #[serde(rename = "canWrite")]
    can_write: Option<bool>,
    #[serde(rename = "baseBranch")]
    base_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

/// What a created branch answers with (D28).
#[derive(serde::Serialize)]
struct BranchAnswer {
    ok: bool,
    branch: String,
}

/// …and an opened pull request: where to go and look at it.
#[derive(serde::Serialize)]
struct PullRequestAnswer {
    ok: bool,
    url: String,
    number: i64,
}

fn put_binding(context: &Context, project: &str, body: &str) -> Result<Reply> {
    let input: serde_json::Value =
        serde_json::from_str(body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
    let mut binding = github::normalize_binding(&input)?;
    let new_token = github::normalize_token(&input)?;
    // A bound project still owns a local directory: it is where it came from,
    // and where it returns to if the binding is removed.
    fs::create_dir_all(project_dir(&context.data_dir, project)?).map_err(internal)?;
    // Whatever token this binding will run on — the one just given, or the one
    // already stored. Without either there is nothing to probe with.
    let token = new_token
        .clone()
        .or_else(|| github::token_for(&context.secrets_file, project));
    let probe = match &token {
        Some(token) => github::probe_access(&binding, token),
        None => github::Probe::unknown(),
    };
    binding.can_write = probe.can_write;
    let mut bindings = github::load_bindings(&context.data_dir);
    // The base is sticky, and every step of this fallback is a real case: what
    // the client stated, else what this project already recorded — which is
    // what makes switching branches a PUT of `{ branch }` and nothing else —
    // else the repository's own default branch as the probe just read it, else
    // the branch being bound, because a store that cannot ask still has to
    // answer.
    let base_branch = binding
        .base_branch
        .clone()
        .or_else(|| {
            bindings
                .get(project)
                .and_then(|stored| stored.base_branch.clone())
                .filter(|base| !base.is_empty())
        })
        .or_else(|| probe.default_branch.clone())
        .unwrap_or_else(|| binding.branch.clone());
    binding.base_branch = Some(base_branch.clone());
    bindings.insert(project.to_string(), binding);
    github::save_bindings(&context.data_dir, &bindings).map_err(internal)?;
    if let Some(token) = new_token {
        let mut secrets = github::load_secrets(&context.secrets_file);
        secrets.insert(project.to_string(), token);
        github::save_secrets(&context.secrets_file, &secrets).map_err(internal)?;
    }
    context.cache.forget_all(project);
    Ok(Reply::ok(
        serde_json::to_string(&BindingAnswer {
            ok: true,
            can_write: probe.can_write,
            base_branch,
            warning: probe.warning,
        })
        .map_err(json)?,
    ))
}

/// Unbind: metadata and token go, the local directory and GitHub both stay.
fn remove_binding(context: &Context, project: &str) -> Result<()> {
    let mut bindings = github::load_bindings(&context.data_dir);
    if bindings.remove(project).is_some() {
        github::save_bindings(&context.data_dir, &bindings).map_err(internal)?;
    }
    let mut secrets = github::load_secrets(&context.secrets_file);
    if secrets.remove(project).is_some() {
        github::save_secrets(&context.secrets_file, &secrets).map_err(internal)?;
    }
    context.cache.forget_all(project);
    Ok(())
}

fn internal(err: std::io::Error) -> HttpError {
    HttpError::new(500, err.to_string())
}

// ---------------------------------------------------------------------------
// native dialogs
// ---------------------------------------------------------------------------

/// Raise the open dialog and hand the page the file's text. The page decides
/// whether the text is a scene — the same check it applies to `?scene=<url>`.
fn import_file(dialogs: &dyn Dialogs) -> Result<Reply> {
    let Some(path) = dialogs.pick_open() else {
        return Ok(Reply::ok(r#"{"canceled":true}"#));
    };
    let file = fs::File::open(&path).map_err(internal)?;
    let mut buffer = Vec::new();
    // One byte past the ceiling is enough to know it was exceeded, and the
    // rest of the file is never read.
    file.take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(internal)?;
    if buffer.len() as u64 > MAX_IMPORT_BYTES {
        return Err(HttpError::new(413, "file too large"));
    }
    let content =
        String::from_utf8(buffer).map_err(|_| HttpError::new(400, "file is not UTF-8 text"))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Reply::ok(
        serde_json::json!({ "name": name, "content": content }).to_string(),
    ))
}

#[derive(serde::Deserialize)]
struct ExportRequest {
    name: String,
    content: String,
}

/// Raise the save dialog and write the text the page generated — a scene, a
/// Mermaid diagram, or a semantic sidecar. Only the dialog is the shell's
/// business; the write happens here, off the main thread.
fn export_file(dialogs: &dyn Dialogs, request: &mut Request) -> Result<Reply> {
    let body = read_body(request)?;
    let payload: ExportRequest =
        serde_json::from_str(&body).map_err(|_| HttpError::new(400, "body is not an export"))?;
    // Only the leaf is a suggestion the dialog can use; a name carrying
    // separators would otherwise steer where it opens.
    let suggested = Path::new(&payload.name)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("scene{EXT}"));
    let Some(path) = dialogs.pick_save(&suggested) else {
        return Ok(Reply::ok(r#"{"canceled":true}"#));
    };
    fs::write(&path, payload.content).map_err(internal)?;
    Ok(Reply::ok(
        serde_json::json!({ "saved": path.to_string_lossy() }).to_string(),
    ))
}

/// Raise a message box and answer what the user did with it. Both kinds share
/// this one handler because they share everything but the buttons: the same
/// body shape, the same validation, and the same default title.
///
/// The page sends `{ message }` and optionally `{ title }`. A body that is not
/// JSON, or that carries no message string, is the client's mistake and is
/// refused before anything appears on screen — the same 400s the write routes
/// answer with, for the same reason.
fn ask(dialogs: &dyn Dialogs, request: &mut Request, kind: AskKind) -> Result<Reply> {
    let body = read_body(request)?;
    let input: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
    let Some(message) = input.get("message").and_then(|value| value.as_str()) else {
        return Err(HttpError::new(400, "body is not a message"));
    };
    let title = input
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|title| !title.is_empty())
        .unwrap_or(DIALOG_TITLE);
    match kind {
        AskKind::Confirm => Ok(Reply::ok(
            serde_json::json!({ "confirmed": dialogs.confirm(title, message) }).to_string(),
        )),
        AskKind::Alert => {
            dialogs.alert(title, message);
            Ok(Reply::ok(r#"{"ok":true}"#))
        }
    }
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
    /// Present only on bound projects (S14), so an unbound listing is
    /// byte-identical to what this store answered before bindings existed.
    #[serde(skip_serializing_if = "is_false")]
    bound: bool,
    /// What the last bind-time probe learned, when it learned anything — the
    /// modal marks a read-only project from this rather than asking for every
    /// project's binding, and it is still not a network call because it comes
    /// off the bindings dotfile.
    #[serde(rename = "canWrite", skip_serializing_if = "Option::is_none")]
    can_write: Option<bool>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(serde::Serialize)]
struct SceneInfo {
    name: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    size: u64,
}

fn list_projects(context: &Context) -> Result<Reply> {
    let data_dir = context.data_dir.as_path();
    // Created on demand so a fresh profile lists empty instead of erroring.
    fs::create_dir_all(data_dir).map_err(internal)?;
    let bindings = github::load_bindings(data_dir);
    let mut projects = Vec::new();
    for entry in fs::read_dir(data_dir).map_err(internal)? {
        let entry = entry.map_err(internal)?;
        if !entry.file_type().map_err(internal)?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        // The bindings dotfile's own directory is not a project (D27).
        if id.starts_with('.') {
            continue;
        }
        if let Some(binding) = bindings.get(&id) {
            // Deliberately not a network call: the projects listing is the
            // first thing the modal asks for and must never wait on GitHub.
            // The count is whatever this process last saw, and zero until it
            // has seen anything.
            let scenes = context.cache.count(&id);
            let can_write = binding.can_write;
            projects.push(ProjectInfo {
                id,
                scenes,
                updated_at: None,
                bound: true,
                can_write,
            });
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
            id,
            scenes,
            updated_at: updated_at.map(iso8601),
            bound: false,
            can_write: None,
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
pub(crate) fn sort_by<T>(values: &mut [T], key: impl Fn(&T) -> &String) {
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
    fn the_stub_dialog_answers_cancel_or_a_path() {
        let cancelled = StubDialog::new("cancel");
        assert_eq!(cancelled.pick_open(), None);
        assert_eq!(cancelled.pick_save("scene.excalidraw"), None);

        let picked = StubDialog::new("/tmp/docent/scene.excalidraw");
        let expected = Some(PathBuf::from("/tmp/docent/scene.excalidraw"));
        assert_eq!(picked.pick_open(), expected);
        // The suggested name is the dialog's business, not the answer's.
        assert_eq!(picked.pick_save("other.excalidraw"), expected);
    }

    #[test]
    fn the_stub_dialog_records_message_boxes_and_declines_by_default() {
        let stub = StubDialog::new("cancel");
        assert!(!stub.confirm("Docent", "Delete everything?"));
        stub.alert("Docent", "Could not save.");
        assert_eq!(
            stub.asked(),
            vec![
                Asked {
                    kind: AskKind::Confirm,
                    title: "Docent".into(),
                    message: "Delete everything?".into(),
                },
                Asked {
                    kind: AskKind::Alert,
                    title: "Docent".into(),
                    message: "Could not save.".into(),
                },
            ]
        );

        // …and answers yes only where a test says so, never by default: a run
        // with no display must not confirm a deletion nobody saw.
        assert!(StubDialog::new("cancel")
            .confirming(true)
            .confirm("Docent", "Delete everything?"));
    }

    #[test]
    fn timestamps_match_to_iso_string() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(86_400_000), "1970-01-02T00:00:00.000Z");
        assert_eq!(iso8601(1_600_000_000_000), "2020-09-13T12:26:40.000Z");
        assert_eq!(iso8601(1_755_648_000_123), "2025-08-20T00:00:00.123Z");
    }
}
