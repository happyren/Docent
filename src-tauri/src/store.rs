//! Desktop portfolio store (S13, D25) — the second implementation of the one
//! store *contract*: the D17 file tree, a subtree now
//! (`<data>/<project>/<seg>/…/<leaf>.excalidraw`, D92), behind the D18 `/api`
//! routes. Route shapes, status codes, error bodies, the name and path gates,
//! and the `.excalidraw`-only write gate match
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
//! A project may also be bound to a GitHub repository (S14, D27, D29), which
//! changes nothing about the routes above it: the project directory *is* the
//! working copy, so scene CRUD is the same code either way and never waits on
//! the network. What a binding adds is the sync verbs — status, pull, resolve,
//! push — whose rules live in `sync.rs` and whose calls live in `github.rs`.
//! This file routes to them, and holds the one thing the desktop must decide
//! for itself: where the token file goes (the app's config directory, never
//! the portfolio).

use std::fs;
use std::io::{ErrorKind, Read};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::UNIX_EPOCH;

use tiny_http::{Header, Method, Request, Response, Server};

use crate::github::{self, Binding, Cache};
use crate::sync;

const MAX_SCENE_BYTES: usize = 50 * 1024 * 1024;
/// Import reads whatever file the user pointed at. The scene ceiling would let
/// one mis-click pull a video into memory, so this direction stops earlier.
const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
const EXT: &str = ".excalidraw";

/// Origins this store answers CORS for: the webview in a packaged build
/// (`tauri://` on macOS and Linux, `http(s)://tauri.localhost` on Windows) and
/// the Vite dev server when the shell runs under `tauri dev`.
pub(crate) const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

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

/// A successful reply: a status and a body that is already JSON text — a
/// scene answers with its own bytes, everything else with an envelope.
struct Reply {
    status: u16,
    json: String,
}

impl Reply {
    fn ok(json: impl Into<String>) -> Self {
        Self::new(200, json)
    }

    fn new(status: u16, json: impl Into<String>) -> Self {
        Self {
            status,
            json: json.into(),
        }
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
            .with_header(header("Access-Control-Allow-Headers", "content-type"))
            .with_header(header("Access-Control-Max-Age", "86400"));
        for extra in cors_headers(origin.as_deref()) {
            response = response.with_header(extra);
        }
        let _ = request.respond(response);
        return;
    }

    let (status, body) = match dispatch(context, dialogs, origin.as_deref(), &mut request) {
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
            // Deleting a bound project unbinds it and removes the working copy
            // and its sync state. Nothing on GitHub is touched — the
            // repository is the user's, and a portfolio operation must never
            // reach into it destructively.
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

    // The sync verbs (S14, D29). `sync-status` needs no token: its local half
    // is the whole point, and a project whose credential is gone still has to
    // be able to say what its own files did.
    if segments.len() == 4 && part(3) == Some("sync-status") && method == Method::Get {
        let project = &segments[2];
        check_name(project, "project")?;
        let binding = github::load_bindings(data_dir)
            .remove(project)
            .ok_or_else(|| {
                HttpError::new(404, format!("no GitHub binding for project: {project}"))
            })?;
        let token = github::token_for(&context.secrets_file, project);
        let answer = sync::status(
            data_dir,
            project,
            &binding,
            token.as_deref(),
            &context.cache,
        );
        return Ok(Reply::ok(serde_json::to_string(&answer).map_err(json)?));
    }

    if segments.len() == 4 && part(3) == Some("pull") && method == Method::Post {
        let project = &segments[2];
        check_name(project, "project")?;
        require_app_origin(origin)?;
        let (binding, token) = bound_or_404(context, project)?;
        let answer = sync::pull(data_dir, project, &binding, &token, &context.cache)?;
        return Ok(Reply::ok(serde_json::to_string(&answer).map_err(json)?));
    }

    if segments.len() == 5
        && part(3) == Some("pull")
        && part(4) == Some("resolve")
        && method == Method::Post
    {
        let project = &segments[2];
        check_name(project, "project")?;
        require_app_origin(origin)?;
        let (binding, token) = bound_or_404(context, project)?;
        let body = object_body(&read_body(request)?, "a resolution")?;
        let answer = sync::resolve(data_dir, project, &binding, &token, &body)?;
        return Ok(Reply::ok(serde_json::to_string(&answer).map_err(json)?));
    }

    if segments.len() == 4 && part(3) == Some("push") && method == Method::Post {
        let project = &segments[2];
        check_name(project, "project")?;
        require_app_origin(origin)?;
        let (binding, token) = bound_or_404(context, project)?;
        let extras = sync::parse_push_body(&read_body(request)?)?;
        let answer = sync::push(data_dir, project, &binding, &token, &context.cache, &extras)?;
        return Ok(Reply::ok(serde_json::to_string(&answer).map_err(json)?));
    }

    // The review pictures (D49): pushed to the quarantined `docent-review`
    // branch, never the working branch.
    if segments.len() == 4 && part(3) == Some("review-images") && method == Method::Post {
        let project = &segments[2];
        check_name(project, "project")?;
        require_app_origin(origin)?;
        let (binding, token) = bound_or_404(context, project)?;
        let today = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| (d.as_secs() / 86_400) as i64)
            .unwrap_or(0);
        let answer = github::push_review_images(&binding, &token, &read_body(request)?, today)?;
        return Ok(Reply::ok(serde_json::to_string(&answer).map_err(json)?));
    }

