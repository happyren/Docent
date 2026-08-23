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
  "Narration may be SPOKEN aloud on the desktop (a voice plugin): write narration as prose to be read — short sentences, the author's words. The camera waits for the voice, not you: narrate() returns as soon as speech starts, and focus/highlight/flow/present/dive wait for the sentence in flight before they move — so ONE CALL PER STOP: focus({id, narrate:'…'}) flies there and speaks on arrival. Never spell numbers or symbols out; they are read the way an engineer says them.",
  "For a walkthrough: script_tour({frame?}) derives the stops and the author's words from the diagram itself (frames in order, components in flow order; `declared` lines are the author's, `inferred` lines are yours to rewrite) — then present({action:'enter', mode:'guided'}) and tour({steps}). That is three calls for a whole walkthrough, and it is the same walkthrough every time. Each result carries a `next` hint.",
  "You may also AUTHOR: add_node / add_edge / update / remove / add_frame / add_detail_layer / define_kind / layout, or many at once with edit({ops}) — one validated, all-or-nothing batch, one undo step, answered with the semantic changelog; propose({ops}) is the same batch as a dry run. You author MEANING, never pixels: a component is a label + a `kind` (from the legend — define_kind adds one) + intents; Docent picks the shape, the style (the diagram's own), and the place. The craft: every component gets a kind and at least one intent; rules and conditions become `logic`; every frame gets a narrative; anything with an inner mechanism gets add_detail_layer rather than a crowded frame (≤12 per frame); reuse existing kinds before defining new ones; refs like `$orders` name things created earlier in the same batch. HOW DOCENT LAYS OUT, so you plan for it: a frame built in one batch is ranked by flow, left to right; a flow longer than five ranks FOLDS into bands that turn (right to left beneath, then left to right again), so a long sequence stays a picture, not a ribbon — plan a frame as a flow, never as a row; the gap between columns is sized to the widest edge label in it, so an edge label is a phrase (two to four words) and the sentence goes in the edge's intents; every edge is routed AROUND any component between its ends with turning points — an arrow never cuts through a shape, and never over the legend. ARROWS MUST NOT CROSS: build a frame in ONE batch (its components and its edges together) so Docent lays it out by flow; add a component with its edges in the same batch so it lands after its feeders; if validate() reports crossings or an edge passing through a component, layout({frame}) a frame you built, re-place the component, or move the tangle into a detail layer — never leave a crossing the diagram does not need. tidy({scope}) formats any frame or the whole diagram and never changes meaning — use it after validate reports crossings, or before save_scene. Work in batches of a frame at a time, then validate() and fix what it lists, then save_scene(). On a project bound to GitHub and sitting on its base branch (get_view().git.onBase), create_branch({name:'docent/<topic>'}) BEFORE the first edit. While you edit the person sees an orange frame; keep batches short and tell them what you changed.",
].join("\n");

/**
 * Published workflows (D58): a prompt is a fixed sequence of calls a client
 * can offer as a command, so the flow is the server's rather than each
 * model's improvisation. Arguments are plain text.
 */
export const PROMPTS = [
  {
    name: "walkthrough",
    description:
      "Narrated walkthrough of the diagram (or one frame): derived stops and words, spoken, at the diagram's pace.",
    arguments: [
      { name: "frame", description: "A frame id from get_outline; omit for the whole Layer 1", required: false },
      { name: "focus", description: "What the listener cares about, to shape the inferred lines", required: false },
    ],
  },
  {
    name: "explain",
    description: "Explain one component — what it is, what it talks to, what the author declared, and what lies beneath it.",
    arguments: [{ name: "what", description: "A label, tag, or id to find", required: true }],
  },
  {
    name: "where-is",
    description: "Find where something lives across every tier and take the camera there.",
    arguments: [{ name: "query", description: "Words to look for", required: true }],
  },
  {
    name: "draw",
    description: "Draw a new diagram from a description — kinds, frames, components with intents, edges, detail layers — in batches, validated, saved.",
    arguments: [
      { name: "brief", description: "What the diagram should show, in a paragraph or a list", required: true },
      { name: "project", description: "Portfolio project to create the scene in", required: false },
      { name: "scene", description: "Scene name", required: false },
    ],
  },
  {
    name: "extend",
    description: "Add a part to the open diagram, in its own style, wired to what is there.",
    arguments: [{ name: "brief", description: "What to add and where it connects", required: true }],
  },
  {
    name: "annotate",
    description: "Fill in the meaning an existing diagram lacks: kinds, intents, logic, narratives — from its structure and what the person tells you.",
    arguments: [{ name: "notes", description: "Anything the person knows that the drawing does not say", required: false }],
  },
  {
    name: "tier",
    description: "Split a crowded frame into detail layers so each tier reads at a glance.",
    arguments: [{ name: "frame", description: "A frame id from get_outline", required: true }],
  },
];

