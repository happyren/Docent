#!/usr/bin/env node
/**
 * Docent MCP server (S8, B4, D7) — a thin transport over the in-browser
 * Command API. No scene logic lives here: tool calls are relayed to the
 * connected canvas over an HTTP + Server-Sent-Events bridge and results
 * relayed back. Zero runtime dependencies (I7): hand-rolled MCP stdio
 * framing (newline-delimited JSON-RPC 2.0) and Node's built-in http.
 *
 * Run:  node server/docent-mcp.mjs        (bridge on port 3001)
 * Then open the Docent canvas (it connects to the bridge automatically)
 * and point any MCP client at this process over stdio.
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
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
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
bridge.listen(BRIDGE_PORT);

function callCanvas(tool, params) {
  return new Promise((resolve, reject) => {
    if (!canvasStream) {
      reject(
        new Error(
          `No canvas connected — open Docent in a browser (it attaches to the bridge on port ${BRIDGE_PORT} automatically)`,
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

// -------------------------------------------------- MCP stdio transport --
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
  void handle(message);
});
rl.on("close", () => process.exit(0));

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => id !== undefined && write({ jsonrpc: "2.0", id, result });
  const fail = (code, msg) =>
    id !== undefined && write({ jsonrpc: "2.0", id, error: { code, message: msg } });

  switch (method) {
    case "initialize":
      reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "docent", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "tools/call": {
      const tool = params?.name;
      if (!TOOLS.some((t) => t.name === tool)) {
        fail(-32602, `Unknown tool: ${tool}`);
        return;
      }
      try {
        const result = await callCanvas(tool, params?.arguments ?? {});
        reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (err) {
        reply({
          content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (id !== undefined) fail(-32601, `Method not found: ${method}`);
  }
}
