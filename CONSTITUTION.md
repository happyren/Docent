# Docent Constitution

This document governs delivery. It is binding on every contributor — human or agent.
When code and constitution conflict, the constitution wins and the code is the bug.
Specifics over slogans; every rule here is checkable.

---

## 1. Purpose

Docent makes one diagram serve three audiences:

1. **Humans watching** — continuous-camera presentations over Excalidraw frames.
2. **AI reading** — deterministic, token-efficient semantic export (Mermaid + compact JSON) carrying the diagram's full meaning and intention, not just its structure.
3. **AI driving** — an MCP-exposed Command API for camera, highlighting, flow animation, and narrated tours.

Anything that does not serve one of these three is out of scope by default.

---

## 2. Invariants

These hold at every commit. A PR that violates one is rejected regardless of what it delivers.

**I1 — Upstream is sacred.**
`@excalidraw/excalidraw` is a pinned npm dependency. Never fork it, never patch it,
never modify `node_modules`, never vendor modified copies. If a capability seems to
require touching core, the design is wrong — redesign against the public API
(`excalidrawAPI`, props, `onChange`, element `customData`).

**I2 — The overlay never writes.**
All visual effects (highlight, spotlight, dim, flow pulses, tour cues) render on the
overlay layer. No effect may mutate scene elements, element `version`/`versionNonce`,
or the undo history. Test: run any sequence of Command API calls, then diff the
serialized scene — it must be byte-identical to before.

**I3 — Export is deterministic.**
The same scene always produces byte-identical export output: stable element ordering
(by ID), sorted JSON keys, no timestamps, no randomness. Test: export twice, `diff`
is empty.

**I4 — Provenance is always labeled.** *(amended A1)*
Every exported fact carries one of three provenance levels:
- `explicit` — read directly from the drawing: bindings, labels, containment, frames
- `declared` — author-stated intent: legend mappings, element tags/notes, frame narratives
- `inferred` — heuristic: proximity-resolved arrows, layout-derived hints

The export never presents a declaration or a guess as a drawing-fact, and never
silently guesses. A consuming model always knows whether it is reading the diagram,
reading the author's recorded intent, or reading a heuristic.

**I5 — Agents live in ID-space.**
Every Command API parameter that references the diagram uses scene-graph IDs from
`get_scene_graph`. No pixel coordinates in the agent surface. Unknown IDs return an
explicit error; commands never silently no-op.

**I6 — IDs are stable.**
Scene-graph IDs derive from Excalidraw element IDs and survive re-export, viewport
changes, and styling edits. An agent that cached a graph five minutes ago can still
address the same components (modulo user deletions, which error per I5).

**I7 — Dependencies are deliberate.**
No new runtime dependency without an entry in the Decision Log (§6). Dev dependencies
are free; runtime weight is not.

**I8 — Animation degrades, never blocks.**
All motion runs on `requestAnimationFrame`, is interruptible, and respects
`prefers-reduced-motion` (tweens collapse to instant transitions). No animation may
block input or the agent command loop.

---

## 3. Scope — v1 (locked)

### In scope

