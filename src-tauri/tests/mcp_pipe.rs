//! The desktop agent pipe (S15, D34): a client POSTs JSON-RPC to /mcp, the
//! page long-polls it off /bridge/poll and posts the dispatcher's answer to
//! /bridge/answer, and the client hears exactly what the page said. The pipe
//! itself carries no agent logic — these tests fake the page with canned
//! answers and assert the relay, the origin gate, and the method gating.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::thread;

use docent_lib::mcp;

const WEBVIEW_ORIGIN: &str = "tauri://localhost";

struct Res {
    status: u16,
    headers: String,
    body: String,
}

fn send(port: u16, method: &str, path: &str, body: Option<&str>, origin: Option<&str>) -> Res {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("pipe accepts connections");
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(origin) = origin {
        head.push_str(&format!("Origin: {origin}\r\n"));
    }
    head.push_str(&format!(
        "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
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
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let (headers, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    // tiny_http answers Connection: close without chunking, so the body is
    // the remainder verbatim.
    Res {
        status,
        headers: headers.to_string(),
        body: body.to_string(),
    }
}

#[test]
fn the_pipe_relays_a_request_and_the_pages_answer_back() {
    let pipe = mcp::spawn().expect("pipe binds");
    let port = pipe.port();

    // The fake page: pull one queued body off the bridge, answer it the way
    // mcp-core would, carry the initialize marker through.
    let page = thread::spawn(move || {
        for _ in 0..10 {
            let polled = send(port, "POST", "/bridge/poll", None, Some(WEBVIEW_ORIGIN));
            if polled.status != 200 {
                continue;
            }
            let queued: serde_json::Value =
                serde_json::from_str(&polled.body).expect("queued json");
            let body = queued["body"].as_str().expect("queued body");
            let answer = serde_json::json!({
                "id": queued["id"],
                "status": 200,
                "json": r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true,"echo":true}}"#,
                "initialized": body.contains("initialize"),
            });
            let posted = send(
                port,
                "POST",
                "/bridge/answer",
                Some(&answer.to_string()),
                Some(WEBVIEW_ORIGIN),
            );
            assert_eq!(posted.status, 200);
            return body.to_string();
        }
        panic!("the page never saw the request");
    });

    let res = send(
        port,
        "POST",
        "/mcp",
        Some(r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}"#),
        None,
    );
    assert_eq!(res.status, 200, "{}", res.body);
    assert!(
        res.headers.to_ascii_lowercase().contains("mcp-session-id:"),
        "initialize earns a session header: {}",
        res.headers
    );
    assert!(res.body.contains(r#""echo":true"#), "{}", res.body);

    let seen = page.join().expect("page thread");
    assert!(seen.contains(r#""method":"initialize""#));
}

#[test]
fn the_bridge_answers_only_the_webview() {
    let pipe = mcp::spawn().expect("pipe binds");
    let port = pipe.port();
    // No origin at all (curl), and a wrong one — both are turned away
    // before they can see or answer queued agent traffic.
    assert_eq!(send(port, "POST", "/bridge/poll", None, None).status, 403);
    assert_eq!(
        send(
            port,
            "POST",
            "/bridge/answer",
            Some("{}"),
            Some("http://evil.example")
        )
        .status,
        403
    );
}

#[test]
fn the_stdio_shim_pipes_a_line_through_the_running_app() {
    let pipe = mcp::spawn().expect("pipe binds");
    let port = pipe.port();

    // The fake page again: one canned answer for whatever arrives.
    let page = thread::spawn(move || {
        for _ in 0..10 {
            let polled = send(port, "POST", "/bridge/poll", None, Some(WEBVIEW_ORIGIN));
            if polled.status != 200 {
                continue;
            }
            let queued: serde_json::Value =
                serde_json::from_str(&polled.body).expect("queued json");
            let answer = serde_json::json!({
                "id": queued["id"],
                "status": 200,
                "json": r#"{"jsonrpc":"2.0","id":3,"result":{"viaShim":true}}"#,
                "initialized": false,
            });
            send(
                port,
                "POST",
                "/bridge/answer",
                Some(&answer.to_string()),
                Some(WEBVIEW_ORIGIN),
            );
            return;
        }
        panic!("the page never saw the shim's request");
    });

    let input = b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n" as &[u8];
    let mut output = Vec::new();
    mcp::stdio_shim(input, &mut output, move || vec![port]);
    page.join().expect("page thread");
    let printed = String::from_utf8(output).expect("utf8 output");
    assert!(printed.contains(r#""viaShim":true"#), "{printed}");
}

#[test]
fn the_stdio_shim_says_the_app_is_not_running() {
    // Port 9 (discard) refuses on loopback — the shim must answer the
    // request with words, not die or go silent.
    let input =
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n" as &[u8];
    let mut output = Vec::new();
    mcp::stdio_shim(input, &mut output, || vec![9]);
    let printed = String::from_utf8(output).expect("utf8 output");
    assert!(printed.contains("Docent is not running"), "{printed}");
    assert!(printed.contains(r#""id":1"#), "{printed}");
}

#[test]
fn the_port_file_round_trips() {
    let dir = std::env::temp_dir().join(format!("docent-portfile-{}", std::process::id()));
    mcp::record_port_in(&dir, 43110);
    assert_eq!(mcp::read_port_in(&dir), Some(43110));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_mcp_method_gate_matches_the_reference_server() {
    let pipe = mcp::spawn().expect("pipe binds");
    let port = pipe.port();
    // GET is refused the way the spec allows; DELETE is the polite goodbye.
    assert_eq!(send(port, "GET", "/mcp", None, None).status, 405);
    assert_eq!(send(port, "DELETE", "/mcp", None, None).status, 204);
    assert_eq!(send(port, "GET", "/nowhere", None, None).status, 404);
}