    // The "before" copy of a scene (D47): what the recorded base sha says.
    if segments.len() == 6
        && part(3) == Some("scenes")
        && part(5) == Some("base")
        && method == Method::Get
    {
        let (project, scene) = (&segments[2], &segments[4]);
        check_name(project, "project")?;
        check_scene_path(scene)?;
        return match sync::read_base(data_dir, project, scene) {
            Some(text) => Ok(Reply::ok(text)),
            None => Err(HttpError::new(
                404,
                format!("no base copy yet for {project}/{scene} — pull or push first"),
            )),
        };
    }

    if segments.len() == 4 && part(3) == Some("scenes") && method == Method::Get {
        return list_scenes(data_dir, &segments[2]);
    }

    // Scene CRUD is the same code for every project (D29): a bound project's
    // directory is its working copy, so opening and saving are file operations
    // that never wait on — or even reach — the network.
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
            // reject anything that isn't one, loudly. Bound or not.
            let parsed: serde_json::Value =
                serde_json::from_str(&body).map_err(|_| HttpError::new(400, "body is not JSON"))?;
            if parsed.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
                return Err(HttpError::new(400, "body is not an .excalidraw scene"));
            }
            let dir = project_dir(data_dir, project)?;
            if !dir.is_dir() {
                return Err(HttpError::new(404, format!("no such project: {project}")));
            }
            // A directory exists because a scene lives in it (D92), so a PUT
            // at a path is what creates the folders on the way to it.
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(internal)?;
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
                Ok(()) => {
                    prune_empty_dirs(&file, &project_dir(data_dir, project)?);
                    Ok(Reply::ok(r#"{"ok":true}"#))
                }
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
    context.cache.forget(project);
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
    /// How many scenes the working copy gained or lost by switching branches
    /// (D29) — present only when this PUT was a switch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pulled: Option<usize>,
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
    // A bound project's directory is its working copy (D29): binding creates
    // it if it is missing and never touches what is already in it — the first
    // pull is what reconciles those files with the repository.
    fs::create_dir_all(project_dir(&context.data_dir, project)?).map_err(internal)?;
    // Moving an existing binding to another branch means the working copy is
    // about to be replaced with that branch's content, so it has to be clean
    // first. Answered before the probe: there is no point asking GitHub
    // anything when the switch cannot happen.
    // What the caller means by "the branch": stated explicitly, else whatever
    // this project is already on. Absent both, the binding is fresh and the
    // probe below names the branch — which cannot be a switch.
    if binding.branch.is_empty() {
        if let Some(stored) = github::load_bindings(&context.data_dir).get(project) {
            binding.branch = stored.branch.clone();
        }
    }
    let switching = !binding.branch.is_empty()
        && github::load_bindings(&context.data_dir)
            .get(project)
            .is_some_and(|stored| stored.branch != binding.branch);
    if switching {
        let dirty = sync::dirty_scenes(&context.data_dir, project);
        if !dirty.is_empty() {
            return Err(HttpError::new(409, github::dirty_switch_error(&dirty)));
        }
    }
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
    // The active branch: what was asked for (or already recorded), else the
    // repository's own default as the probe just read it, else the
    // conventional name — a store that cannot ask still has to answer.
    if binding.branch.is_empty() {
        binding.branch = probe
            .default_branch
            .clone()
            .unwrap_or_else(|| github::DEFAULT_BRANCH.to_string());
    }
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
    // Stored only when a flag is on, so a binding that never asked for
    // artifacts is the same bytes it always was; a PUT that does not mention
    // review keeps what was recorded.
    binding.review = binding
        .review
        .or_else(|| bindings.get(project).and_then(|stored| stored.review))
        .filter(|review| review.any());
    // The trunk lock (D104), on the same terms: absent keeps what was
    // recorded, and only an on lock is written down.
    binding.protected = binding
        .protected
        .or_else(|| bindings.get(project).and_then(|stored| stored.protected))
        .filter(|on| *on);
    bindings.insert(project.to_string(), binding);
    github::save_bindings(&context.data_dir, &bindings).map_err(internal)?;
    if let Some(token) = new_token {
        let mut secrets = github::load_secrets(&context.secrets_file);
        secrets.insert(project.to_string(), token);
        github::save_secrets(&context.secrets_file, &secrets).map_err(internal)?;
    }
    // A different branch is a different set of blobs: whatever this process
    // remembered about the old one is now wrong rather than merely stale.
    context.cache.forget(project);
    // The copy was clean, so a switch can only fast-forward it: every scene
    // either arrives, changes, or goes, and nothing of the user's is at stake.
    // A pull that cannot reach GitHub fails loudly — the binding has moved,
    // and the fix is to pull again rather than to pretend it did not.
    let pulled = match (switching, token) {
        (false, _) => None,
        (true, None) => Some(0),
        (true, Some(token)) => {
            let stored = bindings.get(project).expect("just inserted");
            let answer = sync::pull(&context.data_dir, project, stored, &token, &context.cache)?;
            Some(answer.updated.len() + answer.removed.len())
        }
    };
    Ok(Reply::ok(
        serde_json::to_string(&BindingAnswer {
            ok: true,
            can_write: probe.can_write,
            base_branch,
            warning: probe.warning,
            pulled,
        })
        .map_err(json)?,
    ))
}

/// Unbind: metadata, sync state and token go; the working copy and GitHub both
/// stay. Dropping the sync state is what makes rebinding safe — with no
/// recorded base, every local file reads as never-synced and the first pull
/// keeps all of them.
fn remove_binding(context: &Context, project: &str) -> Result<()> {
    let mut bindings = github::load_bindings(&context.data_dir);
    if bindings.remove(project).is_some() {
        github::save_bindings(&context.data_dir, &bindings).map_err(internal)?;
    }
    let mut secrets = github::load_secrets(&context.secrets_file);
    if secrets.remove(project).is_some() {
        github::save_secrets(&context.secrets_file, &secrets).map_err(internal)?;
    }
    sync::remove_state(&context.data_dir, project);
    context.cache.forget(project);
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

/// How deep a scene path may go (D92): eight segments, so a flat name is a
/// path of one and nothing addresses further than a reader can follow.
pub const MAX_SCENE_DEPTH: usize = 8;

/// The reference store's message for a path that is not one. Every route that
/// names a scene answers with exactly this, because the two stores are one
/// contract (S13).
pub const SCENE_PATH_ERROR: &str = "invalid scene path — up to 8 folders of letters, digits, spaces, - or _ (max 64 each, no leading symbol)";

/// A scene's name is a path (D92): one to eight slash-separated segments, each
/// obeying the one name rule above. One rule per segment keeps traversal
/// impossible the same way one rule per name always has.
pub fn valid_scene_path(path: &str) -> bool {
    let mut segments = 0;
    for segment in path.split('/') {
        segments += 1;
        if segments > MAX_SCENE_DEPTH || !valid_name(segment) {
            return false;
        }
        // `.docent` is reserved at every level. The name rule already refuses
        // a leading dot, so this is the contract written down rather than the
        // gate that enforces it — and it stays true if either rule moves.
        if segment.eq_ignore_ascii_case(".docent") {
            return false;
        }
    }
    true
}

fn check_scene_path(path: &str) -> Result<()> {
    if valid_scene_path(path) {
        return Ok(());
    }
    Err(HttpError::new(400, SCENE_PATH_ERROR))
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
    check_scene_path(scene)?;
    Ok(nested_file(dir, scene))
}

/// `<root>/<seg>/…/<leaf>.excalidraw` — the one layout the working copy and
/// the base copies beside it both use (D92, D94). Pushed segment by segment
/// rather than joined, so the separator is the platform's.
pub(crate) fn nested_file(root: PathBuf, scene: &str) -> PathBuf {
    let mut file = root;
    let mut segments = scene.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_some() {
            file.push(segment);
        } else {
            file.push(format!("{segment}{EXT}"));
        }
    }
    file
}

/// Remove the directories a deleted scene left empty, ancestor by ancestor,
/// stopping at — and never removing — `stop_at` (D92). A directory exists
/// because scenes live in it, and Git cannot keep an empty one either, so the
/// store never pretends to. A directory that still holds something ends the
/// walk, which is what `remove_dir` refusing already means.
pub(crate) fn prune_empty_dirs(file: &Path, stop_at: &Path) {
    let mut current = file.parent();
    while let Some(dir) = current {
        if dir == stop_at || !dir.starts_with(stop_at) || fs::remove_dir(dir).is_err() {
            return;
        }
        current = dir.parent();
    }
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
        // A bound project counts its working copy exactly like any other
        // (D29): the count is a directory read, never a network call, and it
        // is true whether or not GitHub can be reached. What the last probe
        // learned about the token travels with it so the modal can mark a
        // read-only project without a request per project.
        let binding = bindings.get(&id);
        let mut scenes = 0_usize;
        let mut updated_at: Option<u128> = None;
        // Recursively (D92): a scene in a folder is still one of the
        // project's, and the count the modal shows has to say so.
        count_scenes(&entry.path(), 0, &mut scenes, &mut updated_at);
        projects.push(ProjectInfo {
            id,
            scenes,
            updated_at: updated_at.map(iso8601),
            bound: binding.is_some(),
            can_write: binding.and_then(|binding| binding.can_write),
        });
    }
    sort_by(&mut projects, |project| &project.id);
    Ok(Reply::ok(serde_json::to_string(&projects).map_err(json)?))
}

