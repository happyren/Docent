/**
 * Tier breadcrumbs, anchored to the diagram: the trail hangs above the
 * current detail frame's top-left corner (beside Excalidraw's frame name)
 * and rides pan/zoom imperatively. When the frame's top edge leaves the
 * viewport it clamps below the toolbar band, sticky-header style.
 *
 * The way back out of a followed link (D96) rides the same bar, ahead of
 * the tier trail: one diagram's depth and the trail across diagrams are
 * both "where the reader is", and the reader looks in one place for both.
 * With no tier to hang from the bar parks under the toolbar band instead.
 */
import { useEffect, useRef } from "react";
import type { DocentCanvasHandle } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import type { Crumb } from "../scene/tiers";
import { displayPath, leafOf } from "../portfolio/tree";
import type { Drill } from "./useDrill";

const ABOVE_FRAME = 46;
const TOP_SAFE = 92;
const BOTTOM_SAFE = 96;

export function Breadcrumbs({
  canvas,
  camera,
  trail,
  drill,
  revision,
  onBack,
}: {
  canvas: DocentCanvasHandle;
  camera: CameraEngine | null;
  trail: Crumb[];
  drill: Drill;
  revision: number;
  /** Reopen the scene the last jump left, focused on what jumped (D96). */
  onBack?: () => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const currentFrameId = trail[trail.length - 1]?.frameId ?? null;
  const back = drill.jumps[drill.jumps.length - 1] ?? null;

  useEffect(() => {
    const reposition = () => {
      const bar = barRef.current;
      if (!bar) return;
      const frame = currentFrameId ? canvas.getFrameInfo(currentFrameId) : null;
      if (!frame) {
        // No tier under the camera, but a jump to walk back from: the way
        // out must stay reachable, so it parks under the toolbar band.
        if (!back) {
          bar.style.display = "none";
          return;
        }
        bar.style.display = "flex";
        bar.style.left = "8px";
        bar.style.top = `${TOP_SAFE}px`;
        return;
      }
      const vp = canvas.getViewport();
      const size = canvas.getViewportSize();
      const left = (frame.bounds.x + vp.scrollX) * vp.zoom;
      const top = (frame.bounds.y + vp.scrollY) * vp.zoom;
      const width = bar.offsetWidth || 200;
      const x = Math.max(8, Math.min(size.width - width - 8, left));
      const y = Math.max(TOP_SAFE, Math.min(size.height - BOTTOM_SAFE, top - ABOVE_FRAME));
      bar.style.display = "flex";
      bar.style.left = `${x}px`;
      bar.style.top = `${y}px`;
    };
    reposition();
    return canvas.onViewportChange(reposition);
  }, [canvas, currentFrameId, revision, back]);

  if (!trail.length && !back) return null;

  return (
    <nav ref={barRef} className="docent-breadcrumbs">
      {back && (
        <button
          className="docent-chip docent-chip-back"
          title={`Back to ${back.project} / ${displayPath(back.scene)}`}
          onClick={() => onBack?.()}
        >
          ↩ {leafOf(back.scene)}
        </button>
      )}
      {trail.length > 0 && (
        <button className="docent-chip" onClick={() => drill.up()}>
          ◂ Up
        </button>
      )}
      {trail.map((crumb) => (
        <button
          className="docent-crumb"
          key={crumb.frameId}
          title={`Jump to ${crumb.name}`}
          onClick={() => {
            const bounds = canvas.getFrameInfo(crumb.frameId)?.bounds;
            if (bounds && camera) void camera.flyTo(bounds, { padding: 0.1 });
          }}
        >
          {crumb.name}
        </button>
      ))}
    </nav>
  );
}
