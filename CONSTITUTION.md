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
| S10 | Intent capture *(added A1)* | **Legend editor** — visual attribute → meaning mappings (e.g. `dashed → async`, `red → hot-path`), stored as data; **element annotations** — tags, **intents** (an ordered list of short declared statements, one per line — an arrow between two systems legitimately carries several), and **logic** (free-form pseudocode or rules for what a component does, on any element including imported composites) on any element, stored in `customData` (fork-free per I1) *(amended A8)*; **frame narratives** — per-frame "what this means" text, the single source of truth for both export and `tour` narration |
| S11 | Drill-down (tiered diagrams) *(added A2)* | Any element may declare a **detail diagram** — a frame on the same canvas drawing its inner mechanism — via `customData.docent.detail` (fork-free per I1). **Navigation:** in presentation/drill mode, activating a linked element dives the camera into its detail frame with an eased portal tween (zoom toward the element, resolve on the frame); back/breadcrumb climbs one tier; unknown/deleted targets error per I5. **Authoring:** activating an unlinked element offers to create its detail frame (named after the element, placed in free canvas space, linked, then dived into). Depth is unbounded — elements inside detail frames may declare their own details. The mechanism is element-agnostic: any element type (shapes, images, frames themselves; grouped composites via their frame or any member). Drill interactions must not break normal editing — plain click still selects; drill uses presentation mode or a dedicated affordance |
| S12 | Project portfolio *(added A3)* | One deployment hosts many **projects**; a project holds many **scenes**. A portfolio modal browses projects and their scenes: create a project, open a scene, save the current scene into a project, delete either (confirmed). Scenes address by URL (`?project=<p>&scene=<s>`); Save writes back to the portfolio scene it was opened from; local `.excalidraw` file open/save is unchanged. Storage is a **file tree of plain `.excalidraw` files** behind a zero-dependency same-origin store service (D17, D18); a deployment without the store degrades gracefully — the modal says so and file workflows are unaffected |
| S13 | Desktop distribution *(added A4)* | Docent ships as a **Tauri** desktop app for macOS, Windows, and Linux, wrapping the **same built SPA** — no second frontend, no fork (I1). The desktop portfolio is a native store implementing the **same D17 file-tree contract and `/api` route contract** as the self-host store, rooted in the OS app-data directory; contract parity is tested. Samples and bundled libraries ship in the app. The MCP agent endpoint was not part of desktop v1; A7 adds it as S15. Installers build in CI; auto-update is out of scope for v1 |
| S14 | GitHub project sync *(added A5, local-first per A6)* | A portfolio project may **bind to a GitHub repository** (`owner/repo`, path prefix, branch, and an API base URL so GitHub Enterprise instances work). The bound project's directory is a **local working copy**: scenes open and save at disk speed, offline included, as plain `.excalidraw` files (D17). Synchronization is explicit, like code: **pull** fast-forwards the working copy from the active branch and surfaces per-scene **conflicts** when both sides changed — never auto-merged; the author resolves keep-mine or take-remote; **push** lands every local change as **one commit** on the active branch (refused when the remote moved — pull first); branches are created and switched deliberately (switching requires a clean copy), and pull requests open back onto the recorded base (D28). Sync state — per-scene base blob SHA and base content hash, per project — lives under the `.docent/` exception beside the bindings. Auth is a **fine-grained personal access token** — chosen over OAuth device flow because customer-controlled GitHub instances may not host any OAuth app; tokens are held outside the data tree and are write-only through the API (never echoed). Both store implementations honor the same binding contract; unbound projects behave exactly as before |
| S15 | Desktop agent endpoint *(added A7)* | The desktop app exposes the **same protocol-standard MCP agent surface** as a deployment (S8, D19), **read-only**: the scene document is never modified — camera moves, overlay effects, narration, presentation control, drill navigation, and scene opening are navigation, not writes, and opening a scene is refused while the canvas holds unsaved changes. Transport is **loopback streamable HTTP** on a fixed local port with an ephemeral fallback (D34) — loopback is exempt from MCP clients' HTTPS requirement, which is what made the self-host endpoint need a stdio shim (D24). The page-side dispatcher is the **same shared module** the self-host MCP server runs (D34), so the tool surface cannot drift between the two. **Help → Agent Endpoint…** shows the live URL and a ready-to-paste client configuration. *(amended A8)* The surface is **tier-aware and progressive**: agents are told at `initialize` that diagrams are tiered and read them outline-first, tier by tier; `get_outline` and `find` exist for orientation and for locating the relevant part by keyword; reads return the legend-applied semantic view with the author's intents; and the camera keeps context — a focused component is framed with its neighbourhood and can never fill the view |
| S16 | Visual review *(added A9)* | Changing a diagram produces a review a person can read. A **semantic scene diff** (D46) compares before and after by stable id — components, edges, frames, and the declared meaning on them — and its changelog rides every push's commit message and every pull request body. In the app, a **Review** view (D48) shows each changed frame as before/after crops of the changed area with the changelog, flies the camera to a change with removed elements ghosted on the overlay, and prefills the PR. **The diagram directory and the base branch carry nothing for this by default**: the "before" copies live under `.docent/` at the data root (D47), and the only artifacts that can reach GitHub are opt-in per binding (D49) — before/after crops quarantined on a prunable orphan branch and embedded in the PR body, and semantic sidecars beside the scenes for teams that want meaning as text in the repo |
| S19 | Agent authoring *(added A13 — v2 opens)* | Agents **create and modify diagrams over MCP**, with the same reach a person has at the canvas, in the diagram's own terms: **agents author meaning; Docent draws** (D59). The write surface lives in the Command API (B4) and reaches Excalidraw only through the adapter (B1): `add_node`, `add_edge`, `update`, `remove`, `add_frame`, `add_detail_layer`, `define_kind`, `layout`, and `edit` — a validated, all-or-nothing batch that lays out once, lands as one undo step, and answers with the semantic changelog (D62) — plus `propose` (the batch's dry run) and `validate` (the diagram's lint). Style and shape come from the **legend and the diagram's own conventions**, never from pixels (D59); placement is Docent's and never disturbs hand-placed work uninvited (D60). Every agent write is **visible, undoable, and reviewable**: the canvas wears an orange *agent at work* frame and is view-only for the duration of a batch, the camera shows what changed, the panel offers Undo, and A9's review covers the result (D61). Agents know the craft (D63): kinds and intents on every component, logic for rules, narratives on frames, detail layers for inner mechanism, a branch before the first edit on a bound project. Scenes are created and saved through the store; Git stays the person's (D65). The overlay still never writes (I2) |
| S17 | Plugins *(added A10; desktop)* | The desktop app can be extended by **plugins**: a plugin is a folder in the app's config directory holding a manifest (`docent-plugin.json`) and a **provider process** that Docent launches, health-checks, proxies on its own loopback origin at `/plugins/<name>/`, and stops on quit (D50). A plugin fulfils one or more **versioned provider contracts** — small HTTP shapes the core defines and documents as a public surface (D51) — and **no plugin code ever runs in the page**: the canvas, the adapter, the overlay, and the scene stay exactly as bounded (B1–B4, I1, I2). A **Plugins** panel lists what is installed — name, version, contract, license, status — and enables or disables each. The self-host deployment does not host plugins in v1; the contracts are origin-relative so it can follow by decision, not by amendment |
| S18 | Spoken narration *(added A10; desktop; the first plugin)* | Narration is **spoken aloud** through a `speech/1` provider (D51): what an agent narrates, what a tour step says, and the author's frame narratives during presentation — the same words the panel shows, never different ones. Speech is **off until the person turns it on** (one gesture per session, because audio needs one), cancels the moment the narration changes, mutes with one key, and **paces tours**: a step's dwell lasts at least as long as its speech (D52). The reference provider is a local **PocketTTS** plugin in its own repository — a 100M-parameter CPU model; nothing leaves the machine, no account, no key (D53). The §3 exclusion of TTS narration is lifted in this form only |
| S5 | Overlay renderer | Viewport-synced SVG layer; sync verified across pan/zoom/resize |
| S6 | Highlight | `glow`, `spotlight` (dim-others), `outline`; idempotent; clearable |
| S7 | Flow animation | End-to-end pulse along an edge; multi-hop chaining across an ordered edge path; straight, curved, and elbow arrows |
| S8 | Command API + MCP | `get_scene_graph`, `focus`, `highlight`, `flow`, `tour`, `narrate` over a local MCP server |
| S9 | Narration panel | Text panel rendering `narrate` output during tours; `tour` steps may reference frame narratives (S10) as narration source |

### Out of scope for v1 (locked out — do not build, do not scaffold "for later")

- ~~**Agent authoring** (`add_node`, `add_edge`, element mutation) — deferred to v2 by design.~~
  *(A13 opened v2: S19. The ID model was kept for it; it is now implemented under D59–D65.)*
- **Library-shape authoring by agents** — inserting the bundled icon libraries' items by name
  needs a library-import funnel (named, id'd, lookup-able items) that does not exist yet; until it
  does, agents author with the primitive shapes the legend maps *(noted A13)*
- Forking/patching Excalidraw core (I1 — permanent, not just v1)
- Multiplayer, collaboration, presence
- Auth, accounts, multi-tenancy — Docent v1 is single-user self-hosted
- Viewport rotation (Prezi's rotating camera)
- Pixel-perfect tracing of roughjs strokes (see D3)
- TTS narration *(amended A10: lifted for the desktop app only, as a plugin-provided `speech/1` provider — S18; the core still ships no speech engine)*; mobile layouts; custom Excalidraw element types
- Plugins that run code inside the page — UI plugins, adapter or overlay hooks, scene mutators. *(added A10: plugins are out-of-process providers behind versioned contracts, S17; a marketplace, registry, signing, or auto-update of plugins is likewise out of scope)*
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
| D20 *(2026-08-18)* | **Composite legend rules.** A rule may carry additional `also` conditions — it matches only when the primary attr/value AND every extra condition match (e.g. rectangle + solid `#1e1e1e` stroke + width 2 → `kind: service`); evaluation runs in ascending specificity so specific rules override generic ones for the same key; simple rules keep their exact serialized form | Single-attribute rules can't express "this combination means a service" without polluting single attributes with meaning they don't carry alone. Backwards compatible by construction: existing files and goldens are byte-identical (I3/Q2), and the sidecar joins composite conditions with `+` deterministically |
| D21 *(2026-08-18)* | **Cross-tier edge refinement.** An edge may declare (`customData.docent.refine`) which inner component of a bound endpoint's detail diagram it actually lands on / departs from. The coarse edge stays true at its tier; the graph resolves `toRefined`/`fromRefined` only when the component currently lives in that detail frame (read-time validation, like detail links); the sidecar exports refined endpoints as `declared` facts; Mermaid adds a dotted refinement edge | "Service A → Broker" and "Service A's traffic lands on Adapter A inside Broker" are both true at different tiers — without refinement the finer truth is uncapturable. Declared, never inferred (D10); rides the one graph (B6); dangling declarations read as absent, never as errors in export |
| D22 *(2026-08-18)* | **Grouped composites are one component.** A group that draws with primitives (a member outside the node vocabulary — the library-icon signature) collapses into a single scene-graph node: union bounds, any member's label/intent/detail link, and edges bound to any part resolve to it. The composite is flagged in exports with `inferred` provenance, or `declared` when the author set `customData.docent.composite` (true forces a collapse, false forbids one) | An imported icon is one component to every reader, but a dozen strokes to the data model — exporting its drawing parts as separate components corrupts the graph an AI reads and clutters every diagram. The signature is a heuristic, so it is flagged `inferred` per I4 and always overridable by declared intent (D10) |
| D23 *(2026-08-18)* | **Bundled shape libraries as static assets, eager or lazy by weight.** `public/libraries/software-architecture.excalidrawlib` (Software Architecture, Youri Tjang / `youritjang`, 7 items, ~44 KB) and `public/libraries/aws-architecture-icons.excalidrawlib` (AWS Architecture Icons, Anna Pastushko / `childishgirl`, 249 items, ~3.9 MB) — both from `excalidraw/excalidraw-libraries` (MIT, per that repository's LICENSE), vendored verbatim and attributed in the README. The adapter (B1) holds the manifest and fetches each from the app's own origin, non-fatally — a missing or malformed asset warns and the canvas comes up regardless. **The small library merges into the sidebar at canvas mount; the large one is deferred to the first time the user opens the library sidebar, fetched exactly once per session.** Serving marks them `application/json` so they gzip | Self-hosting means the shapes are there on first load, with no call out to libraries.excalidraw.com. I7 governs npm runtime weight; a static file ships no code, no transitive tree, and no upgrade surface, so both are recorded here for provenance rather than counted as dependencies — the runtime set stays `react`, `react-dom`, `@excalidraw/excalidraw` (D12). The library API is Excalidraw's, so exactly one module may touch it (B1); vendoring the files rather than fetching upstream at runtime keeps the deployment offline-capable and pins what users get. The eager/lazy split is startup cost: 3.9 MB is ~90× the architecture set, and a canvas that must download and merge an icon catalogue before it draws fails S1's self-host promise for every user who never opens the sidebar — deferring puts the cost on the one interaction that asks for it. Attribution notes that the icons' AWS names and marks remain Amazon's; the MIT license covers redistributing the file, not the marks |
| D24 *(2026-08-18)* | **stdio bridge for HTTPS-only clients.** `server/docent-mcp-proxy.mjs` — a spawned stdio process that forwards JSON-RPC verbatim to a deployment's `/mcp` and relays answers back, carrying the session header and surfacing unreachability as a JSON-RPC error. No logic of its own | Many MCP clients refuse plain-HTTP remotes, and a self-hosted LAN box cannot obtain a certificate for its IP; stdio has no transport policy to satisfy, so the shim restores access without HTTPS, tunnels, or a second server implementation. B4 holds — it is transport, and the one dispatcher still lives in the MCP server (D19); I7 holds — zero dependencies |

| D25 *(A4, 2026-08-18)* | **Tauri is the desktop shell.** System webview + Rust core around the unchanged SPA build; the Rust crate is shell tooling, not an npm runtime dependency, so I7's runtime set is untouched. The desktop store is a second implementation of the one store *contract* (D17 file tree + `/api` routes), kept honest by contract tests | Smallest cross-platform footprint (no bundled browser, no bundled Node), one frontend forever; a contract with two thin implementations beats shipping a Node runtime to every desktop |
| D26 *(A4, 2026-08-18)* | **Credit is structural, not incidental.** The repo and every distributed artifact carry: a prominent README section crediting Excalidraw as the foundation Docent is inspired by and depends on; a `THIRD_PARTY_NOTICES.md` with the full MIT license texts of Excalidraw and other shipped third-party work; and an explicit no-affiliation/no-endorsement disclaimer | Docent's value is built on Excalidraw's; distribution without unmistakable credit would be wrong and, under MIT's notice-preservation condition, non-compliant. Structural placement survives forks, mirrors, and installers |

| D27 *(A5, 2026-08-20)* | **GitHub sync speaks the API, not the git binary.** Bound projects use the Contents/Git-Data HTTP endpoints from both store implementations; no `git` executable is required on any machine. Binding metadata lives in a single dotfile at the data root (`.docent/bindings.json`) — a narrow, declared exception to D17's "no format of its own", carrying **no secrets**: tokens live outside the data tree (deployment config for the self-host store, the app's own config area for desktop) and the API never returns them | Requiring git on every Windows desktop kills portability; the API gives commits, history, and SHA-based conflict detection for free. The data tree stays rsync-able and secret-free — copying a portfolio can never leak a credential |

| D28 *(2026-08-20)* | **Branch-aware sync.** A binding records a `baseBranch` beside the active `branch`; every scene operation lands on the active branch, and the same store API lists branches, cuts one off the active branch (switching to it in the same call), and opens a pull request back onto the base — `GET/POST /api/projects/:p/branches`, `POST /api/projects/:p/pull-request`, identical on both implementations. The base is resolved from the repository's own default branch by the bind-time probe that was already running; a binding written before this has no base and keeps behaving exactly as it did, its branch being its own base | Diagram changes deserve the repository's review flow rather than landing on `main` unseen — and the branch is already the one thing every GitHub call carries (D27), so this adds a field and two routes, not a mechanism. Drafting on a branch also makes the SHA conflict rare instead of routine, because two people are no longer aiming at the same file on the same branch |

| D29 *(A6, 2026-08-20)* | **Bound projects are local-first.** Reads and writes never wait on the network; GitHub is touched only by the sync verbs (pull, push, branch, PR) and the bind-time probe. Conflicts exist at file granularity and are always surfaced, never merged | Live-through reads made every open a network round-trip and every thumbnail a rate-limit expense, and offline meant a dead portfolio. A working copy of plain `.excalidraw` files keeps D17's promises — rsync-able, secret-free, inspectable — while giving diagrams the same pull → branch → push → PR rhythm as the code beside them. File-granular conflict resolution is the honest choice: there is no meaningful line-merge for a drawing |

| D30 *(2026-08-20)* | **Releases ride a nightly train, not per-push CI.** Versioning and packaging run from a separate automation repository (`happyren/docent-release`): each evening that `master` carries commits the latest release lacks, the train gates the tree (typecheck, web tests, store contract tests, Q6 when configured), bumps the semantic version — patch unless a commit message since the last tag includes a line starting `[minor]` or `[major]` — commits the bump, tags, builds every desktop platform, publishes the GitHub Release with the standing asset set, and mirrors `docs/` to the user site that serves the project page. This repository carries no workflows of its own | Every change reaches a versioned release without a manual step, and the gate that ran per-push runs pre-release instead — nothing publishes unless it passes. The repository itself stays code-only, and the quality bars' "in CI" clauses (S4, Q3, Q6, S13) are discharged by the train's gate |

| D31 *(2026-08-20)* | **Detail layers announce themselves.** Every component with a live detail diagram wears a small corner chip drawn by the overlay — one per composite (D22), none for a dangling link — clickable as a dive in every mode, with the pointer cursor over diveable components during presentation and a session-scoped View toggle (default on) to hide them | An alpha reader could not tell which shapes went deeper: the affordance existed only after clicking. The overlay draws the marker because the overlay never writes (I2) — scene files, exports, and goldens are byte-untouched — and static unfiltered SVG chips ride the composited stage, so a presentation glide pays nothing for them |

| D32 *(2026-08-20)* | **Frame-scoped semantic export, one tier deep.** Right-clicking a frame — or a component whose declared detail layer is one — adds a "Copy semantic JSON" entry to the canvas context menu that puts that frame's sidecar on the clipboard: the frame, its members, their bound labels, and the scene legend, produced by the ordinary export pipeline over a sub-snapshot. Layers nested beneath the frame's components are never included — the sub-snapshot lacks their frames, so the standard read-time validation strips their contents and the dangling pointers alike. Upstream has no context-menu API, so the adapter appends the one item to the menu's DOM after it mounts (cloned from a native entry), a coupling licensed only by the exact pin (I7/D12) and revalidated on any upgrade | A frame is the unit a human narrates and an AI should read — handing one tier to the clipboard makes "paste the diagram into a chat" one gesture, deterministic (I3), and honest about depth: what you copied is what that tier says, nothing leaked from below |

| D33 *(2026-08-20)* | **Protected trunk, auto-checkpointed drafts.** Docent never pushes to a binding's base branch — `POST /api/projects/:p/push` refuses it on both stores, so through Docent the base changes only by a merged pull request. Saving is never blocked by that: a save on the base lands locally and offers, once per project per session, to cut a draft branch. On a draft branch, local modifications are committed routinely and without ceremony — debounced after the last save, swept periodically, silent on success and on every reason to skip, and never over an unanswered conflict or a manual pull or push | Two failures worth designing out. A drawing that lands on `main` unreviewed is the one D28 already argued against, and only a hard refusal makes it impossible rather than merely discouraged. The other is the closed laptop: local-first (D29) means saves are instant, which also means a session's work can sit unpushed for hours, so the app checkpoints it rather than waiting for someone to remember. Ceremony is what makes people stop doing it, so the checkpoint asks nothing and says nothing unless the branch moved underneath |

| D34 *(A7, 2026-08-21)* | **The desktop shell is agent transport, never an agent brain.** One MCP dispatcher exists — `server/mcp-core.mjs`, plain ESM with the tool table and the JSON-RPC handling — and both surfaces run it: the self-host Node server imports it and relays tool calls to the canvas over its bridge; the desktop **page** imports it and executes directly against the Command API (B4). The Rust side only pipes: a loopback listener on a fixed port (`DOCENT_MCP_PORT`, default 3301, ephemeral fallback) forwards raw JSON-RPC bodies to the page over an Origin-gated long-poll bridge on the same listener — never the store, whose one-request-at-a-time thread a parked poll would starve — and returns what the page answers. The page connects that bridge automatically at startup — the shell it talks to is the same process, so there is nothing to configure and no one to ask | Two dispatchers would drift; a Rust one would re-implement scene logic the page already has behind B4. Long-polling over the existing loopback store keeps the shell's HTTP dependency surface at `tiny_http`, and loopback's HTTPS exemption is what lets any MCP client connect with one URL and no shim |
| D35 *(A7, 2026-08-21)* | **Agent tool surface v1 — read-only, ID-space, and portfolio-aware.** Beside the existing seven (get_scene_graph, focus, highlight, flow, narrate, tour, clear_effects) the surface gains: `get_mermaid` (the compact AI-first export), `read_frame` (one frame's semantic JSON, one tier deep per D32), `list_projects` (projects with their scenes), `open_scene` (refused on a dirty canvas), `get_view` (current scene, breadcrumb trail, presentation state), `present` (enter/exit/next/prev/overview), and `dive`/`climb` (declared detail links only, per D14). Moving around stays in ID-space per I5: the camera pans and zooms through `focus` with padding, `present`, and `dive`/`climb` — there are no pixel coordinates in the agent surface and none were added | Everything an agent reads was already built for reading — the graph with legend, refinements, narratives, and provenance; the deterministic exports; the tiered hierarchy; the portfolio. v1 exposes exactly that and nothing that writes, so the trust question stays as small as the loopback socket it listens on |

| D36 *(2026-08-21)* | **The train comes home; the history is builds, not keystrokes.** The nightly release train (D30) moves into this repository's own workflows and GitHub Actions is enabled again — the working-hours discipline kept by *scheduling* rather than hiding: nothing runs on push, everything runs on the evening cron (or an after-hours dispatch), so every run the Actions tab shows carries an out-of-hours timestamp. The train gains the website — `docs/` deploys to GitHub Pages from the workflow, never from branch pushes, because a push must not mint a daytime run — and a tidy job keeps only seven days of run history. `happyren/docent-release` retires, its history with it; the mirror folder leaves the maintainer's personal site | One repository again: the split existed only to hide a tab the maintainer has since chosen to show, and same-repo publishing needs no cross-repo token — `GITHUB_TOKEN` does everything the train does |

| D37 *(2026-08-21)* | **The camera follows the narration.** The agent surface is content-aware: a tour step that highlights or flows without naming a focus frames the union bounds of what it shows, and agent-issued `highlight`/`flow` calls frame their targets first whenever those targets do not already *read well* — fully inside the viewport AND at least a tenth of it in one dimension. "In view but microscopic" counts as unseen. The user's own toolbar effects never pass through this — their camera stays theirs | Field report: a walkthrough narrated one component's exit rules while the camera sat at a zoom where that component was a speck. Narration about content the viewer cannot see is the one way a tour fails its audience, and no prompt fixes that as reliably as the machinery refusing to let it happen |
| D38 *(2026-08-21)* | **One binary, two mouths.** `docent --agent-stdio` runs a stdio→loopback MCP pipe instead of the window: newline JSON-RPC on stdin forwarded verbatim to the running app's `/mcp` (port from `DOCENT_MCP_PORT`, else the `mcp-port` file the shell records in its config directory, else the default), answers on stdout, and a spoken JSON-RPC error — never silence — when the app is not running. Help → Agent Endpoint… shows the paste-ready `claude_desktop_config.json` stanza with the binary's real path | Some clients' connector dialogs insist on https even for loopback (Claude Desktop's does), but every one of them can spawn a stdio server — and the shim being the app's own binary means no Node, no extra file, and portable zips carry it for free. Mirrors the self-host shim's reasoning exactly (D24): stdio has no transport policy to satisfy |

| D39 *(A8, 2026-08-21)* | **Effects treat a composite as one shape.** Glow, outline, and the spotlight's dim holes address a highlighted *target*, never its strokes: a composite or group gets one rounded box over the union of its members — one glow path, one outline, one `evenodd` hole — and holes that overlap are merged into their enclosing box before cutting, so the hole set is always disjoint. A lone plain shape keeps its true outline (ellipse, diamond) | Two failures with one cause. Overlapping holes under `evenodd` cancel — the half-darkened patches inside imported icons are one hole per stroke re-dimming every overlap; and a glow traced per stroke is forty blurred paths where one would do. One box per target is cheaper (one filter pass, not one per stroke), sound under the fill rule, and what a reader sees as "the icon" anyway |
| D40 *(A8, 2026-08-21)* | **Intent edits say when they are saved.** The intent panel commits on blur as before, and now also on a **Save** button (`⌘↩`), on closing the panel, and on changing selection — nothing typed is ever lost to a click elsewhere. The panel shows its state plainly: an *Unsaved* mark while a field differs from the scene, *Saved* once committed. Each commit stays one undo step | Blur-to-save is invisible, and invisible saving reads as no saving; the author should never wonder whether the sentence they just wrote made it into the file |
| D41 *(A8, 2026-08-21)* | **An element carries an ordered list of intents.** `customData.docent.intents` — short declared statements, authored one per line in the panel. Files stay compatible by construction: a single intent is written as the existing `note` (byte-identical to every file and golden today), and `intents` is written only when there are two or more; readers treat a lone `note` as the one-item list. The sidecar emits `note` as before plus `intents` when present, both `declared`; Mermaid is unchanged | One arrow between two complex systems legitimately means several things, and splitting it into several arrows would be the convolution S11 warns against. A list of lines is the least ceremony that still keeps each intent addressable by an agent |
| D42 *(A8, 2026-08-21)* | **Logic is a field, detail is a layer.** `customData.docent.logic` — free-form pseudocode or rules, multiline, language-agnostic — on any element, composites included, authored in a monospace *Logic* section of the intent panel and exported as `logic` with `declared` provenance (sidecar, `get_scene_graph`, `read_frame`); Mermaid omits it. A small `{ }` corner chip on the overlay marks elements that carry logic, the way the detail chip marks depth (D31). The rule of thumb the panel states: *a sentence or a snippet is logic; boxes and arrows are a detail layer*. Guardrail: logic is text Docent stores and exports — it never parses, highlights, validates, or runs it, and no code-editor surface grows around it | A nested layer is the right home for a drawn mechanism and the wrong one for twelve lines of pseudocode: it costs a frame, a dive, and a tier for what an agent wants to read inline beside the node. The two coexist because they answer different questions — how it is built versus what it computes |
| D43 *(A8, 2026-08-21)* | **Agents read meaning, not paint.** `get_scene_graph` returns the legend-applied semantic view — the sidecar's entity model with stable ids: `kind` and mapped properties with provenance, tags, intents, notes, logic, refinements, composites, detail links, frame names and narratives — instead of raw styling plus legend rules for the agent to apply itself. One representation serves every AI reader (B5): the file export, `read_frame`, and the live graph say the same thing | Narration is only as good as what the narrator read. The author already declared what a dashed red arrow *means*; handing an agent `strokeStyle: dashed` and a rule table is asking it to re-derive the author's words, and it will paraphrase them worse |
| D44 *(A8, 2026-08-21)* | **The camera keeps context.** `focus` on a component frames its **neighbourhood** by default — the component plus every component an edge connects it to within the same tier — and a **zoom ceiling** holds the focused component to at most 40% of the viewport's shorter side; `context: "self"` tightens to the component alone but stays under the ceiling; a frame focuses as a whole. The same ceiling bounds D37's framing. With D37's 10% floor this is the readable band: never a speck, never a wall | An agent zooming one box to fill the screen shows the viewer a rectangle with a word in it; the meaning of a component is its connections, and a frame that keeps them in view narrates better than any sentence about them |
| D45 *(A8, 2026-08-21)* | **Progressive, tier-aware reading is the protocol, not advice.** The `initialize` answer carries MCP `instructions` stating that diagrams are tiered and how to read them: `get_outline` first, one tier at a time with `read_frame`, `dive`/`climb` between tiers, `find` to locate by keyword. `get_outline` returns the table of contents — tiers, frames with names and narrative openers, component counts, which components go deeper. `find({query})` matches case-insensitively across labels, tags, intents, notes, logic, narratives, frame names, and legend meanings, returning hits with their tier trail so a request to "show the retry path" resolves to a dive in one call. Above a size threshold (150 components) `get_scene_graph` answers with the outline and the progressive path instead of the whole graph unless `force: true` | Tiering exists so a big system can be drawn honestly; an agent that ingests all tiers at once flattens that back into a wall and narrates from it. Guidance an agent can ignore is not a design — the size gate and the tools that make the progressive path the easy one are |

| D46 *(A9, 2026-08-22)* | **Diffs are semantic before they are visual.** `src/scene/diff.ts` compares two snapshots by stable id (I6) into added / removed / changed components (label, geometry moved or resized, legend-applied kind, tags, intents, logic, detail link), edges added / removed / rewired, and frames added / removed / renamed or re-narrated — deterministic (I3), pure, tested. It renders to a **changelog** in the author's terms (*"Core Services: +Retry queue; Orders → Payments removed; Orders: intent added 'retries on failure'"*) that the push writes into its commit message and the PR body | A JSON diff shows forty changed lines and no meaning; images show the shape of a change and not its meaning either. Only a diff over the graph can say what changed in the terms the diagram was drawn in, and text in the commit reaches every reviewer and every agent with zero infrastructure |
| D47 *(A9, 2026-08-22)* | **The "before" is a local copy, never a repo artifact.** At pull and push the store keeps a base copy of each bound scene under `.docent/sync/<project>/base/` at the data root — the existing exception (D17, D27), never inside the project directory, never pushed. Before/after is therefore offline and exact, and "revert to base" falls out of it | The sync state already records the base blob's sha and hash; a copy beside them costs one small file per scene and buys a review that needs no network and a diagram folder that stays plain scenes |
| D48 *(A9, 2026-08-22)* | **Review in the app, crops at one rectangle.** The portfolio's sync row gains *Review changes*: per changed frame, the changed elements cluster to one crop — their union bounds, padded, clamped to the frame — rendered **before and after at the identical rectangle** through the adapter's `exportToCanvas` path (B1), *after* outlining added/changed, *before* ghosting removed; the changelog beside it; click a change to fly there with the removed elements drawn as ghosts on the overlay from the base copy (I2 — nothing is written). *Open PR* prefills the body with the changelog. Only frames whose diff is non-empty are rendered | Authors review where they draw, at full fidelity, at no cost to the repository; the identical crop rectangle is what makes before and after comparable at a glance |
| D49 *(A9, 2026-08-22)* | **GitHub artifacts are opt-in and quarantined.** Per binding, off by default: (a) *review images* — the D48 crops are pushed to an orphan branch `docent-review` under `<push-sha>/<scene>/<frame>-{before,after}.png` and embedded side by side in the PR body via raw URLs; the branch is a cache, pruned to the last 90 days, never merged, deletable without touching history; (b) *semantic sidecars* — `<scene>.docent.json` committed beside each scene, regenerated only when that scene changed. Neither ever touches the base branch's diagram directory except the sidecar a team explicitly asked for. GitHub's swipe/onion-skin view is forgone on purpose — it needs images inside the PR's own diff, which is exactly the pollution this avoids | Review pictures are for a conversation, not for the record: they age, they are regenerable, and a repository that carries a few hundred kilobytes of every changed frame forever would pay for every review for the rest of its life. A side-by-side in the PR body reads as well as a swipe for "what changed here", and a prunable branch gives the repository's growth a ceiling |
| D50 *(A10, 2026-08-22)* | **A plugin is a manifest and a process, never page code.** The desktop core (Rust) discovers `plugins/<name>/docent-plugin.json` under the app's config directory, starts the declared command with `{port}` substituted (or attaches to a declared `url` for a service the person runs themselves), polls the declared health path, proxies `/plugins/<name>/…` to it on a **pooled loopback listener of its own** — Origin-gated like the MCP pipe, never the single-threaded store listener, because a streamed reply must not stall `/api` — and terminates what it started on quit. The page learns the plugin base and the capability from the same initialization script that names the store (`__DOCENT_CAPABILITIES__`); the web build has neither and shows nothing. Plugins are enabled per person and remembered; a manifest naming a contract major the core does not know is refused, loudly | Everything a plugin system needs — spawn, health, proxy, kill — the desktop core already has in kind (D25, D34), and nothing a self-host box can do well. Keeping plugin code out of the page is what keeps B1–B4 real rather than advisory: a webview has no sandbox, and a plugin that reaches the adapter is a fork by another name (I1). Out-of-process also isolates performance (I8): a model can burn two cores and the canvas never notices. Self-host stays the zero-dependency three-service stack it is |
| D51 *(A10, 2026-08-22)* | **Contracts are the public surface, versioned by major.** A provider contract is a named HTTP shape (`<name>/<major>`) documented in `docs/plugins.md`; the manifest schema is documented beside it; both change only by decision, like the store routes. **`speech/1`** is PocketTTS's own serving API so the reference provider needs no adapter: `POST /tts` as a multipart form with `text` and an optional `voice` (`voice_url` alias accepted) answering a chunked `audio/wav` stream; `GET /voices` is optional and answers `[{id, license}]`, falling back to the manifest's declared `voices`. Other engines conform by matching the shape; other kinds of plugin arrive as new contracts the core chooses to add | A community can build against a stable shape in any language; a contract that is a de-facto API of the reference implementation costs nothing to define and nothing to adapt. What plugins *can* be is decided on the core side, one small typed surface at a time — the same gate the MCP tool list is |
| D52 *(A10, 2026-08-22)* | **Speech follows the narration choke points and paces the tour.** One `SpeechController` in the shell subscribes to the two places words reach the person — `narrate` through the Command API (B4: every agent narration and tour step) and the presentation's current waypoint narrative — normalizes the text for a reader (arrows become "to", markdown and em-dash asides are spoken plainly), streams the provider's WAV into Web Audio chunk by chunk, and cancels on change. Off by default, enabled by one gesture per session, muted with `M`. The Command API's `tour` waits for the step's speech to end before moving on — dwell is `max(dwell, speech)` — and `narrate` resolves when speech has been *started*, never when it ends, so an agent is never blocked by audio (I8) | Spoken words that differ from written ones would be a second narration source, which S10 forbids; hooking the two existing sinks guarantees they are the same words. A tour whose camera outruns its voice is worse than silence, so the voice sets the pace; an agent command that waited for audio would make the loop audio-bound, so it does not |
| D54 *(A11, 2026-08-22)* | **A guided presentation: the chrome without the walk.** `present({action:'enter', mode:'guided'})` puts the canvas in presentation mode — view-only, toolbars gone, the HUD up — and then leaves the camera alone: the agent moves it with `focus` and `tour` at its own pace, the frame stepping keys are off, *Home* still pulls back to the overview and *Esc* still exits. `mode:'frames'` (the default) is the author's ordered walkthrough as before. `get_view` reports the mode | An agent narrating an architecture does not think in the author's frame order; it goes where the question goes. Making it fake that through next/prev, or narrate over an editable canvas with its toolbars showing, were the two bad options. The presentation chrome is what a walkthrough needs; the waypoints were only ever one way to drive it |
| D55 *(A11, 2026-08-22)* | **Narration paces the agent, by default.** `narrate` resolves when the words have been *spoken* whenever a voice is on — at once when it is not — so an agent that narrates and then moves the camera moves after the sentence, not under it; `wait:false` asks for the old behaviour. Amends D52's "never when it ends": a tour still waits for its speech, and a `narrate` that waits is capped by the agent pipe's answer window | A walkthrough whose camera leaves mid-sentence is the one thing worse than silence (D52). The agent is the narrator; it should know when it has finished speaking. I8 is about animation blocking input or the command loop — a spoken sentence the agent asked to wait for blocks neither |
| D56 *(A11, 2026-08-22)* | **The voice reads text the way an engineer says it.** Before synthesis, narration goes through a deterministic **verbalization** layer in the shell (`src/speech/readable.ts`): numbers are written out as words — `8,000` is *eight thousand*, `3.5` *three point five*, `15%` *fifteen percent*, `8k`/`1.5M` *eight thousand* / *one point five million*, `p99` *p ninety-nine*, `2x` *two times* — units and rates are named (`200ms`, `req/s`, `GB`), operators and symbols are spoken (`>=` *greater than or equal to*, `!=` *not equal to*, `&` *and*, `~` *about*, `±` *plus or minus*), identifiers are split (`retry_queue`, `retryQueue`), and the usual abbreviations expand (`e.g.`, `etc.`, `vs.`, `w/o`). The table is tested case by case and is the one place pronunciation is fixed; the panel shows the same words the voice says only when they are words | A text-to-speech model is a reader of prose, and a diagram's labels are not prose: a thousands separator becomes four digits, an operator becomes a noise. Fixing this in the engine is impossible (it is a plugin) and in the author's text is wrong (S10: the author writes meaning, not pronunciation). One pure, testable layer between the two, owned by the shell, is the whole of the fix — and it serves every voice plugin alike |
| D57 *(A12, 2026-08-22)* | **Speech gates the camera, not the agent.** Amends D55: `narrate` returns as soon as the voice has started (`wait:true` still waits), and every command that would move the picture — `focus`, `highlight`, `flow`, `present`, `dive`, `climb`, `open_scene` — **waits in the page for the speech in flight to finish** before acting, unless asked to `interrupt`. Camera commands take a `narrate` text to say on arrival, so one call is one stop: wait for the last sentence, fly, start speaking, return. `tour` is unchanged — the fully scripted form. The gate lives in the Command API (B4), so every caller obeys it | A narrator that blocks on its own voice serialises speech with the model's thinking: each stop costs the sentence plus two round trips of reasoning, and with a deliberate model half of a walkthrough is dead air. Putting the wait on the camera keeps D52's invariant — the picture never leaves mid-sentence — while the model thinks during the voice. The camera was always the thing that had to wait; the agent never was |
| D58 *(A12, 2026-08-22)* | **Walkthroughs are derived, never authored.** `script_tour({frame?})` compiles a tour from what the diagram already carries: stops are the frames in declared order and, within a frame, the components in flow order (edges first, position as the tie-break); words are the frame's narrative, a component's intents, note and logic, and — where nothing is declared — a plain factual line from the graph and legend, marked `inferred`. Nothing is stored and nothing is asked of the author: every narrative or intent written for the export makes the script better by itself (S10). The MCP server also publishes **prompts** — `walkthrough`, `explain`, `where-is` — each a fixed sequence of calls; and action results carry a one-line `next` hint | Two competent models should give the same walkthrough of the same diagram, and they can only do that if the stops and the facts come from the diagram rather than from each model's reading of a graph dump. A derived script also cuts what a model must read before it can speak, and a published prompt makes the workflow the server's rather than the model's improvisation. What stays the model's is the prose between the stops — which is what one wants to vary |
| D59 *(A13, 2026-08-22)* | **Agents author meaning; Docent draws — in the diagram's own style.** A write names a `kind`, a label, intents, logic, tags, a frame, and what it connects to; never a coordinate, a colour, or a stroke. Docent resolves the look in two steps: the **legend** first (the inverse of export — a kind whose rule maps a style gets that style, and `define_kind` writes the rule when there is none), then the diagram's **house style** — per kind and per element type, the prevailing stroke colour, fill and fill style, stroke width, sloppiness, roundness, font family and size, arrow type and arrowheads, and the shape used for that kind — derived from the scene at each write. A raw `style` override exists for completeness and is discouraged by the instructions. Arrows are always bound to their shapes | Two people can only draw on one diagram if their drawings look alike; a second style is a second diagram. The legend is already the place where look means something, so it is the place to read the look from; and what the legend does not cover, the author's own hand already decided. A coordinate is the one thing an agent is worst at and a layout engine is best at |
| D60 *(A13, 2026-08-22)* | **Placement is Docent's, and it is polite.** New components go into free space inside their frame, in reading order after what feeds them, sized to their label; frames grow to fit, and new frames — detail layers included — go to free canvas space as create-on-click already does. A deterministic layered layout (`src/scene/layout.ts`: rank by longest path from sources, order within rank by neighbours, stable tie-breaks) re-flows a frame **only when `layout` is asked for**; hand-placed elements are never moved uninvited | A diagram someone arranged by hand carries meaning in its arrangement; an engine that "tidies" it destroys that meaning. Appending is safe, re-flowing is a request |
| D61 *(A13, 2026-08-22)* | **Every agent write is visible, undoable, and reviewable.** One tool call — or one `edit` batch — is one undo step in the person's history. While a write is in flight, and for a short linger after so consecutive calls read as one session, the canvas wears an **orange "agent at work" frame** and is view-only for the duration of each batch, so the two never edit the same element at once. Afterwards the camera shows what changed with the new and changed elements outlined, the narration panel says what happened in the changelog's words with an **Undo** beside it, and `edit` answers with the same changelog. **Agent can edit** is a session switch in the app (on by default on the desktop), announced to the agent at `initialize`; a write while it is off is refused with that reason | An edit the author cannot see, cannot undo, or cannot read is an edit they cannot trust. The orange frame is the one piece of chrome this adds: it says *whose turn it is*, which is the whole of collaboration on a single canvas |
| D62 *(A13, 2026-08-22)* | **`edit` is a transaction; `propose` is its dry run; `validate` is the lint.** A batch is validated whole before anything is applied — unknown ids, labels that collide inside a frame, a detail link that would cycle, a frame that would nest — and applied whole or not at all; the answer is the semantic changelog (D46) and a map from the caller's temporary ids to the ids Docent assigned. `propose` runs the same validation and answers the changelog without applying. `validate` reports what a reviewer would: components without a kind or an intent, edges without intents, frames without narratives, frames over twelve components, dangling edges, detail frames nobody links to | An agent that builds a diagram in forty calls makes forty undo steps and forty chances to stop halfway; one batch is one thought. A dry run turns "did I mean that" into a question answered before anything moves, and a lint turns the craft rules (D63) into something checkable rather than hoped for |
| D63 *(A13, 2026-08-22)* | **Agents know the craft.** `initialize` carries the authoring rules: every component gets a `kind` and at least one intent; rules and conditions become `logic`; every frame gets a narrative; anything with an inner mechanism gets a **detail layer** rather than a crowded frame; frames stay at or under twelve components; existing kinds are reused before new ones are defined; finish with `validate`, then `propose`, then `edit`. On a bound project sitting on its base branch, **create a branch first** (`docent/<topic>`), so the checkpointer can land the work where a pull request can review it. Prompts publish the workflows: `draw` (a diagram from a description), `extend`, `annotate` (fill intents, logic and narratives on an existing diagram), `tier` (split a crowded frame into detail layers) | The meaning model only pays off if it is filled in; a model that draws boxes and leaves intents empty has produced a picture, not a Docent diagram. The rules are the same ones the export, the tour, and the review already assume, written once where the agent reads them; the branch rule is D33's protection of the trunk, applied to a second author |
| D64 *(A13, 2026-08-22)* | **Library shapes wait for the funnel.** Agents author with the primitive shapes the legend maps — rectangle, ellipse, diamond, text — and not with the bundled icon libraries, until library items carry names, ids, and a lookup (the library-import funnel, a later decision). The house style still follows an author who draws with icons: the look of their primitives, arrows and text is what a new primitive inherits | An icon an agent cannot name is an icon it cannot choose well, and a half-made funnel would make every agent diagram a guess. Stating the gap beats pretending it is closed |
| D65 *(A13, 2026-08-22)* | **Scenes through the store; Git stays the person's.** Agents may `create_scene` and `save_scene` through the portfolio store — the same routes a save from the app takes — and `create_branch` on a bound project; they never push, open a pull request, switch branches, or bind. The checkpointer lands what they saved exactly as it lands a person's saves | A saved scene is reversible and reviewable; a push or a pull request is a message to other people, and the person sends those. The branch is the one Git act an agent needs, because without it nothing it draws can be reviewed at all |
| D66 *(A14, 2026-08-22)* | **Arrows do not cross.** Amends D60: a frame the agent itself built — every component in it new in this batch, detail layers included — is laid out whole before it lands (rank by flow, rows ordered to minimize crossings); into a frame with hand-placed work, a new component goes in the column after all its feeders at the mean row of its feeders, never merely "right of the last one". Labels wrap at a readable width instead of stretching the shape. Every plan, proposal, and lint counts **arrow crossings per frame**, and the instructions say what to do about them: `layout` the frame you built, re-place the component, or add a detail layer — a crossing that stays must be one the diagram needs | A crossing is a question the reader has to answer before the diagram says anything; a sequential placer produces them by construction. Counting them makes the rule checkable, and laying out what the agent built is free of the one cost D60 guards against — there is no hand placement in it to destroy |
| D53 *(A10, 2026-08-22)* | **The engine is a plugin, the weights are never ours, and nothing leaves the machine.** The PocketTTS provider lives in its own repository (`happyren/docent-pocket-tts`, MIT): a manifest that runs `pocket-tts serve` through `uvx`, its voice list with each voice's license, and install notes. Docent bundles no model, no weights, no Python: the plugin downloads Kyutai's weights (CC-BY-4.0) on first run and attributes them; the Plugins panel shows the licenses. Provider URLs are loopback only — a manifest naming any other host is refused — so narration text cannot be sent anywhere silently | I7 holds (the runtime set is unchanged; a plugin is the person's installation, like a shape library is a static file — D23), the app stays a 7 MB binary, the weights' license obligations stay with the artifact that carries them, and "local TTS" means local by construction rather than by configuration |

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

**A4 — 2026-08-18.** Desktop distribution amendment. Added S13 (Tauri desktop app
wrapping the unchanged SPA; native store honoring the D17/D18 contracts; MCP stays
self-host in v1), D25 (Tauri as shell; one store contract over two thin
implementations), D26 (structural credit to Excalidraw and all shipped third-party
work). Rationale: the tool should reach people who will never run docker compose,
without forking anything, shipping a second frontend, or blurring who the
foundation belongs to.

**A5 — 2026-08-20.** GitHub project sync amendment. Added S14 (per-project GitHub
binding over the HTTP API: save-as-commit, SHA-conflict detection, fine-grained
PAT auth, configurable API base for GitHub Enterprise), D27 (API-not-git-binary;
bindings dotfile as a narrow D17 exception; secrets never in the data tree).
Rationale: architecture diagrams belong in the repository next to the code they
describe, with the history, review, and team access the repository already has —
reachable from any Docent, including deployments pointed at customer-controlled
GitHub instances where OAuth apps cannot be assumed.

**A6 — 2026-08-20.** Local-first sync amendment. Amended S14 (bound project
directories become working copies; explicit pull/push with single-commit pushes
and file-granular, never-auto-merged conflicts; branch switching requires a clean
copy), added D29. Rationale: opening a diagram should never wait on a network,
and synchronizing should be as deliberate — and as reviewable — as it is for
code.

**A7 — 2026-08-21.** Desktop agent endpoint amendment. Added S15 (the desktop
exposes the deployment's MCP agent surface, read-only, over loopback streamable
HTTP), amended S13's exclusion accordingly, added D34 (shell as transport, one
shared dispatcher) and D35 (the v1 read-only tool surface: exports, portfolio
awareness, presentation and drill control — all in ID-space per I5). Rationale:
the desktop serves the watching and reading audiences, and an agent narrating a
diagram to its author is both — loopback removes the HTTPS constraint that made
this a self-host-only capability, and read-only keeps the trust boundary exactly
where the canvas already draws it.

**A8 — 2026-08-21.** Intent depth and agent literacy amendment, from the first
alpha and agent walkthroughs. Amended S10 (ordered intents per element; a logic
field for pseudocode and rules) and S15 (tier-aware, progressive agent reading
with outline, find, and context-keeping camera); added D39–D45. Rationale: the
author's declared meaning is the product's value, so capturing it must be
generous (several intents, real logic) and visibly saved, and an agent must be
handed that meaning directly and read it the way the diagram is built — tier by
tier, never as a wall, never losing the neighbourhood of what it shows.

**A9 — 2026-08-22.** Visual review amendment. Added S16 (semantic scene diff
with its changelog in every push and PR; an in-app Review view of before/after
crops per changed frame; opt-in, quarantined GitHub artifacts) and D46–D49.
Rationale: a diagram's change deserves a review in the terms the diagram was
drawn in, and that review must not cost the repository — text rides the commit
for free, the "before" lives locally, and pictures go to a prunable branch only
when a team asks for them.

**A10 — 2026-08-22.** Plugins and spoken narration amendment (desktop). Added
S17 (plugins as out-of-process providers behind versioned contracts, proxied on
the desktop's own loopback origin; no plugin code in the page; self-host
deferred) and S18 (spoken narration through a `speech/1` provider, off until
asked, pacing tours; the reference PocketTTS plugin in its own repository);
lifted §3's TTS exclusion in that form only and excluded in-page plugins and a
plugin marketplace; added D50–D53. Rationale: the thing a plugin system mostly
is — spawn, health, proxy, kill — the desktop core already has, and keeping
plugin code out of the page is what keeps the architecture boundaries real; a
voice makes a narrated tour land, and a 100M-parameter local model makes that
cost nothing to anyone's privacy or to the core's dependency set.

**A11 — 2026-08-22.** Guided presentation and spoken-word fidelity amendment.
Added D54 (a guided presentation mode: the chrome without the frame walk, the
agent driving the camera), D55 (`narrate` waits for its own voice by default,
amending D52), and D56 (a deterministic verbalization layer — numbers, units,
operators, identifiers, abbreviations — between narration text and any voice
plugin). Rationale: once narration is spoken, the agent is the narrator — it
goes where the question goes and should not move before it has finished the
sentence — and what it says must sound like an engineer, not a reader of
digits.

**A14 — 2026-08-22.** Crossing-free authoring amendment. Added D66 (agent-built
frames are laid out whole; placement into hand-placed frames is column-after-
feeders at the feeders' mean row; labels wrap; crossings are counted per frame
in plans, proposals and the lint, and the instructions forbid leaving them).
Rationale: a reader should never untangle an agent's arrows.

**A13 — 2026-08-22.** Agent authoring amendment — v2 opens. Added S19
(agents create and modify diagrams over MCP, with a person's reach, in the
diagram's own terms and style), struck the v2 deferral in §3, noted the
library-shape funnel as the remaining gap, and added D59–D65 (meaning-first
writes in the house style; polite placement; visible, undoable, reviewable
writes under an orange agent-at-work frame; `edit` as a validated transaction
with `propose` and `validate`; the craft rules and a branch first; library
shapes deferred; scenes through the store and Git left to the person).
Rationale: the ID model was kept for this from M2, every consumer of meaning
is built, and collaboration on one canvas needs exactly two things — the
drawings must look alike, and it must be clear whose turn it is.

**A12 — 2026-08-22.** Narration pacing and derived walkthroughs amendment.
Added D57 (speech gates the camera, not the agent: `narrate` returns at once,
camera commands wait for the voice and can narrate on arrival; amends D55) and
D58 (`script_tour` derives a walkthrough from declared meaning and structure;
MCP prompts publish the workflows; results carry `next` hints). Rationale: the
invariant was always "the picture never leaves mid-sentence", and putting the
wait on the camera keeps it while the model thinks during the voice; a derived
script makes two competent models give the same walkthrough of the same diagram
and costs the author nothing.
