# Docent

> A docent walks you through the museum. This one walks humans — and AI agents — through your architecture.

**Docent** is a presentation, semantics, and agent-control layer wrapped around self-hosted
[Excalidraw](https://github.com/excalidraw/excalidraw). One diagram, three audiences:

- **Humans watching** — a continuous Prezi-style camera glides through your diagram. No slide cuts. One unbroken take.
- **AI reading** — a token-efficient semantic export (Mermaid + compact JSON) that models parse natively.
- **AI driving** — an MCP server that lets agents tour you through the canvas: move the camera, spotlight components, and pulse data flows along arrows in real time.

Docent is a **wrapper, never a fork**. Excalidraw stays upstream and pinned; everything Docent adds lives beside it.

---

## Why

Architecture diagrams fail twice. They bore humans (static walls of boxes) and they blind AI
(pixels, or JSON that is 70% rendering noise). Docent fixes both directions with one primitive:
a **semantic scene graph** with stable IDs. Humans get cinematography over it; agents get an
address space into it.

The demo that explains everything:

> *"Walk me through what happens when a request hits the API."*
>
> The camera glides to the ingress. The gateway glows. A pulse of light travels the arrow into
> the auth service, then fans out along the write path — while the agent narrates each hop.

---

## Features

### 🎥 Longtake presentations
- Excalidraw **frames become waypoints**; ordering by frame name or a sidecar manifest.
- Continuous camera: pan/zoom tweens with easing between waypoints — dive into a frame, pull back to the whole canvas, glide to the next.
- Keyboard-driven presenting (next / prev / overview), shareable as a self-hosted URL.
- The hand-drawn roughjs aesthetic does the charm; Docent does the motion.
- **Controls:** ▶ Present lives in the hamburger menu (as do all Docent actions — the canvas is full-bleed) · `→`/`Space` next · `←` prev · `Home` overview · click a linked component to dive into its detail diagram · `⌫` climbs back a tier · `Esc` exits. Selecting elements pops a floating toolbar beside the selection with the contextual actions (⤵/＋ Detail, Glow, Spotlight, Flow on arrows). Load any scene straight into the app with `?scene=<url>` — try `?scene=samples/demo.excalidraw`, or the full-capability tour scene `?scene=samples/showcase.excalidraw` (3 tiers, 9 narrated frames, legend, hot-path, inferred edges).

### 🪆 Tiered drill-down
One canvas, many zoom-levels of meaning — overview → service → component → logic:
- **Click a shape, dive into its inner mechanism.** Any element can declare a *detail diagram* — a frame on the same canvas drawing what's inside it, linked via `customData.docent.detail`. In drill mode, activating the element portals the camera into that frame, Prezi-style; back climbs one tier.
- **Create on first click.** Activating a shape with no detail yet offers to create its detail frame — named after the element, placed in free canvas space, linked, and dived into.
- **Unbounded tiers.** Elements inside a detail frame can declare their own details. The mechanism is element-agnostic: shapes, images, frames, grouped composites.
- **Tiers never bleed into view.** Detail frames live in bands far below Layer 1 (computed from the link graph, spaced adaptively) — reviewing the system diagram shows the system diagram, nothing else. Overview, file-open, and presentation waypoints all scope to Layer 1; lower tiers are reached by diving. Distant bands cost nothing to render (viewport culling).
- **Pop back instantly.** Breadcrumbs derive from the link structure at wherever the camera is — after a dive, ◂ Up restores the exact view you left; after free navigation it climbs one tier and glows the shape you came out of. Works even right after opening a file deep in a tier.
- **Arrange detail tiers** runs automatically on every save (and on demand from the menu), reflowing scattered frames into clean bands — one undoable step; already-tidy scenes are untouched.
- The hierarchy is data, not decoration — it rides the scene graph into both exports (provenance `declared`), so agents can tour tier by tier.
- **Cross-tier edge refinement**: an arrow into a component can declare which *inner* part of that component's detail diagram the traffic actually lands on (select the arrow → "Lands on" picker). `Service A → Broker` stays true at Layer 1, while the export also carries `Service A ⇢ Adapter A (inside Broker)` — as a declared fact in the sidecar and a dotted edge in Mermaid.

### 📦 Semantic export
- Resolves arrow `startBinding`/`endBinding` into an explicit **node/edge graph** — connections as data, not pixels.
- **Library icons read as one component**: an imported shape (AWS, GCP, …) is a group of strokes to the data model but one thing to a reader, so Docent collapses it into a single node — its label, its box, its arrows. Override either way from the selection toolbar (`⧉ Merge` / `⧉ 1 component`); exports flag whether it was inferred or declared.
- **Legend-aware stripping**: styling your legend maps to meaning is *converted* (`dashed` → `channel: async`), styling it doesn't map is stripped as noise — roughly **70% fewer tokens** than raw `.excalidraw` JSON, with zero meaning lost. Styling is only noise if the legend says so.
- Emits **Mermaid** as the primary AI-facing format, plus a **compact JSON sidecar** carrying what Mermaid can't (spatial layout, frames, groups, intent).
- **Provenance on every fact**: `explicit` (read from the drawing) · `declared` (author-stated intent) · `inferred` (heuristics, e.g. proximity-resolved arrows). The consuming model always knows whether it's reading the diagram, your recorded intent, or a guess — and the export never silently guesses.
- Deterministic: the same scene always produces byte-identical output.
- **Completeness is measured, not asserted**: every fixture scene ships a question bank (structural + intentional), and CI scores a model's answers given only the export. See CONSTITUTION.md Q6.

### 🧭 Intent capture
A diagram's *meaning* isn't in its data model — why an arrow is dashed, why a box is red, what a cluster of services means lives in the author's head. Docent gives intent a place to live at authoring time, all fork-free:
- **Legend editor** — declare your conventions as data: `dashed → async`, `red → hot-path`, `cylinder → datastore`. The exporter applies them. Authoring is point-and-click: the editor docks beside a live canvas — select any element, click the style chip that carries the meaning (color swatch, dash, shape…), and type only what it means.
- **Element annotations** — tags and free-text notes on any element ("rate-limited at edge", "legacy — kill in Q3"), stored in Excalidraw's `customData`.
- **Frame narratives** — one or two sentences per frame: "what this section means." The same text is the **single source of truth** for both the semantic export and the agent's `tour` narration. Capture once, serve both audiences.

### 🤖 Agent-drivable canvas
- An **MCP server** exposes the Command API — MCP is an open protocol, so **any agent with any MCP client** can drive the canvas; nothing vendor-specific ships in Docent. It speaks **stdio** for locally-spawned clients and **MCP streamable HTTP** at `/mcp` on every deployment. Connected agents can:
  - `get_scene_graph` — read the diagram as nodes/edges/frames with stable IDs
  - `focus` — tween the camera to any element or frame
  - `highlight` — glow / spotlight / dim-others on any set of components
  - `flow` — animate a light pulse along one arrow or a chained multi-hop path
  - `tour` — run a full narrated sequence of the above
- Agents operate purely in **ID-space**. They never address pixels, never touch Excalidraw internals.
- All effects render on a **non-destructive overlay** — the document is never mutated, undo history stays clean.

### 🗂 Project portfolio
- One deployment hosts many **projects**; a project holds many **scenes** (work, personal, …).
- **Menu → Portfolio…** browses them: create projects, open scenes, save the current scene into a project, delete either.
- A scene opened from the portfolio saves back to it (`⌘S`); local `.excalidraw` file open/save is unchanged.
- Scenes address by URL: `?project=work&scene=checkout`.
- Storage is a plain file tree — `data/<project>/<scene>.excalidraw` on a named volume, no database. Anything the store can do, a file manager can too.

### 🧱 Architecture shapes out of the box
- A **software-architecture shape library** ships with the app — microservice, database, cache, event bus/pipeline, documents or code, browser, mobile device — merged into Excalidraw's library sidebar at startup, served from the deployment's own origin. Nothing to download, no call out to libraries.excalidraw.com. Attribution below.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Docent Shell                     │
│                                                      │
│   ┌────────────────┐        ┌─────────────────────┐  │
│   │  Camera Engine │        │  Overlay Renderer   │  │
│   │ (tweens, tours)│        │ (highlight, flow FX)│  │
│   └───────┬────────┘        └──────────┬──────────┘  │
│           │                            │             │
│   ┌───────┴────────────────────────────┴──────────┐  │
│   │           Command API  (ID-space)             │  │
│   │   focus · highlight · flow · tour · narrate   │  │
│   └───────┬───────────────────────────┬───────────┘  │
│           │                           │              │
│   ┌───────┴────────┐         ┌────────┴───────┐      │
│   │  Scene Graph   │         │   MCP Server   │      │
│   │  + Exporters   │         │ (local, stdio  │      │
│   │ (Mermaid/JSON) │         │  + SSE bridge) │      │
│   └───────┬────────┘         └────────────────┘      │
│           │                                          │
│   ┌───────┴──────────────────────────────────────┐   │
│   │      @excalidraw/excalidraw  (pinned)        │   │
│   └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**The five subsystems:**

1. **Shell** — a thin React app embedding the Excalidraw component; owns `excalidrawAPI`.
2. **Scene Graph** — parses the live scene into `{nodes, edges, frames, groups}` with stable IDs; feeds both exporters and the Command API. This is the shared address space.
3. **Camera Engine** — viewport tweening over `scrollX/scrollY/zoom` with easing; consumed by presentation mode and agent `focus`/`tour` commands alike.
4. **Overlay Renderer** — a viewport-synced SVG layer above the canvas. All highlights and flow pulses render here. It never writes to the document.
5. **MCP Server** — exposes the Command API to agents; also serves the semantic export.

---

## Command API

```jsonc
get_scene_graph()
// → { nodes: [...], edges: [...], frames: [...] }  — stable IDs, current state

focus({ id: "n_auth", padding?: 0.2 })
// camera tweens to the element/frame's bounds

highlight({ ids: ["n_auth", "n_db"], style: "spotlight" })
// styles: "glow" | "spotlight" (dim everything else) | "outline"
// idempotent; clear with highlight({ ids: [] })

flow({ path: ["e_12", "e_15", "e_19"], speed?: 1.0, loop?: false })
// a pulse travels each edge end-to-end, in order — multi-hop request tracing

tour({ steps: [ { focus: "f_ingress", narrate: "Requests land here…" }, ... ] })
// runs a full narrated walkthrough; interruptible

narrate({ text: "..." })
// renders in the narration panel
```

Unknown IDs return explicit errors — commands never silently no-op.

---

## Export format

**Mermaid (primary, AI-facing):**

```mermaid
flowchart LR
  n_api[API Gateway] -->|verify JWT| n_auth[Auth Service]
  n_auth --> n_db[(Postgres)]
```

**Compact JSON sidecar (spatial + structural context):**

```json
{
 "docent": 1,
 "provenanceDefault": "explicit",
 "legend": {"fill.#a5d8ff":"kind: datastore","stroke.dashed":"channel: async"},
 "nodes": [
  {"detail":"f_gw_detail","frame":"f_ingress","id":"n_gateway","label":"API Gateway","note":"rate-limited at edge","provenance":{"detail":"declared","note":"declared","tags":"declared"},"shape":"rectangle","tags":["edge","hot-path"],"xywh":[340,140,180,70]},
  {"frame":"f_core","id":"n_db","kind":"datastore","label":"Postgres","provenance":{"kind":"declared"},"xywh":[710,340,160,80]}
 ],
 "edges": [
  {"from":"n_gateway","id":"e_verify","label":"verify JWT","to":"n_auth"},
  {"channel":"async","from":"n_db","id":"e_session","label":"session reads","provenance":{"channel":"declared","link":"inferred"},"to":"n_auth"}
 ],
 "frames": [
  {"id":"f_ingress","name":"01 Ingress","narrative":"All external traffic lands here; the gateway terminates TLS and rate-limits before anything reaches core.","provenance":{"narrative":"declared"},"xywh":[50,130,650,90]}
 ]
}
```

Provenance levels: `explicit` — read from the drawing · `declared` — author-stated via legend/annotations/narratives · `inferred` — heuristic, never presented as fact. `provenanceDefault` makes the encoding self-describing: any fact not listed in its entity's `provenance` map is `explicit`; `declared` and `inferred` facts are always listed.

---

## Quick start

```bash
# self-host
docker compose up
# → http://localhost:3000  (canvas)

# or dev mode
pnpm install
pnpm dev
pnpm store   # optional: the portfolio store (docker compose runs it for you)
```

**Deploy to a box on your LAN** (continuous rollout): clone on the box, run the
installer once — it starts the app and registers a 2-minute cron that redeploys
whenever `master` advances with green CI:

```bash
git clone https://github.com/happyren/Docent.git ~/docent && ~/docent/scripts/install-cd.sh
```

**Agent control:** every deployment ships the MCP server as a service — point any
MCP client at the deployment's `/mcp` endpoint (MCP streamable HTTP):

```
http://<your-host>:3000/mcp
```

In dev, run it locally instead (stdio for spawned clients + the same `/mcp` over
the dev proxy):

```bash
pnpm mcp
```

Either way, attach the canvas to the bridge — connection is always explicit, so
the app never probes the network on its own: use **Menu → Connect agent bridge**,
or open the canvas with `?agent`
(e.g. `http://localhost:3000/?agent&scene=samples/demo.excalidraw`). The
last-connected canvas answers the agents. Ask for `get_scene_graph` and start
touring.

```bash
# quality gates
pnpm test            # determinism, goldens, token reduction, command invariants, path parity
pnpm comprehension   # Q6: scores a reference model given only the export
```

**Q4 frame-rate check** (per release, needs a regular visible browser tab — rAF is
paused in hidden/embedded views): open `?scene=samples/perf.excalidraw` (200 elements)
(dev or deployed — the harness ships in every build) and run
`await __docent.measurePerformance()` in the console. It reports
avg fps and p95 frame time for camera tweens, flow pulses, and combined
spotlight+flow+tween. Target: ≥60fps avg. Docent's measured main-thread overhead on
that scene is ~0.01ms per camera frame and ~0.12ms per scene-graph build — the frame
budget belongs to Excalidraw's canvas rendering.

---

## Roadmap (scope-locked — see CONSTITUTION.md)

| Milestone | Deliverable | Definition of done |
|-----------|-------------|--------------------|
| **M0 — Shell** | Self-hosted canvas | Docker one-command up; Excalidraw pinned; load/save `.excalidraw` files |
| **M1 — Longtake** | Presentation mode | Frames-as-waypoints; eased camera tweens; keyboard controls; overview mode; drill-down navigation + create-on-click detail frames (S11) |
| **M2 — Scene Graph + Intent + Export** | Semantic layer | Deterministic graph extraction; legend editor, element annotations (`customData`), frame narratives; drill hierarchy in graph + exports; Mermaid + JSON emitters with legend application and full provenance; token-reduction and round-trip comprehension measured in CI |
| **M3 — Overlay FX** | Highlight + flow | Viewport-synced overlay; glow/spotlight/dim; flow pulse on straight + curved arrows; elbow-arrow path parity |
| **M4 — Agent control** | MCP server | Full Command API over MCP; narrated `tour`; the end-to-end demo |

**v2 (explicitly deferred):** agent *authoring* — creating and mutating diagram elements via the
Command API. v1 agents read and drive; they don't draw. The scene graph is designed so `add_node`
/ `add_edge` slot in without rework.

## Non-goals

Locked out of scope — see CONSTITUTION.md for rationale:

- Forking or patching Excalidraw core
- Multiplayer / real-time collaboration
- Auth, accounts, multi-tenancy (single-user self-host)
- Prezi-style viewport *rotation*
- Pixel-perfect tracing of roughjs strokes
- TTS narration, mobile support, custom element types

---

## Design decisions (locked)

1. **Wrapper, never fork.** Upstream pinned; upgrades are deliberate events.
2. **Overlay is non-destructive.** Visual effects never mutate the scene or undo history.
3. **Neon-over-pencil.** Flow pulses render as a wider soft glow *over* the sketchy stroke — deliberately not tracing roughjs jitter. It reads better and stays robust to upstream rendering changes.
4. **Path-math parity.** Curved and elbow arrows replicate Excalidraw's path construction from `element.points` + roundness — no naive point-connecting.
5. **ID-space agent surface.** Agents reference scene-graph IDs only; unknown IDs fail loudly.
6. **Deterministic export.** Stable ordering, sorted keys, full provenance.
7. **Legend-as-data.** Declared style→meaning mappings are applied by the exporter; unmapped styling is stripped. Styling is only noise if the legend says so.
8. **Intent is captured, never guessed.** Meaning enters through the legend, `customData` annotations, and frame narratives at authoring time — it is not recoverable from the data model afterward. Narratives are the single source for both export and tour narration.
9. **Completeness = round-trip comprehension.** "The export carries the diagram's meaning" is defined by a scored question bank in CI (CONSTITUTION.md Q6) — measured, not asserted.

---

## License

MIT. Docent embeds [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT © Excalidraw contributors) as an npm dependency — their notice travels with the package.

### Bundled third-party assets

- `public/libraries/software-architecture.excalidrawlib` — **Software Architecture** shape library by **Youri Tjang** (`youritjang`, https://github.com/youritjang). Source: https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib, published in [excalidraw/excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries) (`libraries/youritjang/software-architecture.excalidrawlib`) under that repository's MIT license (MIT © 2020 Excalidraw). Bundled verbatim — 7 items, unmodified.
