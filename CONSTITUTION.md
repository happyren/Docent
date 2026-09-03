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
| S10 | Intent capture *(added A1)* | **Legend editor** — visual attribute → meaning mappings (e.g. `dashed → async`, `red → hot-path`), stored as data; **element annotations** — tags, **intents** (an ordered list of short declared statements, one per line — an arrow between two systems legitimately carries several), and **logic** (free-form pseudocode or rules for what a component does, on any element including imported composites) on any element, stored in `customData` (fork-free per I1) *(amended A8)*; **frame narratives** — per-frame "what this means" text, the single source of truth for both export and `tour` narration ; *(amended A23)* **scene links** — an element may reference another scene as related reading, stored as meaning and followed with a way back (D95, D96) |
| S11 | Drill-down (tiered diagrams) *(added A2)* | Any element may declare a **detail diagram** — a frame on the same canvas drawing its inner mechanism — via `customData.docent.detail` (fork-free per I1). **Navigation:** in presentation/drill mode, activating a linked element dives the camera into its detail frame with an eased portal tween (zoom toward the element, resolve on the frame); back/breadcrumb climbs one tier; unknown/deleted targets error per I5. **Authoring:** activating an unlinked element offers to create its detail frame (named after the element, placed in free canvas space, linked, then dived into). Depth is unbounded — elements inside detail frames may declare their own details. The mechanism is element-agnostic: any element type (shapes, images, frames themselves; grouped composites via their frame or any member). Drill interactions must not break normal editing — plain click still selects; drill uses presentation mode or a dedicated affordance  *(amended A23)* The drill affordance also follows **scene links**: dive when it is this diagram going deeper, link when it is another diagram's story (D95, D96) |
| S12 | Project portfolio *(added A3)* | One deployment hosts many **projects**; a project holds many **scenes**. A portfolio modal browses projects and their scenes: create a project, open a scene, save the current scene into a project, delete either (confirmed). Scenes address by URL (`?project=<p>&scene=<s>`); Save writes back to the portfolio scene it was opened from; local `.excalidraw` file open/save is unchanged. Storage is a **file tree of plain `.excalidraw` files** behind a zero-dependency same-origin store service (D17, D18); a deployment without the store degrades gracefully — the modal says so and file workflows are unaffected. *(amended A22)* A scene's name is a **path**: slash-separated folders inside the project (D92), browsed as a collapsible tree in the modal, with scenes created into, moved between, and deleted with their folders (D93) |
| S13 | Desktop distribution *(added A4)* | Docent ships as a **Tauri** desktop app for macOS, Windows, and Linux, wrapping the **same built SPA** — no second frontend, no fork (I1). The desktop portfolio is a native store implementing the **same D17 file-tree contract and `/api` route contract** as the self-host store, rooted in the OS app-data directory; contract parity is tested. Samples and bundled libraries ship in the app. The MCP agent endpoint was not part of desktop v1; A7 adds it as S15. Installers build in CI. *(amended A15)* The app **updates itself**: it checks for a newer release nightly and on **Help → Check for Updates…**, installs only on the person's click, verifies the update's signature against a key it carries, and relaunches (D67, D68) *(amended A27)* The app wears the **house chrome**: two themes of one token system (D107) in a **borderless** window (D108) *(amended A28)* Its commands live in the **native menu bar**, the tools dock left and collapse, and a **command palette** reaches everything from the keyboard (D109–D111) |
| S14 | GitHub project sync *(added A5, local-first per A6)* | A portfolio project may **bind to a GitHub repository** (`owner/repo`, path prefix, branch, and an API base URL so GitHub Enterprise instances work). The bound project's directory is a **local working copy**: scenes open and save at disk speed, offline included, as plain `.excalidraw` files (D17). Synchronization is explicit, like code: **pull** fast-forwards the working copy from the active branch and surfaces per-scene **conflicts** when both sides changed — never auto-merged; the author resolves keep-mine or take-remote; **push** lands every local change as **one commit** on the active branch (refused when the remote moved — pull first); branches are created and switched deliberately (switching requires a clean copy), and pull requests open back onto the recorded base (D28). Sync state — per-scene base blob SHA and base content hash, per project — lives under the `.docent/` exception beside the bindings. Auth is a **fine-grained personal access token** — chosen over OAuth device flow because customer-controlled GitHub instances may not host any OAuth app; tokens are held outside the data tree and are write-only through the API (never echoed). Both store implementations honor the same binding contract; unbound projects behave exactly as before. *(amended A22)* The working copy is a **subtree**: scenes at paths sync as files at those paths — pulled recursively, pushed at their place in the tree, conflicts named by path (D94) *(amended A25)* The workflow can be felt and trusted: sync verbs show a busy state and refuse a double-fire (D102), a bound scene reverts to its recorded base with the discarded changes named first (D103), and a binding may **protect its base branch** — the canvas is view-only on the trunk, and the way to edit is a branch (D104) |
| S15 | Desktop agent endpoint *(added A7)* | The desktop app exposes the **same protocol-standard MCP agent surface** as a deployment (S8, D19), **read-only**: the scene document is never modified — camera moves, overlay effects, narration, presentation control, drill navigation, and scene opening are navigation, not writes, and opening a scene is refused while the canvas holds unsaved changes. Transport is **loopback streamable HTTP** on a fixed local port with an ephemeral fallback (D34) — loopback is exempt from MCP clients' HTTPS requirement, which is what made the self-host endpoint need a stdio shim (D24). The page-side dispatcher is the **same shared module** the self-host MCP server runs (D34), so the tool surface cannot drift between the two. **Help → Agent Endpoint…** shows the live URL and a ready-to-paste client configuration. *(amended A8)* The surface is **tier-aware and progressive**: agents are told at `initialize` that diagrams are tiered and read them outline-first, tier by tier; `get_outline` and `find` exist for orientation and for locating the relevant part by keyword; reads return the legend-applied semantic view with the author's intents; and the camera keeps context — a focused component is framed with its neighbourhood and can never fill the view |
| S16 | Visual review *(added A9)* | Changing a diagram produces a review a person can read. A **semantic scene diff** (D46) compares before and after by stable id — components, edges, frames, and the declared meaning on them — and its changelog rides every push's commit message and every pull request body. In the app, a **Review** view (D48) shows each changed frame as before/after crops of the changed area with the changelog, flies the camera to a change with removed elements ghosted on the overlay, and prefills the PR. **The diagram directory and the base branch carry nothing for this by default**: the "before" copies live under `.docent/` at the data root (D47), and the only artifacts that can reach GitHub are opt-in per binding (D49) — before/after crops quarantined on a prunable orphan branch and embedded in the PR body, and semantic sidecars beside the scenes for teams that want meaning as text in the repo |
| S19 | Agent authoring *(added A13 — v2 opens)* | Agents **create and modify diagrams over MCP**, with the same reach a person has at the canvas, in the diagram's own terms: **agents author meaning; Docent draws** (D59). The write surface lives in the Command API (B4) and reaches Excalidraw only through the adapter (B1): `add_node`, `add_edge`, `update`, `remove`, `add_frame`, `add_detail_layer`, `define_kind`, `layout`, and `edit` — a validated, all-or-nothing batch that lays out once, lands as one undo step, and answers with the semantic changelog (D62) — plus `propose` (the batch's dry run) and `validate` (the diagram's lint). Style and shape come from the **legend and the diagram's own conventions**, never from pixels (D59); placement is Docent's and never disturbs hand-placed work uninvited (D60). Every agent write is **visible, undoable, and reviewable**: the canvas wears an orange *agent at work* frame and is view-only for the duration of a batch, the camera shows what changed, the panel offers Undo, and A9's review covers the result (D61). Agents know the craft (D63): kinds and intents on every component, logic for rules, narratives on frames, detail layers for inner mechanism, a branch before the first edit on a bound project. Scenes are created and saved through the store; Git stays the person's (D65). The overlay still never writes (I2) |
| S20 | Pleasing by construction *(added A18)* | Every diagram Docent draws — an agent's batch, and any diagram on request — is laid out to the **aesthetic criteria the research ranks**: fewest edge crossings first, fewest bends, straight and aligned flows, balance, room for every label, and gentle turns (D74, D75). **Tidy** is the formatter: one command (⌥⇧F, the menu, or `tidy({scope})` over MCP) re-lays out a selection, a frame, a tier, or the whole diagram and is **guaranteed to change nothing but the picture** — its semantic changelog (D46) is empty, by test (D73). The lint carries a **craft score** with its parts, so an agent has a loop — draw, validate, tidy — and a number to report (D76). **Colour means something**: tones and role families pick conventional hues, and every new kind is as visually distinct from the legend's others as the palette allows (D77). The engine is Docent's own — pure, deterministic, dependency-free (I3, I7); outside engines are a later plugin contract (noted A18). Hand-placed work still moves only when asked (D60) — Tidy is the asking *(amended A24)* Drawn diagrams are **squared away**: no diagonal edges — an edge is axis-aligned or it turns (D98); everything sits on a grid with a shared rhythm of sizes and gaps (D99); and Layer 1 is arranged whole — frames and the components around them ranked as one picture (D100). The score counts squareness, and Tidy delivers it |
| S21 | Symbols *(added A20)* | Agents **use the bundled icon libraries by name**: a generated, checked-in **catalog** of every library item — id, name, library, category, icon size, aliases (D81); `find_symbol` to look one up (D82); `add_node({symbol})` to place one as **one component** — the icon's own drawing, an invisible carrier on its bounds that arrows bind to and meaning lives on, and the caption under it as its label (D83); symbols in the legend and the exports (D84); symbols laid out and routed like any component (D85). The libraries stay Excalidraw's own files (I1); the catalog is derived from them and never edited by hand except for names and aliases. Libraries a person imports themselves are **noted, not built**: a runtime catalog per project is a later decision |
| S22 | Genres *(added A21)* | Docent knows five **genres** — the diagram categories a developer actually reaches for, each a **profile**: a vocabulary of kinds, frame conventions, a layout posture, its own lint, and the prose an agent is told (D87). The five: **architecture map** (C4-shaped — person / system / service / store, boundary frames, Docent's tiers doing context → container → component natively), **life of a request** (named **scenarios** — ordered edge paths stored as meaning on the map itself, replayed by `flow` and the guided tour, spoken — D89), **event flow** (Event-Modeling-shaped — lane frames per context, command → event → read model, time left to right), **data flow** (sources → transforms → stores → consumers, contracts as edge meaning, cycles flagged), and **lifecycle** (states and guarded transitions, guards as `logic`, terminal states). A scene adopts a genre with `use_genre` (or `create_scene({genre})`): the genre's kinds seed the legend through the existing surface, and the recorded genre turns on its lint and its posture (D87, D88, D90). A genre advises and never refuses (D88). UML class/ERD, Wardley maps, and classic flowcharts are deliberately not genres |
| S23 | Print *(added A26)* | The diagram exports to **paper shapes**: a PDF of the whole diagram — one page per frame in the outline's order, tier 1 first then detail layers along their parentage, each page sized to its frame with the frame's name and narrative as the caption, the legend and any unframed Layer-1 components on the overview page (D105) — and a **properly sized image per frame** rather than one canvas-long strip (D106). Rendering rides the adapter's one export surface (B1); the PDF is written by Docent itself — no new dependency carries it (I7) |
| S24 | Proposals *(added A38)* | A design change is **drawn against the current truth and argued on the drawing**. The shadow is never a new object: a proposal is a **branch** of the scene (S14) or a linked sibling scene (D95) — Git doing its job (D133). A **compare lens** overlays the live canvas against a reference — the base copy the store already keeps (D103), the saved copy, or any named scene: removed elements ghosted at their old places, additions and changes tinted, counts and craft-score delta announced — an overlay through and through, writing nothing (I2, D134). The proposal's **case is meaning**: wins and costs recorded beside the legend like the genre and the scenarios are, exported with everything else, spoken when presented (D135). Merging the branch is accepting the decision; the record is already in the diagram |
| S25 | Local-repo projects *(added A47)* | A project can **live with its code**: the person links a portfolio project to a directory on their own disk — a repo they run with their own git, their own CLI workflow — and Docent reads and saves that project's scenes there as plain `.excalidraw` files, nested per D92's paths. The link is the PORTFOLIO'S memory, never the repo's: no metadata lands in the repo, no sync verbs exist there, and Docent never runs git — committing the diagrams is the person's own workflow (the posture D65 promised, completed). Unlinking forgets the link and touches nothing |
| S26 | Plugins that hold the pen *(added A49; desktop)* | A plugin may do more than provide: it may **control the diagram, wear a face, and mark the drawing**. Control is the agent's own door — a plugin declaring `control/1` is handed the desktop MCP endpoint and holds exactly the agent surface, gated exactly as an agent is (D149). A plugin may declare a **panel** — a loopback URL Docent opens as a native window beside the canvas: a notebook, a console, a dashboard (D151). A plugin may **mark** components with status — ok, fail, warn, note — as glyph chips on the overlay, namespaced by author, never written into the scene (D150). And the **registry** knows which claims are exclusive — one voice, one author per mark namespace — and refuses a second claimant at enable time, naming the holder (D152). Everything the plugin does with AWS, Jupyter, or any other world is its own process's business: Docent owes it the pen, the face, the grammar, and the referee |
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
- ~~**Library-shape authoring by agents** — inserting the bundled icon libraries' items by name
  needs a library-import funnel (named, id'd, lookup-able items) that does not exist yet; until it
  does, agents author with the primitive shapes the legend maps *(noted A13)*~~
  *(A20 built the funnel for the bundled libraries: S21, D81–D85. Libraries a person imports
  themselves — a runtime catalog per project through the store — and library containers as
  frames remain noted, not built.)*
- **Layout engines as dependencies** — Graphviz/WASM, ELK, dagre, Cytoscape are not taken on as runtime dependencies (I7); the layered pipeline is Docent's own (D74). A `layout/1` **plugin contract** (an out-of-process engine given a graph, answering positions) is the intended door for Graphviz or ELK on the desktop, a later decision. ~~Frame-level arrangement of Layer 1~~ *(A24 built it: D100)* and a BeauVis-style rating harness — the latter is likewise **noted, not built** *(noted A18)*
- **UML class/ERD, Wardley maps, classic flowcharts** — not genres (S22): data modeling belongs to a data modeler's tool, strategy maps are not debugging, and the decision shapes plus `logic` already cover flowcharts *(noted A21)*
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
| D67 *(A15, 2026-08-23)* | **Signed updates from the release, installed by the app.** The desktop uses Tauri's updater: the train signs every update artifact with a minisign key held as a repository secret and publishes `latest.json` with the release, the app carries the public key and reads the manifest at the release's evergreen URL, and an update is downloaded, **verified against that key**, installed over the running bundle, and relaunched — all in the shell, nothing in the page. The private key and its password live outside the repository (the maintainer's machine and the secret store); losing them means no existing install can update again and a fresh install is the only path, so they are backed up like a credential | A person should never have to leave the app to stay current, and on macOS an unsigned download from a browser cannot even be opened — an update the app fetches itself carries no quarantine, which makes this the *easier* path for the people the Gatekeeper note is about. Signing is what makes "the app installs what it downloaded" safe: a release asset the key did not sign is refused, whoever put it there |
| D68 *(A15, 2026-08-23)* | **Check automatically, install only on consent.** The app asks for a newer release once a day — at start-up, and every twenty-four hours while it runs — and says nothing unless there is one, which it announces once per release; **Help → Check for Updates…** always answers, including "you are current" and "that did not work". The announcement offers **Install and relaunch** or **Later**; nothing downloads until *Install* is pressed, the window says what it is doing while it downloads, and a failure says why. Unsaved work is never lost: the relaunch is refused while the canvas is dirty, with the reason | An update that installs itself mid-sentence is a surprise; one that nags every morning is a noise. Once a day and once per release is the cadence of a colleague mentioning something; pressing *Install* is the person's decision, and protecting a dirty canvas is the same rule open_scene already keeps |
| D69 *(A16, 2026-08-23)* | **The legend is drawn, not listed.** Each legend rule is shown on the canvas as the thing it describes with its meaning beside it: a rule about fill or shape as a small sample shape in that style, a rule about stroke alone as a short arrow in that style, labelled `kind: datastore`, `channel: async`, `tag: hot-path`. The samples and labels are locked, grouped with the title, and marked `legendSample` in `customData`, so the graph, the exports, the tours, the review, and the lint never see them as components or edges — the rules still live as data on the one carrier (D9), and the drawing is derived from them whenever the legend changes, by the editor or by `define_kind`. **Placement never covers the legend**: its area counts as occupied for every agent write, and new frames go below it | A legend that reads "backgroundColor #a5d8ff + shape ellipse → kind: datastore" asks the reader to compile it; a blue ellipse beside the word *datastore* is the legend. Drawing it from the rules keeps one source of truth, and marking the samples keeps every consumer of meaning honest about what is a component. An agent that paints over the key to the diagram has destroyed the diagram |
| D70 *(A17, 2026-08-23)* | **An edge is as long as its words.** The distance between two columns of a laid-out frame, and the gap a new component keeps from the feeders it lands after, is at least the width of the widest edge label that has to sit in it — the label wrapped at the edge font, with a margin. The straight-line crossing count and the frame's size follow from that. An edge label is still a phrase, not a sentence; the sentence is the edge's intent | A label on an arrow sixty pixels long is printed over the shapes at both ends, which the reader then cannot read. The only honest fix is to give the arrow the room the words take — an agent cannot, because it does not draw; Docent can, because it does |
| D71 *(A17, 2026-08-23)* | **Long flows turn.** A laid-out frame with more than five ranks is folded into bands of columns: the first band runs left to right, the next right to left beneath it, and so on — a sequence still reads as a sequence, but the frame stays close to the page's shape instead of one long line. The number of columns per band is the smallest that keeps the bands balanced (`⌈√(2·ranks)⌉`); the band gap leaves room for the turning edge's label. The MCP instructions say this is how Docent lays out, so a model plans a frame as a flow and never as a row | A ten-step pipeline drawn as ten columns is a scroll, not a diagram; a reader can hold a picture, not a ribbon. Folding belongs to the layout, not to the model — the model has no pixels to fold with |
| D72 *(A17, 2026-08-23)* | **An edge never cuts through a component.** Every agent-drawn edge is checked against every component that is not one of its ends, and the legend; when the straight line between its ends would pass through one, the edge is routed around — an orthogonal path found on the grid the components' padded edges define, fewest bends first, shortest second — and drawn with the house arrow's curvature through those turning points. Edges of a frame are re-routed whenever its layout changes. The lint reports an edge that passes through a component, with what it passes through | An arrow drawn through a box says the box is on the path; a reader believes the drawing before the words. A router is the one thing the model cannot be asked to be, since it is the one thing the model cannot see. The legend is a component for this purpose: nothing is drawn over the key to the diagram |
| D73 *(A18, 2026-08-23; amended A19)* | **Tidy is a formatter.** `tidy({scope})` — a selection, a frame, a tier, or the diagram — re-lays out what it names under D74 and D75, **re-routes every bound edge in the scope** (D78) whether or not its ends moved *(A19)*, and lands as one undo step under the agent frame, from the menu, from ⌥⇧F, or over MCP. It **never changes meaning**: components, edges, frames, labels, kinds, intents, logic, narratives, and the legend are exactly what they were, so the semantic changelog (D46) of a tidy is empty — a property the test suite asserts on every fixture. It moves hand-placed work only because it was asked to (D60 stands); an agent that built a frame gets the same layout without asking (D66) | *Format Document* is trusted because it is known to change nothing but whitespace; a diagram formatter earns the same trust the same way, and Docent already owns the instrument that proves it. A keystroke that cannot lie about what it did can be pressed without thinking |
| D74 *(A18, 2026-08-23)* | **The layered pipeline, whole.** Layout is the Sugiyama pipeline done properly, in Docent's own code: rank by flow (longest path, balanced toward the middle); order within ranks by **repeated median sweeps down and up with a transpose pass** until no sweep improves the crossing count; assign coordinates by **Brandes–Köpf** so that an edge between adjacent ranks is straight where it can be, a node sits on the median of what it joins, and each rank is centred on the diagram's axis; give same-rank nodes one height and same-kind nodes one size. D70's label gaps and D71's folding apply after. Ties break by position then id, so two runs of the same diagram give one picture (I3). No force-directed layout, ever, for a flow | Crossings are what the evidence says hurts most, and one barycenter pass leaves crossings a second sweep removes; alignment and centring are what make a drawing look *intended* — straight flows, parents over their children, balance — and they are a coordinate assignment away once the order is right. Owning the pipeline is what lets it know about frames, tiers, labels, the legend, and the house style; an engine that does not cannot be told |
| D75 *(A18, 2026-08-23)* | **Edges that flow.** Every edge leaves and enters a component at a **port spread along the side** it uses — edges sharing a side are spaced by their order across the other end, never all at the centre; routed segments that would run together are **nudged apart** by a fixed gap; and every right-angle turn is **softened** into an arc of a fixed radius by two points either side of the corner, so the house arrow's curvature draws a bend, not a cusp. D72's routing — around everything, fewest bends first — stands beneath this | The eye follows a line by continuity; a cusp ends one line and starts another, and two lines on top of each other are one line to the eye. Angular resolution and nudging are the difference between an arrow the reader can trace and a knot |
| D76 *(A18, 2026-08-23)* | **The craft score.** The lint computes, per frame and for the diagram: crossings, bends per edge, the share of non-axis-aligned segments, edge-length spread, the smallest angle between edges at a port, component and label overlaps, and the legend's least colour distance; it reports a **0–100 score with its parts**, weighted as the evidence ranks them (crossings first, bends next, alignment and balance after, angles last). The score is a number, never a verdict: `validate` says which part costs most and what would raise it (tidy, a detail layer, a kind's colour). A fixture set scores in the test suite and a drop fails the build | Pleasing is not computable; its proxies are, and they are validated. A number an agent can read closes the loop — draw, validate, tidy — and a number the test suite watches keeps the pipeline from regressing quietly |
| D77 *(A18, 2026-08-23)* | **Colour means something.** `define_kind` and tags may carry a **tone** — `positive`, `neutral`, `caution`, `danger`, `inactive` — and a **role** family — storage, compute, messaging, external, people, boundary — which pick the conventional hue (green, blue‑grey, amber, red, grey‑and‑dashed; blues for storage, warm for compute, purples for messaging, greys for external). Without either, a new kind takes the colour from a **colour‑blind‑safe base set that maximises its least CIELAB distance** from every kind already in the legend; past six kinds a **second channel** — stroke style, then shape — is added automatically, because hue alone no longer separates. Tags with conventional names (`hot-path`, `deprecated`, `critical`, `draft`) default to their tone. The legend states what was chosen and why, as it does for every derived look (D59) | Meanings that differ should look different, and colours already carry meaning a reader brings with them; a palette in definition order spends both. Distance is measurable, and the second channel is Bertin's answer to a palette that runs out |
| D78 *(A19, 2026-08-24)* | **A routed edge reads as one stroke.** Amends D75. When an edge's straight line is clear it stays straight, from the ports D75 spreads. When it is blocked, the **sides it leaves and enters are chosen by route cost** over every pair of sides — a back edge along a row goes over or under it as a U, never out of the side that faces its target and straight back down — and the ports on the chosen sides are then spread as before. The route is **simplified before it is drawn**: a jog shorter than a corner is collapsed, no leg is shorter than the corner radius, and a hairpin — two turns that double back within a corner's length — is removed; each simplification is refused when it would put the edge through a component or the legend (D72 outranks the stroke). **Docent draws the arcs itself**: a routed edge is a sharp polyline carrying explicit points along a circular arc at every turn (radius the corner radius, or half the shorter leg), so what is drawn is exactly the route; Excalidraw's own curvature is kept only for edges with no turning points. The lint reports an edge whose legs are shorter than a corner or that doubles back on itself | A turn the route did not need, a knot of points at a corner, and a curve that overshoots its corner all say the same thing to a reader: this line was not drawn on purpose. The turns that remain are the obstacles' doing, and an arc of one radius at each of them is how a hand draws a line around things |
| D79 *(A19, 2026-08-24)* | **A cycle is ranked by the order it was authored.** Before ranking, edges are walked depth-first in the order the components were created — position order for components already on the canvas — and an edge that closes a cycle is a **back edge**: it takes no part in ranking, and it is routed over or under the row (D78). Components keep the order the flow was written in; a `c → a` after `a → b → c` is the return, not a reason to put `a` last. Amends D74, whose ranking recognised only a two-cycle | A flow with a return is the commonest diagram there is, and a ranking that lets the return decide the order draws the flow backwards. The author wrote the components in the order they happen; that order is the one fact about the cycle the layout can trust |
| D80 *(A19, 2026-08-24)* | **A kind's shared size is its typical label's.** Amends D74: same-kind components share the width their typical label needs — the median of their natural widths, never less than the widest single word among them — and a label longer than that **wraps taller** rather than widening every sibling; the rank's height is still the tallest member's. | One long label should cost its own component a line, not cost every component of its kind half a screen |
| D81 *(A20, 2026-08-24)* | **The symbol catalog is generated and checked in.** A script reads the bundled `.excalidrawlib` files and writes `public/libraries/catalog.json`: for every item a `symbol` id (library slug + name slug, e.g. `aws/lambda`), its `name`, `library`, a `category` read off the icon's brand fill where the library has one, the icon's size without its caption, the caption, and `aliases`. A hand-kept `aliases.json` supplies names for items that have none and the synonyms a model reaches for (`function`, `serverless` → Lambda; `queue` → SQS). A test asserts the catalog matches the files, so it cannot drift. The model sees names and sizes, never an item's geometry | 249 named icons are a vocabulary, not a drawing; a vocabulary is what a model can search. Generating the catalog keeps one source of truth — the library file — and checking it in keeps the lookup deterministic and free of any runtime parse |
| D82 *(A20, 2026-08-24)* | **`find_symbol` finds one.** `find_symbol({query, library?, limit?})` answers ranked matches, deterministically: exact name, then alias, then a token prefix, then a bounded fuzzy match — each with id, name, library, category, and size. The instructions and the `draw` prompt say: when a component is a named product or service, look its symbol up first and pass it to `add_node`; never draw a product as a plain box when its symbol exists | A reader who sees the Lambda icon knows what it is before reading; a box that says "Lambda" asks them to read. The lookup is the one thing the model cannot do from the catalog alone without being shown all of it |
| D83 *(A20, 2026-08-24)* | **A symbol is a component.** `add_node({symbol, label, kind?, intents…})` places the item's icon elements with fresh ids as one group, and adds two things: a **carrier** — an invisible rectangle exactly on the icon's bounds, in the group, declared composite (D22) and carrying the component's meaning and its stable id — and the **label**: the item's caption, retyped to the agent's label in the house label font, under the icon where the library puts it, wrapped to the icon's width. **Arrows bind to the carrier**, so they meet the icon's border, take ports along its sides, and follow the icon when it is dragged. The icon keeps its brand drawing; the house style dresses the label only. The component's box, for placement and routing, is icon ∪ label | D22 already reads a placed icon as one component; a carrier gives that component an edge for arrows to meet and a place for its meaning to live, without drawing anything a reader can see. Binding to the icon's bounds is what a reader perceives as its border; a silhouette would cost every icon a hand-drawn outline for no visible gain |
| D84 *(A20, 2026-08-24)* | **Symbols in the legend and the exports.** A legend rule may match on a new attribute, `symbol` (`define_kind({kind, symbol})` writes one); the drawn legend (D69) shows the icon scaled to a sample row beside its meaning; a symbol component's kind resolves through that rule, and the exports carry `symbol` with declared provenance. The craft score's colour part ignores symbol kinds: the brand's colour is not Docent's to judge | The legend is where a diagram says what its pictures mean; an icon is a picture |
| D85 *(A20, 2026-08-24)* | **Symbols lay out like anything else.** A symbol component takes the catalog's native size (the icon plus its caption) and shares it with every component of the same symbol, so uniform sizing is automatic; ranks, ports, routing, tidy, the score, and the lint treat it as any component through its carrier's box | One layout for everything is the whole point of owning the pipeline |
| D86 *(2026-08-25)* | **Frames keep their distance.** No write leaves two frames overlapping, or a frame over the legend: after every plan that creates, grows, or moves a frame — an agent's batch, a tidy, a re-layout — the frames of each tier are checked pairwise and any overlap is resolved by moving the frame that comes later in the declared order, by the smaller of the two pushes that would clear it, members and labels carried along and the edges that touch them re-routed (D72). The legend is immovable; the person's relative arrangement — what is left of what, what is above what — is preserved, only the gap is made real | A frame is a boundary; two boundaries drawn through each other say nothing. Growth is Docent's doing — a frame grows because a write put something in it — so keeping the neighbours clear is Docent's debt, not the person's chore |
| D87 *(A21, 2026-08-25)* | **A genre is a profile, recorded with the legend.** `src/authoring/genre.ts` defines each genre as data — its kinds (name, tone or role, shape or symbol), its frame conventions, its layout posture, its lint rules, and its guidance prose. `use_genre` (an op in the edit batch and a tool) records the genre on the legend carrier (`docent.genre`), seeds the kinds the legend does not already define through the D59 path, and answers with the genre's guidance; `create_scene({genre})` does the same at birth. Everything downstream — lint, layout, instructions — reads the recorded genre. No mode, no second store | A category of diagram is a set of conventions, and Docent already has one home for conventions: the legend. Writing the genre beside it makes the choice data — visible, exported, diffable — instead of behaviour |
| D88 *(A21, 2026-08-25)* | **Genre grammar is lint, not law.** Each genre contributes findings to `validate` and the lint, named for the genre: the architecture map flags a component with no kind; event flow flags an event no command causes, a read model no event feeds, and time flowing backwards across lanes; data flow flags a cycle and an edge with no declared contract; lifecycle flags an unreachable state and a machine with no terminal. Findings advise — an edit that breaks the grammar still lands (D60: the author may mean it) — and the craft score is untouched: grammar is meaning, not looks | A profile that refuses would make agents fight their tools; one that advises makes the diagram's own vocabulary do the teaching. A rule the author can overrule on purpose is the difference between a genre and a cage |
| D89 *(A21, 2026-08-25)* | **Scenarios are meaning.** A **scenario** is a named, ordered path of edges — `define_scenario({name, path, description?})`, an op and a tool — stored beside the legend on the carrier by stable id (I6). Scenarios ride every read: the outline and both exports list each scenario's steps in the author's words, `find` matches their names and descriptions, and removing an edge a scenario steps through is flagged (I5). Replay is the machinery that exists: `flow` pulses the path, the guided tour walks it and speaks it, and numbered step badges appear on the **overlay during replay only** (I2) — the diagram itself stays clean, so one map carries as many scenarios as it has stories | The trace-shaped view developers debug with is a path through the architecture they already drew, not a second diagram to keep in sync. Sequence diagrams become unnecessary rather than unsupported |
| D90 *(A21, 2026-08-25)* | **Layout takes a posture per genre.** The layered pipeline (D74) gains postures a genre chooses: **lanes** — frames as rows, rank as columns, so event flow reads command → event → read model left to right with each context keeping its lane; **straight** — no serpentine folding, for data flow, whose time axis must not turn back on itself; and the default serpentine map for architecture, request, and lifecycle. A posture is an option on the same deterministic pipeline — same ranking, same crossing sweeps, same routing — never a second engine (I3, I7) | Time-shaped genres die when the layout folds time; maps thrive on it (D71). The difference is one option, not one engine |
| D91 *(A21, 2026-08-25)* | **Agents are told the genres.** The MCP instructions name the five genres, when each fits, and the loop — `use_genre`, draw with the seeded kinds, `validate`, `tidy` — while each genre's full guidance answers from `use_genre`, so the menu stays short and the recipe arrives when ordered. The site shows the genres, each with a drawn example | A category an agent is not told about does not exist; one it must load wholesale on every call is a tax |
| D92 *(A22, 2026-08-25)* | **A scene's name is a path; directories are implied.** A scene addresses as `folder/subfolder/name` — one to eight segments, each obeying the store's one name rule, `.docent` reserved at every level — and the store lays it out as nested directories: `<data>/<project>/<path>.excalidraw`. PUT creates the parents; DELETE prunes directories left empty (never the project). **A directory exists because scenes live in it** — Git's own model, and Git cannot keep an empty directory anyway, so the store never pretends to. The routes do not change: the scene segment of every URL carries the path URL-encoded, `?scene=` and every tool that takes a scene name take the path, listings answer relative paths sorted folders-first, and a flat scene is simply a path of one segment — nothing migrates. Both stores, parity-tested | The repo the project binds to is a tree; pretending the project is flat makes Docent the odd one out. One rule per segment keeps traversal impossible the same way one rule per name always has |
| D93 *(A22, 2026-08-25)* | **The portfolio browses the tree.** The modal shows a project's scenes as a collapsible folder tree; a scene is created into a folder (or by typing a path), **moved** to another folder as one action (the contract is PUT at the new path, DELETE at the old — on a bound project the next push shows it as Git shows any move), and a folder is deleted with the scenes in it, confirmed with their count. A new folder is staging until its first scene lands — the UI says so rather than pretending an empty folder persists | The tree is the user's mental model of their own repo; the modal should show them the same shape their teammates see on GitHub |
| D94 *(A22, 2026-08-25)* | **Sync covers the subtree.** Pull enumerates the bound prefix **recursively** (the Git trees API, filtered to the prefix, cached like the flat listing was); sync state and base copies key by path — `.docent/sync/<project>/base/<path>.excalidraw`, nested; push writes each scene at its path in the tree and removals prune there too; conflicts and changelogs name the path. The depth and segment rules are byte-identical on both stores and the parity suite proves nested create, list, get, move, delete, and a sync round trip | The subtree was always the contract with the repo — the flat listing was the store's shortcut, not the store's promise |
| D95 *(A23, 2026-08-26)* | **A link is meaning, not a URL.** Any element may declare a **scene link** — `customData.docent.link = { scene, project?, at? }`: `scene` a D92 path, `project` defaulting to the scene's own, `at` the stable id (I6) of a component in the target to arrive focused on. The snapshot parses it, the graph carries it on nodes, edges, and frames, and it is **declared** meaning everywhere meaning goes: both exports (the Mermaid emitter writes its native `click` directive; the sidecar the object, provenance on it), the semantic diff (D46 — "link → payments/events added"), and `find`. The rule, stated in the instructions: **dive when it is this diagram going deeper (S11); link when it is another diagram's story** | The same subject is drawn in several genres now (S22) and several folders (S12); the connection between those drawings is authored knowledge, and a raw URL would rot on every move and mean nothing to the exports |
| D96 *(A23, 2026-08-26)* | **Following a link is a jump with a way back.** Activating a scene-linked element (the drill affordance, presentation, or the panel) opens the target scene under the same guard `open_scene` keeps — never over unsaved changes — and arrives focused on `at` when it names a component the target still holds (gone or absent: arrive at the overview, with a note, not a refusal). The **trail crosses scenes**: the jump records where it left — project, scene, element — the breadcrumb offers the way back, and back reopens the source and focuses the element that jumped. Linked elements wear a **link marker** through the detail badges' machinery — "goes elsewhere" visible the way "goes deeper" is, under the same markers toggle, overlay-only (I2) | A jump without a trail is being lost in someone else's diagram; a link nobody can see is a link nobody follows |
| D97 *(A23, 2026-08-26)* | **Links are authored and kept honest.** People: the annotation panel links the selected element to a scene picked from the portfolio's tree or a typed path. Agents: `add_node({link})` and `update({link})`, the path shape checked at plan by D92's one rule, cleared with null. **`validate` checks the target exists** where the store is reachable: a link to a scene the store does not hold is a warning naming the path — so a move that strands inbound links is caught the next time anyone validates, and the move itself still rewrites no other scene's file (D92's honesty). Rewriting inbound links on move — a project-wide scan — is noted, not built | The lint is where Docent says what a diagram gets wrong; a stale link is exactly that, and catching it at validate costs one listing instead of a write fanning out across files |
| D98 *(A24, 2026-08-26)* | **An edge is axis-aligned or it turns.** The router's clear-line fast path stands only when the drawn line is horizontal or vertical within a snap tolerance — and then it is snapped true, by the ports when ports spread it. Every other pair routes through the orthogonal grid (D72, D78): elbows, softened corners, simplification, all unchanged. A blocked line always routed; now an oblique one does too | The reader's eye tracks rectilinear paths and bundles parallel runs; a field of mixed angles reads as string. Every hand-made diagram the craft admires is orthogonal — the machine's excuse for diagonals was only that they were cheap |
| D99 *(A24, 2026-08-26)* | **Everything sits on the grid.** `GRID = 8`: every box the layout answers — positions, sizes, column edges, row tops — lands on multiples, kind-shared sizes round up to it, and the standard gaps are multiples of it (label-driven minimums round up, never down). The score's angles part becomes **squareness**: an oblique drawn segment and an off-grid box cost, so the number notices what the eye does. Tidy (D73) therefore leaves every diagram grid-true — the formatter's output is the rhythm | Neatness the eye reads as intention is mostly a shared rhythm of edges and gaps; a grid is the cheapest machine that produces it, and deterministic (I3) besides |
| D100 *(A24, 2026-08-26)* | **Layer 1 is arranged whole.** When a batch or a tidy lays out the top tier, the tier-1 frames and the unframed components are ranked as ONE layered picture: each frame a box (its drawn size), cross-boundary edges projected onto it, sources taking the columns before what they feed and sinks the columns after — the same pipeline, then members carried with their frames (D86's machinery) and every touched edge re-routed. Hand-placed arrangements still move only when asked (D60) — a batch that touches one frame arranges only what it touched; Tidy of the whole diagram is the asking | The picture the A18 pipeline never composed was the outermost one: externals in a row in the sky, diagonals raining on the frame below. Arranging the tier as one graph is the same algorithm one level up |
| D101 *(A24a, 2026-08-26)* | **Tidy hugs the frame.** When a `layout` lays out a frame's members — which every tidy scope compiles to — the frame's border comes back at the members' bounding box plus the standard room: the head for the name, the pad around, grid-true (D99) — **shrinking** what writes had only ever grown. Outside the asking, nothing changes: a batch that adds into a frame still only grows it (D60), and an empty frame keeps its drawn size — a person's empty frame is a plan, not a mistake | The room a person left in a frame was theirs until they asked for the formatter; after a tidy, leftover acreage is just the picture lying about how much it holds |
| D102 *(A25, 2026-08-27)* | **Sync shows its work.** Pull, push, branch creation and switching, and opening a pull request each show a busy state in the portfolio — the verb, a spinner, the controls disabled until the answer — and a verb in flight cannot be fired again. Failures land as the message the store answered, beside the control that asked | Seconds of silence teach people to click twice, and clicking twice teaches sync races. A workflow is trusted when it visibly works |
| D103 *(A25, 2026-08-27)* | **A bound scene reverts to its base.** The base copy D47 already keeps is one confirmed action away: revert takes the scene back to the branch's last synced state, and the confirm names what would be thrown away — the semantic changelog of working copy against base (D46), not a file hash. The working copy file is replaced, the open canvas reloads if it is the scene reverted, and nothing touches the remote | The 'before' was always there; a person under pressure should not have to find it with git. What is discarded must be said in the diagram's own terms, because that is the moment of regret |
| D104 *(A25, 2026-08-27)* | **The trunk can be locked.** A binding may protect its base branch (a toggle in the binding editor, ON for newly created bindings): while the active branch is the base, the canvas is **view-only** — the same one mechanism agent-at-work uses — with the way forward beside it: create a branch. Agents are told the same truth: `get_view` answers `canEdit: false` with the reason, and `edit` refuses with `create_branch` as the way forward (D63 already asks for this politely; the lock makes it the rule where the person turned it on) | The discipline S14 recommends — branches deliberately, trunk by pull request — was advice the canvas itself would let you break in a distracted moment. A lock a person sets is not ceremony; it is the trunk's owner speaking |
| D105 *(A26, 2026-08-27)* | **The PDF is one page per frame, written by hand.** Export PDF walks the outline: page one is the overview — legend, unframed Layer-1 components, the tier-1 frames' places — then one page per frame, tiers in order, parents before their details; each page takes its frame's aspect with a margin, capped to a sane raster scale, captioned with the frame's name and its narrative. The file itself is Docent's: a minimal PDF writer — objects, one JPEG image stream per page (DCTDecode), a text caption — no library (I7). Rendering goes through the adapter's export surface, the same one the review's crops use (B1) | A tiered diagram is a document already — the outline is its table of contents. And a PDF of embedded JPEGs is a small, honest format an afternoon can own, where a dependency would own us |
| D106 *(A26, 2026-08-27)* | **An image export is sized to what it shows.** A frame exports as an image at its own aspect and a raster scale chosen for legibility (text ≥ a readable pixel size, capped so a huge frame does not produce a huge file) — never the whole canvas in one strip. The whole-diagram image remains what Excalidraw offers; the sized exports are Docent's addition beside it, not a replacement | The canvas is an address space, not a layout for paper; exporting it whole was always a screenshot of a filing cabinet |
| D107 *(A27, 2026-08-28)* | **The chrome wears the house.** Docent's own chrome — portfolio, panels, toolbars, dialogs, banners — draws from one token system with two themes that follow the canvas's own light/dark: dark is **Atelier** (umber grounds `#1c1a18`/`#26231f`, bone text `#efeae2`, bronze accent `#c08a3e`, clay `#d97a58` for destructive), light is **Porcelain** (porcelain grounds `#faf8f4`/`#f4f1ea`, ink text `#26231e`, sienna accent `#9a6b1f`, `#b5563a` destructive). One type ramp — Newsreader for titles, Spline Sans for body, letterspaced caps for metadata — with both faces **bundled as static assets** (D23's precedent; I7 untouched). Radii 3–6, one hairline border weight per theme, depth from one shadow, hit targets ≥ 44px. Excalidraw's surfaces are tuned only through the styling hooks it exposes (I1) | Premium is restraint made consistent: one accent spent sparingly, one border, one shadow, a real type ramp. Two named palettes make it enforceable instead of tasteful-by-accident |
| D108 *(A27, 2026-08-28)* | **The window is borderless.** On macOS the title bar is an overlay — the canvas paints to the window's edge and the traffic lights float over it, with the chrome's floating islands keeping clear of them. Windows and Linux keep their native frames: a custom frame there buys sameness at the cost of every windowing convention. No drawn top border anywhere — the paper is the edge | The drawing is the app; a title bar is furniture between the person and the paper |
| D109 *(A28, 2026-08-29)* | **The menu moves into the menu bar.** On desktop the app's commands live in the native menu bar — File (open, save, save as, the three exports), Diagram (present, tidy, arrange tiers, legend, detail markers), Project (portfolio, agent bridge, plugins) — built with the shell's menu API and dispatching into the SAME handlers the in-canvas menu uses: one command path (B4). The in-canvas hamburger is hidden on desktop by one display rule on upstream's stable trigger hook — the narrowest touch D107's discipline admits, commented as such — and remains the whole menu on the web, where there is no bar to move into | A native bar is what a desktop app owes its platform; a hamburger inside the drawing is web furniture worn indoors |
| D110 *(A28, 2026-08-29)* | **The tools dock left and collapse.** The drawing toolbar stands vertically on the left edge — a styling reflow of upstream's toolbar container through its stable classes, deliberately SMALL and commented as upstream-version-sensitive: if the classes move in an upgrade, the toolbar falls back to upstream's own layout and nothing breaks. A Docent-owned chip collapses it to nothing and brings it back (root class, remembered per machine); collapsed, the paper is the whole window | The canvas is the point and the tools are visitors; a left rail is where every drawing tool the craft respects keeps them, and a collapse is the room's best furniture |
| D111 *(A28, 2026-08-29)* | **A command palette.** Cmd+K (Ctrl+K elsewhere) opens a Docent-owned palette over the canvas: every command the menus carry (with their shortcuts shown), and the portfolio's scenes by PATH — fuzzy-matched, Enter opening under the same guards open_scene keeps (D96's words on unsaved changes). It runs the same handlers as the menu and the bar (B4, one path), closes on Esc, and never traps the canvas's own keys | The keyboard is the fastest pointer, and scene paths (D92) made every diagram addressable by typing — the palette is where that address gets used |
| D112 *(A29, 2026-08-28)* | **The top edge is a handle, and shows itself.** The borderless window's drag strip (D108) works and speaks: the shell grants the one window permission dragging needs — `core:window:allow-start-dragging`, the capability set having been empty, so the region never dragged — and hovering the top edge fades in a soft band in the house's surface tone that names the grab area, fading out when the pointer leaves. The interactive strip keeps the 14px that overlaps no island; the band is presentation only, pointer-transparent, and grants nothing else | A window you cannot move is a bug wearing minimalism's clothes; the fix is one permission, and one hover that says "here" |
| D113 *(A29, 2026-08-28)* | **The last raw surfaces wear the house, and the help button retires.** Upstream's surface family — `--color-surface-low/mid/high/lowest`, `--color-on-surface`, what the zoom pill, undo/redo and the remaining footer buttons are made of — is mapped to house tones in both themes through the variables upstream publishes (I1, D107's discipline). The floating "?" button is hidden by one display rule on its stable class — D109's narrowest-touch precedent, degrading to upstream if the class moves — and help keeps its "?" key | D107 dressed the islands and left the footer in lavender; a retheme that stops at the waterline reads as an accident. And a permanent button for a dialog a chord opens is furniture the paper pays for |
| D114 *(A29, 2026-08-28)* | **The collapse is a command, not a chip** *(amends D110)*. The pencil chip is retired. Toggling the rail is a command like any other (B4): "Toggle the Tools" in the native Diagram menu on Cmd+\ (Ctrl+\ elsewhere), the same chord bound on the web, and the palette row it already had. Collapse stays remembered per machine. While collapsed, a slim handle hugs the left edge — hairline, warming on hover — as the mouse's way back; while the tools are out, no extra chrome exists at all | A chip that stands guard over the tools all day is chrome minding chrome; a command costs nothing until asked for, and the handle exists only while there is something to bring back |
| D115 *(A30, 2026-08-28)* | **Settings, on the settings chord.** Cmd+, (Ctrl+, elsewhere) opens a Docent-owned Settings dialog in the house grammar, consolidating the person's switches in one place: the canvas theme (through a typed `setTheme` on the adapter handle — B1, the same door `setViewMode` uses), detail markers, agent-can-edit, and the agent's address — the desktop shows its own MCP endpoint read-only, the web offers the bridge connect. It reaches through the app menu on macOS, File elsewhere, the hamburger on the web, and the palette; every switch runs the same handler its menu twin runs (B4) | Switches scattered across three menus are settings only an author can find; one dialog on the one chord every desktop reserves for it is where a person expects themselves |
| D116 *(A30, 2026-08-28)* | **The PDF crosses the desktop's file channel.** `/desktop/export` learns bytes: a body may say `encoding: "base64"` and the shell decodes (a small house decoder, the D105 posture — no new dependency) and writes bytes behind the same native dialog. Export PDF… joins the native File menu and stands available everywhere, closing the note D109 left | An export that exists on the web and not in the app reads as a bug, and base64 over loopback JSON is the smallest honest bridge from a text channel to a binary file |
| D117 *(A30, 2026-08-28)* | **The band stands** *(amends D112's presentation)*. The top bar is not a hover reveal: it is a standing gradient — the house surface at the window's very edge fading to nothing over the title bar's height, always there, taking no pointer, drawing no line (D108's no-drawn-border kept). The drag strip beneath it is unchanged | The maintainer asked for fading, not appearing: a wash that is always quietly present names the grab area without a single hard edge |
| D118 *(A30, 2026-08-28)* | **The desktop drops "Connect Agent Bridge".** The shell's own MCP pipe connects itself at launch and simply waits (D34) — a menu verb for it was ceremony, and it goes. The web keeps the manual verbs it needs (S8: auto-attempts would error-log on every launch without a server): the hamburger item, the palette row, and Settings' connect | A button that asks the person to do what the app already did teaches them the wrong model of their own tool |
| D119 *(A31, 2026-08-28)* | **The house has its own glyphs.** A bundled `docent-house` library of about twenty minimal, monochrome glyphs — the generic vocabulary of systems drawing: user, service, database, queue, topic, cache, storage, function, gateway, load balancer, scheduler, event, stream, lock, cloud, terminal, metrics, browser, mobile, server, document, external — pure ink line work in the canvas's own hand (one stroke weight, transparent grounds, no lettering), drawn by a deterministic generator script committed beside the file (D81's posture: generated, checked in, `--check` in the tests). Catalog ids are `docent/<name>`; the items ride the same catalog, the same `find_symbol`, the same placement (D83) as every other library | The premium register the chrome reached (D107) stops at the canvas edge if the only vocabulary is vendor clip-art; a diagram's default nouns should be drawn the way the house draws |
| D120 *(A31, 2026-08-28)* | **Agent-placed symbols wear the house.** When the AGENT copies a library item into the scene (and when the legend samples one — D84), the drawing passes a normalization: scribble fills (`hachure`, `cross-hatch`, `zigzag`) become `solid`, roughness is clamped to the canvas's own 1, a stroke heavier than the house weight 2 comes down to it — and every colour is kept, because the hue is the brand and the brand is meaning. A person's own insertions — sidebar drags, their imported libraries — are never touched: the treatment lives on the agent's write path (B4), not on the library | Cross-hatch at icon scale reads as noise, not craft; solid tints in the same hues read as intent. And a person's own hand is theirs (D86's rule, restated for style) |
| D121 *(A31, 2026-08-28)* | **Brandless words prefer the house.** `find_symbol` keeps its tiers (D82); within a tier the house glyphs sort first. Naming a vendor still wins naturally — "lambda" and "sqs" score on names the house does not carry, and vendor-flavoured phrases outrank the house's lower tier — so the rule only decides the genuinely generic word: "queue", "database", "gateway" answer `docent/…` first, with the vendor rows still on the list | An agent asked for "a queue" should draw the idea of a queue; an agent asked for SQS should draw SQS. The tie-break encodes exactly that and nothing more |
| D122 *(A32, 2026-08-29)* | **The library keeps to the house's shelves.** Upstream's "Browse libraries" button — an external funnel to libraries.excalidraw.com — is hidden by one display rule on its stable class (D109's narrowest touch, degrading to upstream if the class moves). The bundled libraries are the library: the house glyphs, the vendor sets, and whatever a person imports themselves through Excalidraw's own import, which stays | An app that promises "no call out to libraries.excalidraw.com" (D23) should not keep a button whose whole job is that call; and a browse button beside a real search is furniture |
| D123 *(A32, 2026-08-29)* | **The palette finds icons.** A Cmd+K query also searches the symbol catalog — the same `find_symbol` ranking agents get (D82, D121), so one word answers the same way at the keyboard as over MCP — and an icon row appears after the commands and scenes, a few at most. Enter copies the item's own drawing onto the paper at the viewport's centre, selected and grouped, as the PERSON'S insertion: sidebar parity — whole item, no carrier, no label retyped, and no house treatment (D120's person rule). The one search is the keyboard's; the sidebar stays a browse surface | 271 items outgrew scrolling the moment the house glyphs joined; the palette already knows how to answer typing, and the catalog already knows how to rank it — the feature is a seam, not a system |
| D124 *(A33, 2026-08-29)* | **The icon search gets its own door** *(amends D123)*. Cmd+K returns to commands and scenes alone: one list ranked two ways — fuzzy labels against catalog tiers — put a weak scene match above an exact icon, and confused exactly the person it was built for. Icons answer on the sibling chord, Cmd+Shift+K (the palette, shifted): the same palette in icon mode — the query against the catalog's own ranking (D82, D121), each row wearing a THUMBNAIL of the drawing itself, rendered off-screen through the adapter's export surface (B1), theme-aware so ink inverts with the paper; Enter inserts at the centre as D123 built. The mode is a command like any other (B4): "Insert Icon…" in the Diagram menu carrying the chord, a palette row, the web binding. An empty query opens on the house vocabulary (D119) | Two ranking systems in one list cannot be predictable, and predictable is what a palette owes the fingers; a sibling chord is one muscle memory with a shift key, and a picture of the icon is the only honest answer to "which one is it" |
| D125 *(A34, 2026-08-29)* | **The explainer — a sixth genre** *(extends S22, D87)*. For explaining anything that runs in order — an execution sequence, a concept built up idea by idea, a plan: a SPINE of steps in story order, one idea per step, numbered by the telling; a long spine folds into rows that turn (D71's bands — the comic-strip reading the layout already draws). Kinds: **step** (neutral), **decision** (caution, diamond — the question is its label and every leaving edge is labelled with its answer), **aside** (inactive — hangs off the step it annotates, nothing follows from it), **outcome** (positive — where the story lands), **pitfall** (danger). Edges carry the connective — "then", "because", "unless" — so step-edge-step reads as a sentence. The guidance tells the agent to define_scenario over the spine: an explainer is meant to replay numbered and be spoken (D89, D58). The grammar lints: a spine with no scenario, a story with no outcome, an aside that feeds the spine, a decision with an unlabelled branch | The findings of the explanation literature, written as drawing rules: spatial order should mirror narrative order and continuous processes should be segmented and numbered (Tversky), one idea per chunk with the organization signalled (Mayer's segmenting and signaling), a labelled edge between two ideas reads as a proposition (Novak's concept maps), and what must be read together must sit together (Larkin & Simon). One narrative genre, deliberately not three layout engines — no lifelines, no radial maps — because the spine tells all three stories and the engine already draws it well |
| D126 *(A35, 2026-08-29)* | **The welcome is a scene.** First launch — nothing addressed by URL, `docent.welcomed` unset — opens a bundled diagram ABOUT Docent: `public/samples/welcome.excalidraw`, an explainer (D125) whose steps teach the app itself — the canvas, the chords, meaning in the legend, diving a tier, agents, presenting — with a detail layer under one step so dive is learned by diving, narrated frames, and a scenario over the spine. A committed static asset like the demo fixture (D23's posture). Shown once, never over real work (an addressed scene always wins), and reachable forever after: Help → Welcome Tour, and the palette | An app whose product is explaining systems should explain itself in its own medium — a diagram, not a slideshow about diagrams |
| D127 *(A35, 2026-08-29)* | **The walkthrough is the presentation engine.** On the welcome scene a quiet pill — the trunk lock's grammar — offers "Start the tour": ⌘P, the SAME guided presentation every diagram gets (S2), waypoints from the narrated frames, spoken where a voice plugin lives (D52). No onboarding framework, no coach marks pinned into upstream's markup, no tooltip library (I1, I7) — when the tour ends the person has already used the feature they will use most | Every onboarding overlay teaches an app's chrome; touring a real diagram teaches the act the app exists for, and retires itself the moment it is understood |
| D128 *(A36, 2026-08-29)* | **Clear Canvas gets a desktop path.** D109 hid the hamburger and took upstream's only door to it with it. It returns as a Docent command: File → Clear Canvas… (and the palette), asking through the shell's own confirm — the one channel every destructive question uses (D102) — then clearing through a typed adapter reset (B1). No chord: a wipe is a thing you go looking for, never a thing to reach mid-draw | A destructive action behind zero doors is not safety, it is a missing feature; behind one confirmed door it is both |
| D129 *(A36, 2026-08-29)* | **The canvas background is a Settings row.** Settings → Appearance gains the paper's colour: upstream's own per-theme swatches, read and written through typed adapter accessors (B1) — the value lives in the scene as it always did, so it saves, exports and diffs unchanged. The other of D109's two orphans, housed where the person's other appearance switch already lives (D115) | The paper's colour is an appearance setting wearing a menu item's costume; Settings is where it was always going to end up |
| D130 *(A36, 2026-08-29)* | **The personal library joins the vocabulary** *(closes A20's deferral, D84)*. The NAMED items of the person's own Excalidraw library enter the catalog at runtime as `my/<name>` (library `personal`) — naming an item is the teaching act, an unnamed item stays a drawing. From there the built machinery simply applies: `find_symbol` answers them where a canvas is attached (the storeless Node dispatcher keeps to the bundled shelves — a personal library needs a person), `add_node` places them, the icon door shows them with thumbnails (D124), the treatment dresses them on the agent path and only there (D120), and D121's tie-break extends one rung: the person's word outranks the house's, which outranks the vendors' | The whole symbol pipeline was built symbol-agnostic on purpose; the funnel is the only missing piece, and a person who names an item in their own library has told the agent exactly what to call it |
| D131 *(A37, 2026-08-29)* | **The icon door names the nameless** *(completes D130)*. Upstream's sidebar has no rename, so "naming is the teaching act" shipped without a pen. Icon mode (Cmd+Shift+K), on an empty query, lists the person's UNNAMED library items after the named shelves — each with its thumbnail — and Enter turns the palette's own input into the pen: type the name, Enter again, and the adapter writes it back into the library through upstream's own update API. The item enters the vocabulary on the spot. No prompt dialog — the desktop webview has none, and the palette already owns a focused input | A rule that cannot be followed in the app is a rule about some other app; the door where icons are found is the door where they learn their names |
| D132 *(A37, 2026-08-29)* | **A glyph is one thing** *(amends D119)*. Every house glyph's elements share one group, written by the generator — so a sidebar drag moves the drawing, not a stroke of it. The bundled vendor items always behaved because their files carry groups; the house's now do too | An icon whose head comes off in your hand is not an icon |
| D133 *(A38, 2026-08-29)* | **A proposal is a branch.** The shadow replica is never a new object: to explore a change, branch the scene (S14, `create_branch`) or draw a linked sibling (D95) and redraw freely — the trunk stays protected (D104), the working copy IS the replica, and merging is accepting. No fork of scene state, no second canvas: one drawing per place, versioned like the code it describes | Git already keeps perfect shadows with perfect memories; inventing a replica object would be Git wearing a costume, maintained by us |
| D134 *(A38, 2026-08-29)* | **The compare lens.** `compare({against})` — and the palette's rows — overlays the live canvas against a reference snapshot: the scene's BASE copy (the one the store keeps for sync and revert, D47/D103), its SAVED copy, or any named scene. Matched by stable id (I6): removed elements appear as ghosts — faint, dashed, named — at their old places; additions wear a positive tint, changes a caution tint, both as outline effects in the overlay's own grammar (D39). A chip names the reference and the counts; the answer carries added/removed/changed and the craft score of both sides — the measurable half of the wins. Entirely overlay (I2): nothing writes, `clear_effects` and the chip's ✕ end it | A proposal argued from memory of the old drawing is argued badly; both versions on one canvas, told apart by tint, is the argument seeing itself |
| D135 *(A38, 2026-08-29)* | **The case is meaning.** `define_proposal({title, against?, wins, costs})` records the proposal's argument beside the legend, where the genre and the scenarios live (D87, D89): each win and each cost one sentence. It exports with everything else (sidecar as data, Mermaid as comments), the outline says it, and clearing it (`define_proposal({clear})`) is one call. Judgment stays the author's: the lens measures what it can, the case says the rest | Pros and cons in a chat thread die with the thread; on the drawing they are versioned, exported, spoken — and merged into history with the decision itself |
| D136 *(A39, 2026-08-29)* | **The title bar says where you are.** The macOS overlay band (D108, D117) gains a breadcrumb readout, centred clear of the traffic lights: the open scene's own trail — project › folders › scene, the segments D92 wrote — extension dropped, "Untitled" while nothing is addressed, and the unsaved dot standing beside it as it does in the window title. Set in the metadata voice (D107); when the trail is long the middle segments yield to ellipsis before the scene's own name does. Furniture, not control: the readout takes no pointer, so the band beneath keeps its drag and its double-click zoom (D112). Framed windows and browser tabs already carry the trail in their own title bars — the readout stands only where borderless left the window nameless | A window that shows a drawing but not which drawing makes the person carry that state in their head; the band was already standing there, empty |
| D137 *(A40, 2026-08-29)* | **The arrowhead earns a runway** *(amends D78)*. No routed edge turns within a corner radius of either port: the last stroke into the arrowhead — and the first out of the source — is one straight of at least stub plus corner. A turn that stands closer is dissolved, in order of preference: the port WALKS along its own side onto the run's line (inside D75's span, outline-true through D98's arithmetic, never onto a seat another edge holds); refused that, the turn STEPS BACK a full corner from the stub, so the jog stands clear of the head with room for its arcs. A pure L — the run riding the OTHER port's own line — walks that port instead, scanning outward along its span at half the nudge gap; and when the corridor is hemmed by seats, boxes, and the span's end, the scan takes what it can get down to two nudges — still a legible stroke under the head, and only where it is a real gain. Refused all of it — geometry allows none — the route stands as it was, honestly. Applied in the one routing pipeline, so agent draws, `layout` and `tidy` all obey | An arrowhead drawn over its own corner arcs is mush: the reader cannot see where the line ends or the head begins — and the cure was already in the house's grammar: ports were always allowed to slide (D98), turns were always priced, only the last corner had no floor under it |
| D138 *(A41, 2026-08-30)* | **The words own their air** *(amends D75's nudge)*. Parallel runs share a corridor when they sit closer than the air their words need — not only when they coincide to the half-unit. Every routed segment claims a half-gap of air: six units for a bare line, half its label's height plus a margin where the label rides (the label sits at the path's midpoint, so the midpoint segment is the one that claims). The nudge spreads every violating pair until each keeps the sum of the two claims — splitting the deficit between movable lines, and standing off IMMOVABLE ones: the drawn lines of edges outside the batch join every corridor as fixed neighbours, so a scope's tidy can no longer lay its lines onto a stranger's at a stroke's width. A shift that would put a line through a component is still given up, honestly | Three long returns bundled at a stroke's width read as one wire, and the wire strikes through all three labels; the eye's tolerance is the label's height, not the router's half-unit — and "drawn in a different batch" is bookkeeping, which a reader cannot see |
| D139 *(A42, 2026-08-30)* | **A passing line keeps its distance** *(amends D98's near-miss, extends D138)*. Every drawn edge stands off what it passes by a small buffer — twelve units, half the routing clearance. Two teeth: a clear straight line STANDS only when it misses every component in reach by the standoff — the old posture let a graze through as "what hand drawing does", but a line kissing a box reads as a connection that is not there, so the grazer now takes the grid, whose corridors already run at the full clearance. And every component's outline joins D138's corridors as a WALL with its own air, so a routed run that hugs a box drifts off it whenever its legs allow — through-checks (D72) and honest refusals unchanged. Ends are exempt where they must touch: the stub and the arrowhead meet the shape; nothing else does | The reader resolves nearness as meaning: a stroke on a box's edge says "attached", two strokes a hair apart say "one wire" — twelve units is how a line says "passing, not touching" |
| D140 *(A43, 2026-08-30)* | **The seventh genre: options** *(extends S22; the drawn half of S24's decisions)*. For a decision argued on one canvas: kinds **question** (caution, diamond — the decision itself), **option** (neutral), **win** (positive), **cost** (danger), **context** (inactive — constraints, givens). One frame per option, named for it; the question stands outside with an edge to each option; each option's wins and costs sit inside its frame, linked from the option. The grammar lints the decision's honesty: an option with no declared cost (there is no free lunch, only an undeclared price), a decision with a single option (a conclusion wearing a question's clothes), a win or cost adrift of any option. The guidance says when to leave the canvas: an option too deep for a frame becomes a SIBLING SCENE with its own case (D133, D135) — the genre and the folder are the same decision at two scales | Choosing is drawing two futures side by side; a decision matrix in a chat thread dies with the thread, and one on the canvas is versioned, linted, presented, and merged with the choice itself |
| D141 *(A43, 2026-08-30)* | **Weigh.** A decision whose options are sibling scenes — a folder of them (D92), each carrying its D135 case — is gathered by one tool: `weigh({folder} or {options}, against?)` reads each option from the store and answers the decision matrix: per option its case (title, wins, costs), its semantic distance from the common base — added, removed, changed, by the compare arithmetic (D134) — and both craft scores. An option with no case answers loudly as such (I5). An option DESCENDS from its base: open the base and `save_scene({scene})` — save-as, the copy becomes the open scene — into the decision's folder, so ids persist (I6) and the diff prices the change; weigh says loudly when an option shares no ids with what it claims to stand against. The LENS stays the live half: `compare({against: option})` flips the canvas between futures — weigh is the table, the lens is the sight. Tools 39→40, and `save_scene` learns its target | The substrate was built pairwise on purpose: folders already name the decision, cases already carry the argument, the diff already prices a change — the plural needed one seam, not a system |
| D142 *(A44, 2026-08-30)* | **A seat carries its words** *(extends D75's spread and D138's air to the ports)*. The label of a short edge rides its port leg, and a port leg can never nudge — so the AIR the words need is claimed at the SEAT: in D75's spread, a labelled edge's seat claims half its label's height plus a margin (a bare edge keeps exactly the even share it always had, so nothing legacy moves), adjacent claims are honoured by the same relax the corridors use, clamped to the side's span; and every port WALK the later passes make (D137's settle, D139's graze) honours the sibling seats' claims in its seat check — a walk may no longer converge two labelled legs below the air their words need. Refused honestly where the span cannot fit the claims | The nudge could give words air everywhere except the one place short edges actually keep them — on the legs that stand on ports; the seat was always the only mover those legs have |
| D143 *(A45, 2026-08-31)* | **Architect ink** *(amends D119–D120's wobble posture)*. The house draws in sloppiness ARCHITECT — roughness 0 — and only architect: the agent style's default and its canvas vote pin it, the treatment dresses imported glyphs down to it, the house library is regenerated in it, the person's tool default is set to it at launch, and the sloppiness options leave the panel — hidden through upstream's own control markup (UPSTREAM-VERSION-SENSITIVE: an upgrade that moves it degrades to upstream's own choices, nothing breaks). TIDY finishes the job: the formatter patches every member of its scope down to roughness 0 — a picture-only patch, D73's semantic changelog stays empty — so a diagram drawn before this decision comes right on its next tidy. The person's freehand pen is untouched: roughness shapes only the sketch-stroked types, and a hand drawing IS its wobble | Any rougher hand draws each stroke in two passes, and a long arrow wearing two lines reads as two arrows; the wobble was warmth, but ink that says one thing once is the cleaner claim — the maintainer chose the drafting table over the sketchbook |
| D144 *(A46, 2026-09-02)* | **A drawing travels whole, and an icon in a box is the box's ornament** *(extends D22, D83, D85)*. Two teeth. TRAVEL: a composite is one thing under the layout no matter who made it — a symbol carrier already moved its whole group (D83), and now a symbol-LESS composite (a person's sidebar-inserted icon among them) does too: the layout keeps its drawn size, centres it in its slot, and moves every member by the same step; it is never resized to a sibling's share and never torn. ORNAMENT: a label-less, symbol-less composite whose whole extent sits inside exactly one component's box is that component's DECORATION, not a component — it takes no slot of its own, arrows bound to any of its members resolve to the HOST, and when the host moves, the ornament moves with it, keeping its place in the box. A drawing containing nothing and contained by nothing stays a component, as it always was | The maintainer wrapped an icon in an intent-carrying box and tidy sent the two to different addresses — one of them in pieces; the reader drew ONE thing, and what reads as one thing must be laid out as one thing |
| D145 *(A47, 2026-09-02)* | **The link is a registry; resolution is one door.** A linked project is an entry in the portfolio's own `.docent/links.json` — project name → absolute directory — and `project_dir`, the single choke point every scene route already passes through, consults it first: read, write, list, delete, save-as and weigh all follow without one of them changing. A link must name a directory that exists, must not collide with a portfolio project or a bound name, and must not sit inside the portfolio itself (no aliasing). UNLINK removes the entry and nothing else — deleting a linked project IS unlinking it, and the repo's files are the person's, always | One resolution door means the whole store speaks the capability at once; a registry in the portfolio means the repo never carries a byte of Docent's bookkeeping |
| D146 *(A47, 2026-09-02)* | **The person links, on the desktop.** Linking is a native directory-picker act: `/desktop/link-project`, app-origin-gated like every dialog route; the picked directory IS the diagram directory, and the project takes the folder's name unless the person names it. The deployed store refuses the link routes loudly — a server must not roam its host's disk. The modal shows a linked project with the root it lives at, and offers **Unlink** where Delete would stand | Choosing a directory on the person's disk is a trust decision with a native idiom; a picker the person drives is the whole consent story |
| D147 *(A47, 2026-09-02)* | **Git stays the person's, absolutely.** A linked project cannot take a GitHub binding and a bound project cannot be linked; there are no sync verbs, no base copies, no checkpointer, no trunk lock — agents see an unbound project and the person sees their own repository. Docent's entire footprint in the repo is the `.excalidraw` files it was asked to save | The user's words: "I have my own workflow" — a tool that respects a workflow is one that cannot be found in its reflog |
| D148 *(A48, 2026-09-02)* | **One gesture opens a repo** *(extends D146)*. File → Open Repo Folder… raises the folder picker and does the whole journey: picking a folder links it (re-picking an already-linked folder is IDEMPOTENT — same root, same project, no fuss; a name linked to a different root refuses loudly), and the portfolio opens on that project with every diagram the recursive listing detects — when exactly one scene lives there, it opens itself, unless unsaved work stands on the canvas, in which case the modal opens instead and nothing is lost. Desktop-only, like the picker it wraps; the palette carries the same row | "Open this repo in Docent" should cost what it says: one gesture — the linking is bookkeeping the person should never have to think about twice |
| D149 *(A49, 2026-09-03)* | **A plugin's control is the agent's door.** `control/1` grants nothing new and everything there is: at launch the plugin receives `DOCENT_MCP_URL` — the desktop's own MCP endpoint (S15) — and every read, write, camera move, overlay, compare and weigh it makes passes the one choke point every agent passes (B4), under the same "Agent can edit" switch and the same orange agent-at-work frame (D62). Maximal control is precisely the agent's control; there is no second API to drift from the first. The contract exists so the person can SEE who holds the pen: the panel lists it, the registry counts it | Two control surfaces would mean two truths about what a diagram is; one door, already guarded, is the whole of the design |
| D150 *(A49, 2026-09-03)* | **Status marks — the health grammar.** `mark_status({by, marks:[{id, state, note?, corner?}], clear?})` puts a glyph chip on a component: ✓ for `ok` (positive), ✕ for `fail` (danger), ! for `warn` (caution), • for `note` (neutral) — the palette's tones (D77), at a corner of the component's bounds (top-left by default), the note as its tooltip. Marks are NAMESPACED by `by`: an author's new set replaces its old one, `clear:true` empties one author, `clear_effects` empties all. Pure overlay (I2): never in the scene, never in an export, gone with the session. Agents and plugins share the tool | A test result belongs on the box it tested, and belongs to whoever ran the test — a namespace is how two authors mark one drawing without erasing each other |
| D151 *(A49, 2026-09-03)* | **A plugin may have a face.** Manifest `panel: {title, url}` — loopback only, as every plugin URL is (D53) — and the Plugins panel offers **Open panel**: the shell opens a native window at that URL beside the canvas. A window, not an iframe: no plugin code in the page (D50 holds), no mixed-content fight, and the person closes it like any window. The route is app-origin-gated like every dialog route | A notebook is a face a plugin already has; Docent's job is to open the door, not to host the room |
| D152 *(A49, 2026-09-03)* | **The registry knows who conflicts.** A contract is a claim, and Docent's registry knows which claims are EXCLUSIVE: `speech/1` (one voice), and every mark namespace a plugin declares (`marks: ["aws-health"]` — one author per namespace). Enabling a plugin whose exclusive claim a running plugin already holds is REFUSED, loudly, naming the holder; the listing carries each plugin's `conflicts` so the panel says it before the click. `control/1` and `panel` are shared claims: many may hold the pen (the agent frame serialises them), every face is its own window | Two plugins that could not run together should be told so by the tool that would run them, not discovered by the reader watching two voices speak at once |
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

**A49 — 2026-09-03.** Plugins-that-hold-the-pen amendment. Added S26 and
D149–D152 (a plugin may control the diagram through the agent's own MCP
door, handed to it at launch as `DOCENT_MCP_URL`, gated exactly as an
agent is; status marks — ok, fail, warn, note — as overlay glyph chips
namespaced by author; a manifest panel opened as a native window; and a
registry that refuses a second claimant of an exclusive claim — one
voice, one author per mark namespace — naming the holder). Rationale:
the maintainer is planning a plugin that runs a notebook, asks AWS about
resources, and paints their health onto the diagram; Docent owes such a
plugin the pen, a face, a health grammar, and a referee — and owes it no
second API, because the agent's door already is the maximal one.

**A48 — 2026-09-02.** Open-repo amendment. Added D148, extending D146
(File → Open Repo Folder… does the whole journey in one gesture — pick,
link or idempotently re-open, then straight to the detected diagrams,
the lone scene opening itself when the canvas is clean). Also in this
cycle, a field fix without a decision: the GitHub form's grid tracks
refused to shrink below 220 units and a narrow window clipped the form
against the column's own overflow — tracks now yield to the column.
Rationale: the maintainer's words — "just open this repo in Docent" —
described a single gesture, and A47 had built everything but the verb.

**A47 — 2026-09-02.** Local-repo amendment. Added S25 and D145–D147 (a
project can live with its code: a links registry in the portfolio maps a
project to a directory the person picked with a native dialog, the one
`project_dir` door resolves it so every scene route follows unchanged,
the deployed store refuses loudly, unlink forgets and touches nothing,
and git stays entirely the person's — no binding, no sync verbs, no
checkpointer, not a byte of bookkeeping in the repo). Rationale: the
maintainer codes in local repos with their own git workflow and wants
diagrams saved beside the code they describe; the store already had one
resolution choke point, so the capability is a registry and a picker,
not a second store.

**A46 — 2026-09-02.** Whole-drawings amendment. Added D144, extending
D22, D83 and D85 (a symbol-less composite travels whole under the layout
— drawn size kept, every member stepped together, never resized to a
sibling's share; and a label-less composite sitting wholly inside one
component's box becomes that component's ornament: no slot of its own,
arrows resolving to the host, moving with the host). Rationale: a
maintainer's field report — an intent-carrying box around a sidebar
icon, and tidy sent box and icon to different addresses with the icon
torn member from member; whole-group travel had only ever been built
for the agent's own carriers.

**A45 — 2026-08-31.** Architect-ink amendment. Added D143, amending
D119–D120's wobble posture (roughness 0 everywhere the house draws: the
agent default, the treatment, the regenerated house library, the
person's tool default; the sloppiness options hidden version-sensitively
through upstream's own markup; tidy patching its whole scope down to
architect under D73's empty changelog; the freehand pen exempt).
Rationale: the maintainer chose it — every rougher sloppiness draws its
strokes twice, and an arrow carrying two lines is not one arrow.

**A44 — 2026-08-30.** Seated-words amendment. Added D142, extending D75
and D138 to the ports (a labelled edge's seat claims its label's air in
the port spread — bare edges keep their exact legacy seats — and every
later port walk honours the sibling seats' claims, so no pass may
converge two labelled port legs below the air their words need).
Rationale: a sample shoot showed twin gains/pays labels kissing on
parallel port legs eight units apart — the corridors owned the words'
air everywhere except on the one kind of leg that cannot nudge, where
the seat was always the only mover available.

**A43 — 2026-08-30.** Solution-options amendment. Added D140 (a seventh
genre, options — question, option, win, cost, context; one frame per
option; the grammar lints an option with no cost, a one-option decision,
and wins or costs adrift; deep options become sibling scenes with cases)
and D141 (`weigh` gathers a folder of option scenes into the decision
matrix — each option's case, its distance from the common base by the
compare arithmetic, and both craft scores — while the compare lens stays
the live way to flip the canvas between futures; tools 39→40).
Rationale: the maintainer asked to compare candidate solutions with
their pros and cons in one place, and S24 had already built everything
but the plural — folders name the decision, cases carry the argument,
the diff prices each option; two seams finish it — plus the one the build
uncovered: options had no way to descend from their base, so `save_scene`
learned a target (save-as), and weigh calls out an option that shares no
ids with what it stands against.

**A42 — 2026-08-30.** Standoff amendment. Added D139, amending D98's
near-miss posture and extending D138 (every drawn edge keeps twelve units
from what it passes: a straight line that would graze a component takes
the grid instead, and component outlines join the nudge corridors as
walls with their own air, so routed runs drift off the boxes they hug;
ends still touch what they are attached to, and through-checks and
honest refusals stand). Rationale: a maintainer's field report showed a
run lying on a component's shoulder — the reader resolves nearness as
meaning, and a line that kisses a box claims an attachment the diagram
never declared.

**A41 — 2026-08-30.** Air amendment. Added D138, amending D75's nudge (a
corridor is shared when lines sit closer than the air their words need:
each segment claims a half-gap — more where its label rides — and
violating pairs spread until both claims hold, movable lines splitting
the deficit and standing lines from outside the batch holding their
ground as fixed neighbours; obstacle refusals unchanged). Rationale: a
maintainer's field report showed three cross-frame returns bundled at a
stroke's width, the bundle striking through all three labels — lines met
in different batches were strangers to the nudge, and its gap was sized
for wires, never for the words they carry.

**A40 — 2026-08-29.** Runway amendment. Added D137, amending D78 (no routed
edge turns within a corner radius of either port: a too-close turn is
dissolved by walking the port onto the run's line within its span, or by
stepping the turn back a full corner, or stands honestly when geometry
allows neither — so the stroke into every arrowhead is straight and the
head is never drawn over its own arcs). Rationale: a maintainer's field
report showed exactly this mush where a five-door hub's polls arrive — the
port-spread and the router each did their job and the seam between them
had no rule; this is the rule.

**A39 — 2026-08-29.** Title-trail amendment. Added D136 (the macOS overlay
title bar reads the open scene's trail as a breadcrumb — project › folders ›
scene, D92's own segments in the metadata voice, with the unsaved dot;
pointer-transparent, so the band keeps the drag and double-click zoom D112
granted it; standing only where borderless removed the window's own title,
since framed windows and browser tabs still carry theirs). Rationale: D108
traded the native title bar for a clean edge and D117 gave the band a
surface, but nothing on the paper ever said which diagram was open — the
one fact a person re-orients by should be readable at a glance, not
remembered.

**A38 — 2026-08-29.** Proposals amendment. Added S24 and D133–D135 (a
proposal is a branch or a linked sibling, never a new replica object; a
compare lens overlaying the live canvas against the base, saved, or any
named scene — ghosts for the removed, tints for the added and changed,
counts and craft delta announced, all overlay and nothing written; the
proposal's wins and costs recorded as meaning beside the legend, exported
and spoken like everything else). Rationale: systems diagrams exist mostly
to discuss change, and every piece of the substrate — branches, stable
ids, the semantic diff, the base copies, the overlay — was already built;
the lens and the case are the two seams that were missing.

**A37 — 2026-08-29.** Pen-and-glue amendment. Added D131–D132 (icon mode
listing the person's unnamed library items and naming them through the
palette's own input, written back via upstream's update API — D130's
teaching act finally has a pen in the app; the house glyphs grouped by
their generator so a drag moves the drawing, not a stroke). Rationale: two
maintainer field reports the same afternoon — a rule that cannot be
followed in the app, and an icon whose head came off in his hand.

**A36 — 2026-08-29.** Orphans-and-funnel amendment. Added D128–D130 (Clear
Canvas back as a confirmed File command and the canvas background as a
Settings swatch row — D109's two orphans housed; the person's own named
library items entering the catalog at runtime as `my/<name>`, found,
placed, thumbnailed and treated by the machinery A20–A33 already built,
ranked ahead of the house because the person's word for a thing outranks
everyone's). Rationale: two features an amendment hid deserve doors an
amendment names, and the symbol pipeline was built waiting for exactly
this funnel.

**A35 — 2026-08-29.** Welcome amendment. Added D126–D127 (first launch opens
a bundled welcome scene — an explainer about Docent itself, with a detail
layer, narrated frames and a scenario, committed as a static asset, shown
once and reachable forever from Help and the palette; the guided
walkthrough is the presentation engine touring that scene from a quiet
pill, no onboarding framework, no coach marks, no new dependency).
Rationale: the product is guided explanation of systems; the only honest
introduction is the product performing itself, and the machinery for that
walkthrough shipped in M1.

**A34 — 2026-08-29.** Explainer amendment. Added D125, extending S22's five
genres to six (the explainer: a numbered spine of steps that folds into
turning rows, decisions as labelled diamonds, asides off the spine,
outcomes and pitfalls, connective edge labels, a scenario over the spine so
it replays and speaks; grammar lints for the missing scenario, the missing
outcome, the aside that feeds the spine, the unlabelled branch). Rationale:
the maintainer asked what genre explanation deserves; the literature's
answer — order as space, segment and number, one idea per chunk, labelled
relations as propositions — is a drawing recipe the engine already knows
how to draw, so it became one genre rather than three layout engines.

**A33 — 2026-08-29.** Icon-door amendment. Added D124, amending D123 (the
icon band leaves Cmd+K — mixing fuzzy labels with catalog tiers put weak
scene matches above exact icons; icons answer on Cmd+Shift+K, the same
palette in icon mode, thumbnails of the drawings rendered off-screen and
theme-aware, reached as a command from the Diagram menu, the palette and
the chord, opening on the house vocabulary when nothing is typed).
Rationale: the maintainer read the mixed list cold and it read wrong;
sibling palettes are one muscle memory, and showing the drawing is the
only honest answer to which icon a name means.

**A32 — 2026-08-29.** Library-search amendment. Added D122–D123 (the
"Browse libraries" external funnel hidden — the bundled shelves and a
person's own imports are the library; the Cmd+K palette searching the
symbol catalog with the same ranking agents get, Enter dropping the item's
own drawing at the viewport centre as the person's untreated insertion).
Rationale: the house glyphs made the library worth searching and the
palette is where Docent answers typing; a browse-the-internet button
beside a real search was furniture with a network cable.

**A31 — 2026-08-28.** Drawings-with-taste amendment. Amended S21's posture
and added D119–D121 (a bundled `docent-house` library of ~20 minimal
monochrome glyphs from a committed deterministic generator, on the same
catalog and placement as every library; agent-placed symbols and legend
samples normalized — scribble fills to solid, roughness and stroke to the
house's own, hues untouched — with the person's own insertions never
touched; brandless queries answering the house glyph first while vendor
names still win their own words). Rationale: the chrome learned restraint
in A27 and the diagrams kept drawing in borrowed clip-art; the drawings'
高级感 is the same discipline — one weight, ink first, colour as meaning —
applied to what the agent draws by default.

**A30 — 2026-08-28.** Person's-switches amendment. Added D115–D118, D117
amending D112 (a Settings dialog on Cmd+, consolidating theme, detail
markers, agent-can-edit and the agent's address, with a typed `setTheme` on
the adapter handle; the PDF export crossing the desktop file channel over a
small house base64 decoder and joining the native File menu; the top band
made a standing gradient rather than a hover reveal; the desktop menu
dropping "Connect Agent Bridge" because the shell's pipe connects itself,
the web keeping its manual verbs). Rationale: the person's switches belong
on the person's chord, an export should not depend on which build you hold,
and chrome should never ask for what already happened.

**A29 — 2026-08-28.** Edges-finished amendment. Added D112–D114, D114
amending D110 (the drag strip gains the shell permission it always needed and
a fade-in band that names the grab area; upstream's surface variables — the
zoom and undo/redo pills, the footer — mapped to house tones, the floating
help button hidden with help kept on its key; the collapse chip retired for a
menu command on Cmd+\, the chord on the web too, and a slim edge handle that
exists only while the tools are away). Rationale: the borderless window
shipped with an unmovable window and three pieces of borrowed furniture;
finishing means the last raw edges wear the house and chrome only exists
while it works.

**A28 — 2026-08-29.** Chrome-earns-its-keep amendment. Amended S13 and added
D109–D111 (native menu bar on desktop with the hamburger hidden there and
kept on the web, one command path; the toolbar docked left and collapsible
through a small, honestly-brittle styling reflow that degrades to upstream's
layout; a Cmd+K palette over the same handlers, fuzzy scene paths included).
Rationale: a desktop app owes its platform a menu bar, a drawing app owes
its canvas the room, and paths made every diagram addressable by typing.

**A27 — 2026-08-28.** House-chrome amendment. Amended S13 and added D107–D108
(one chrome token system in two themes following the canvas's light/dark —
Atelier dark, Porcelain light, bundled Newsreader + Spline Sans, one accent,
one hairline, one shadow; a borderless window on macOS with the canvas
painted to the edge, native frames kept elsewhere). Rationale: the maintainer
chose the direction from drawn candidates; premium is restraint made
consistent, and a token system is restraint the code can hold.

**A26 — 2026-08-27.** Print amendment. Added S23 and D105–D106 (a PDF of
the diagram — one page per frame in outline order, sized to the frame,
captioned with its name and narrative, written by a minimal in-house PDF
writer over the adapter's export surface; per-frame images sized to what
they show instead of one canvas-long strip). Rationale: a tiered diagram
is already a document with a table of contents; paper just needed pages,
and a hand-rolled PDF of JPEG pages is small enough to own outright.

**A25 — 2026-08-27.** Workflow-you-can-feel amendment. Amended S14 and added
D102–D104 (sync verbs show busy states and refuse double-fires; revert to
the D47 base as one confirmed action that names the discarded changes in
the diagram's own terms; a per-binding trunk protection — view-only on the
base branch for people and agents alike, with a branch as the way forward).
Rationale: sync that works silently is sync people double-fire; the base
copy was always the safety net and deserved a handle; and the branch
discipline the constitution recommends should be enforceable by the one
who owns the trunk.

**A24a — 2026-08-26.** Frame-hugging decision. Added D101 (a tidy's layout
answers each frame at its members' bounding box plus the standard head and
pad, grid-true — shrinking what writes only ever grew; non-tidy writes
still only grow, and empty frames keep their size). Rationale: growth-only
was D60's politeness, and tidy is the asking — after it, an oversized
border is only the picture lying about how much it holds.

**A24 — 2026-08-26.** Squared-away amendment. Amended S20 and added D98–D100
(the clear-line fast path stands only axis-aligned, snapped true — every
oblique pair routes orthogonally; an 8px grid under every position, size,
and gap, with the score's angles part become squareness; Layer 1 arranged
whole — tier-1 frames as boxes in one ranked picture with the unframed
components, members carried, edges re-routed), striking A18's deferral of
frame-level arrangement. Rationale: what reads as neat is rectilinear
paths, a shared rhythm, and an outermost picture that was actually
composed; the pipeline owned all three stages and had simply been letting
the cheap diagonal and the arbitrary pixel through.

**A23 — 2026-08-26.** Scene links amendment. Amended S10 (annotations gain
scene links) and S11 (the drill affordance follows them) and added D95–D97
(a link is declared meaning — `docent.link = {scene, project?, at?}` on any
element, in the graph, both exports, and the diff; following is a guarded
jump that arrives focused and leaves a trail back, with link markers beside
the detail badges; authoring through the panel and the ops, the path shape
checked at plan, and validate warning on a target the store does not hold).
Rationale: genres (A21) and folders (A22) made one project many related
diagrams; the relation between them is authored knowledge, and the rule
that keeps it distinct from S11 is one sentence — dive when it is this
diagram going deeper, link when it is another diagram's story.

**A22 — 2026-08-25.** Scenes-at-paths amendment. Amended S12 (the portfolio
browses a folder tree) and S14 (the working copy is a subtree) and added
D92–D94 (a scene's name is a slash path, directories implied by the scenes
in them — created by PUT, pruned by DELETE, `.docent` reserved at every
level, routes unchanged with the path URL-encoded; the modal's tree with
create-into, move, and folder delete; sync recursive over the bound prefix
with state and base copies keyed by path). Rationale: a project bound to a
repository already is a tree — flat was the store's shortcut, not its
promise — and implied directories are the only kind Git itself can keep.

**A21 — 2026-08-25.** Genres amendment. Added S22 (five genres — architecture
map, life of a request, event flow, data flow, lifecycle — each a profile:
vocabulary, frame conventions, layout posture, lint, guidance) and D87–D91 (a
genre is data recorded with the legend, seeded through existing surfaces;
grammar as advisory lint, never refusal; scenarios as named edge paths stored
as meaning, replayed by flow and tour with overlay-only badges; layout
postures — lanes, straight, serpentine — as options on the one pipeline;
genres in the instructions and on the site). Rationale: the diagrams
developers actually reach for are a small set of disciplines, not shapes —
and every mechanism they need (kinds, frames, tiers, flow, tour, lint)
already exists; a genre is the conventions that aim them, made data. The
novelty is the scenario: the trace a developer debugs with, drawn as a path
over the map they already have.

**A21a — 2026-08-25.** Frame-separation decision. Added D86 (no write leaves
two frames overlapping, or a frame over the legend; overlaps resolved in
declared order by the smallest clearing push, members carried, edges
re-routed). Rationale: frames grow because writes put things in them, so
clearing the neighbours is part of the write.

**A20 — 2026-08-24.** Symbols amendment. Added S21 (agents use the bundled
icon libraries by name) and D81–D85 (a generated, checked-in catalog with
hand-kept names and aliases; `find_symbol`; a symbol placed as one component
with an invisible carrier that arrows bind to and a retyped caption as its
label; symbols in the legend and the exports; symbols laid out like any
component); struck the A13 library-shape exclusion for the bundled libraries.
Rationale: 249 named icons are a vocabulary a model can search, the reading
side was already one component under D22, and an invisible carrier gives that
component an edge and a home for its meaning without drawing anything new.

**A19 — 2026-08-24.** Edges as one stroke amendment. Added D78 (a routed edge
reads as one stroke: sides chosen by route cost when the line is blocked, jogs
and hairpins simplified under D72's guarantee, arcs drawn by Docent as explicit
points on a sharp polyline, a lint for legs shorter than a corner), D79 (a
cycle is ranked by the order it was authored; back edges never decide rank),
and D80 (a kind's shared size is its typical label's; long labels wrap
taller); amended D73 (Tidy re-routes every bound edge in scope). Rationale:
the turns a route needs are the obstacles' doing and should look drawn on
purpose; the ones it did not need, and the curve that overshoots them, were
Docent's doing and are now removed at the source.

**A18 — 2026-08-23.** Diagrams that please amendment. Added S20 (pleasing by
construction: the aesthetic criteria the research ranks, a formatter that
proves it changed nothing but the picture, a score, colour that means
something; Docent's own engine) and D73–D77 (Tidy as a formatter with an empty
semantic changelog; the layered pipeline whole — median sweeps with transpose,
Brandes–Köpf coordinates, centring, uniform sizes; edges that flow — ports,
nudging, softened corners; the craft score with its parts, watched by the
tests; colour by tone, role, and perceptual distance with a second channel
past six kinds). Noted, not built: a `layout/1` plugin contract for outside
engines, frame-level arrangement of Layer 1, a BeauVis-style rating harness.
Rationale: the criteria that make a drawing readable are known and ranked —
crossings, bends, alignment, balance — and every one of them is a layout
stage Docent can own deterministically; a formatter people trust is one that
can prove it changed nothing but the picture; and the colours a reader brings
with them should be spent on meaning, not on definition order.

**A17 — 2026-08-23.** Edge craft amendment. Added D70 (an edge is as long as
its words: column gaps and feeder gaps are sized to the widest edge label that
has to sit in them), D71 (long flows turn: a laid-out frame with more than
five ranks folds into balanced bands that alternate direction; the MCP
instructions say so), and D72 (an edge never cuts through a component: every
agent-drawn edge is routed around what lies between its ends, on an
orthogonal grid, fewest bends first; re-routed on layout; the lint reports a
pass-through). Rationale: an agent authors meaning and Docent draws — so a
label that does not fit, a row that does not end, and an arrow through a box
are Docent's faults, and Docent fixes them, deterministically, where the
model has no pixels to fix them with.

**A16 — 2026-08-23.** Visual legend amendment. Added D69 (the legend is drawn
as samples with their meanings, derived from the rules, excluded from every
consumer of meaning; placement never covers it). Rationale: the key to a
diagram should be read at a glance, and never be painted over.

**A15 — 2026-08-23.** In-app updates amendment. Amended S13 (the desktop app
checks nightly and on demand, installs on the person's click, verifies the
signature, relaunches) and added D67 (signed updates from the release,
installed by the shell; key custody) and D68 (check automatically, install only
on consent, protect a dirty canvas). Rationale: staying current should not
mean leaving the app, and on macOS it is the only path that avoids the
Gatekeeper dead-end for unsigned downloads.

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
