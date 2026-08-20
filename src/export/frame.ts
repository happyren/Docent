/**
 * Frame-scoped semantic export (D32): the sidecar of ONE frame — its own
 * members, their bound labels, and the scene legend — one tier deep and
 * nothing else. Runs the ordinary export pipeline over a sub-snapshot, so
 * determinism (I3) and provenance (I4) come for free, and a member's own
 * deeper detail frame is absent from the sub-snapshot — which makes the
 * standard read-time validation strip both its contents AND the dangling
 * `detail` pointer. Nested layers can never leak into the copy.
 */
import type { SceneSnapshot } from "../adapter/snapshot";
import { buildSceneGraph } from "../scene/graph";
import { exportSidecar } from "./sidecar";

export interface FrameExport {
  /** The frame's display name (its Excalidraw name, or "frame"). */
  name: string;
  sidecar: string;
}

export function exportFrameSidecar(
  snapshot: SceneSnapshot,
  frameSourceId: string,
): FrameExport {
  const frame = snapshot.elements.find(
    (el) => el.id === frameSourceId && el.type === "frame",
  );
  if (!frame) {
    throw new Error("only a frame can be exported");
  }
  const kept = new Set<string>([frame.id]);
  for (const el of snapshot.elements) {
    if (el.frameId === frameSourceId) kept.add(el.id);
    // The legend is scene-global meaning — styles inside the frame decode
    // through it, so the carrier rides along wherever it lives.
    if (el.docent.legend !== null) kept.add(el.id);
  }
  // Bound labels belong to their containers even when Excalidraw left their
  // own frameId unset.
  for (const el of snapshot.elements) {
    if (el.containerId !== null && kept.has(el.containerId)) kept.add(el.id);
  }
  const sub: SceneSnapshot = {
    elements: snapshot.elements.filter((el) => kept.has(el.id)),
  };
  return {
    name: frame.name ?? "frame",
    sidecar: exportSidecar(buildSceneGraph(sub)),
  };
}
