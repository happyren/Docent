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

export const SERVER_INFO = { name: "docent", version: "1.0.0" };

export const TOOLS = [
  {
    name: "get_scene_graph",
    description:
      "Read the diagram as a semantic graph: nodes, edges, frames, groups, and the declared legend. Every entity has a stable `id` — all other tools address the scene through these ids. Nodes carry label/shape/frame/tags/note/detail (detail = the frame drawing that node's inner mechanism — `dive` goes there); edges carry from/to plus fromProvenance/toProvenance ('explicit' = drawn binding, 'inferred' = proximity guess) and, when declared, toRefined/fromRefined — the inner component of the endpoint's detail diagram the edge actually lands on or departs from; frames carry name/order/narrative (the author's own words — prefer them when narrating).\nExample: get_scene_graph() → {nodes:[{id:'n_gateway',label:'API Gateway',...}], edges:[{id:'e_req',from:'n_client',to:'n_gateway',toRefined:'n_router'}], frames:[{id:'f_ingress',name:'01 Ingress',narrative:'…'}]}",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
      "Glide the camera to an element's or frame's bounds with an eased tween — this is how you pan and zoom: focus a frame to see a whole tier, focus a node to move close, raise `padding` to pull back wider. Ids only, never pixels. Unknown ids return an error — never a silent no-op.\nExample: focus({id:'f_ingress'}) — fly to the ingress frame; focus({id:'n_db', padding:0.6}) — the database with plenty of context around it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Graph id of a node, edge, or frame" },
        padding: {
          type: "number",
          description: "Fractional padding around the target (default 0.2; larger = zoomed further out)",
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