/// Count a project's scenes, and date it by the newest of them. Infallible on
/// purpose: a directory that cannot be read is a project with fewer scenes in
/// the listing, never a portfolio that refuses to open.
fn count_scenes(dir: &Path, depth: usize, scenes: &mut usize, updated_at: &mut Option<u128>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth + 1 < MAX_SCENE_DEPTH && valid_name(&file_name) {
                count_scenes(&entry.path(), depth + 1, scenes, updated_at);
            }
            continue;
        }
        if !file_name.ends_with(EXT) {
            continue;
        }
        *scenes += 1;
        if let Some(ms) = modified_millis(&entry.path()) {
            *updated_at = Some(updated_at.map_or(ms, |current| current.max(ms)));
        }
    }
}

/// Every scene under a project, as a path relative to it (D92). Only folders
/// the path rule could address are entered, so a repository's own `.git` — or
/// anything deeper than the rule allows — is not part of the portfolio.
fn collect_scenes(
    dir: &Path,
    prefix: &str,
    depth: usize,
    scenes: &mut Vec<SceneInfo>,
) -> std::io::Result<()> {
    // Only the project's own directory answers a 404; an entry that cannot be
    // read under it is a scene the listing does without.
    for entry in fs::read_dir(dir)?.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth + 1 < MAX_SCENE_DEPTH && valid_name(&file_name) {
                let _ = collect_scenes(
                    &entry.path(),
                    &format!("{prefix}{file_name}/"),
                    depth + 1,
                    scenes,
                );
            }
            continue;
        }
        let Some(stem) = file_name.strip_suffix(EXT) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        scenes.push(SceneInfo {
            name: format!("{prefix}{stem}"),
            updated_at: modified_millis(&entry.path()).map(iso8601),
            size: meta.len(),
        });
    }
    Ok(())
}