function promptMessages(name, args = {}) {
  const frame = args.frame ? `frame: '${args.frame}'` : "";
  const focus = args.focus ? ` The listener cares about: ${args.focus}.` : "";
  switch (name) {
    case "walkthrough":
      return [
        `Give a spoken walkthrough of the open diagram${args.frame ? ` — the frame ${args.frame}` : ""}.${focus}`,
        "Do exactly this, in order:",
        "1. get_outline() — know the tiers and frames.",
        `2. script_tour({${frame}}) — the stops and the author's words. Keep every \`declared\` line verbatim; rewrite \`inferred\` lines in one or two plain sentences each, in the author's vocabulary.`,
        "3. present({action:'enter', mode:'guided'}).",
        "4. tour({steps}) with the script — one call; each step waits for its own speech.",
        "5. present({action:'exit'}) when it ends, then summarize in two sentences what was shown.",
        "Do not call focus or narrate between steps 3 and 5; the tour paces itself.",
      ].join("\n");
    case "explain":
      return [
        `Explain '${args.what ?? ""}' in the open diagram, aloud.`,
        "Do exactly this, in order:",
        `1. find({query:'${args.what ?? ""}'}) — take the best hit; if it is on a deeper tier, dive to it first.`,
        "2. read_frame on its frame — the neighbours and the declared meaning.",
        "3. focus({id, narrate}) on it — one sentence: what it is (legend kind) and what the author declared.",
        "4. highlight its edges' other ends with narrate — what it receives and what it sends, one sentence each.",
        "5. If it has a detail layer: dive({id, narrate:'Beneath it…'}), read_frame, focus the inner components in flow order with narrate, climb.",
        "Use the author's intents, notes and logic verbatim where they exist; say `inferred` facts as such.",
      ].join("\n");
    case "draw":
      return [
        `Draw a Docent diagram for: ${args.brief ?? ""}`,
        "Do this, in order:",
        args.project && args.scene ? `1. create_scene({project:'${args.project}', scene:'${args.scene}'}).` : "1. If no scene is open (get_view), ask which project to create it in, then create_scene.",
        "2. Decide the kinds (service, datastore, queue, client, external…); get_scene_graph().legend first — reuse existing kinds; define_kind for each new one (shape optional).",
        "3. One Layer 1 frame per area (add_frame with a narrative); ≤12 components per frame.",
        "4. edit({ops}) per frame — ONE batch holding the frame's components AND its edges, so the frame is laid out by flow with no crossings (a long flow folds into bands that turn; edges are routed around what is in the way): add_node with label, kind, frame, intents (what it does, in the person's words), logic for rules; add_edge with a label or intents; use refs ($name) inside the batch. Keep labels short (a component: a name; an edge: two to four words — never a sentence); the sentence goes in intents.",
        "5. add_detail_layer for anything with an inner mechanism, then edit its components into that layer.",
        "6. validate(); fix warnings with update; if it reports arrow crossings or an edge passing through a component, layout the frame or add a detail layer; propose before any large change.",
        "7. save_scene(); then focus the first frame with a one-sentence narrate of what was drawn.",
        "Never specify coordinates or colours; the legend and the house style decide. Keep the person informed: one line per batch.",
      ].join("\n");
    case "extend":
      return [
        `Extend the open diagram: ${args.brief ?? ""}`,
        "1. get_outline(), then read_frame on the frame it belongs to; find() what it connects to.",
        "2. If the project is bound and on its base branch (get_view().git.onBase), create_branch({name:'docent/<topic>'}).",
        "3. propose({ops}) — add_node with the existing kinds AND its add_edge ops in the same batch (so it lands after its feeders), intents on both; read the changelog and the lint for crossings.",
        "4. edit({ops}) with the same ops; validate(); save_scene().",
        "5. focus the new component with a narrate saying what was added.",
      ].join("\n");
    case "annotate":
      return [
        `Annotate the open diagram with the meaning it lacks.${args.notes ? ` The person says: ${args.notes}` : ""}`,
        "1. validate() — the list of what is missing. get_scene_graph() for the structure.",
        "2. For each component without a kind: pick from the legend's kinds by shape and role, or define_kind once per new kind; update({id, kind}).",
        "3. For each component without an intent: update({id, intents:[…]}) — one short declared statement of what it does, from its label, its edges, and the person's notes; logic where a rule is evident.",
        "4. For each frame without a narrative: update({id, narrative}) — two sentences on what the frame means.",
        "5. Do it in one edit({ops}) per frame; validate() again; save_scene(). Say `inferred` where you guessed, so the person can correct it.",
      ].join("\n");
    case "tier":
      return [
        `Split the frame ${args.frame ?? ""} into detail layers.`,
        "1. read_frame({id}) — its components and edges.",
        "2. Group what belongs together by its edges and labels; each group with an inner mechanism becomes one component in the frame plus a detail layer beneath it.",
        "3. propose, then edit: add_detail_layer on the representative component, update({id, frame:$layer}) to move the inner components into it, add_edge for what crosses.",
        "4. validate(); the frame must end at or under 12 components; save_scene().",
      ].join("\n");
    case "where-is":
      return [
        `Find '${args.query ?? ""}' in the open diagram.`,
        `1. find({query:'${args.query ?? ""}'}).`,
        "2. For the best hit, dive along its tier trail if needed, then focus({id, narrate}) with one sentence saying where it is and what it is.",
        "3. List the other hits by tier, one line each, without moving the camera.",
      ].join("\n");
    default:
      return "";
  }
}

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
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
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
      "Glide the camera to a component, edge, or frame — this is how you pan and zoom, in ids only, never pixels. A component is framed WITH its neighbourhood (the components its edges connect it to on that tier) and never fills the view: a zoom ceiling keeps it under 40% of the frame, so the context that gives it meaning stays visible. context:'self' frames the component alone (still under the ceiling); focus a frame to see a whole tier; raise `padding` to pull back wider. Unknown ids return an error — never a silent no-op. Waits for any speech in flight before moving; `narrate` says a sentence on arrival — one call per stop.\nExample: focus({id:'n_gateway', narrate:'Requests land at the gateway first.'}); focus({id:'f_ingress'}) — the whole ingress frame.",
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
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
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
      properties: {
        id: { type: "string", description: "Graph id of a node with a detail layer" },
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "climb",
    description:
      "Climb one tier back up from the current detail layer — the inverse of dive. From Layer 1 it is a no-op with a message.\nExample: climb({narrate:'Back on the overview.'})",
    inputSchema: {
      type: "object",
      properties: {
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "present",
    description:
      "Drive presentation mode — view-only canvas, toolbars gone, a HUD up. Two modes on 'enter': 'frames' (default) is the author's continuous-camera walkthrough over the frames in their declared order with their narratives — 'next'/'prev' step the waypoints; 'guided' is the same chrome with the camera left to you — move it with focus and tour at your own pace, narrate as you go; next/prev do not apply. 'overview' pulls back to the whole tier, 'exit' leaves.\nExample: present({action:'enter', mode:'guided'}) then focus({id:'n_gateway'}), narrate({text:'…'}), focus({id:'n_orders'}) …; or present({action:'enter'}) then present({action:'next'}) as you narrate each waypoint.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enter", "exit", "next", "prev", "overview"] },
        mode: { type: "string", enum: ["frames", "guided"] },
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
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
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
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
        narrate: { type: "string", description: "Say this on arrival (one call = one stop)" },
        interrupt: { type: "boolean", description: "Cut the voice in flight instead of waiting for it" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "narrate",
    description:
      "Show text in the narration panel — and say it aloud where a voice is on. Returns as soon as the voice has started: the CAMERA waits for the sentence (every focus/highlight/flow/present/dive call waits for speech in flight), never you. Prefer focus({id, narrate}) — one call per stop. wait:true stays until the words are done. Empty/null text hides the panel and stops the voice.\nExample: narrate({text:'Requests land at the gateway first.'}) → {narrating:true, spoken:false}",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: ["string", "null"] },
        wait: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "script_tour",
    description:
      "Derive a walkthrough from the diagram itself — nothing authored for it: stops are the frames in declared order and, inside a frame, the components in flow order (what feeds comes before what is fed); words are the author's narrative, intents, notes and logic where declared (`provenance:'declared'` — keep verbatim) and a plain factual line from the graph and legend otherwise (`'inferred'` — yours to rewrite). Pass the steps to tour(). With `frame`, that frame only; without, every Layer 1 frame.\nExample: script_tour({frame:'f_core'}) → {steps:[{focus:'f_core', narrate:'…', provenance:'declared'}, {focus:'n_orders', highlight:['n_orders'], narrate:'Orders: retries failed charges.', provenance:'declared'}, …], declared:5}",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "A frame id from get_outline; omit for the whole Layer 1" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tour",
    description:
      "Run a narrated walkthrough in one call — the page paces it: each step flies, highlights, pulses, and narrates, and lasts at least as long as its speech; when a step focuses a frame and omits narrate, the frame's author-declared narrative narrates it. Interruptible by the user; resolves with steps completed. script_tour() gives you the steps.\nExample: tour({steps:[{focus:'f_ingress'},{focus:'n_gateway',highlight:['n_gateway'],narrate:'The gateway rate-limits at the edge.'},{flow:['e_verify'],narrate:'Every request is verified.'}]})",
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
    name: "add_node",
    description:
      "Add a component: a label, a `kind` (from the legend — get_scene_graph().legend; define_kind adds one), the frame it lives in, intents (declared statements of what it does), logic (rules). Docent chooses the shape, the style (the diagram's own), and the place — `after` puts it right of a component. Lands as one undo step; the answer is the semantic changelog and the new id.\nExample: add_node({label:'Retry queue', kind:'queue', frame:'f_core', intents:['retries failed charges'], after:'n_orders'})",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        kind: { type: "string" },
        frame: { type: ["string", "null"], description: "Frame id; null or absent = Layer 1, unframed" },
        shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"], description: "Only to override the legend's shape" },
        tags: { type: "array", items: { type: "string" } },
        intents: { type: "array", items: { type: "string" } },
        logic: { type: "string" },
        after: { type: "string", description: "Place it right of this component" },
      },
      required: ["label"],
      additionalProperties: false,
    },
  },
  {
    name: "add_edge",
    description:
      "Connect two components with a bound arrow, in the diagram's arrow style, routed around whatever lies between them. Give it a label or intents so the relation is stated: the label is a phrase (two to four words — the gap between the components is sized to it), the sentence goes in intents.\nExample: add_edge({from:'n_orders', to:'n_retry', label:'park', intents:['only after three failures']})",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        label: { type: "string" },
        intents: { type: "array", items: { type: "string" } },
        logic: { type: "string" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "update",
    description:
      "Change a component, edge, or frame: label, kind (re-styled through the legend), tags, intents, logic; a frame's name, narrative, order; or move a component into a frame (frame:null takes it out). Only the fields named change; `intents`/`tags` replace, `addIntents`/`addTags` add to the author's.\nExample: update({id:'n_orders', addIntents:['retries failed charges'], logic:'if charge fails: retry 3x then park'})",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Replaces the tags" },
        intents: { type: "array", items: { type: "string" }, description: "Replaces the intents — prefer addIntents on a person's diagram" },
        addTags: { type: "array", items: { type: "string" } },
        addIntents: { type: "array", items: { type: "string" }, description: "Adds to what is declared, keeping the author's words" },
        logic: { type: ["string", "null"] },
        narrative: { type: ["string", "null"] },
        name: { type: "string" },
        order: { type: ["number", "null"] },
        frame: { type: ["string", "null"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove",
    description:
      "Remove a component (with its edges and label), an edge, or a frame (with its contents). A component with a detail layer needs cascade:true — the layer and everything in it go too. Explicit ids only; never a whole scene.\nExample: remove({id:'n_legacy'})",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, cascade: { type: "boolean" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_frame",
    description:
      "Add a Layer 1 frame — an area of the diagram with a name and a narrative (what it means, two sentences) — placed in free canvas space. Add components into it with add_node({frame}).\nExample: add_frame({name:'03 Data Plane', narrative:'Every durable fact lives here; nothing else writes to disk.'})",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, narrative: { type: "string" }, order: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "add_detail_layer",
    description:
      "Give a component a detail layer: a frame on the tier below drawing its inner mechanism, linked so dive() reaches it. Then add_node({frame:<the new frame>}) into it. Use it instead of crowding a frame past 12 components.\nExample: add_detail_layer({node:'n_orders', narrative:'How an order moves from accepted to fulfilled.'}) → {ids:{…}, …}",
    inputSchema: {
      type: "object",
      properties: { node: { type: "string" }, name: { type: "string" }, narrative: { type: "string" } },
      required: ["node"],
      additionalProperties: false,
    },
  },
  {
    name: "define_kind",
    description:
      "Add a kind to the legend — the meaning a style carries. Without a style, Docent picks a distinct fill; with a shape, that shape. Reuse existing kinds before defining new ones.\nExample: define_kind({kind:'queue', shape:'diamond'})",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"] },
        style: {
          type: "object",
          properties: {
            backgroundColor: { type: "string" },
            strokeColor: { type: "string" },
            strokeStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
            fillStyle: { type: "string", enum: ["solid", "hachure", "cross-hatch", "zigzag"] },
            strokeWidth: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "layout",
    description:
      "Re-flow a frame's components by their edges (what feeds comes left of what is fed; a flow longer than five ranks folds into bands that turn), with column gaps sized to the edge labels, and every edge re-routed around what lies between its ends. The only thing that moves hand-placed work — use it on frames you are building, not on the person's arrangement.\nExample: layout({frame:'f_core'})",
    inputSchema: {
      type: "object",
      properties: { frame: { type: ["string", "null"], description: "Frame id, or null for the unframed Layer 1 components" } },
      required: ["frame"],
      additionalProperties: false,
    },
  },
  {
    name: "tidy",
    description:
      "Tidy re-lays out a frame, a tier, a selection, or the diagram — the layered pipeline, routed edges — and is guaranteed to change nothing but the picture: its semantic changelog is empty. The one command that moves hand-placed work, because it was asked.\nExample: tidy({frame:'f_core'})",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: ["string", "null"], description: "One frame — null for the unframed Layer 1 components" },
        tier: { type: "number", description: "Every frame on this tier (1 is Layer 1)" },
        all: { type: "boolean", description: "The whole diagram, every tier" },
        selection: { type: "array", items: { type: "string" }, description: "Ids — the frames holding them are tidied" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Apply many authoring operations as ONE batch: validated whole (unknown ids, duplicate labels, missing refs — nothing applied if anything is wrong), laid out once, one undo step, answered with the semantic changelog, the ids for your refs, and the lint. Each op is one of add_node, add_edge, update, remove, add_frame, add_detail_layer, define_kind, layout with that tool's fields plus `op` and an optional `ref` ($name) later ops can use. Prefer this over one call per component.\nExample: edit({ops:[{op:'add_frame', ref:'$core', name:'02 Core'}, {op:'add_node', ref:'$orders', label:'Orders', kind:'service', frame:'$core', intents:['owns the order state']}, {op:'add_node', ref:'$pay', label:'Payments', kind:'service', frame:'$core', intents:['charges the card']}, {op:'add_edge', from:'$orders', to:'$pay', label:'charge'}]})",
    inputSchema: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object", additionalProperties: true } } },
      required: ["ops"],
      additionalProperties: false,
    },
  },
  {
    name: "propose",
    description:
      "The dry run of edit: the same ops, validated and simulated, answered with the changelog they WOULD produce and the lint of the result — nothing is applied. Use before a large change.\nExample: propose({ops:[…]}) → {applied:false, changelog:'02 Core: +Retry queue; +edge Orders → Retry queue', …}",
    inputSchema: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object", additionalProperties: true } } },
      required: ["ops"],
      additionalProperties: false,
    },
  },
  {
    name: "validate",
    description:
      "The craft check: components without a kind or an intent, edges without a label or intent, frames without a narrative or over 12 components, dangling edges, unlinked detail frames.\nExample: validate() → {findings:[{level:'warn', about:'n_db', message:'Postgres has no intent'}], summary:'3 warnings, 1 note'}",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "undo_edit",
    description: "Put the scene back to before your last edit (the person can do the same from the panel).\nExample: undo_edit()",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_scene",
    description:
      "Save the open scene back to the portfolio project it came from — the same save the person makes. On a bound project the checkpointer commits it to the branch; opening a pull request stays the person's.\nExample: save_scene()",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_scene",
    description:
      "Create an empty scene in a portfolio project and open it (refused while the canvas holds unsaved changes).\nExample: create_scene({project:'work', scene:'payments-platform'})",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, scene: { type: "string" } },
      required: ["project", "scene"],
      additionalProperties: false,
    },
  },
  {
    name: "create_branch",
    description:
      "On a GitHub-bound project, cut a branch off the active one and move the project onto it — do this before the first edit when get_view().git.onBase is true, so the work lands where a pull request can review it.\nExample: create_branch({name:'docent/retry-queue'})",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
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
        capabilities: { tools: {}, prompts: {} },
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
    case "prompts/list":
      return reply({ prompts: PROMPTS });
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === params?.name);
      if (!prompt) return fail(-32602, `Unknown prompt: ${params?.name}`);
      const text = promptMessages(prompt.name, params?.arguments ?? {});
      return reply({
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      });
    }
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
