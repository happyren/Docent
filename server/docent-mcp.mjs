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
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" },
              }),
            );
            return;
          }
          const messages = Array.isArray(parsed) ? parsed : [parsed];
          if (messages.some((m) => m?.method === "initialize")) {
            res.setHeader("mcp-session-id", randomUUID());
          }
          const responses = (
            await Promise.all(messages.map((m) => dispatch(m)))
          ).filter(Boolean);
          if (responses.length === 0) {
            res.writeHead(202).end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(Array.isArray(parsed) ? responses : responses[0]),
          );
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

// ------------------------------------------------------------- MCP tools --
// Q5: every tool carries a docstring with one worked example, and
// get_scene_graph output is self-describing enough to drive everything else.
const TOOLS = [
  {
    name: "get_scene_graph",
    description:
      "Read the diagram as a semantic graph: nodes, edges, frames, groups, and the declared legend. Every entity has a stable `id` — all other tools address the scene through these ids. Nodes carry label/shape/frame/tags/note/detail (detail = the frame drawing that node's inner mechanism); edges carry from/to plus fromProvenance/toProvenance ('explicit' = drawn binding, 'inferred' = proximity guess); frames carry name/order/narrative (the author's own words — prefer them when narrating).\nExample: get_scene_graph() → {nodes:[{id:'n_gateway',label:'API Gateway',...}], edges:[{id:'e_req',from:'n_client',to:'n_gateway'}], frames:[{id:'f_ingress',name:'01 Ingress',narrative:'…'}]}",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "focus",
    description:
      "Glide the camera to an element's or frame's bounds with an eased tween. Unknown ids return an error — never a silent no-op.\nExample: focus({id:'f_ingress'}) — the camera flies to the ingress frame; focus({id:'n_db', padding:0.35}) leaves more breathing room.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Graph id of a node, edge, or frame" },
        padding: {
          type: "number",
          description: "Fractional padding around the target (default 0.2)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "highlight",
    description:
      "Highlight components on the non-destructive overlay. Styles: 'glow' (default), 'spotlight' (dim everything else), 'outline'. Idempotent; clear with ids: [].\nExample: highlight({ids:['n_gateway','n_auth'], style:'spotlight'}) then later highlight({ids:[]}).",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        style: { type: "string", enum: ["glow", "spotlight", "outline"] },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "flow",
    description:
      "Animate a light pulse traveling each edge end-to-end, in order — multi-hop request tracing. Resolves when the pulse finishes (loop: first cycle).\nExample: flow({path:['e_req','e_verify','e_query']}) traces client → gateway → auth → database.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "array", items: { type: "string" }, description: "Ordered edge ids" },
        speed: { type: "number", description: "1.0 ≈ 500 scene-units/s" },
        loop: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "narrate",
    description:
      "Show text in the narration panel. Empty/null text hides the panel.\nExample: narrate({text:'Requests land at the gateway first.'})",
    inputSchema: {
      type: "object",
      properties: { text: { type: ["string", "null"] } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "tour",
    description:
      "Run a narrated walkthrough. Each step may focus, highlight, pulse a flow, and narrate; when a step focuses a frame and omits narrate, the frame's author-declared narrative narrates it. Interruptible by the user; resolves with steps completed.\nExample: tour({steps:[{focus:'f_ingress'},{focus:'n_gateway',highlight:['n_gateway'],narrate:'The gateway rate-limits at the edge.'},{flow:['e_verify'],narrate:'Every request is verified.'}]})",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              focus: { type: "string" },
              highlight: { type: "array", items: { type: "string" } },
              highlightStyle: {
                type: "string",
                enum: ["glow", "spotlight", "outline"],
              },
              flow: { type: "array", items: { type: "string" } },
              narrate: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        stepMs: {
          type: "number",
          description: "Fixed per-step dwell in ms (default scales with narration length)",
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_effects",
    description:
      "Clear every overlay effect and hide the narration panel.\nExample: clear_effects({})",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// -------------------------------------------------- shared dispatcher --
/**
 * One JSON-RPC message in, one response out (null for notifications and
 * malformed traffic). Both transports call this — the transport layers
 * carry zero logic (B4).
 */
async function dispatch(message) {
  const { id, method, params } = message ?? {};
  const reply = (result) =>
    id !== undefined ? { jsonrpc: "2.0", id, result } : null;
  const fail = (code, msg) =>
    id !== undefined ? { jsonrpc: "2.0", id, error: { code, message: msg } } : null;

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "docent", version: "0.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const tool = params?.name;
      if (!TOOLS.some((t) => t.name === tool)) {
        return fail(-32602, `Unknown tool: ${tool}`);
      }
      try {
        const result = await callCanvas(tool, params?.arguments ?? {});
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (err) {
        return reply({
          content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

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
    void dispatch(message).then((response) => response && write(response));
  });
  rl.on("close", () => process.exit(0));
}