fn list_scenes(data_dir: &Path, project: &str) -> Result<Reply> {
    let dir = project_dir(data_dir, project)?;
    let mut scenes = Vec::new();
    collect_scenes(&dir, "", 0, &mut scenes)
        .map_err(|_| HttpError::new(404, format!("no such project: {project}")))?;
    scenes.sort_by(|a, b| compare_scene_paths(&a.name, &b.name));
    Ok(Reply::ok(serde_json::to_string(&scenes).map_err(json)?))
}

/// `localeCompare` order, approximated: case-insensitive first so `apples`
/// sorts before `Bananas` as it does in the reference store, with the raw
/// string breaking ties so the result stays deterministic (I3 habits).
pub(crate) fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// …applied to a whole listing.
pub(crate) fn sort_by<T>(values: &mut [T], key: impl Fn(&T) -> &String) {
    values.sort_by(|a, b| compare_names(key(a), key(b)));
}

/// Folders first, then names (D92). Two paths are compared segment by segment;
/// where one still has a folder under the segment and the other does not, the
/// folder wins outright — which is what keeps a directory's contents together
/// in the listing instead of interleaved with its siblings. Segments that are
/// equally folders, or equally leaves, fall back to the name order above.
pub(crate) fn compare_scene_paths(a: &str, b: &str) -> std::cmp::Ordering {
    let (left, right): (Vec<&str>, Vec<&str>) = (a.split('/').collect(), b.split('/').collect());
    for index in 0..left.len().min(right.len()) {
        let (left_folder, right_folder) = (index + 1 < left.len(), index + 1 < right.len());
        if left_folder != right_folder {
            return right_folder.cmp(&left_folder);
        }
        let order = compare_names(left[index], right[index]);
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
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

    /// A directory of this test's own, under the system temp directory.
    fn scratch(prefix: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "docent-{prefix}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn a_scene_path_is_up_to_eight_segments_of_the_one_name_rule() {
        for path in [
            "sketch",
            "work/checkout",
            "a/b/c/d/e/f/g/h",
            "Team notes/2026/Q1 plan",
        ] {
            assert!(valid_scene_path(path), "{path} should pass");
        }
        for path in [
            "",
            // Nine segments is one too many.
            "a/b/c/d/e/f/g/h/i",
            "work//checkout",
            "work/",
            "/work",
            "work/../escape",
            // Reserved at the top and at every level under it.
            ".docent/notes",
            "work/.docent/notes",
            "work/.DOCENT",
            &format!("work/{}", "a".repeat(65)),
        ] {
            assert!(!valid_scene_path(path), "{path} should fail");
        }
        // A flat name is a path of one segment, so nothing that addressed a
        // scene before this stops addressing one (D92).
        for name in ["a", "Check out 2", "a-b_c", "-flag", "a.b"] {
            assert_eq!(valid_name(name), valid_scene_path(name), "{name}");
        }
    }

    #[test]
    fn folders_sort_before_files_at_every_level() {
        let mut paths = vec![
            "zeta",
            "alpha",
            "beta/second",
            "beta/first",
            "beta",
            "Alps/peak",
        ];
        paths.sort_by(|a, b| compare_scene_paths(a, b));
        assert_eq!(
            paths,
            [
                // Folders first, in name order, each one's contents kept
                // together rather than interleaved with its siblings…
                "Alps/peak",
                "beta/first",
                "beta/second",
                // …then the loose scenes, `beta` among them even though a
                // folder shares its name.
                "alpha",
                "beta",
                "zeta",
            ]
        );
    }

    #[test]
    fn a_path_becomes_a_nesting_not_a_name_with_slashes_in_it() {
        assert_eq!(
            nested_file(PathBuf::from("/data/work"), "folder/deep/sketch"),
            Path::new("/data/work/folder/deep/sketch.excalidraw")
        );
        // A flat name is one segment, laid out exactly where it always was.
        assert_eq!(
            nested_file(PathBuf::from("/data/work"), "sketch"),
            Path::new("/data/work/sketch.excalidraw")
        );
    }

    #[test]
    fn a_deleted_scene_takes_the_folders_it_emptied_with_it() {
        let project = scratch("prune");
        let file = nested_file(project.clone(), "a/b/c/sketch");
        fs::create_dir_all(file.parent().expect("a parent")).expect("the folders");
        fs::write(&file, "{}").expect("the scene");
        // A sibling one level up keeps its own folder — and everything above
        // it — alive.
        let sibling = nested_file(project.clone(), "a/b/other");
        fs::write(&sibling, "{}").expect("the sibling");

        fs::remove_file(&file).expect("the scene goes");
        prune_empty_dirs(&file, &project);
        assert!(!project.join("a").join("b").join("c").exists());
        assert!(sibling.is_file());

        fs::remove_file(&sibling).expect("the sibling goes");
        prune_empty_dirs(&sibling, &project);
        // Empty all the way up now — but never the project itself.
        assert!(!project.join("a").exists());
        assert!(project.is_dir());
        let _ = fs::remove_dir_all(&project);
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
        // Which is what carries a whole scene path in one URL segment (D92):
        // the encoded separator survives the split and arrives as one name
        // with slashes in it, for the path gate rather than the name gate.
        assert_eq!(
            path_segments("/api/projects/work/scenes/notes%2F2026%2Fplan"),
            ["api", "projects", "work", "scenes", "notes/2026/plan"]
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
