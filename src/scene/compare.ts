/**
 * The compare lens's arithmetic (D134): two scene graphs, matched by the
 * stable ids the constitution has kept since M0 (I6), sorted into what the
 * proposal added, removed, and changed. Pure and deterministic (I3): the
 * overlay draws what this says, and the tool's answer counts it.
 *
 * The legend and its samples are the diagram's margin, not its matter —
 * they move when meaning changes elsewhere — so they never appear here;
 * the graph already excludes them.
 */
import type { GraphEdge, GraphNode, SceneGraph } from "./graph";

/** A removed thing, drawn faint at the place it used to hold. */
export interface CompareGhost {
  sourceId: string;
  /** What to write beside the ghost — the label or name it answered to. */
  label: string | null;
  /** True for a frame's ghost, which is drawn as its outline only. */
  frame: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface CompareView {
  /** Live element source ids the reference does not hold. */
  added: string[];
  /** Live element source ids present in both but different (see below). */
  changed: string[];
  /** What the reference holds and the live scene no longer does. */
  ghosts: CompareGhost[];
  counts: { added: number; removed: number; changed: number };
}

const round = (v: number): number => Math.round(v);

/**
 * What counts as changed (D134): the label, the declared meaning a reader
 * would quote (kind is legend-applied and travels with style; intents and
 * logic are the author's words), or a real move — position changes beyond
 * a grid step, so a tidy's nudge reads as change but a sub-pixel settle
 * does not.
 */
const MOVE_TOLERANCE = 8;

function nodeFingerprint(node: GraphNode): string {
  return JSON.stringify([node.label, node.intents, node.logic, node.tags, node.shape]);
}

function moved(a: GraphNode["bounds"], b: GraphNode["bounds"]): boolean {
  return (
    Math.abs(a.x - b.x) > MOVE_TOLERANCE ||
    Math.abs(a.y - b.y) > MOVE_TOLERANCE ||
    Math.abs(a.width - b.width) > MOVE_TOLERANCE ||
    Math.abs(a.height - b.height) > MOVE_TOLERANCE
  );
}

function edgeFingerprint(edge: GraphEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.label, edge.intents]);
}

/** Reference (the before) against current (the live canvas), by source id. */
export function compareGraphs(reference: SceneGraph, current: SceneGraph): CompareView {
  const added: string[] = [];
  const changed: string[] = [];
  const ghosts: CompareGhost[] = [];

  const refNodes = new Map(reference.nodes.map((n) => [n.sourceId, n]));
  const refEdges = new Map(reference.edges.map((e) => [e.sourceId, e]));
  const refFrames = new Map(reference.frames.map((f) => [f.sourceId, f]));

  for (const node of current.nodes) {
    const before = refNodes.get(node.sourceId);
    if (!before) added.push(node.sourceId);
    else if (nodeFingerprint(before) !== nodeFingerprint(node) || moved(before.bounds, node.bounds))
      changed.push(node.sourceId);
    refNodes.delete(node.sourceId);
  }
  for (const edge of current.edges) {
    const before = refEdges.get(edge.sourceId);
    if (!before) added.push(edge.sourceId);
    else if (edgeFingerprint(before) !== edgeFingerprint(edge)) changed.push(edge.sourceId);
    refEdges.delete(edge.sourceId);
  }
  for (const frame of current.frames) {
    const before = refFrames.get(frame.sourceId);
    if (!before) added.push(frame.sourceId);
    else if (before.name !== frame.name || (before.narrative ?? "") !== (frame.narrative ?? ""))
      changed.push(frame.sourceId);
    refFrames.delete(frame.sourceId);
  }

  // What is left in the reference maps was removed. An edge's ghost is the
  // box between where its ends stood — enough to say "a link lived here".
  for (const node of refNodes.values()) {
    ghosts.push({
      sourceId: node.sourceId,
      label: node.label,
      frame: false,
      bounds: {
        x: round(node.bounds.x),
        y: round(node.bounds.y),
        width: round(node.bounds.width),
        height: round(node.bounds.height),
      },
    });
  }
  for (const edge of refEdges.values()) {
    const from = edge.from ? reference.nodes.find((n) => n.id === edge.from) : null;
    const to = edge.to ? reference.nodes.find((n) => n.id === edge.to) : null;
    if (!from || !to) continue;
    const x1 = from.bounds.x + from.bounds.width / 2;
    const y1 = from.bounds.y + from.bounds.height / 2;
    const x2 = to.bounds.x + to.bounds.width / 2;
    const y2 = to.bounds.y + to.bounds.height / 2;
    ghosts.push({
      sourceId: edge.sourceId,
      label: edge.label ? `${edge.label}` : null,
      frame: false,
      bounds: {
        x: round(Math.min(x1, x2)),
        y: round(Math.min(y1, y2)),
        width: round(Math.abs(x2 - x1)) || 2,
        height: round(Math.abs(y2 - y1)) || 2,
      },
    });
  }
  for (const frame of refFrames.values()) {
    ghosts.push({
      sourceId: frame.sourceId,
      label: frame.name,
      frame: true,
      bounds: {
        x: round(frame.bounds.x),
        y: round(frame.bounds.y),
        width: round(frame.bounds.width),
        height: round(frame.bounds.height),
      },
    });
  }

  ghosts.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
  added.sort();
  changed.sort();
  return {
    added,
    changed,
    ghosts,
    counts: { added: added.length, removed: ghosts.length, changed: changed.length },
  };
}
