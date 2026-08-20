//! Desktop agent endpoint (S15, D34) — the shell's MCP pipe. This listener
//! carries no agent logic at all: JSON-RPC bodies POSTed to `/mcp` are queued
//! for the page, the page long-polls them off `/bridge/poll`, runs the one
//! shared dispatcher (server/mcp-core.mjs) against the Command API, and posts
//! each answer to `/bridge/answer`; whatever the page said is what the client
//! hears.
//!
//! The listener binds loopback on a fixed port (`DOCENT_MCP_PORT`, default
//! 3301) so an MCP client can be configured once — with an ephemeral fallback
//! when the port is taken, surfaced in Help → Agent Endpoint…. Loopback is
//! exempt from MCP clients' HTTPS requirement, which is why the desktop needs
//! neither certificates nor the stdio shim the self-host deployment does
//! (D24).
//!
//! Several worker threads serve the socket: a long-poll deliberately parks
//! one for up to its window, and an `/mcp` request must still get through
//! while it waits.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write as IoWrite};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server};

use crate::store::ALLOWED_ORIGINS;

/// Where the fixed port comes from, and what it is when nothing says.
pub const DEFAULT_PORT: u16 = 3301;
const PORT_ENV: &str = "DOCENT_MCP_PORT";

/// How long a page poll parks before answering "nothing yet" (204).
const POLL_WINDOW: Duration = Duration::from_secs(25);
/// How long a client request waits for the page before giving up. Long on
/// purpose: a `tour` call answers only when the tour finishes, and a
/// narrated walkthrough legitimately runs minutes (the reference Node
/// server waits the same 120s).
const ANSWER_WINDOW: Duration = Duration::from_secs(120);
/// The one identifier every path derives from — must match tauri.conf.json.
const APP_IDENTIFIER: &str = "io.github.happyren.docent";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const WORKERS: usize = 4;

/// What the page reports back for one queued body — mcp-core's own words.
struct Answer {
    status: u16,
    json: Option<String>,
    initialized: bool,
}

#[derive(Default)]
struct BridgeState {
    queue: Mutex<VecDeque<(u64, String)>>,
    wake: Condvar,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Answer>>>,
}

/// The running endpoint. Dropping it stops the listener and joins the pool.
pub struct McpHandle {
    port: u16,
    server: Arc<Server>,
    workers: Vec<JoinHandle<()>>,
}

