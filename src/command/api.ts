/**
 * Command API (B4) — the single choke point for programmatic actions.
 * Presentation UI, FX buttons, and (M4) the MCP server all route through
 * here. Agents live in graph-id space (I5): unknown ids throw, commands
 * never silently no-op.
 *
 * I2 by construction: this module receives a READ-ONLY scene surface —
 * there is no scene-writing method in `SceneReader`, so no command can
 * mutate the document or its undo history.
 */
import type {
  EdgeGeometry,
  ElementInfo,
  FrameInfo,
  SceneBounds,
  SceneSnapshot,
  Viewport,
} from "../adapter";
import type { CameraEngine } from "../camera/engine";
import { buildSceneGraph, type SceneGraph } from "../scene/graph";
import { computeTiers } from "../scene/tiers";
import type { HighlightStyle, OverlayStore } from "../overlay/state";
import type { SceneWrite } from "../adapter/excalidraw";
import { idSource, lint, plan, PlanError, simulate, type LintFinding, type Op } from "../authoring/ops";
import { describeChange } from "../scene/diff";

/** The read-only slice of the canvas surface commands may touch. */
export interface SceneReader {
  getSceneSnapshot(): SceneSnapshot;
  getElementInfo(elementId: string): ElementInfo | null;
  getFrameInfo(frameId: string): FrameInfo | null;
  getFrames(): FrameInfo[];
  getSceneBounds(): SceneBounds | null;
  getEdgeGeometry(elementId: string): EdgeGeometry | null;
  getViewport(): Viewport;
  getViewportSize(): { width: number; height: number };
  onViewportChange(callback: (viewport: Viewport) => void): () => void;
}

/**
 * The write slice of the canvas surface (S19, B4): one write lands as one
 * undo step; capture/restore is the agent's own Undo; `canEdit` is the
 * person's switch; `working` and `report` are the shell's chrome — the
 * orange frame and the panel line (D61).
 */
export interface SceneWriter {
  applyWrite(write: SceneWrite): void;
  captureScene(): unknown;
  restoreScene(captured: unknown): void;
  canEdit(): boolean;
  working?(on: boolean): void;
  report?(line: string, undo: (() => void) | null): void;
}

/** What an edit or a proposal answers (D62). */
export interface EditResult {
  applied: boolean;
  changelog: string;
  /** Caller refs and new ids → graph ids (what every other tool addresses). */
  ids: Record<string, string>;
  notes: string[];
  /** Graph ids of what was created or changed. */
  touched: string[];
  lint: { findings: LintFinding[]; summary: string };
}

/** Scene-units per second at speed 1.0. */
const FLOW_UNITS_PER_SECOND = 500;

/**
 * The zoom ceiling (D44): the subject may take at most this share of the
 * framed box in either dimension, so it can never fill the view.
 */
const MAX_SUBJECT_SHARE = 0.4;

function unionOf(a: SceneBounds, b: SceneBounds): SceneBounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Grow `framed` until `subject` is at most MAX_SUBJECT_SHARE of it in both
 * dimensions, growing around the subject's centre so it stays in view.
 */
function withCeiling(framed: SceneBounds, subject: SceneBounds): SceneBounds {
  const minW = subject.width / MAX_SUBJECT_SHARE;
  const minH = subject.height / MAX_SUBJECT_SHARE;
  const cx = subject.x + subject.width / 2;
  const cy = subject.y + subject.height / 2;
  const floor: SceneBounds = {
    x: cx - minW / 2,
    y: cy - minH / 2,
    width: minW,
    height: minH,
  };
  return unionOf(framed, floor);
}

/**
 * Where narrate() text goes (S9) — the shell's narration panel, and, when
 * the shell speaks (S18, D52), the voice. `spoken` resolves when the words
 * have finished being said — at once when nothing is spoken — so a tour can
 * wait for them; `narrate` itself never waits on audio.
 */
export interface NarrationSink {
  narrate(text: string | null): void;
  spoken?(text: string | null): Promise<void>;
  /** Whether a voice is on right now — what `narrate` reports having waited for. */
  speaks?(): boolean;
  /** Resolves when no speech is in flight — at once when nothing speaks. */
  settled?(): Promise<void>;
}

