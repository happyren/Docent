/**
 * Floating selection toolbar: the contextual actions (highlight FX, drill)
 * appear beside the selection itself — Figma-style — instead of hiding in
 * the main menu. Positions imperatively on viewport events so it tracks
 * pans and zooms without React re-renders.
 */
import { useEffect, useRef } from "react";
import type { DocentCanvasHandle, ElementInfo } from "../adapter";
import type { CommandAPI } from "../command/api";
import type { Drill } from "./useDrill";

const BAR_OFFSET = 52;

export function SelectionToolbar({
  canvas,
  selectedIds,
  singleSelected,
  commands,
  drill,
  revision,
}: {
  canvas: DocentCanvasHandle;
  selectedIds: string[];
  singleSelected: ElementInfo | null;
  commands: CommandAPI;
  drill: Drill;
  revision: number;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);

  const infos = selectedIds
    .map((id) => canvas.getElementInfo(id))
    .filter((i): i is ElementInfo => i !== null);
  const allLinear = infos.length > 0 && infos.every(
    (i) => i.type === "arrow" || i.type === "line",
  );

  useEffect(() => {
    const reposition = () => {
      const bar = barRef.current;
      if (!bar) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of selectedIds) {
        const info = canvas.getElementInfo(id);
        if (!info) continue;
        minX = Math.min(minX, info.bounds.x);
        minY = Math.min(minY, info.bounds.y);
        maxX = Math.max(maxX, info.bounds.x + info.bounds.width);
        maxY = Math.max(maxY, info.bounds.y + info.bounds.height);
      }
      if (minX === Infinity) {
        bar.style.display = "none";
        return;
      }
      const vp = canvas.getViewport();
      const size = canvas.getViewportSize();
      const left = (minX + vp.scrollX) * vp.zoom;
      const right = (maxX + vp.scrollX) * vp.zoom;
      const topY = (minY + vp.scrollY) * vp.zoom;
      const bottomY = (maxY + vp.scrollY) * vp.zoom;
      // Selection fully off-viewport (e.g. after diving away) — no bar.
      if (right < 0 || left > size.width || bottomY < 0 || topY > size.height) {
        bar.style.display = "none";
        return;
      }
      const width = bar.offsetWidth || 220;
      const x = Math.max(8, Math.min(size.width - width - 8, (left + right) / 2 - width / 2));
      let y = topY - BAR_OFFSET;
      if (y < 8) y = Math.min(bottomY + 16, size.height - 48);
      bar.style.display = "flex";
      bar.style.left = `${x}px`;
      bar.style.top = `${y}px`;
    };
    reposition();
    return canvas.onViewportChange(reposition);
  }, [canvas, selectedIds, revision]);

  if (!infos.length) return null;

  return (
    <div ref={barRef} className="docent-selection-toolbar">
      {singleSelected &&
        (singleSelected.detailFrameId ? (
          <button
            className="docent-tool docent-tool-primary"
            title="Dive into this element's detail diagram"
            onClick={() => drill.dive(singleSelected.id)}
          >
            ⤵ Detail
          </button>
        ) : (
          <button
            className="docent-tool docent-tool-primary"
            title="Create a detail diagram for this element and dive in"
            onClick={() => drill.createAndDive(singleSelected.id)}
          >
            ＋ Detail
          </button>
        ))}
      <button
        className="docent-tool"
        title="Glow highlight"
        onClick={() => commands.highlight({ ids: selectedIds, style: "glow" })}
      >
        Glow
      </button>
      <button
        className="docent-tool"
        title="Spotlight (dim everything else)"
        onClick={() => commands.highlight({ ids: selectedIds, style: "spotlight" })}
      >
        Spotlight
      </button>
      {allLinear && (
        <button
          className="docent-tool"
          title="Pulse a flow along the selected arrows"
          onClick={() =>
            void commands
              .flow({ path: selectedIds })
              .catch((err) => window.alert(String(err)))
          }
        >
          Flow
        </button>
      )}
      <button
        className="docent-tool docent-tool-quiet"
        title="Clear all effects"
        onClick={() => commands.clearEffects()}
      >
        ✕
      </button>
    </div>
  );
}
