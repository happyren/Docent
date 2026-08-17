import { useCallback, useState } from "react";
import type { DocentCanvasHandle, SceneBounds, Viewport } from "../adapter";
import type { CameraEngine } from "../camera/engine";

interface DrillTier {
  frameId: string;
  name: string;
  returnViewport: Viewport;
}

export interface Drill {
  /** Breadcrumb trail, outermost tier first. */
  stack: DrillTier[];
  /** Dive into an element's declared detail frame. False if it has none. */
  dive(elementId: string): boolean;
  /** Create + link a detail frame for the element, then dive into it. */
  createAndDive(elementId: string): void;
  /** Climb one tier back to where the last dive started. */
  up(): void;
  reset(): void;
}

export function useDrill(
  canvas: DocentCanvasHandle | null,
  camera: CameraEngine | null,
): Drill {
  const [stack, setStack] = useState<DrillTier[]>([]);

  const push = useCallback(
    (from: SceneBounds, frameId: string, name: string, target: SceneBounds) => {
      if (!canvas || !camera) return;
      const returnViewport = canvas.getViewport();
      setStack((prev) => [...prev, { frameId, name, returnViewport }]);
      void camera.dive(from, target);
    },
    [canvas, camera],
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
        const { frameId, bounds } = canvas.createAndLinkDetailFrame(elementId);
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
    setStack((prev) => {
      const top = prev[prev.length - 1];
      if (!top) return prev;
      void camera.flyToViewport(top.returnViewport, 650);
      return prev.slice(0, -1);
    });
  }, [camera]);

  const reset = useCallback(() => setStack([]), []);

  return { stack, dive, createAndDive, up, reset };
}