| # | Capability | Definition of done |
|---|-----------|--------------------|
| S1 | Self-host shell | `docker compose up` serves the canvas; load/save `.excalidraw` files; Excalidraw version pinned |
| S2 | Presentation mode | Frames as ordered waypoints (name-order, manifest override); eased pan/zoom tweens; next/prev/overview keyboard controls |
| S3 | Scene graph | Live extraction of `{nodes, edges, frames, groups}` with labels resolved from bound text (`containerId`) and connections from arrow bindings |
| S4 | Exporters *(amended A1)* | Mermaid emitter (primary) + compact JSON sidecar; **legend applied** — styling mapped by the legend is exported as meaning, unmapped styling is stripped; **provenance on every fact** (I4); ≥60% token reduction vs raw scene JSON, measured in CI; comprehension eval passing (Q6) |
| S10 | Intent capture *(added A1)* | **Legend editor** — visual attribute → meaning mappings (e.g. `dashed → async`, `red → hot-path`), stored as data; **element annotations** — tags + free-text notes on any element, stored in `customData` (fork-free per I1); **frame narratives** — per-frame "what this means" text, the single source of truth for both export and `tour` narration |
| S11 | Drill-down (tiered diagrams) *(added A2)* | Any element may declare a **detail diagram** — a frame on the same canvas drawing its inner mechanism — via `customData.docent.detail` (fork-free per I1). **Navigation:** in presentation/drill mode, activating a linked element dives the camera into its detail frame with an eased portal tween (zoom toward the element, resolve on the frame); back/breadcrumb climbs one tier; unknown/deleted targets error per I5. **Authoring:** activating an unlinked element offers to create its detail frame (named after the element, placed in free canvas space, linked, then dived into). Depth is unbounded — elements inside detail frames may declare their own details. The mechanism is element-agnostic: any element type (shapes, images, frames themselves; grouped composites via their frame or any member). Drill interactions must not break normal editing — plain click still selects; drill uses presentation mode or a dedicated affordance |
| S12 | Project portfolio *(added A3)* | One deployment hosts many **projects**; a project holds many **scenes**. A portfolio modal browses projects and their scenes: create a project, open a scene, save the current scene into a project, delete either (confirmed). Scenes address by URL (`?project=<p>&scene=<s>`); Save writes back to the portfolio scene it was opened from; local `.excalidraw` file open/save is unchanged. Storage is a **file tree of plain `.excalidraw` files** behind a zero-dependency same-origin store service (D17, D18); a deployment without the store degrades gracefully — the modal says so and file workflows are unaffected |
| S5 | Overlay renderer | Viewport-synced SVG layer; sync verified across pan/zoom/resize |
| S6 | Highlight | `glow`, `spotlight` (dim-others), `outline`; idempotent; clearable |
| S7 | Flow animation | End-to-end pulse along an edge; multi-hop chaining across an ordered edge path; straight, curved, and elbow arrows |
| S8 | Command API + MCP | `get_scene_graph`, `focus`, `highlight`, `flow`, `tour`, `narrate` over a local MCP server |
| S9 | Narration panel | Text panel rendering `narrate` output during tours; `tour` steps may reference frame narratives (S10) as narration source |

### Out of scope for v1 (locked out — do not build, do not scaffold "for later")

- **Agent authoring** (`add_node`, `add_edge`, element mutation) — deferred to v2 by design.
  The scene graph's ID model must not preclude it, but no v1 code implements it.
