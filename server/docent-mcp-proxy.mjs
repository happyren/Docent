#!/usr/bin/env node
/**
 * Docent MCP stdio bridge to a deployed Docent (S8, D7, B4).
 *
 * Many MCP clients only accept remote servers over HTTPS, which a
 * self-hosted LAN deployment on plain HTTP can't satisfy without
 * certificates for an IP address. This process closes that gap: the
 * client spawns it over stdio — always allowed, no transport policy to
 * satisfy — and it forwards every JSON-RPC message verbatim to the
 * deployment's `/mcp` endpoint and writes the answer back. No logic of
 * its own (B4): it is a transport shim, not a second server.
 *
 * Zero runtime dependencies (I7): Node's built-in fetch and readline.
 *
 * Run:  node server/docent-mcp-proxy.mjs http://<host>:<port>/mcp
 * Env:  DOCENT_REMOTE_MCP — the same URL, when passing args is awkward.
 *
 * With Claude Code, for example:
 *   claude mcp add docent -- node /path/to/server/docent-mcp-proxy.mjs \
 *     http://192.168.1.28:3300/mcp
 */
import { createInterface } from "node:readline";

const REMOTE = process.argv[2] ?? process.env.DOCENT_REMOTE_MCP;
const REQUEST_TIMEOUT_MS = 130_000;

if (!REMOTE) {
  process.stderr.write(
    "docent-mcp-proxy: pass the deployment's /mcp URL, e.g.\n" +
      "  node server/docent-mcp-proxy.mjs http://192.168.1.28:3300/mcp\n",
  );
  process.exit(2);
}

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/**
 * The session id the deployment issued at initialize. Docent's server is
 * stateless, but the spec expects the header echoed back, and a future
 * server (or a proxy in front of one) may rely on it.
 */
let sessionId = null;

async function forward(message) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(REMOTE, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const issued = response.headers.get("mcp-session-id");
  if (issued) sessionId = issued;
  // Notifications answer 202 with no body — nothing to relay.
  if (response.status === 202) return null;
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

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
  void forward(message)
    .then((response) => {
      if (response) write(response);
    })
    .catch((err) => {
      // A transport failure must surface as a JSON-RPC error, not silence:
      // the client should say "can't reach Docent", not hang.
      const id = Array.isArray(message) ? null : (message?.id ?? null);
      if (id === null || id === undefined) return;
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: `Cannot reach Docent at ${REMOTE}: ${err instanceof Error ? err.message : err}`,
        },
      });
    });
});
rl.on("close", () => process.exit(0));
