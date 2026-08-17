import { useCallback, useRef, useState } from "react";
import type { DocentCanvasHandle, SceneBounds, Viewport } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import { bandPlacement, computeTiers, tierOfElement } from "../scene/tiers";

interface DrillTier {
  frameId: string;
  name: string;
  returnViewport: Viewport;
}

export interface Drill {
  /** Session dive stack (exact viewport restore), outermost tier first. */
  stack: DrillTier[];
  /** Dive into an element's declared detail frame. False if it has none. */
  dive(elementId: string): boolean;
  /** Create + link a detail frame in the next tier band, then dive into it. */
  createAndDive(elementId: string): void;
  /**
   * Climb one tier: exact restore when a dive is on the stack, otherwise the
   * structural fallback (fly to the linking shape's parent context).
   */
  up(): void;
  reset(): void;
}

export function useDrill(
  canvas: DocentCanvasHandle | null,
  camera: CameraEngine | null,
  structuralUp?: () => void,
  /** Deepest detail frame the viewport is currently inside (structural). */
  deepestFrameId?: () => string | null,
): Drill {
  const [stack, setStack] = useState<DrillTier[]>([]);
  // Ref mirror so navigation decisions never live inside setState updaters —
  // React replays queued updaters on later renders, which would re-run
  // camera side effects against a fresh viewport.
  const stackRef = useRef<DrillTier[]>(stack);
  const commitStack = useCallback((next: DrillTier[]) => {
    stackRef.current = next;
    setStack(next);
  }, []);

  const push = useCallback(
    (from: SceneBounds, frameId: string, name: string, target: SceneBounds) => {
      if (!canvas || !camera) return;
      const returnViewport = canvas.getViewport();
      commitStack([...stackRef.current, { frameId, name, returnViewport }]);
      void camera.dive(from, target);
    },
    [canvas, camera, commitStack],
  );

  const dive = useCallback(
    (elementId: string): boolean => {
      if (!canvas || !camera) return false;
      const info = canvas.getElementInfo(elementId);
      if (!info?.detailFrameId) return false;
      const frame = canvas.getFrameInfo(info.detailFrameId);
      if (!frame) {
        console.error(
          `Element ${elementId} declares detail frame ${info.detailFrameId}, which does not exist`,
        );
        return false;
      }
      push(info.bounds, frame.id, frame.name || "detail", frame.bounds);
      return true;
    },
    [canvas, camera, push],
  );

  const createAndDive = useCallback(
    (elementId: string) => {
      if (!canvas || !camera) return;
      const info = canvas.getElementInfo(elementId);
      if (!info) return;
      try {
        // Place the new frame in the band one tier below its parent (S11
        // spatial policy) so lower tiers never crowd the parent's view.
        const snapshot = canvas.getSceneSnapshot();
        const tiers = computeTiers(snapshot);
        const parentTier = tierOfElement(tiers, snapshot, elementId);
        const placement = bandPlacement(tiers, snapshot, parentTier + 1);
        const { frameId, bounds } = canvas.createAndLinkDetailFrame(
          elementId,
          placement,
        );
        const frame = canvas.getFrameInfo(frameId);
        push(info.bounds, frameId, frame?.name ?? "detail", frame?.bounds ?? bounds);
      } catch (err) {
        console.error(err);
        window.alert(
          `Could not create detail frame: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    [canvas, camera, push],
  );

  const up = useCallback(() => {
    if (!camera) return;
    const prev = stackRef.current;
    const top = prev[prev.length - 1];
    const currentFrame = deepestFrameId?.() ?? null;
    // Exact viewport restore only when the stack matches where we actually
    // are; after free navigation the chain is stale — climb structurally
    // and drop the broken chain.
    if (top && (currentFrame === null || top.frameId === currentFrame)) {
      void camera.flyToViewport(top.returnViewport, 650);
      commitStack(prev.slice(0, -1));
      return;
    }
    if (top) commitStack([]);
    structuralUp?.();
  }, [camera, structuralUp, deepestFrameId, commitStack]);

  const reset = useCallback(() => commitStack([]), [commitStack]);

  return { stack, dive, createAndDive, up, reset };
}
