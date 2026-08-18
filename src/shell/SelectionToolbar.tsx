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
/** Keep clear of Excalidraw's islands: shape toolbar band on top, hamburger/undo row below. */
const TOP_SAFE = 92;
const BOTTOM_SAFE = 96;

/** Element types the scene graph models as components (mirrors graph.ts). */
const NODE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "image",
  "embeddable",
  "iframe",
  "text",
]);

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

  // Selecting a grouped library icon selects every member element. When the
  // whole selection is one group, treat it as a single unit: the Detail
  // action targets the member already carrying the link, else the largest
  // member (S11 — grouped composites work via any member).
  const area = (i: ElementInfo) => i.bounds.width * i.bounds.height;
  const sharesCommonGroup =
    infos.length > 1 &&
    infos.every((i) => i.groupIds.length > 0) &&
    infos[0].groupIds.some((g) => infos.every((i) => i.groupIds.includes(g)));
  const groupRep = sharesCommonGroup
    ? (infos.find((i) => i.detailFrameId !== null) ??
      infos.reduce((a, b) => (area(a) >= area(b) ? a : b)))
    : null;
  const detailTarget = singleSelected ?? groupRep;

  // Whether the shared group currently reads as one component, so the
  // toggle can say what clicking it will do (D22).
  const compositeState = (() => {
    if (!sharesCommonGroup) return null;
    // The group the toggle acts on: the outermost one shared by the whole
    // selection (groupIds run innermost-first), matching the adapter.
    const target = [...infos[0].groupIds]
      .reverse()
      .find((g) => infos.every((i) => i.groupIds.includes(g)));
    if (!target) return null;
    const members = canvas
      .getSceneSnapshot()
      .elements.filter((el) => el.groupIds.includes(target));
    const flags = members
      .map((m) => m.docent.composite[target])
      .filter((v) => v !== undefined);
    if (flags.some((v) => v === true)) return "one";
    if (flags.length && flags.every((v) => v === false)) return "separate";
    // Heuristic mirror: primitives in the group read as a drawn glyph.
    return members.some((m) => !NODE_TYPES.has(m.type)) ? "one" : "separate";
  })();

  const runEffect = (action: () => void) => {
    try {
      action();
    } catch (err) {
      window.alert(String(err instanceof Error ? err.message : err));
    }
  };

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
      if (y < TOP_SAFE) y = bottomY + 16; // flip below the selection
      y = Math.max(TOP_SAFE, Math.min(size.height - BOTTOM_SAFE, y));
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
      {detailTarget &&
        (detailTarget.detailFrameId ? (
          <button
            className="docent-tool docent-tool-primary"
            title="Dive into this element's detail diagram"
            onClick={() => drill.dive(detailTarget.id)}
          >
            ⤵ Detail
          </button>
        ) : (
          <button
            className="docent-tool docent-tool-primary"
            title="Create a detail diagram for this element and dive in"
            onClick={() => drill.createAndDive(detailTarget.id)}
          >
            ＋ Detail
          </button>
        ))}
      {compositeState && (
        <button
          className="docent-tool"
          title={
            compositeState === "one"
              ? "This group exports as one component — click to keep its parts separate"
              : "These grouped shapes export separately — click to treat them as one component"
          }
          onClick={() =>
            runEffect(() =>
              canvas.setGroupComposite(
                selectedIds,
                compositeState === "one" ? false : true,
              ),
            )
          }
        >
          {compositeState === "one" ? "⧉ 1 component" : "⧉ Merge"}
        </button>
      )}
      <button
        className="docent-tool"
        title="Glow highlight"
        onClick={() =>
          runEffect(() => commands.highlight({ ids: selectedIds, style: "glow" }))
        }
      >
        Glow
      </button>
      <button
        className="docent-tool"
        title="Spotlight (dim everything else)"
        onClick={() =>
          runEffect(() =>
            commands.highlight({ ids: selectedIds, style: "spotlight" }),
          )
        }
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
