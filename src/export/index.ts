/**
 * Semantic export (S4): Mermaid primary + compact JSON sidecar, both pure
 * functions of the scene graph (B5) and byte-deterministic (I3).
 */
import type { SceneSnapshot } from "../adapter/snapshot";
import { buildSceneGraph } from "../scene/graph";
import { exportMermaid, type ExportContext } from "./mermaid";
import { exportSidecar } from "./sidecar";

export interface SceneExport {
  mermaid: string;
  sidecar: string;
}

/**
 * `context` is what only the caller knows (D95): the project the open scene
 * belongs to, so a link that names none is written against its own project
 * rather than against nothing. Absent for a loose file, which has none.
 */
export function exportScene(
  snapshot: SceneSnapshot,
  context?: ExportContext,
): SceneExport {
  const graph = buildSceneGraph(snapshot);
  return {
    mermaid: exportMermaid(graph, context),
    sidecar: exportSidecar(graph, context),
  };
}

export { buildSceneGraph } from "../scene/graph";
export { exportMermaid } from "./mermaid";
export type { ExportContext } from "./mermaid";
export { exportSidecar } from "./sidecar";
export { exportFrameSidecar } from "./frame";
export { applyLegend, legendToRecord } from "./legend";
