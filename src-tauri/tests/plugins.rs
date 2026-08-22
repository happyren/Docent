//! The plugins host (S17, D50): manifests are discovered and refused for
//! the documented reasons, an enabled plugin is proxied on the host's own
//! loopback listener with its reply streamed through, the origin gate holds,
//! the choice is remembered, and a command the host started is stopped when
//! the plugin is disabled.

use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use docent_lib::plugins;

const WEBVIEW_ORIGIN: &str = "tauri://localhost";
static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Res {
    status: u16,
    headers: String,
    body: Vec<u8>,
}

impl Res {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.text()).unwrap_or(serde_json::Value::Null)
    }
}

fn send(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    content_type: &str,
    origin: Option<&str>,
) -> Res {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("host accepts connections");
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(origin) = origin {
        head.push_str(&format!("Origin: {origin}\r\n"));
    }
    head.push_str(&format!(
        "Content-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.map_or(0, <[u8]>::len)
    ));
    stream.write_all(head.as_bytes()).unwrap();
    if let Some(body) = body {
        stream.write_all(body).unwrap();
    }
    stream.flush().unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block");
    let headers = String::from_utf8_lossy(&raw[..split]).into_owned();
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut body = raw[split + 4..].to_vec();
    // A streamed reply has no length, so tiny_http chunks it; undo the
    // framing so the tests compare bytes.
    if headers
        .to_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = dechunk(&body);
    }
    Res {
        status,
        headers,
        body,
    }
}

fn dechunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let Some(line_end) = raw[at..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_text = String::from_utf8_lossy(&raw[at..at + line_end]).into_owned();
        let size = usize::from_str_radix(size_text.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        at += line_end + 2;
        if size == 0 {
            break;
        }
        out.extend_from_slice(&raw[at..(at + size).min(raw.len())]);
        at += size + 2;
    }
    out
}

/// A `speech/1` provider that answers health, voices, and a streamed wav.
struct FakeProvider {
    server: Arc<tiny_http::Server>,
    worker: Option<JoinHandle<()>>,
    port: u16,
}

const WAV: &[u8] = b"RIFF....WAVEfmt ................data....chunk-one|chunk-two|chunk-three";

