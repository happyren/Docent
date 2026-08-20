/**
 * The one MCP dispatcher (B4, D19, D34): the tool table and the JSON-RPC
 * handling every Docent agent surface runs. Plain ESM with zero
 * dependencies (I7) and zero DOM, so both consumers can import it as-is:
 *
 *   server/docent-mcp.mjs   — the self-host server; relays tool calls to
 *                             the connected canvas over its bridge
 *   src/agent/desktopBridge — the desktop page; executes tool calls
 *                             directly against the Command API
 *
 * Tool semantics live in the page-side executor (src/agent/execute.ts);
 * nothing here touches a scene. Q5: every tool description carries one
 * worked example, and get_scene_graph output is self-describing enough to
 * drive everything else.
 */

export const SERVER_INFO = { name: "docent", version: "1.1.0" };

/**
 * Handed to every client at initialize (D45): how a Docent diagram is meant
 * to be read. Diagrams are tiered — a Layer 1 of frames, with components
 * that declare detail layers beneath — and the honest way to read one is the
 * way it is built: outline first, one tier at a time, diving where the
 * question leads.
 */
export const INSTRUCTIONS = [
  "Docent diagrams are TIERED: Layer 1 is a set of frames; components marked `detail` open a deeper layer (a frame) drawing their inner mechanism, and so on without bound.",
  "Read progressively, never as one wall: call get_outline first (tiers, frames, what goes deeper), then read_frame on the one frame the question is about, dive into a component to go a tier down and climb to come back, and get_view to know where the camera is.",
  "When the user asks about one part of the diagram, call find({query}) — it matches labels, tags, intents, notes, logic, narratives, and legend meanings across every tier and returns each hit with its tier trail, so the relevant layer is one dive away.",
  "Narrate with the author's own words: every entity carries legend-applied meaning (kind, mapped properties), intents, notes, logic, and frame narratives, each labeled with its provenance — prefer `declared` facts over your own paraphrase, and say when something is `inferred`.",
  "Everything is read-only: you may move the camera, highlight, pulse flows, narrate, present, and open scenes, never edit. Move in ID-space with focus (a component is framed with its neighbourhood; padding is the zoom), dive/climb, and present — there are no pixel coordinates.",
].join("\n");

