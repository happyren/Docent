/**
 * Legend editor (S10, D9): declare style→meaning mappings as data. The
 * adapter persists rules on a locked text element so the legend travels
 * inside the `.excalidraw` file.
 *
 * Docked panel, not a modal: the canvas stays interactive while it's
 * open, so authors point at meaning instead of typing it — select an
 * element, click the style chip that carries the meaning (stroke color,
 * dash, fill, shape…), and only type what it means. Values remain
 * editable as text for hand-tuning.
 */
import { useEffect, useState } from "react";
import type { DocentCanvasHandle, ElementInfo, LegendRule } from "../adapter";

const ATTRS: { value: LegendRule["attr"]; label: string }[] = [
  { value: "strokeStyle", label: "stroke style" },
  { value: "strokeColor", label: "stroke color" },
  { value: "backgroundColor", label: "fill color" },
  { value: "fillStyle", label: "fill style" },
  { value: "strokeWidth", label: "stroke width" },
  { value: "shape", label: "shape" },
];

/** Suggested semantic key per attribute — a starting point, always editable. */
const DEFAULT_KEYS: Record<LegendRule["attr"], string> = {
  strokeStyle: "channel",
  strokeColor: "tag",
  backgroundColor: "kind",
  fillStyle: "texture",
  strokeWidth: "weight",
  shape: "kind",
};

interface StyleChip {
  attr: LegendRule["attr"];
  value: string;
  label: string;
  swatch?: string;
}

const isColor = (attr: LegendRule["attr"]) =>
  attr === "strokeColor" || attr === "backgroundColor";

/** The selected element's distinctive styles, as clickable chips. */
function chipsFor(selection: ElementInfo): StyleChip[] {
  const s = selection.style;
  const chips: StyleChip[] = [
    { attr: "shape", value: selection.type, label: selection.type },
    {
      attr: "strokeColor",
      value: s.strokeColor,
      label: s.strokeColor,
      swatch: s.strokeColor,
    },
  ];
  if (s.backgroundColor && s.backgroundColor !== "transparent") {
    chips.push({
      attr: "backgroundColor",
      value: s.backgroundColor,
      label: s.backgroundColor,
      swatch: s.backgroundColor,
    });
  }
  chips.push({ attr: "strokeStyle", value: s.strokeStyle, label: s.strokeStyle });
  chips.push({ attr: "fillStyle", value: s.fillStyle, label: s.fillStyle });
  chips.push({
    attr: "strokeWidth",
    value: String(s.strokeWidth),
    label: `width ${s.strokeWidth}`,
  });
  return chips;
}

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
  // Focus lands on the meaning field of the rule a chip just created.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = (i: number, patch: Partial<LegendRule>) => {
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const addFromChip = (chip: StyleChip) => {
    const existing = rules.findIndex(
      (r) => r.attr === chip.attr && r.value === chip.value,
    );
    if (existing !== -1) {
      setFocusIndex(existing);
      return;
    }
    // Reuse the key other rules already use for this attribute — one
    // attribute maps to one semantic dimension in a coherent legend.
    const siblingKey = rules.find((r) => r.attr === chip.attr && r.key)?.key;
    setRules((prev) => [
      ...prev,
      {
        attr: chip.attr,
        value: chip.value,
        key: siblingKey ?? DEFAULT_KEYS[chip.attr],
        meaning: "",
      },
    ]);
    setFocusIndex(rules.length);
  };

  const save = () => {
    canvas.setLegend(
      rules.filter((r) => r.value.trim() !== "" && r.key.trim() !== ""),
    );
    onClose();
  };

  return (
    <div className="docent-legend-panel">
      <header className="docent-intent-header">
        <span className="docent-intent-title">Legend — style → meaning</span>
        <button className="docent-narration-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>
      <p className="docent-modal-hint">
        Select an element on the canvas, then click the style that carries
        its meaning — no typing of colors or values needed.
      </p>
      {selection ? (
        <div className="docent-legend-chips">
          {chipsFor(selection).map((chip) => (
            <button
              key={`${chip.attr}:${chip.value}`}
              className="docent-legend-chip"
              title={`Map ${ATTRS.find((a) => a.value === chip.attr)?.label} = ${chip.value}`}
              onClick={() => addFromChip(chip)}
            >
              {chip.swatch && (
                <span
                  className="docent-legend-swatch"
                  style={{ background: chip.swatch }}
                />
              )}
              <span className="docent-legend-chip-attr">
                {ATTRS.find((a) => a.value === chip.attr)?.label}
              </span>
              {chip.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="docent-modal-hint">
          Nothing selected — click a shape on the canvas to see its styles
          here.
        </p>
      )}
      <div className="docent-legend-rows">
        {rules.length === 0 && (
          <p className="docent-modal-hint">No rules yet.</p>
        )}
        {rules.map((rule, i) => (
          <div className="docent-legend-rule" key={i}>
            <div className="docent-legend-row">
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
              {isColor(rule.attr) && rule.value && (
                <span
                  className="docent-legend-swatch"
                  style={{ background: rule.value }}
                />
              )}
              <input
                value={rule.value}
                placeholder="dashed / #a5d8ff / ellipse"
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <button
                title="Remove rule"
                onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            <div className="docent-legend-row">
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
                autoFocus={i === focusIndex}
                onChange={(e) => update(i, { meaning: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
            </div>
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
  );
}