impl FakeProvider {
    fn start() -> Self {
        let server = Arc::new(
            tiny_http::Server::http((Ipv4Addr::LOCALHOST, 0)).expect("fake binds loopback"),
        );
        let port = server.server_addr().to_ip().unwrap().port();
        let worker = {
            let server = Arc::clone(&server);
            thread::spawn(move || {
                for mut request in server.incoming_requests() {
                    let url = request
                        .url()
                        .split('?')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let method = request.method().as_str().to_string();
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let content_type = request
                        .headers()
                        .iter()
                        .find(|h| h.field.equiv("Content-Type"))
                        .map(|h| h.value.as_str().to_string())
                        .unwrap_or_default();
                    let response = match (method.as_str(), url.as_str()) {
                        ("GET", "/") => tiny_http::Response::from_string("ok").boxed(),
                        ("GET", "/voices") => tiny_http::Response::from_string(
                            r#"[{"id":"alba","license":"CC-BY-4.0"}]"#,
                        )
                        .with_header(
                            tiny_http::Header::from_bytes("Content-Type", "application/json")
                                .unwrap(),
                        )
                        .boxed(),
                        ("POST", "/tts") => {
                            // The form body must have come through verbatim.
                            if !content_type.starts_with("multipart/form-data")
                                || !body.contains("name=\"text\"")
                            {
                                tiny_http::Response::from_string("bad form")
                                    .with_status_code(400)
                                    .boxed()
                            } else {
                                // Stream in pieces with pauses, as a model does.
                                let (reader, mut writer) = os_pipe();
                                thread::spawn(move || {
                                    for piece in WAV.chunks(24) {
                                        let _ = writer.write_all(piece);
                                        let _ = writer.flush();
                                        thread::sleep(Duration::from_millis(40));
                                    }
                                });
                                tiny_http::Response::new(
                                    tiny_http::StatusCode(200),
                                    vec![tiny_http::Header::from_bytes(
                                        "Content-Type",
                                        "audio/wav",
                                    )
                                    .unwrap()],
                                    reader,
                                    None,
                                    None,
                                )
                                .boxed()
                            }
                        }
                        _ => tiny_http::Response::from_string("nope")
                            .with_status_code(404)
                            .boxed(),
                    };
                    let _ = request.respond(response);
                }
            })
        };
        Self {
            server,
            worker: Some(worker),
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for FakeProvider {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// A pipe whose read end is `Send + 'static`, for streamed fake replies.
fn os_pipe() -> (
    Box<dyn Read + Send + 'static>,
    Box<dyn Write + Send + 'static>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    struct Reader {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        pending: Vec<u8>,
    }
    impl Read for Reader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pending.is_empty() {
                match self.rx.recv() {
                    Ok(chunk) => self.pending = chunk,
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.pending.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            Ok(n)
        }
    }
    struct Writer {
        tx: std::sync::mpsc::Sender<Vec<u8>>,
    }
    impl Write for Writer {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.tx.send(buf.to_vec());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    (
        Box::new(Reader {
            rx,
            pending: Vec::new(),
        }),
        Box::new(Writer { tx }),
    )
}

struct Fixture {
    config_dir: PathBuf,
    handle: Option<plugins::PluginsHandle>,
}

impl Fixture {
    fn new(manifests: &[(&str, serde_json::Value)]) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let config_dir = std::env::temp_dir().join(format!(
            "docent-plugins-{}-{}-{stamp}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        for (folder, manifest) in manifests {
            let dir = config_dir.join("plugins").join(folder);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("docent-plugin.json"),
                serde_json::to_string_pretty(manifest).unwrap(),
            )
            .unwrap();
        }
        let handle = plugins::spawn(plugins::Host::new(config_dir.clone())).expect("host binds");
        Self {
            config_dir,
            handle: Some(handle),
        }
    }

    fn port(&self) -> u16 {
        self.handle.as_ref().expect("a live host").port()
    }

    fn list(&self) -> serde_json::Value {
        let res = send(
            self.port(),
            "GET",
            "/plugins",
            None,
            "application/json",
            Some(WEBVIEW_ORIGIN),
        );
        assert_eq!(res.status, 200, "{}", res.text());
        res.json()
    }

    fn status_of(&self, name: &str) -> String {
        self.list()
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .map(|p| p["status"]["kind"].as_str().unwrap_or_default().to_string())
            .unwrap_or_default()
    }

    fn wait_for(&self, name: &str, kind: &str, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.status_of(name) == kind {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    fn post(&self, path: &str) -> Res {
        send(
            self.port(),
            "POST",
            path,
            None,
            "application/json",
            Some(WEBVIEW_ORIGIN),
        )
    }

    fn settings(&self) -> serde_json::Value {
        fs::read_to_string(self.config_dir.join("plugins.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(serde_json::Value::Null)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // The host goes first, so the directory it stops plugins in is there.
        self.handle.take();
        let _ = fs::remove_dir_all(&self.config_dir);
    }
}

fn attached(url: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "fake",
        "version": "0.1.0",
        "description": "a fake speech provider",
        "contracts": ["speech/1"],
        "url": url,
        "license": { "code": "MIT" },
        "voices": [{ "id": "alba", "license": "CC-BY-4.0" }],
    })
}

#[test]
fn manifests_are_listed_and_refused_for_the_documented_reasons() {
    let provider = FakeProvider::start();
    let fixture = Fixture::new(&[
        ("fake", attached(&provider.url())),
        (
            "future",
            serde_json::json!({ "name": "future", "contracts": ["speech/2"], "url": "http://127.0.0.1:1" }),
        ),
        (
            "remote",
            serde_json::json!({ "name": "remote", "contracts": ["speech/1"], "url": "http://192.168.1.28:8000" }),
        ),
        ("broken", serde_json::json!("not an object")),
    ]);
    let listed = fixture.list();
    let names: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["broken", "fake", "future", "remote"]);
    assert_eq!(fixture.status_of("fake"), "stopped");
    assert_eq!(fixture.status_of("future"), "refused");
    assert_eq!(fixture.status_of("remote"), "refused");
    assert_eq!(fixture.status_of("broken"), "refused");
    let future = &listed.as_array().unwrap()[2];
    assert!(future["status"]["detail"]
        .as_str()
        .unwrap()
        .contains("speech/2"));
    let remote = &listed.as_array().unwrap()[3];
    assert!(remote["status"]["detail"]
        .as_str()
        .unwrap()
        .contains("loopback"));
    // A refused plugin cannot be enabled.
    let res = fixture.post("/plugins/future/enable");
    assert_eq!(res.status, 409, "{}", res.text());
    // Unknown plugins and non-plugin paths 404.
    assert_eq!(fixture.post("/plugins/nope/enable").status, 409);
    assert_eq!(
        send(
            fixture.port(),
            "GET",
            "/other",
            None,
            "application/json",
            Some(WEBVIEW_ORIGIN)
        )
        .status,
        404
    );
    // The listing carries what the panel shows.
    let fake = &listed.as_array().unwrap()[1];
    assert_eq!(fake["route"], "/plugins/fake");
    assert_eq!(fake["license"]["code"], "MIT");
    assert_eq!(fake["voices"][0]["id"], "alba");
    assert_eq!(fake["enabled"], false);
}

#[test]
fn an_enabled_plugin_is_proxied_with_its_reply_streamed_and_the_choice_remembered() {
    let provider = FakeProvider::start();
    let fixture = Fixture::new(&[("fake", attached(&provider.url()))]);
    // Not enabled: the route answers 503, never the provider.
    let res = send(
        fixture.port(),
        "GET",
        "/plugins/fake/voices",
        None,
        "application/json",
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 503, "{}", res.text());
    // Enable: remembered at once, running once health answers.
    let res = fixture.post("/plugins/fake/enable");
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(fixture.settings()["enabled"], serde_json::json!(["fake"]));
    assert!(fixture.wait_for("fake", "running", Duration::from_secs(5)));
    // GET is proxied, with the provider's content type.
    let res = send(
        fixture.port(),
        "GET",
        "/plugins/fake/voices",
        None,
        "application/json",
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(res
        .headers
        .to_lowercase()
        .contains("content-type: application/json"));
    assert_eq!(res.json()[0]["id"], "alba");
    // POST carries the form through verbatim; the wav streams back whole.
    let boundary = "----docent";
    let form = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nHello there\r\n--{boundary}--\r\n"
    );
    let started = Instant::now();
    let res = send(
        fixture.port(),
        "POST",
        "/plugins/fake/tts?x=1",
        Some(form.as_bytes()),
        &format!("multipart/form-data; boundary={boundary}"),
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(
        res.headers
            .to_lowercase()
            .contains("content-type: audio/wav"),
        "{}",
        res.headers
    );
    assert_eq!(res.body, WAV);
    // Three pauses of 40ms went by: the reply was streamed, not buffered
    // until the provider finished and then sent — which would also pass
    // this check, so the stronger claim is the proxy's code path: no
    // length header, a pass-through reader.
    assert!(started.elapsed() >= Duration::from_millis(80));
    assert!(
        !res.headers.to_lowercase().contains("content-length"),
        "{}",
        res.headers
    );
    // The origin gate: curl-shaped callers are refused everywhere.
    assert_eq!(
        send(
            fixture.port(),
            "GET",
            "/plugins",
            None,
            "application/json",
            None
        )
        .status,
        403
    );
    assert_eq!(
        send(
            fixture.port(),
            "GET",
            "/plugins/fake/voices",
            None,
            "application/json",
            Some("http://evil.example")
        )
        .status,
        403
    );
    // Disable: forgotten, stopped, and the route closes.
    let res = fixture.post("/plugins/fake/disable");
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(fixture.settings()["enabled"], serde_json::json!([]));
    assert_eq!(fixture.status_of("fake"), "stopped");
    let res = send(
        fixture.port(),
        "GET",
        "/plugins/fake/voices",
        None,
        "application/json",
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 503);
}

#[test]
fn an_enabled_plugin_comes_back_at_launch() {
    let provider = FakeProvider::start();
    let mut first = Fixture::new(&[("fake", attached(&provider.url()))]);
    assert_eq!(first.post("/plugins/fake/enable").status, 200);
    first.handle.take();
    // Same config dir, new host: the choice was remembered and acted on.
    let handle = plugins::spawn(plugins::Host::new(first.config_dir.clone())).expect("host binds");
    first.handle = Some(handle);
    let second = first;
    assert!(second.wait_for("fake", "running", Duration::from_secs(5)));
    assert_eq!(second.list()[0]["enabled"], true);
}

#[cfg(unix)]
#[test]
fn a_command_the_host_started_is_run_with_the_port_and_stopped_on_disable() {
    let fixture = Fixture::new(&[(
        "py",
        serde_json::json!({
            "name": "py",
            "version": "0",
            "contracts": ["speech/1"],
            "run": {
                "command": "python3",
                "args": ["-m", "http.server", "{port}", "--bind", "127.0.0.1"],
                "health": "/"
            }
        }),
    )]);
    let res = fixture.post("/plugins/py/enable");
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(
        fixture.wait_for("py", "running", Duration::from_secs(20)),
        "python3 -m http.server never answered: {}",
        fixture.status_of("py")
    );
    // Proxied: the directory listing of the plugin's folder comes through.
    let res = send(
        fixture.port(),
        "GET",
        "/plugins/py/",
        None,
        "text/plain",
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(res.text().contains("docent-plugin.json"), "{}", res.text());
    // The log is where the process wrote.
    let log = fixture
        .config_dir
        .join("plugins")
        .join("py")
        .join("plugin.log");
    assert!(log.exists());
    assert_eq!(fixture.list()[0]["log"], log.to_string_lossy().as_ref());
    // Disable stops the process: its port stops answering.
    let listed = fixture.list();
    assert_eq!(listed[0]["status"]["kind"], "running");
    assert_eq!(fixture.post("/plugins/py/disable").status, 200);
    assert_eq!(fixture.status_of("py"), "stopped");
    let res = send(
        fixture.port(),
        "GET",
        "/plugins/py/",
        None,
        "text/plain",
        Some(WEBVIEW_ORIGIN),
    );
    assert_eq!(res.status, 503);
}

#[cfg(unix)]
#[test]
fn a_launch_sweeps_what_a_killed_previous_host_left_running() {
    let fixture = Fixture::new(&[(
        "py",
        serde_json::json!({
            "name": "py",
            "version": "0",
            "contracts": ["speech/1"],
            "run": {
                "command": "python3",
                "args": ["-m", "http.server", "{port}", "--bind", "127.0.0.1"],
                "health": "/"
            }
        }),
    )]);
    assert_eq!(fixture.post("/plugins/py/enable").status, 200);
    assert!(fixture.wait_for("py", "running", Duration::from_secs(20)));
    let pids: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(fixture.config_dir.join("plugins-pids.json")).expect("pids recorded"),
    )
    .unwrap();
    let pid = pids["started"]["py"].as_u64().expect("a pid") as u32;
    // `kill -0` would say yes to a zombie — and the forgotten handle below
    // never reaps its child — so ask for the state: gone, or a Z, is dead.
    let alive = |pid: u32| {
        std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|out| {
                let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
                !stat.is_empty() && !stat.starts_with('Z')
            })
            .unwrap_or(false)
    };
    assert!(alive(pid));
    // The host "dies" without stopping anything: leak the handle's threads
    // by forgetting it — exactly what a kill -9 of the app amounts to.
    let mut fixture = fixture;
    std::mem::forget(fixture.handle.take());
    assert!(alive(pid), "the engine outlived its host");
    // A fresh host over the same config sweeps it before doing anything.
    let handle =
        plugins::spawn(plugins::Host::new(fixture.config_dir.clone())).expect("host binds");
    // The watcher acts on its signal after its one-second tick.
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid), "the stale engine should have been stopped");
    assert!(
        !fixture.config_dir.join("plugins-pids.json").exists() || {
            // The new host re-enabled the plugin (it was remembered) and
            // recorded its own, new pid.
            let again: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(fixture.config_dir.join("plugins-pids.json")).unwrap(),
            )
            .unwrap();
            again["started"]["py"].as_u64() != Some(u64::from(pid))
        }
    );
    fixture.handle = Some(handle);
}