- Forking/patching Excalidraw core (I1 — permanent, not just v1)
- Multiplayer, collaboration, presence
- Auth, accounts, multi-tenancy — Docent v1 is single-user self-hosted
- Viewport rotation (Prezi's rotating camera)
- Pixel-perfect tracing of roughjs strokes (see D3)
- TTS narration; mobile layouts; custom Excalidraw element types
- Persistence beyond `.excalidraw` files — no database. *(amended A3: the portfolio
  store (S12) persists plain `.excalidraw` files in a project directory tree; the
  exclusion of databases and of any storage format beyond `.excalidraw` stands)*
- Automatic intent *inference* beyond proximity bindings (no "AI guesses what red means" —
  meaning enters through the legend and annotations, or it is flagged `inferred`)

Scope changes require amending this document first (§7), code second.

---

## 4. Architecture boundaries

Five subsystems, with dependency direction enforced top-down:

```
shell → { camera, overlay, command-api, intent-ui } → scene-graph → excalidraw adapter
mcp-server → command-api
exporters → scene-graph
```

**B1** — Only the **excalidraw adapter** module imports from `@excalidraw/excalidraw` or
reads raw element shapes (including `customData`). Everything above it consumes the
scene graph or the adapter's typed surface. When upstream changes its element schema,
exactly one module changes.

**B2** — The **camera engine** is the only writer of viewport state. Presentation mode
and agent `focus`/`tour` are both clients of it — no second tween implementation.

**B3** — The **overlay renderer** is the only place effects draw. Highlight, flow, and
tour cues are overlay programs, not separate rendering paths.

**B4** — The **command API** is the single choke point for agent actions. The MCP server
is a thin transport over it; no logic in the transport layer.

**B5** — **Exporters** are pure functions of the scene graph + legend. No I/O, no
viewport awareness, no side effects.

**B6** *(added A1)* — The **intent model** (legend, annotations, narratives) is part of
the scene graph, not a parallel store. There is one graph; intent is attributes on it.

---

## 5. Quality bars

- **Q1** — Geometry parity: for every arrow type (straight, curved, elbow), the overlay
  path's deviation from Excalidraw's rendered centerline stays within the glow radius.
  Fixture scenes with all arrow types live in the repo; parity checked visually per
  release and by bounding tests in CI.
- **Q2** — Export golden tests: fixture scenes with committed expected Mermaid/JSON
  output. Upstream version bumps must pass goldens before merge.
- **Q3** — Scene-diff test (per I2) runs in CI against a scripted command sequence.
- **Q4** — 60fps target for tweens and pulses on a mid-range laptop with a 200-element
  scene; measured, not asserted.
- **Q5** — Every MCP tool has a docstring with one worked example; `get_scene_graph`
  output is self-describing enough that an agent needs no other documentation to drive.
- **Q6** *(added A1)* — **Round-trip comprehension.** Each fixture scene ships a question
  bank covering structure ("what calls the auth service?") and intention ("which paths
  are async?", "why is the cache beside the gateway?") — every question answerable by
  the author. CI presents a reference model with *only the export* and scores its
  answers. Threshold starts at 95% and ratchets up; it never ratchets down. A failure
  is either an export bug or a capture gap — triaged, never ignored. This is the
  operational definition of "the export carries the diagram's meaning": measured,
  not asserted.

---

## 6. Decision Log (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Wrapper, never fork | Forks rot; upstream velocity is high; everything needed is reachable via public API |
| D2 | Non-destructive overlay | Document integrity and clean undo are non-negotiable; effects are ephemeral by nature |
| D3 | **Neon-over-pencil** — flow pulses render as a wider soft glow *over* the sketchy stroke, not a trace of roughjs jitter | Approved. Reads better aesthetically and is robust to upstream rendering changes |
| D4 | **Path-math parity** — curved/elbow arrow geometry replicated from `element.points` + roundness/elbow routing, not naive point-connecting | Approved. The glow must follow the visible path; naive polylines visibly diverge on elbows |
| D5 | Mermaid primary + JSON sidecar | Models parse Mermaid natively; sidecar carries spatial/structural/intent context Mermaid can't express |
| D6 | MIT license | Excalidraw-compatible; maximum adoption; zero legal friction |
| D7 | Agent surface = MCP over Command API, ID-space only | Interoperable with any MCP client; IDs decouple agents from rendering |
| D8 | v1 = read + drive; authoring = v2 | Ship the demoable core; authoring doubles the correctness surface and must not delay it |
| D9 *(A1, 2026-08-17)* | **Legend-as-data.** The exporter applies declared style→meaning mappings; styling the legend maps is converted to semantics, styling it doesn't map is stripped | Styling is only noise if the legend says so — red stroke is decoration in one diagram and the hot path in another. Aggressive stripping without declared conventions destroys meaning; the legend is what makes stripping safe |
| D10 *(A1, 2026-08-17)* | **Intent is captured, never guessed.** Intent enters via legend, `customData` annotations, and frame narratives at authoring time; narratives are the single source for both export and tour narration | Intention is not recoverable from the data model post-hoc; capture is the only path to completeness. `customData` keeps it fork-free (I1). One source of truth serves both audiences |
| D11 *(A1, 2026-08-17)* | **Completeness = round-trip comprehension.** "100% of meaning" is operationally defined by Q6, measured in CI | "Carries all meaning" is unfalsifiable as stated; a scored question bank makes the gap visible and drivable to zero |

| D12 *(M0, 2026-08-17)* | **M0 runtime dependencies:** `react`, `react-dom`, `@excalidraw/excalidraw` — pinned exact (0.18.1 at adoption) | The minimal set mandated by S1 (a React shell embedding upstream); recorded per I7. All build tooling stays in devDependencies |
| D13 *(A2, 2026-08-17)* | **Detail diagrams are same-canvas frames, not separate files.** An element's inner-mechanism diagram is a frame in the same `.excalidraw` file, linked by `customData.docent.detail` | One file = one scene graph (B6): the tier hierarchy is part of the graph and both exports, with `declared` provenance; no cross-file ID addressing, no database (§3). Physically nesting drawings inside shapes is rejected — Excalidraw zoom bounds and roughjs rendering break past one tier of scaling |
| D14 *(A2, 2026-08-17)* | **Drill authoring is intent capture.** Creating/linking a detail frame is an author-time edit, same class as legend/annotations/narratives | I2 is untouched — the overlay still never writes; drill *navigation* is pure camera work. Agents read declared hierarchy and drive the camera through it, but never create it (authoring stays v2 per D8) |
| D15 *(A2, 2026-08-17)* | **customData namespace.** Every field Docent writes lives under `customData.docent.*`; keys outside that namespace are never written or interpreted | One collision-proof convention locked before M2's intent capture lands; upstream and third-party customData pass through untouched |

| D16 *(2026-08-18)* | **Tier-band layout + tier-scoped camera.** Detail frames live in horizontal bands far below Layer 1 (adaptive gap, ≥20k scene units), computed from the drill-link graph, never from positions; overview, load-fit, and presentation waypoints scope to Layer 1; breadcrumbs derive structurally from the link graph at the viewport's position; "Arrange detail tiers" reflows scattered scenes in one undoable step | Reviewing one layer must never pull other layers into view — distance plus camera scoping guarantees it at any diagram size, Excalidraw's viewport culling keeps distant bands render-free, and structural breadcrumbs make pop-back work even with no session dive stack |

| D17 *(A3, 2026-08-18)* | **Portfolio is a file tree, not a database.** `<data>/<project>/<scene>.excalidraw` — a project is a directory, a scene is a plain `.excalidraw` file; the store adds no format of its own | Files stay portable, inspectable, and rsync-able; D13's one-file-one-graph holds per scene; the §3 "no database" exclusion survives intact. Anything the store can do, a file manager can too |
| D18 *(A3, 2026-08-18)* | **Zero-dependency store service, same origin.** `server/docent-store.mjs` — hand-rolled Node HTTP (precedent: `server/docent-mcp.mjs`), proxied at `/api/` by the same nginx that serves the shell | I7 runtime weight stays zero; same-origin means no CORS surface; single-user LAN self-hosting is unchanged — no auth is added and §3 still excludes it |
| D19 *(2026-08-18)* | **The agent endpoint ships with the deployment, vendor-neutral.** The MCP server runs as a compose service speaking MCP streamable HTTP at `/mcp` (same-origin behind nginx, like `/api`); stdio remains for locally-spawned clients; one dispatcher serves both transports (B4). The canvas bridge is same-origin too, and connecting it stays strictly manual | D7 already fixes the agent surface as protocol-standard MCP — any client, no vendor hardcoded anywhere in the app. Deployment packaging extends S1's self-host promise to S8: a deployed Docent is agent-drivable out of the box, on the same single-user LAN trust model as the rest of the stack |

New decisions append here with a number, a one-line rationale, and a date.

---

## 7. Amendment process

1. Propose the change as a PR editing this file only.
2. State what it unlocks and what it costs (scope, dependency weight, upstream risk).
3. Maintainer (Kaixiang) approves or rejects. Approval lands the amendment; only then
   may implementing code merge.
4. Invariants I1–I5 are entrenched: amending them requires demonstrating the demo
   scenario (§1) is impossible without the change.

---

## 8. Delivery order

Milestones ship strictly in order — each is independently demoable:

**M0 Shell → M1 Longtake → M2 Scene Graph + Intent + Export → M3 Overlay FX → M4 Agent control.**

Rationale for the order: the scene graph (M2) is the address space *and* the meaning
store; it must exist, carry intent, and be golden- and comprehension-tested before
effects (M3) and agents (M4) reference its IDs. The intent-capture UI (S10) lands in
M2 alongside the exporters it feeds. No milestone starts before the previous one's
definition of done (§3) is met. Partial credit is not credit.

*(A2)* S11 splits along the same seam: drill **navigation and create-on-click
authoring** ship with M1 (camera work — the presentation milestone, independently
demoable); the **tier hierarchy in the scene graph, both exports, and the Q6
question banks** ships with M2. M1's definition of done includes the S11 navigation
and authoring behavior.

---

## 9. Amendment history

**A1 — 2026-08-17.** Export completeness amendment. Amended I4 (inference flag →
full provenance triad), S4 (legend application, provenance, Q6 gate), §8 (M2 scope).
Added S10 (intent capture), B6 (intent model unity), Q6 (round-trip comprehension),
D9–D11. Rationale: the export must carry the diagram's declared meaning and intention,
not just its structure — and intention must be captured at authoring time, because it
is not recoverable from the data model afterward.

**A2 — 2026-08-17.** Tiered drill-down amendment. Added S11 (drill-down: per-element
detail diagrams as same-canvas frames, Prezi-style dive navigation, create-on-click
authoring, unbounded tiers), D13 (same-canvas frames, not separate files), D14 (drill
authoring is intent capture; overlay and agent invariants untouched), D15
(`customData.docent.*` namespace), §8 (S11 navigation + authoring in M1; hierarchy in
graph/exports/question banks in M2). Rationale: one diagram should carry its own
zoom-levels of meaning — overview → service → component — navigable by humans
clicking, describable to AI through the same declared hierarchy.

**A3 — 2026-08-18.** Project portfolio amendment. Added S12 (portfolio: projects of
scenes on one deployment, portfolio modal, URL addressing, save-back), D17 (file
tree of plain `.excalidraw` files, not a database), D18 (zero-dependency same-origin
store service). Amended the §3 persistence exclusion accordingly — databases and
non-`.excalidraw` storage formats remain excluded. Rationale: one self-hosted
deployment should carry a user's whole diagram portfolio without giving up file
portability or adding storage formats.