export const TOOLS = [
  {
    name: "get_scene_graph",
    description:
      "Read the whole diagram as its semantic graph — the legend-APPLIED view, not raw styling: nodes, edges, frames, groups, and the legend record, with stable `id`s every other tool addresses. Each node/edge carries what the author meant: `kind` and mapped properties (from the legend), `tags`, `note` and `intents` (declared statements, in order), `logic` (pseudocode/rules), `detail` (the frame drawing that node's inner mechanism — `dive` goes there), `toRefined`/`fromRefined` on edges (the inner component the edge lands on / departs from), and a `provenance` map per entity ('declared' = the author's words, 'inferred' = a heuristic; anything unlisted is read straight off the drawing). Frames carry `name`, `order`, and `narrative`. Diagrams are tiered: on a large one (more than 150 components) this answers with the outline and the progressive path instead — use get_outline / read_frame / find, or pass force: true.\nExample: get_scene_graph() → {provenanceDefault:'explicit', nodes:[{id:'n_gateway',label:'API Gateway',kind:'service',intents:['rate-limits at the edge'],provenance:{kind:'declared',intents:'declared'}}], edges:[{id:'e_req',from:'n_client',to:'n_gateway'}], frames:[{id:'f_ingress',name:'01 Ingress',narrative:'…'}]}",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Return the full graph even on a large diagram (default false)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_outline",
    description:
      "The diagram's table of contents — read this FIRST. Tiers, every frame with its tier, name, narrative opener, component count, and which of its components go deeper (declare a detail layer), plus the totals. Cheap on any size of diagram; it is how you decide which frame to read_frame next and where to dive.\nExample: get_outline() → {tiers:2, components:41, frames:[{id:'f_core',name:'02 Core Services',tier:1,components:4,deeper:[{id:'n_orders',label:'Orders'}]},{id:'f_orders_internals',name:'Orders — internals',tier:2,via:{id:'n_orders',label:'Orders'},parent:'f_core',components:3}]}",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find",
    description:
      "Locate the part of the diagram a question is about: case-insensitive keyword match across labels, tags, intents, notes, logic, frame names and narratives, and legend meanings, over EVERY tier. Hits come ranked (label and intents weigh most) with their `trail` — the tier path from Layer 1 down to the frame the hit lives in — so the right layer is one dive away; an empty trail means Layer 1.\nExample: find({query:'retry'}) → {hits:[{id:'n_retry_queue',type:'node',label:'Retry queue',frame:'f_orders_internals',trail:[{id:'f_orders_internals',name:'Orders — internals'}],matched:['label','logic']}]}",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "One or more keywords" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_mermaid",
    description:
      "Read the diagram as Mermaid — the compact, AI-first export: legend meanings applied, refinements as dotted edges, a fraction of the tokens of the raw scene. Prefer this over get_scene_graph when you only need to understand the diagram, and the graph when you need ids to act with.\nExample: get_mermaid() → 'flowchart TD\\n  n_client[Client] --> n_gateway[API Gateway]\\n  …'",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_frame",
    description:
      "Read ONE frame's semantic JSON — the frame, its components, their bound labels, and the scene legend, one tier deep. Layers nested beneath the frame's components are never included; dive into them and read again. The honest way to study a single tier of a big diagram.\nExample: read_frame({id:'f_orders_internals'}) → {name:'Orders — internals', sidecar:'{…}'}",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Graph id of a frame" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "The portfolio: every project on this Docent and the scenes each one holds. Use it to find which diagram answers the user's question, then open_scene it.\nExample: list_projects() → [{project:'work', scenes:['payments-platform','auth-flows']}]",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_scene",
    description:
      "Open a portfolio scene onto the canvas (read-only navigation — the document itself is never modified). Refused while the canvas holds unsaved changes: the user decides what happens to their work, never an agent.\nExample: open_scene({project:'work', scene:'payments-platform'}) then get_scene_graph() to read what opened.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        scene: { type: "string" },
      },
      required: ["project", "scene"],
      additionalProperties: false,
    },
  },
  {
    name: "get_view",
    description:
      "Where the canvas is right now: the open scene (project/scene, or null for a loose file), the tier breadcrumb trail from Layer 1 down to the detail frame the viewport sits in, and the presentation state.\nExample: get_view() → {scene:{project:'work',scene:'payments-platform'}, trail:[{id:'f_orders_internals',name:'Orders — internals'}], presentation:{active:false}}",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "focus",
    description:
      "Glide the camera to a component, edge, or frame — this is how you pan and zoom, in ids only, never pixels. A component is framed WITH its neighbourhood (the components its edges connect it to on that tier) and never fills the view: a zoom ceiling keeps it under 40% of the frame, so the context that gives it meaning stays visible. context:'self' frames the component alone (still under the ceiling); focus a frame to see a whole tier; raise `padding` to pull back wider. Unknown ids return an error — never a silent no-op.\nExample: focus({id:'n_gateway'}) — the gateway with its client and auth neighbours in view; focus({id:'f_ingress'}) — the whole ingress frame.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Graph id of a node, edge, or frame" },
        padding: {
          type: "number",
          description: "Fractional padding around the framed box (default 0.2; larger = wider)",
        },
        context: {
          type: "string",
          enum: ["neighbors", "self"],
          description: "For a component: frame it with its edge-connected neighbours (default) or alone",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "dive",
    description:
      "Dive the camera into a component's declared detail layer — the frame drawing its inner mechanism. Only components whose graph node carries `detail` can be dived into; depth is unbounded (components inside a detail layer may declare their own).\nExample: dive({id:'n_orders'}) — the camera portals into the Orders internals frame; read_frame or get_scene_graph to study it, climb() to come back.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Graph id of a node with a detail layer" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "climb",
    description:
      "Climb one tier back up from the current detail layer — the inverse of dive. From Layer 1 it is a no-op with a message.\nExample: climb()",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "present",
    description:
      "Drive presentation mode — the continuous-camera walkthrough over the diagram's frames, in the author's declared order with their narratives. Actions: 'enter' (start, from the overview), 'next'/'prev' (step between waypoints), 'overview' (pull back to the whole tier), 'exit'.\nExample: present({action:'enter'}) then present({action:'next'}) as you narrate each waypoint.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enter", "exit", "next", "prev", "overview"] },
      },
      required: ["action"],
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

/**
 * One JSON-RPC message in, one response out (null for notifications and
 * malformed traffic). Both transports and both surfaces call this — the
 * layers around it carry zero logic (B4).
 *
 * @param {unknown} message
 * @param {(tool: string, params: Record<string, unknown>) => Promise<unknown>} callTool
 */
export async function dispatch(message, callTool) {
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
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
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
        const result = await callTool(tool, params?.arguments ?? {});
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (err) {
        return reply({
          content: [
            { type: "text", text: String(err instanceof Error ? err.message : err) },
          ],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/**
 * One streamable-HTTP POST body in, one answer out — shared by the Node
 * /mcp handler and the desktop page (the Rust shell forwards bodies here
 * verbatim and stamps the session header when `initialized` says so).
 *
 * @param {string} body
 * @param {(tool: string, params: Record<string, unknown>) => Promise<unknown>} callTool
 * @returns {Promise<{status: number, json: string | null, initialized: boolean}>}
 */
export async function handleMcpBody(body, callTool) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      status: 400,
      json: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
      initialized: false,
    };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const initialized = messages.some((m) => m?.method === "initialize");
  const responses = (
    await Promise.all(messages.map((m) => dispatch(m, callTool)))
  ).filter(Boolean);
  if (responses.length === 0) return { status: 202, json: null, initialized };
  return {
    status: 200,
    json: JSON.stringify(Array.isArray(parsed) ? responses : responses[0]),
    initialized,
  };
}
