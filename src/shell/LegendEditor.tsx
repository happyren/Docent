/**
 * Legend editor (S10, D9): declare style→meaning mappings as data. The
 * adapter persists rules on a locked text element so the legend travels
 * inside the `.excalidraw` file.
 */
import { useState } from "react";
import type { DocentCanvasHandle, ElementInfo, LegendRule } from "../adapter";

const ATTRS: { value: LegendRule["attr"]; label: string }[] = [
  { value: "strokeStyle", label: "stroke style" },
  { value: "strokeColor", label: "stroke color" },
  { value: "backgroundColor", label: "fill color" },
  { value: "fillStyle", label: "fill style" },
  { value: "strokeWidth", label: "stroke width" },
  { value: "shape", label: "shape" },
];

export function LegendEditor({
  canvas,
  selection,
  onClose,
}: {
  canvas: DocentCanvasHandle;
  selection: ElementInfo | null;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<LegendRule[]>(() => canvas.getLegend());

  const update = (i: number, patch: Partial<LegendRule>) => {
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const valueFromSelection = (i: number) => {
    if (!selection) return;
    const rule = rules[i];
    const value =
      rule.attr === "shape"
        ? selection.type
        : String(selection.style[rule.attr] ?? "");
    update(i, { value });
  };

  const save = () => {
    canvas.setLegend(
      rules.filter((r) => r.value.trim() !== "" && r.key.trim() !== ""),
    );
    onClose();
  };

  return (
    <div className="docent-modal-backdrop" onClick={onClose}>
      <div className="docent-modal" onClick={(e) => e.stopPropagation()}>
        <header className="docent-modal-header">
          <span>Legend — style → meaning</span>
        </header>
        <p className="docent-modal-hint">
          Declare what your styling means. Mapped styling exports as
          semantics; unmapped styling is stripped as noise.
        </p>
        <div className="docent-legend-rows">
          {rules.map((rule, i) => (
            <div className="docent-legend-row" key={i}>
              <select
                value={rule.attr}
                onChange={(e) =>
                  update(i, { attr: e.target.value as LegendRule["attr"] })
                }
              >
                {ATTRS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <input
                value={rule.value}
                placeholder="dashed / #a5d8ff / ellipse"
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <button
                title="Fill from selected element"
                disabled={!selection}
                onClick={() => valueFromSelection(i)}
              >
                ⤺
              </button>
              <span className="docent-legend-arrow">→</span>
              <input
                className="docent-legend-key"
                value={rule.key}
                placeholder="channel / kind / tag"
                onChange={(e) => update(i, { key: e.target.value })}
              />
              <input
                value={rule.meaning}
                placeholder="async / datastore / hot-path"
                onChange={(e) => update(i, { meaning: e.target.value })}
              />
              <button
                title="Remove rule"
                onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="docent-modal-actions">
          <button
            onClick={() =>
              setRules((prev) => [
                ...prev,
                { attr: "strokeStyle", value: "", key: "", meaning: "" },
              ])
            }
          >
            + Add rule
          </button>
          <span className="docent-modal-spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="docent-primary" onClick={save}>
            Save legend
          </button>
        </div>
      </div>
    </div>
  );
}