impl McpHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// What the shell injects as `window.__DOCENT_MCP_BASE__`, and what Help →
    /// Agent Endpoint… shows with `/mcp` appended.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for McpHandle {
    fn drop(&mut self) {
        // One unblock wakes ONE parked recv(), and this listener runs a
        // pool — every worker needs its own wake or the joins deadlock
        // (the store's single-worker handle never meets this).
        for _ in 0..self.workers.len() {
            self.server.unblock();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

/// Bind the agent endpoint: the fixed port first, ephemeral when it is taken
/// (another Docent, or the self-host MCP server on the same machine).
pub fn spawn() -> std::io::Result<McpHandle> {
    let wanted = std::env::var(PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let server = Server::http((Ipv4Addr::LOCALHOST, wanted))
        .or_else(|_| Server::http((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| std::io::Error::other("agent endpoint did not bind a TCP port"))?
        .port();
    let server = Arc::new(server);
    let state = Arc::new(BridgeState::default());
    let counter = Arc::new(AtomicU64::new(1));
    let workers = (0..WORKERS)
        .map(|_| {
            let server = Arc::clone(&server);
            let state = Arc::clone(&state);
            let counter = Arc::clone(&counter);
            thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    serve(&state, &counter, request);
                }
            })
        })
        .collect();
    Ok(McpHandle {
        port,
        server,
        workers,
    })
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn respond(request: tiny_http::Request, status: u16, body: &str, extra: Vec<Header>) {
    let mut response = Response::from_string(body).with_status_code(status);
    response.add_header(header("Content-Type", "application/json"));
    for h in extra {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn read_body(request: &mut tiny_http::Request) -> Option<String> {
    let mut body = String::new();
    use std::io::Read;
    let mut limited = request.as_reader().take(MAX_BODY_BYTES as u64 + 1);
    limited.read_to_string(&mut body).ok()?;
    if body.len() > MAX_BODY_BYTES {
        return None;
    }
    Some(body)
}

/// The id a JSON-RPC error should carry when the page never answered —
/// best-effort from the body, null for batches and unparseable traffic.
fn rpc_id_of(body: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null)
}

fn rpc_error(id: serde_json::Value, code: i64, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// The page is the only caller /bridge answers (same belt as the store's
/// /desktop routes): its fetches carry the webview origin, curl carries none.
fn bridge_cors(origin: Option<&str>) -> Option<Vec<Header>> {
    let origin = origin?;
    if !ALLOWED_ORIGINS.contains(&origin) {
        return None;
    }
    Some(vec![
        header("Access-Control-Allow-Origin", origin),
        header("Vary", "Origin"),
        header("Access-Control-Allow-Methods", "POST, OPTIONS"),
        header("Access-Control-Allow-Headers", "content-type"),
    ])
}

fn serve(state: &BridgeState, counter: &AtomicU64, mut request: tiny_http::Request) {
    let url = request.url().to_string();
    let method = request.method().clone();
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());

    match (method, url.as_str()) {
        (Method::Options, "/bridge/poll" | "/bridge/answer") => {
            match bridge_cors(origin.as_deref()) {
                Some(cors) => respond(request, 204, "", cors),
                None => respond(request, 403, r#"{"error":"forbidden"}"#, vec![]),
            }
        }
        (Method::Post, "/bridge/poll") => {
            let Some(cors) = bridge_cors(origin.as_deref()) else {
                respond(request, 403, r#"{"error":"forbidden"}"#, vec![]);
                return;
            };
            let queued = {
                let queue = state.queue.lock().expect("bridge queue");
                let (mut queue, _timeout) = state
                    .wake
                    .wait_timeout_while(queue, POLL_WINDOW, |q| q.is_empty())
                    .expect("bridge queue");
                queue.pop_front()
            };
            match queued {
                Some((id, body)) => respond(
                    request,
                    200,
                    &serde_json::json!({ "id": id.to_string(), "body": body }).to_string(),
                    cors,
                ),
                None => respond(request, 204, "", cors),
            }
        }
        (Method::Post, "/bridge/answer") => {
            let Some(cors) = bridge_cors(origin.as_deref()) else {
                respond(request, 403, r#"{"error":"forbidden"}"#, vec![]);
                return;
            };
            let Some(body) = read_body(&mut request) else {
                respond(request, 400, r#"{"error":"body too large"}"#, cors);
                return;
            };
            let parsed: Option<(u64, Answer)> = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    let id = v.get("id")?.as_str()?.parse::<u64>().ok()?;
                    Some((
                        id,
                        Answer {
                            status: v.get("status")?.as_u64()? as u16,
                            json: v.get("json").and_then(|j| j.as_str().map(String::from)),
                            initialized: v
                                .get("initialized")
                                .and_then(|b| b.as_bool())
                                .unwrap_or(false),
                        },
                    ))
                });
            if let Some((id, answer)) = parsed {
                if let Some(sender) = state.waiting.lock().expect("bridge waiting").remove(&id) {
                    let _ = sender.send(answer);
                }
            }
            respond(request, 200, r#"{"ok":true}"#, cors);
        }
        (Method::Get, "/mcp") => {
            let mut response = Response::from_string("").with_status_code(405);
            response.add_header(header("Allow", "POST, DELETE"));
            let _ = request.respond(response);
        }
        (Method::Delete, "/mcp") => {
            let _ = request.respond(Response::from_string("").with_status_code(204));
        }
        (Method::Post, "/mcp") => {
            let Some(body) = read_body(&mut request) else {
                respond(
                    request,
                    400,
                    &rpc_error(serde_json::Value::Null, -32600, "body too large"),
                    vec![],
                );
                return;
            };
            let id = counter.fetch_add(1, Ordering::Relaxed);
            let (sender, receiver) = mpsc::channel();
            state
                .waiting
                .lock()
                .expect("bridge waiting")
                .insert(id, sender);
            {
                let mut queue = state.queue.lock().expect("bridge queue");
                queue.push_back((id, body.clone()));
            }
            state.wake.notify_one();
            match receiver.recv_timeout(ANSWER_WINDOW) {
                Ok(answer) => {
                    let mut extra = Vec::new();
                    if answer.initialized {
                        extra.push(header("mcp-session-id", &format!("docent-{id}")));
                    }
                    match answer.json {
                        Some(json) => respond(request, answer.status, &json, extra),
                        None => {
                            let mut response =
                                Response::from_string("").with_status_code(answer.status);
                            for h in extra {
                                response.add_header(h);
                            }
                            let _ = request.respond(response);
                        }
                    }
                }
                Err(_) => {
                    state.waiting.lock().expect("bridge waiting").remove(&id);
                    respond(
                        request,
                        200,
                        &rpc_error(
                            rpc_id_of(&body),
                            -32603,
                            "The Docent canvas did not answer — is the app still starting?",
                        ),
                        vec![],
                    );
                }
            }
        }
        _ => respond(request, 404, r#"{"error":"not found"}"#, vec![]),
    }
}

// ---------------------------------------------------------------------------
// the stdio shim (`docent --agent-stdio`, D38)
// ---------------------------------------------------------------------------

/// The identifier-scoped config directory, hand-rolled from std so the shim
/// — a plain process with no Tauri runtime — resolves the same directory
/// the shell's `app_config_dir()` does for `APP_IDENTIFIER`.
fn config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            Path::new(&home)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(Path::new(&appdata).join(APP_IDENTIFIER))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match std::env::var_os("XDG_CONFIG_HOME") {
            Some(xdg) if !xdg.is_empty() => Some(Path::new(&xdg).join(APP_IDENTIFIER)),
            _ => {
                let home = std::env::var_os("HOME")?;
                Some(Path::new(&home).join(".config").join(APP_IDENTIFIER))
            }
        }
    }
}

fn port_file_in(dir: &Path) -> PathBuf {
    dir.join("mcp-port")
}

/// Record the port the listener actually bound (fixed or fallback) where
/// the shim will look for it.
pub fn record_port_in(dir: &Path, port: u16) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(port_file_in(dir), port.to_string());
}

/// The shell's call after binding; failures are ignored — the shim still
/// has the env override and the default.
pub fn record_port(port: u16) {
    if let Some(dir) = config_dir() {
        record_port_in(&dir, port);
    }
}

pub fn read_port_in(dir: &Path) -> Option<u16> {
    std::fs::read_to_string(port_file_in(dir))
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

/// Ports worth trying, in order: the env override, the recorded port, and
/// the default — deduplicated. The recorded one can be stale (a crashed
/// instance, or a test run that fell back to an ephemeral port), so the
/// default stays in the list as the recovery.
fn resolve_ports() -> Vec<u16> {
    let mut ports = Vec::new();
    if let Some(port) = std::env::var(PORT_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
    {
        ports.push(port);
    }
    if let Some(port) = config_dir().and_then(|dir| read_port_in(&dir)) {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    if !ports.contains(&DEFAULT_PORT) {
        ports.push(DEFAULT_PORT);
    }
    ports
}

fn forward(
    agent: &ureq::Agent,
    port: u16,
    line: &str,
) -> std::result::Result<Option<String>, String> {
    let request = ureq::http::Request::builder()
        .method("POST")
        .uri(format!("http://127.0.0.1:{port}/mcp"))
        .header("Content-Type", "application/json")
        .body(line.to_string())
        .map_err(|err| err.to_string())?;
    let mut response = agent.run(request).map_err(|err| err.to_string())?;
    let text = response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .unwrap_or_default();
    Ok(if text.trim().is_empty() {
        None
    } else {
        Some(text)
    })
}

/// The `--agent-stdio` loop (D38): newline-delimited JSON-RPC on stdin,
/// forwarded verbatim to the running shell's `/mcp`, answers on stdout —
/// how stdio-only clients (Claude Desktop's config file among them) reach
/// a Docent that is already running. A pure pipe, exactly like the Node
/// proxy it mirrors (D24); when the app is not running, every request is
/// answered with a JSON-RPC error that says so, and the shim survives to
/// recover the moment the app opens.
pub fn stdio_shim(input: impl BufRead, mut output: impl IoWrite, ports_of: impl Fn() -> Vec<u16>) {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        // Longer than the pipe's own answer window: a tour resolves when it
        // finishes, and cutting the wait here would orphan the answer.
        .timeout_global(Some(Duration::from_secs(150)))
        .http_status_as_error(false)
        .build()
        .into();
    for line in input.lines() {
        let Ok(line) = line else { break };
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        // Resolved per message: the app may have (re)started on another
        // port since the last one. Candidates are tried in order.
        let mut sent = Err(String::new());
        for port in ports_of() {
            sent = forward(&agent, port, text);
            if sent.is_ok() {
                break;
            }
        }
        let answer = match sent {
            Ok(json) => json,
            Err(_) => serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|value| value.get("id").cloned())
                .filter(|id| !id.is_null())
                .map(|id| {
                    rpc_error(
                        id,
                        -32603,
                        "Docent is not running — open the app, then try again",
                    )
                }),
        };
        if let Some(answer) = answer {
            let _ = writeln!(output, "{}", answer.trim());
            let _ = output.flush();
        }
    }
}

/// What `docent --agent-stdio` runs instead of a window.
pub fn run_stdio_shim() {
    let stdin = std::io::stdin();
    stdio_shim(stdin.lock(), std::io::stdout(), resolve_ports);
}
