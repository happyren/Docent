/**
 * Intent capture UI (S10): element annotations (tags + note) and frame
 * narratives/order. Renders for a single-element selection; writes go
 * through the adapter into `customData.docent.*`.
 */
import { useEffect, useMemo, useState } from "react";
import type { DocentCanvasHandle, ElementInfo } from "../adapter";
import { buildSceneGraph } from "../scene/graph";

/**
 * Refinement targets for one side of a selected edge (D21): the members
 * of the bound endpoint's detail diagram, labeled for a dropdown.
 */
interface RefineSide {
  endpointLabel: string;
  current: string | null;
  options: { id: string; label: string }[];
}

export function IntentPanel({
  canvas,
  selection,
}: {
  canvas: DocentCanvasHandle;
  selection: ElementInfo;
}) {
  const isFrame = selection.type === "frame";
  const isEdge = selection.type === "arrow" || selection.type === "line";

  // For a selected edge whose endpoints declare detail diagrams, offer
  // "lands on / departs from" pickers over those diagrams' components.
  const refineSides = useMemo(() => {
    if (!isEdge) return null;
    const snapshot = canvas.getSceneSnapshot();
    const graph = buildSceneGraph(snapshot);
    const edge = graph.edges.find((e) => e.sourceId === selection.id);
    if (!edge) return null;
    const declared =
      snapshot.elements.find((el) => el.id === selection.id)?.docent.refine ??
      null;
    const side = (
      endpointId: string | null,
      declaredId: string | null,
    ): RefineSide | null => {
      if (!endpointId) return null;
      const endpoint = graph.nodes.find((n) => n.id === endpointId);
      if (!endpoint?.detailFrameId) return null;
      const options = graph.nodes
        .filter((n) => n.frameId === endpoint.detailFrameId)
        .map((n) => ({ id: n.sourceId, label: n.label ?? n.id }));
      if (!options.length) return null;
      return {
        endpointLabel: endpoint.label ?? endpoint.id,
        current: declaredId,
        options,
      };
    };
    const to = side(edge.to, declared?.to ?? null);
    const from = side(edge.from, declared?.from ?? null);
    return to || from ? { to, from } : null;
  }, [canvas, selection.id, isEdge]);
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
          {refineSides?.to && (
            <label className="docent-field">
              <span>Lands on — inside {refineSides.to.endpointLabel}'s detail</span>
              <select
                value={refineSides.to.current ?? ""}
                onChange={(e) =>
                  canvas.setEdgeRefine(selection.id, {
                    to: e.target.value || null,
                  })
                }
              >
                <option value="">(whole {refineSides.to.endpointLabel})</option>
                {refineSides.to.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {refineSides?.from && (
            <label className="docent-field">
              <span>
                Departs from — inside {refineSides.from.endpointLabel}'s detail
              </span>
              <select
                value={refineSides.from.current ?? ""}
                onChange={(e) =>
                  canvas.setEdgeRefine(selection.id, {
                    from: e.target.value || null,
                  })
                }
              >
                <option value="">(whole {refineSides.from.endpointLabel})</option>
                {refineSides.from.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </aside>
  );
}
