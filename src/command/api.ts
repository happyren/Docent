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
import type { HighlightStyle, OverlayStore } from "../overlay/state";

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

/** Scene-units per second at speed 1.0. */
const FLOW_UNITS_PER_SECOND = 500;

export class CommandAPI {
  constructor(
    private readonly reader: SceneReader,
    private readonly camera: CameraEngine,
    private readonly overlay: OverlayStore,
  ) {}

  /** The agent-facing address space: nodes/edges/frames with stable ids. */
  getSceneGraph(): SceneGraph {
    return buildSceneGraph(this.reader.getSceneSnapshot());
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

  /** Tween the camera to an element's or frame's bounds. */
  async focus(params: { id: string; padding?: number }): Promise<void> {
    const graph = this.getSceneGraph();
    const sourceId = this.resolveSourceId(graph, params.id, [
      "frame",
      "node",
      "edge",
    ]);
    const info =
      this.reader.getFrameInfo(sourceId) ?? this.reader.getElementInfo(sourceId);
    if (!info) throw new Error(`Element vanished: ${params.id}`);
    await this.camera.flyTo(info.bounds, { padding: params.padding ?? 0.2 });
  }

  /** Idempotent highlight; empty ids clears (S6). */
  highlight(params: { ids: string[]; style?: HighlightStyle }): void {
    if (!params.ids.length) {
      this.overlay.setHighlight([], params.style ?? "glow");
      return;
    }
    const graph = this.getSceneGraph();
    const sourceIds = params.ids.map((id) =>
      this.resolveSourceId(graph, id, ["node", "edge", "frame"]),
    );
    this.overlay.setHighlight(sourceIds, params.style ?? "glow");
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
      const sourceId = this.resolveSourceId(graph, id, ["edge"]);
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
}
