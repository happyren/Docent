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
use std::net::Ipv4Addr;
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
/// How long a client request waits for the page before giving up.
const ANSWER_WINDOW: Duration = Duration::from_secs(30);
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
