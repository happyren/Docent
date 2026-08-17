/**
 * Intent capture UI (S10): element annotations (tags + note) and frame
 * narratives/order. Renders for a single-element selection; writes go
 * through the adapter into `customData.docent.*`.
 */
import { useEffect, useState } from "react";
import type { DocentCanvasHandle, ElementInfo } from "../adapter";

export function IntentPanel({
  canvas,
  selection,
}: {
  canvas: DocentCanvasHandle;
  selection: ElementInfo;
}) {
  const isFrame = selection.type === "frame";
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [narrative, setNarrative] = useState("");
  const [order, setOrder] = useState("");

  useEffect(() => {
    setTags(selection.tags.join(", "));
    setNote(selection.note ?? "");
    setNarrative(selection.narrative ?? "");
    setOrder(selection.order !== null ? String(selection.order) : "");
  }, [selection.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitElement = () => {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    canvas.setElementIntent(selection.id, {
      tags: tagList.length ? tagList : null,
      note: note.trim() || null,
    });
  };

  const commitFrame = () => {
    const parsed = Number.parseFloat(order);
    canvas.setFrameIntent(selection.id, {
      narrative: narrative.trim() || null,
      order: Number.isFinite(parsed) ? parsed : null,
    });
  };

  return (
    <aside className="docent-intent">
      <header className="docent-intent-header">
        <span className="docent-intent-title">
          {isFrame ? "Frame intent" : "Element intent"}
        </span>
        <span className="docent-intent-target">
          {selection.label ?? (isFrame ? "frame" : selection.type)}
        </span>
      </header>
      {isFrame ? (
        <>
          <label className="docent-field">
            <span>Narrative — what this section means</span>
            <textarea
              value={narrative}
              rows={3}
              placeholder="One or two sentences; narrates tours and rides the export."
              onChange={(e) => setNarrative(e.target.value)}
              onBlur={commitFrame}
            />
          </label>
          <label className="docent-field">
            <span>Presentation order (overrides name order)</span>
            <input
              type="number"
              value={order}
              placeholder="e.g. 1"
              onChange={(e) => setOrder(e.target.value)}
              onBlur={commitFrame}
            />
          </label>
        </>
      ) : (
        <>
          <label className="docent-field">
            <span>Tags (comma-separated)</span>
            <input
              value={tags}
              placeholder="hot-path, legacy"
              onChange={(e) => setTags(e.target.value)}
              onBlur={commitElement}
            />
          </label>
          <label className="docent-field">
            <span>Note</span>
            <textarea
              value={note}
              rows={3}
              placeholder='e.g. "rate-limited at edge"'
              onChange={(e) => setNote(e.target.value)}
              onBlur={commitElement}
            />
          </label>
        </>
      )}
    </aside>
  );
}
