/**
 * Semantic export (S4): Mermaid primary + compact JSON sidecar, both pure
 * functions of the scene graph (B5) and byte-deterministic (I3).
 */
import type { SceneSnapshot } from "../adapter/snapshot";
import { buildSceneGraph } from "../scene/graph";
import { exportMermaid } from "./mermaid";
import { exportSidecar } from "./sidecar";

export interface SceneExport {
  mermaid: string;
  sidecar: string;
}

export function exportScene(snapshot: SceneSnapshot): SceneExport {
  const graph = buildSceneGraph(snapshot);
  return {
    mermaid: exportMermaid(graph),
    sidecar: exportSidecar(graph),
  };
}

export { buildSceneGraph } from "../scene/graph";
export { exportMermaid } from "./mermaid";
export { exportSidecar } from "./sidecar";
export { applyLegend, legendToRecord } from "./legend";
