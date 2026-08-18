/**
 * Tier breadcrumbs, anchored to the diagram: the trail hangs above the
 * current detail frame's top-left corner (beside Excalidraw's frame name)
 * and rides pan/zoom imperatively. When the frame's top edge leaves the
 * viewport it clamps below the toolbar band, sticky-header style.
 */
import { useEffect, useRef } from "react";
import type { DocentCanvasHandle } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import type { Crumb } from "../scene/tiers";
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
}: {
  canvas: DocentCanvasHandle;
  camera: CameraEngine | null;
  trail: Crumb[];
  drill: Drill;
  revision: number;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const currentFrameId = trail[trail.length - 1]?.frameId ?? null;

  useEffect(() => {
    const reposition = () => {
      const bar = barRef.current;
      if (!bar) return;
      const frame = currentFrameId ? canvas.getFrameInfo(currentFrameId) : null;
      if (!frame) {
        bar.style.display = "none";
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
  }, [canvas, currentFrameId, revision]);

  if (!trail.length) return null;

  return (
    <nav ref={barRef} className="docent-breadcrumbs">
      <button className="docent-chip" onClick={() => drill.up()}>
        ◂ Up
      </button>
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
