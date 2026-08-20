#!/usr/bin/env node
/**
 * Docent MCP server (S8, B4, D7) — a thin transport over the in-browser
 * Command API. No scene logic lives here: tool calls are relayed to the
 * connected canvas over an HTTP + Server-Sent-Events bridge and results
 * relayed back. Zero runtime dependencies (I7): hand-rolled MCP stdio
 * framing (newline-delimited JSON-RPC 2.0) and Node's built-in http.
 *
 * Two transports, one dispatcher, any MCP client — the protocol is an
 * open standard and nothing here is vendor-specific:
 *   stdio            — local clients spawn this process directly
 *   streamable HTTP  — POST /mcp on the bridge port; this is how a
 *                      deployed Docent exposes agent control (nginx
 *                      proxies /mcp and /bridge same-origin)
 *
 * Run:  node server/docent-mcp.mjs        (bridge + /mcp on port 3001)
 * Env:  DOCENT_BRIDGE_PORT, DOCENT_MCP_HTTP_ONLY=1 (service mode: skip
 *       stdio so a detached stdin doesn't end the process)
 * Then open the Docent canvas and connect it (Menu → Connect agent
 * bridge, or ?agent), and point any MCP client at stdio or /mcp.
 */
import http from "node:http";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dispatch, handleMcpBody } from "./mcp-core.mjs";

const BRIDGE_PORT = Number(process.env.DOCENT_BRIDGE_PORT ?? "3001");
const CALL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- bridge --
/** @type {import("node:http").ServerResponse | null} */
let canvasStream = null;
const pending = new Map(); // id → {resolve, reject, timer}

const bridge = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // ------------------------------------- MCP streamable HTTP transport --
  // The deployed agent endpoint: any MCP client POSTs JSON-RPC here.
  // Stateless by design — the canvas bridge is global, tools carry no
  // per-session state — so the session id is issued for spec conformance
  // and accepted without bookkeeping.
  if (req.url === "/mcp") {
    if (req.method === "GET") {
      // No server-initiated stream; the spec allows refusing with 405.
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          const answer = await handleMcpBody(body, callCanvas);
          if (answer.initialized) {
            res.setHeader("mcp-session-id", randomUUID());
          }
          if (answer.json === null) {
            res.writeHead(answer.status).end();
            return;
          }
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(answer.json);
        })();
      });
      return;
    }
    res.writeHead(405, { allow: "POST, DELETE" }).end();
    return;
  }
  if (req.method === "GET" && req.url === "/bridge/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    canvasStream?.end();
    canvasStream = res;
    req.on("close", () => {
      if (canvasStream === res) canvasStream = null;
    });
    return;
  }
  if (req.method === "POST" && req.url === "/bridge/result") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200).end("ok");
      try {
        const { id, ok, result, error } = JSON.parse(body);
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error ?? "canvas error"));
      } catch {
        // ignore malformed results
      }
    });
    return;
  }
  res.writeHead(404).end();
});
bridge.listen(BRIDGE_PORT, () => {
  console.error(`docent-mcp: bridge + /mcp on :${BRIDGE_PORT}`);
});

function callCanvas(tool, params) {
  return new Promise((resolve, reject) => {
    if (!canvasStream) {
      reject(
        new Error(
          "No canvas connected — open Docent in a browser and connect it via Menu → Connect agent bridge (or add ?agent to the URL)",
        ),
      );
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Canvas did not answer within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    canvasStream.write(`data: ${JSON.stringify({ id, tool, params })}\n\n`);
  });
}

// Tool table and JSON-RPC handling live in mcp-core.mjs (D34) — the one
// dispatcher both this server and the desktop page run. This file is pure
// transport: bridge relay plus the two MCP framings.

// -------------------------------------------------- MCP stdio transport --
// Service deployments run HTTP-only: with no client on stdin (docker gives
// the process /dev/null) readline would close immediately and exit(0).
if (!process.env.DOCENT_MCP_HTTP_ONLY) {
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    void dispatch(message, callCanvas).then((response) => response && write(response));
  });
  rl.on("close", () => process.exit(0));
}
