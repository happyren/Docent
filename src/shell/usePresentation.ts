import { useCallback, useRef, useState } from "react";
import type { DocentCanvasHandle, FrameInfo, Viewport } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import { computeTiers } from "../scene/tiers";
import { OVERVIEW, orderWaypoints, resolveWaypointTarget } from "../scene/waypoints";

export { OVERVIEW };

/**
 * How the presentation is driven (D54): `frames` steps the author's
 * ordered waypoints; `guided` is the same chrome with the camera left to
 * whoever is narrating — an agent moving it with focus and tour.
 */
export type PresentationMode = "frames" | "guided";

export interface Presentation {
  active: boolean;
  mode: PresentationMode;
  /** OVERVIEW (-1) or an index into `waypoints`. */
  index: number;
  waypoints: FrameInfo[];
  enter(mode?: PresentationMode): void;
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
  const [mode, setMode] = useState<PresentationMode>("frames");
  const [index, setIndex] = useState<number>(OVERVIEW);
  const [waypoints, setWaypoints] = useState<FrameInfo[]>([]);
  const savedViewportRef = useRef<Viewport | null>(null);

  // Overview fits Layer 1 only — lower drill tiers live in distant bands
  // and are reached by diving, never by the linear walkthrough (S11).
  const flyOverview = useCallback(() => {
    if (!canvas || !camera) return;
    const tiers = computeTiers(canvas.getSceneSnapshot());
    const bounds = tiers.tier1Bounds ?? canvas.getSceneBounds();
    if (bounds) void camera.flyTo(bounds, { padding: 0.06, duration: 750 });
  }, [canvas, camera]);

  const goTo = useCallback(
    (target: number, frames: FrameInfo[]) => {
      if (!canvas || !camera) return;
      const resolved = resolveWaypointTarget(target, frames.length);
      if (resolved === OVERVIEW) {
        setIndex(OVERVIEW);
        flyOverview();
        return;
      }
      const frame = canvas.getFrameInfo(frames[resolved].id) ?? frames[resolved];
      setIndex(resolved);
      void camera.flyTo(frame.bounds, { padding: 0.1, duration: 850 });
    },
    [canvas, camera, flyOverview],
  );

  const enter = useCallback(
    (wanted: PresentationMode = "frames") => {
      if (!canvas || !camera) return;
      const tiers = computeTiers(canvas.getSceneSnapshot());
      const frames = orderWaypoints(
        canvas.getFrames().filter((f) => (tiers.frameTier.get(f.id) ?? 1) === 1),
      );
      savedViewportRef.current = canvas.getViewport();
      canvas.setViewMode(true);
      setWaypoints(frames);
      setMode(wanted);
      setActive(true);
      setIndex(OVERVIEW);
      // A guided presentation leaves the camera where it is: the narrator
      // is about to move it, and an overview first would be a lurch.
      if (wanted === "frames") flyOverview();
    },
    [canvas, camera, flyOverview],
  );

  const exit = useCallback(() => {
    if (!canvas || !camera) return;
    canvas.setViewMode(false);
    setActive(false);
    setMode("frames");
    setIndex(OVERVIEW);
    const saved = savedViewportRef.current;
    if (saved) void camera.flyToViewport(saved, 500);
  }, [canvas, camera]);

  // Stepping belongs to the frame walk; a guided presentation has no
  // "next" — the narrator decides where the camera goes.
  const next = useCallback(() => {
    if (mode === "guided") return;
    goTo(index === OVERVIEW ? 0 : index + 1, waypoints);
  }, [goTo, index, waypoints, mode]);

  const prev = useCallback(() => {
    if (mode === "guided") return;
    goTo(index <= 0 ? OVERVIEW : index - 1, waypoints);
  }, [goTo, index, waypoints, mode]);

  const overview = useCallback(() => {
    goTo(OVERVIEW, waypoints);
  }, [goTo, waypoints]);

  return { active, mode, index, waypoints, enter, exit, next, prev, overview };
}