export interface TourStep {
  /** Graph id to fly to (node, edge, or frame). */
  focus?: string;
  /** Graph ids to highlight for this step. */
  highlight?: string[];
  highlightStyle?: HighlightStyle;
  /** Ordered edge ids to pulse for this step. */
  flow?: string[];
  /**
   * Narration text. When omitted and `focus` targets a frame with a
   * declared narrative, the narrative narrates the step (D10, S9).
   */
  narrate?: string;
}

export class CommandAPI {
  private tourGeneration = 0;
  private wakeTour: (() => void) | null = null;

  /** Interruptible sleep — stopTour() resolves it immediately. */
  private dwell(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeTour = null;
        resolve();
      }, ms);
      this.wakeTour = () => {
        clearTimeout(timer);
        this.wakeTour = null;
        resolve();
      };
    });
  }

  private readonly undoStack: unknown[] = [];
  private workingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly reader: SceneReader,
    private readonly camera: CameraEngine,
    private readonly overlay: OverlayStore,
    private readonly narration: NarrationSink = { narrate: () => {} },
    private readonly writer: SceneWriter | null = null,
  ) {}

  // -------------------------------------------------------------------------
  // authoring (S19)
  // -------------------------------------------------------------------------

  /** Whether writes are possible here and allowed now. */
  canEdit(): boolean {
    return this.writer !== null && this.writer.canEdit();
  }

  private requireWriter(): SceneWriter {
    if (!this.writer) throw new Error("This canvas cannot be edited by an agent");
    if (!this.writer.canEdit()) {
      throw new Error("Agent editing is switched off — the person can turn it on under View → Agent can edit");
    }
    return this.writer;
  }

  /** Graph ids for the source ids a plan assigned, once the graph exists. */
  private graphIds(ids: Record<string, string>, graph: SceneGraph): Record<string, string> {
    const toGraph = (sourceId: string) =>
      graph.nodes.find((n) => n.sourceId === sourceId)?.id ??
      graph.edges.find((e) => e.sourceId === sourceId)?.id ??
      graph.frames.find((f) => f.sourceId === sourceId)?.id ??
      sourceId;
    const out: Record<string, string> = {};
    for (const [handle, sourceId] of Object.entries(ids)) {
      if (handle.startsWith("$")) out[handle] = toGraph(sourceId);
    }
    return out;
  }

  private planOrExplain(ops: Op[]) {
    try {
      return plan(ops, this.reader.getSceneSnapshot(), idSource());
    } catch (err) {
      if (err instanceof PlanError) {
        throw new Error(`Nothing applied — ${err.problems.length} problem${err.problems.length === 1 ? "" : "s"}:\n- ${err.problems.join("\n- ")}`);
      }
      throw err;
    }
  }

  /** The batch's dry run (D62): the changelog it would produce, nothing touched. */
  propose(ops: Op[]): EditResult {
    const before = this.reader.getSceneSnapshot();
    const planned = this.planOrExplain(ops);
    const after = simulate(before, planned.write);
    const { changelog } = describeChange(before, after);
    const graph = buildSceneGraph(after);
    return {
      applied: false,
      changelog,
      ids: this.graphIds(planned.ids, graph),
      notes: planned.notes,
      touched: planned.touched.map((id) => this.graphIds({ $x: id }, graph).$x ?? id),
      lint: lint(after),
    };
  }

  /**
   * Apply a batch (D62): validated whole, landed as one undo step, shown,
   * reported, and answered with what actually changed.
   */
  async edit(ops: Op[]): Promise<EditResult> {
    const writer = this.requireWriter();
    const before = this.reader.getSceneSnapshot();
    const planned = this.planOrExplain(ops);
    const captured = writer.captureScene();
    this.setWorking(true);
    try {
      writer.applyWrite(planned.write);
    } catch (err) {
      this.setWorking(false);
      throw err;
    }
    this.undoStack.push(captured);
    if (this.undoStack.length > 20) this.undoStack.shift();
    const after = this.reader.getSceneSnapshot();
    const { changelog } = describeChange(before, after);
    const graph = buildSceneGraph(after);
    const ids = this.graphIds(planned.ids, graph);
    const touched = planned.touched.map((id) => this.graphIds({ $x: id }, graph).$x ?? id);
    // Show the work: fly to what changed, outline it (I2 — overlay only).
    const present = planned.touched.filter((id) => this.reader.getElementInfo(id) || this.reader.getFrameInfo(id));
    if (present.length) {
      try {
        await this.frameTargets(present, 0.25);
        this.overlay.setHighlight(this.resolveEffectTargets(graph, present), "outline");
      } catch {
        // Showing is a courtesy; the edit already landed.
      }
    }
    // The panel line is a glance, not the changelog: counts, and the
    // notes when nothing semantic changed.
    const { diff } = describeChange(before, after);
    const parts: string[] = [];
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (diff.nodes.added.length) parts.push(`+${count(diff.nodes.added.length, "component")}`);
    if (diff.nodes.removed.length) parts.push(`−${count(diff.nodes.removed.length, "component")}`);
    if (diff.nodes.changed.length) parts.push(`${count(diff.nodes.changed.length, "component")} changed`);
    if (diff.edges.added.length) parts.push(`+${count(diff.edges.added.length, "edge")}`);
    if (diff.edges.removed.length) parts.push(`−${count(diff.edges.removed.length, "edge")}`);
    if (diff.edges.changed.length) parts.push(`${count(diff.edges.changed.length, "edge")} changed`);
    if (diff.frames.added.length) parts.push(`+${count(diff.frames.added.length, "frame")}`);
    if (diff.frames.removed.length) parts.push(`−${count(diff.frames.removed.length, "frame")}`);
    if (diff.frames.changed.length) parts.push(`${count(diff.frames.changed.length, "frame")} changed`);
    const summary = parts.length ? parts.join(" · ") : planned.notes.join("; ") || "no semantic change";
    writer.report?.(summary, () => this.undoAgentEdit());
    this.setWorking(false);
    return { applied: true, changelog, ids, notes: planned.notes, touched, lint: lint(after) };
  }

  /** Put the scene back to before the last agent edit — itself undoable. */
  undoAgentEdit(): boolean {
    const writer = this.requireWriter();
    const captured = this.undoStack.pop();
    if (captured === undefined) return false;
    writer.restoreScene(captured);
    this.overlay.setHighlight([], "outline");
    return true;
  }

  /** The craft check (D62). */
  validate(): { findings: LintFinding[]; summary: string } {
    return lint(this.reader.getSceneSnapshot());
  }

  /**
   * The agent-at-work frame (D61): on while a write runs and for a short
   * linger after, so consecutive calls read as one session.
   */
  private setWorking(on: boolean): void {
    if (!this.writer?.working) return;
    if (this.workingTimer) {
      clearTimeout(this.workingTimer);
      this.workingTimer = null;
    }
    if (on) {
      this.writer.working(true);
      return;
    }
    this.workingTimer = setTimeout(() => {
      this.writer?.working?.(false);
      this.workingTimer = null;
    }, 4000);
  }

  /**
   * The speech gate (D57): the picture never leaves mid-sentence. Every
   * command that moves the camera or the overlay waits here first — the
   * async ones inside this class, the shell-driven ones through the
   * executor — unless the caller asked to interrupt, which cuts the voice.
   */
  async awaitSpeech(interrupt = false): Promise<void> {
    if (interrupt) {
      // Panel and voice both: the sentence is cut, not merely hidden.
      void this.narrate({ text: null });
      return;
    }
    await this.narration.settled?.();
  }

  /** The agent-facing address space: nodes/edges/frames with stable ids. */
  getSceneGraph(): SceneGraph {
    return buildSceneGraph(this.reader.getSceneSnapshot());
  }

  /** The raw typed snapshot — what the pure exporters consume. Read-only. */
  getSceneSnapshot(): SceneSnapshot {
    return this.reader.getSceneSnapshot();
  }

  /**
   * Resolve highlight/effect targets: graph node/edge/frame ids, group ids
   * (expanded to member elements), or raw element ids for anything the
   * graph doesn't model as a node — grouped library icons are lines and
   * freedraw strokes, and effects must still land on them. Unknown ids
   * stay loud (I5).
   */
  private resolveEffectIds(graph: SceneGraph, ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const pools = [graph.nodes, graph.edges, graph.frames] as {
        id: string;
        sourceId: string;
      }[][];
      const match = pools
        .flatMap((pool) => pool)
        .find((item) => item.id === id || item.sourceId === id);
      if (match) {
        const node = graph.nodes.find((n) => n.id === match.id && n.composite);
        out.push(...(node ? this.compositeMemberIds(node) : [match.sourceId]));
        continue;
      }
      const group = graph.groups.find((g) => g.id === id);
      if (group) {
        for (const memberId of group.members) {
          const node = graph.nodes.find((n) => n.id === memberId);
          if (node) out.push(node.sourceId);
        }
        continue;
      }
      // A collapsed composite (D22) is one node, so its group id no longer
      // appears in `groups` — resolve it through the node that speaks for
      // it, and light up every part of the glyph rather than one stroke.
      const compositeNode = graph.nodes.find(
        (n) => n.composite && n.groupIds.includes(id),
      );
      if (compositeNode) {
        out.push(...this.compositeMemberIds(compositeNode));
        continue;
      }
      if (this.reader.getElementInfo(id)) {
        out.push(id);
        continue;
      }
      throw new Error(
        `Unknown node/edge/frame/group id: ${id} — use ids from get_scene_graph`,
      );
    }
    return out;
  }

  /** Every source element a composite node stands for (D22). */
  private compositeMemberIds(node: { groupIds: string[]; sourceId: string }): string[] {
    const ids = this.reader
      .getSceneSnapshot()
      .elements.filter((el) => el.groupIds.some((g) => node.groupIds.includes(g)))
      .map((el) => el.id);
    return ids.length ? ids : [node.sourceId];
  }

  /** Resolve a graph id (or raw element id) to its source element id. */
  private resolveSourceId(
    graph: SceneGraph,
    id: string,
    kinds: ("node" | "edge" | "frame")[],
  ): string {
    for (const kind of kinds) {
      const pool =
        kind === "node" ? graph.nodes : kind === "edge" ? graph.edges : graph.frames;
      const match = pool.find((item) => item.id === id || item.sourceId === id);
      if (match) return match.sourceId;
    }
    throw new Error(
      `Unknown ${kinds.join("/")} id: ${id} — use ids from get_scene_graph`,
    );
  }

  /**
   * Tween the camera to an element's or frame's bounds. A component is
   * framed with its **neighbourhood** by default (D44) — itself plus every
   * component an edge connects it to within the same tier — and never
   * fills the view: the zoom ceiling keeps it at or under 40% of the
   * framed box. `context: "self"` drops the neighbours, ceiling kept. A
   * frame or edge focuses as it is.
   */
  async focus(params: {
    id: string;
    padding?: number;
    context?: "neighbors" | "self";
    /** Say this on arrival (D57) — one call is one stop. */
    narrate?: string;
    /** Cut the voice in flight instead of waiting for it. */
    interrupt?: boolean;
  }): Promise<void> {
    await this.awaitSpeech(params.interrupt);
    await this.flyFocus(params);
    if (params.narrate) void this.narrate({ text: params.narrate });
  }

  private async flyFocus(params: {
    id: string;
    padding?: number;
    context?: "neighbors" | "self";
  }): Promise<void> {
    const graph = this.getSceneGraph();
    const node = graph.nodes.find((n) => n.id === params.id || n.sourceId === params.id);
    if (node) {
      const own = this.nodeBounds(node);
      let bounds = own;
      if ((params.context ?? "neighbors") === "neighbors") {
        // Same tier, not same frame: sibling frames on one layer are one
        // neighbourhood; a detail layer beneath is not.
        const snapshot = this.reader.getSceneSnapshot();
        const tiers = computeTiers(snapshot);
        const tierOf = (n: SceneGraph["nodes"][number]) => {
          const frame = graph.frames.find((f) => f.id === n.frameId);
          return frame ? (tiers.frameTier.get(frame.sourceId) ?? 1) : 1;
        };
        const tier = tierOf(node);
        for (const edge of graph.edges) {
          const otherId =
            edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null;
          if (!otherId) continue;
          const other = graph.nodes.find((n) => n.id === otherId);
          if (!other || tierOf(other) !== tier) continue;
          bounds = unionOf(bounds, this.nodeBounds(other));
        }
      }
      await this.camera.flyTo(withCeiling(bounds, own), {
        padding: params.padding ?? 0.2,
      });
      return;
    }
    let info: { bounds: SceneBounds } | null;
    try {
      const sourceId = this.resolveSourceId(graph, params.id, ["frame", "edge"]);
      info =
        this.reader.getFrameInfo(sourceId) ?? this.reader.getElementInfo(sourceId);
    } catch (err) {
      // Not a graph entity — a raw element (library icon part) still focuses.
      info = this.reader.getElementInfo(params.id);
      if (!info) throw err;
    }
    if (!info) throw new Error(`Element vanished: ${params.id}`);
    await this.camera.flyTo(info.bounds, { padding: params.padding ?? 0.2 });
  }

  /** A node's live bounds (composites: the union of their members). */
  private nodeBounds(node: SceneGraph["nodes"][number]): SceneBounds {
    if (!node.composite) {
      return this.reader.getElementInfo(node.sourceId)?.bounds ?? node.bounds;
    }
    let bounds: SceneBounds | null = null;
    for (const id of this.compositeMemberIds(node)) {
      const info = this.reader.getElementInfo(id);
      if (info) bounds = bounds ? unionOf(bounds, info.bounds) : info.bounds;
    }
    return bounds ?? node.bounds;
  }

  /** Union AABB of resolved effect targets; null when nothing resolves. */
  private targetBounds(graph: SceneGraph, ids: string[]): SceneBounds | null {
    const sourceIds = this.resolveEffectIds(graph, ids);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const id of sourceIds) {
      const info = this.reader.getElementInfo(id);
      if (!info) continue;
      any = true;
      minX = Math.min(minX, info.bounds.x);
      minY = Math.min(minY, info.bounds.y);
      maxX = Math.max(maxX, info.bounds.x + info.bounds.width);
      maxY = Math.max(maxY, info.bounds.y + info.bounds.height);
    }
    return any
      ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      : null;
  }

  /**
   * Whether these bounds already read well: fully inside the viewport AND
   * big enough to actually see — at least a tenth of the view in one
   * dimension. "In view but microscopic" is the failure this catches: a
   * narration about content the viewer cannot make out.
   */
  private readsWell(bounds: SceneBounds): boolean {
    const vp = this.reader.getViewport();
    const size = this.reader.getViewportSize();
    if (size.width === 0 || size.height === 0 || vp.zoom <= 0) return false;
    const viewX = -vp.scrollX;
    const viewY = -vp.scrollY;
    const viewW = size.width / vp.zoom;
    const viewH = size.height / vp.zoom;
    const inside =
      bounds.x >= viewX &&
      bounds.y >= viewY &&
      bounds.x + bounds.width <= viewX + viewW &&
      bounds.y + bounds.height <= viewY + viewH;
    if (!inside) return false;
    return Math.max(bounds.width / viewW, bounds.height / viewH) >= 0.1;
  }

  /**
   * Frame a set of effect targets unless they already read well (D37): the
   * camera follows the narrated action, never the other way round. Same id
   * leniency as the effects themselves; unknown ids stay loud (I5).
   */
  async frameTargets(ids: string[], padding = 0.35): Promise<void> {
    if (!ids.length) return;
    await this.awaitSpeech();
    const graph = this.getSceneGraph();
    const bounds = this.targetBounds(graph, ids);
    if (!bounds || this.readsWell(bounds)) return;
    // The same ceiling as focus (D44): what is shown never fills the view.
    await this.camera.flyTo(withCeiling(bounds, bounds), { padding });
  }

  /**
   * Resolve highlight targets (D39): a composite node is ONE target made of
   * its members, a layout group is one target per member node, a plain
   * node/edge/frame or raw element is a target of one. Same leniency and
   * the same loudness as `resolveEffectIds` (I5).
   */
  private resolveEffectTargets(graph: SceneGraph, ids: string[]): string[][] {
    const targets: string[][] = [];
    for (const id of ids) {
      const pools = [graph.nodes, graph.edges, graph.frames] as {
        id: string;
        sourceId: string;
      }[][];
      const match = pools
        .flatMap((pool) => pool)
        .find((item) => item.id === id || item.sourceId === id);
      if (match) {
        const node = graph.nodes.find((n) => n.id === match.id && n.composite);
        targets.push(node ? this.compositeMemberIds(node) : [match.sourceId]);
        continue;
      }
      const group = graph.groups.find((g) => g.id === id);
      if (group) {
        for (const memberId of group.members) {
          const node = graph.nodes.find((n) => n.id === memberId);
          if (node) {
            targets.push(node.composite ? this.compositeMemberIds(node) : [node.sourceId]);
          }
        }
        continue;
      }
      const compositeNode = graph.nodes.find(
        (n) => n.composite && n.groupIds.includes(id),
      );
      if (compositeNode) {
        targets.push(this.compositeMemberIds(compositeNode));
        continue;
      }
      if (this.reader.getElementInfo(id)) {
        targets.push([id]);
        continue;
      }
      throw new Error(
        `Unknown node/edge/frame/group id: ${id} — use ids from get_scene_graph`,
      );
    }
    return targets;
  }

  /** Idempotent highlight; empty ids clears (S6). */
  highlight(params: { ids: string[]; style?: HighlightStyle }): void {
    if (!params.ids.length) {
      this.overlay.setHighlight([], params.style ?? "glow");
      return;
    }
    const graph = this.getSceneGraph();
    const targets = this.resolveEffectTargets(graph, params.ids);
    this.overlay.setHighlight(targets, params.style ?? "glow");
  }

  /**
   * Pulse along an ordered edge path (S7). Resolves when the pulse has had
   * time to finish (looping flows resolve after the first cycle) — the
   * animation itself degrades rather than blocking (I8).
   */
  async flow(params: {
    path: string[];
    speed?: number;
    loop?: boolean;
  }): Promise<void> {
    if (!params.path.length) {
      this.overlay.setFlow([], 1, false);
      return;
    }
    const graph = this.getSceneGraph();
    const speed = params.speed ?? 1;
    if (!(speed > 0)) throw new Error(`Invalid speed: ${params.speed}`);
    let totalLength = 0;
    const sourceIds = params.path.map((id) => {
      let sourceId: string;
      try {
        sourceId = this.resolveSourceId(graph, id, ["edge"]);
      } catch (err) {
        // Plain lines aren't graph edges but still carry drawn geometry —
        // a selected line should pulse. Anything else stays loud (I5).
        if (this.reader.getEdgeGeometry(id)) sourceId = id;
        else throw err;
      }
      const geometry = this.reader.getEdgeGeometry(sourceId);
      if (!geometry) throw new Error(`Not a linear element: ${id}`);
      for (let i = 1; i < geometry.points.length; i++) {
        totalLength += Math.hypot(
          geometry.points[i][0] - geometry.points[i - 1][0],
          geometry.points[i][1] - geometry.points[i - 1][1],
        );
      }
      return sourceId;
    });
    this.overlay.setFlow(sourceIds, speed, params.loop ?? false);
    const ms = (totalLength / (FLOW_UNITS_PER_SECOND * speed)) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms + 200, 60_000)));
  }

  /** Clear all overlay effects. */
  clearEffects(): void {
    this.overlay.clear();
  }

  /**
   * Show a review change in place (D48): fly to its rectangle and draw
   * the removed entities as ghosts where they were, from the base copy.
   * Effects only — the scene is never written (I2). Empty ghosts clears
   * them; `outline` lights the added/changed elements that are present.
   */
  async showChange(params: {
    rect: SceneBounds;
    ghosts: { id: string; label: string; rect: SceneBounds }[];
    outline?: string[];
  }): Promise<void> {
    this.overlay.setGhosts(
      params.ghosts.map((g) => ({ id: g.id, label: g.label, bounds: g.rect })),
    );
    if (params.outline && params.outline.length) {
      const graph = this.getSceneGraph();
      const present = params.outline.filter((id) => this.reader.getElementInfo(id));
      if (present.length) {
        this.overlay.setHighlight(this.resolveEffectTargets(graph, present), "outline");
      }
    } else {
      this.overlay.setHighlight([], "outline");
    }
    // The crop rectangle is already the changed cluster with its margin
    // (D48), so it is flown to as framed — no neighbourhood, no ceiling.
    await this.camera.flyTo(params.rect, { padding: 0.15 });
  }

  /**
   * Render text in the narration panel (S9) — and say it, when the shell
   * speaks (D52). With `wait` (D55) the call resolves when the words have
   * been spoken, so a narrator moves on after its sentence; without it,
   * or when nothing speaks, at once. Resolves to whether it waited.
   */
  async narrate(params: { text: string | null; wait?: boolean }): Promise<boolean> {
    const text = params.text || null;
    this.narration.narrate(text);
    const spoken = this.narration.spoken?.(text);
    if (!spoken) return false;
    const speaking = this.narration.speaks?.() ?? true;
    if (params.wait) {
      await spoken;
      return speaking;
    }
    void spoken;
    return false;
  }

  /**
   * Run a narrated walkthrough (S8/S9): each step may focus, highlight,
   * pulse a flow, and narrate — frame narratives narrate frame-focus steps
   * by default. Interruptible via stopTour(); resolves with the number of
   * steps completed.
   */
  async tour(params: { steps: TourStep[]; stepMs?: number }): Promise<number> {
    this.tourGeneration += 1;
    const generation = this.tourGeneration;
    let completed = 0;
    try {
      for (const step of params.steps) {
        if (generation !== this.tourGeneration) break;
        let narration = step.narrate ?? null;
        if (step.focus) {
          if (narration === null) {
            const graph = this.getSceneGraph();
            const frame = graph.frames.find(
              (f) => f.id === step.focus || f.sourceId === step.focus,
            );
            narration = frame?.narrative ?? null;
          }
          await this.focus({ id: step.focus });
        } else if (step.highlight?.length || step.flow?.length) {
          // A step that shows something but names no focus still frames what
          // it shows (D37) — narrating over content the viewer cannot see is
          // the one way a tour fails its audience.
          await this.frameTargets([
            ...(step.highlight ?? []),
            ...(step.flow ?? []),
          ]);
        }
        if (generation !== this.tourGeneration) break;
        let speech: Promise<void> = Promise.resolve();
        if (narration !== null) {
          this.narration.narrate(narration);
          speech = this.narration.spoken?.(narration) ?? Promise.resolve();
        }
        if (step.highlight) {
          this.highlight({ ids: step.highlight, style: step.highlightStyle });
        }
        if (step.flow?.length) {
          await this.flow({ path: step.flow });
        }
        if (generation !== this.tourGeneration) break;
        // Reading time scales with narration length; always interruptible.
        // When the words are spoken, the step lasts at least as long as the
        // voice (D52): the camera never outruns the narration.
        const readMs =
          params.stepMs ?? Math.min(1200 + (narration?.length ?? 0) * 35, 8000);
        await Promise.all([this.dwell(readMs), speech]);
        if (generation !== this.tourGeneration) break;
        completed += 1;
      }
    } finally {
      if (generation === this.tourGeneration) {
        this.narration.narrate(null);
        this.overlay.clear();
      }
    }
    return completed;
  }

  /** Interrupt a running tour; effects and narration clear immediately. */
  stopTour(): void {
    this.tourGeneration += 1;
    this.wakeTour?.();
    this.narration.narrate(null);
    this.overlay.clear();
    this.camera.stop();
  }
}
