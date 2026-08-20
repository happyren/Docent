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
| S13 | Desktop distribution *(added A4)* | Docent ships as a **Tauri** desktop app for macOS, Windows, and Linux, wrapping the **same built SPA** — no second frontend, no fork (I1). The desktop portfolio is a native store implementing the **same D17 file-tree contract and `/api` route contract** as the self-host store, rooted in the OS app-data directory; contract parity is tested. Samples and bundled libraries ship in the app. The MCP agent endpoint was not part of desktop v1; A7 adds it as S15. Installers build in CI; auto-update is out of scope for v1 |
| S14 | GitHub project sync *(added A5, local-first per A6)* | A portfolio project may **bind to a GitHub repository** (`owner/repo`, path prefix, branch, and an API base URL so GitHub Enterprise instances work). The bound project's directory is a **local working copy**: scenes open and save at disk speed, offline included, as plain `.excalidraw` files (D17). Synchronization is explicit, like code: **pull** fast-forwards the working copy from the active branch and surfaces per-scene **conflicts** when both sides changed — never auto-merged; the author resolves keep-mine or take-remote; **push** lands every local change as **one commit** on the active branch (refused when the remote moved — pull first); branches are created and switched deliberately (switching requires a clean copy), and pull requests open back onto the recorded base (D28). Sync state — per-scene base blob SHA and base content hash, per project — lives under the `.docent/` exception beside the bindings. Auth is a **fine-grained personal access token** — chosen over OAuth device flow because customer-controlled GitHub instances may not host any OAuth app; tokens are held outside the data tree and are write-only through the API (never echoed). Both store implementations honor the same binding contract; unbound projects behave exactly as before |
| S15 | Desktop agent endpoint *(added A7)* | The desktop app exposes the **same protocol-standard MCP agent surface** as a deployment (S8, D19), **read-only**: the scene document is never modified — camera moves, overlay effects, narration, presentation control, drill navigation, and scene opening are navigation, not writes, and opening a scene is refused while the canvas holds unsaved changes. Transport is **loopback streamable HTTP** on a fixed local port with an ephemeral fallback (D34) — loopback is exempt from MCP clients' HTTPS requirement, which is what made the self-host endpoint need a stdio shim (D24). The page-side dispatcher is the **same shared module** the self-host MCP server runs (D34), so the tool surface cannot drift between the two. **Help → Agent Endpoint…** shows the live URL and a ready-to-paste client configuration |
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
