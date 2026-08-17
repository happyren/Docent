import { useCallback, useRef, useState } from "react";
import type { DocentCanvasHandle, FrameInfo, Viewport } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import { orderWaypoints } from "../scene/waypoints";

export const OVERVIEW = -1;

export interface Presentation {
  active: boolean;
  /** OVERVIEW (-1) or an index into `waypoints`. */
  index: number;
  waypoints: FrameInfo[];
  enter(): void;
  exit(): void;
  next(): void;
  prev(): void;
  overview(): void;
}

export function usePresentation(
  canvas: DocentCanvasHandle | null,
  camera: CameraEngine | null,
): Presentation {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState<number>(OVERVIEW);
  const [waypoints, setWaypoints] = useState<FrameInfo[]>([]);
  const savedViewportRef = useRef<Viewport | null>(null);

  const flyOverview = useCallback(() => {
    if (!canvas || !camera) return;
    const bounds = canvas.getSceneBounds();
    if (bounds) void camera.flyTo(bounds, { padding: 0.06, duration: 750 });
  }, [canvas, camera]);

  const goTo = useCallback(
    (target: number, frames: FrameInfo[]) => {
      if (!canvas || !camera) return;
      if (target === OVERVIEW) {
        setIndex(OVERVIEW);
        flyOverview();
        return;
      }
      const clamped = Math.max(0, Math.min(frames.length - 1, target));
      const frame = canvas.getFrameInfo(frames[clamped].id) ?? frames[clamped];
      setIndex(clamped);
      void camera.flyTo(frame.bounds, { padding: 0.1, duration: 850 });
    },
    [canvas, camera, flyOverview],
  );

  const enter = useCallback(() => {
    if (!canvas || !camera) return;
    const frames = orderWaypoints(canvas.getFrames());
    savedViewportRef.current = canvas.getViewport();
    canvas.setViewMode(true);
    setWaypoints(frames);
    setActive(true);
    setIndex(OVERVIEW);
    flyOverview();
  }, [canvas, camera, flyOverview]);

  const exit = useCallback(() => {
    if (!canvas || !camera) return;
    canvas.setViewMode(false);
    setActive(false);
    setIndex(OVERVIEW);
    const saved = savedViewportRef.current;
    if (saved) void camera.flyToViewport(saved, 500);
  }, [canvas, camera]);

  const next = useCallback(() => {
    goTo(index === OVERVIEW ? 0 : index + 1, waypoints);
  }, [goTo, index, waypoints]);

  const prev = useCallback(() => {
    goTo(index <= 0 ? OVERVIEW : index - 1, waypoints);
  }, [goTo, index, waypoints]);

  const overview = useCallback(() => {
    goTo(OVERVIEW, waypoints);
  }, [goTo, waypoints]);

  return { active, index, waypoints, enter, exit, next, prev, overview };
}
