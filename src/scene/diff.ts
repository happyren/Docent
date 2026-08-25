/**
 * Semantic scene diff (S16, D46): what changed between two snapshots, in
 * the terms the diagram was drawn in. Compares the two scene graphs by
 * stable id (I6) — components, edges, frames, and the declared meaning on
 * them — and renders a changelog a reviewer or an agent can read without
 * opening either file. Pure and deterministic (I3): same inputs, same
 * words, same order.
 */
import type { SceneLink, SceneSnapshot } from "../adapter/snapshot";
import { applyLegend } from "../export/legend";
import { buildSceneGraph, type GraphEdge, type GraphNode, type SceneGraph } from "./graph";

/** Position/size changes smaller than this are layout jitter, not edits. */
const MOVE_TOLERANCE = 4;

export type NodeChange =
  | { kind: "label"; from: string | null; to: string | null }
  | { kind: "moved" }
  | { kind: "resized" }
  | { kind: "frame"; from: string | null; to: string | null }
  | { kind: "kind"; from: string | null; to: string | null }
  | { kind: "tags"; added: string[]; removed: string[] }
  | { kind: "intents"; added: string[]; removed: string[] }
  | { kind: "logic"; from: string | null; to: string | null }
  | { kind: "detail"; from: string | null; to: string | null }
  | { kind: "link"; from: SceneLink | null; to: SceneLink | null };

export type EdgeChange =
  | { kind: "rewired"; from: { from: string | null; to: string | null }; to: { from: string | null; to: string | null } }
  | { kind: "label"; from: string | null; to: string | null }
  | { kind: "intents"; added: string[]; removed: string[] }
  | { kind: "logic"; from: string | null; to: string | null }
  | { kind: "refined"; from: { to: string | null; from: string | null }; to: { to: string | null; from: string | null } }
  | { kind: "link"; from: SceneLink | null; to: SceneLink | null };

export type FrameChange =
  | { kind: "renamed"; from: string; to: string }
  | { kind: "narrative"; from: string | null; to: string | null }
  | { kind: "link"; from: SceneLink | null; to: SceneLink | null };

export interface SceneDiff {
  nodes: {
    added: GraphNode[];
    removed: GraphNode[];
    changed: { before: GraphNode; after: GraphNode; changes: NodeChange[] }[];
  };
  edges: {
    added: GraphEdge[];
    removed: GraphEdge[];
    changed: { before: GraphEdge; after: GraphEdge; changes: EdgeChange[] }[];
  };
  frames: {
    added: SceneGraph["frames"];
    removed: SceneGraph["frames"];
    changed: { before: SceneGraph["frames"][number]; after: SceneGraph["frames"][number]; changes: FrameChange[] }[];
  };
  /** True when nothing above is non-empty. */
  empty: boolean;
}

function setDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

/**
 * A link said as one string (D95) — the project it names, the path, and the
 * component it arrives on. Two links are the same link when this is.
 */
function linkText(link: SceneLink | null): string | null {
  if (link === null) return null;
  return `${link.project ? `${link.project}/` : ""}${link.scene}${link.at ? `#${link.at}` : ""}`;
}

function movedOrResized(a: GraphNode["bounds"], b: GraphNode["bounds"]): { moved: boolean; resized: boolean } {
  return {
    moved:
      Math.abs(a.x - b.x) > MOVE_TOLERANCE || Math.abs(a.y - b.y) > MOVE_TOLERANCE,
    resized:
      Math.abs(a.width - b.width) > MOVE_TOLERANCE ||
      Math.abs(a.height - b.height) > MOVE_TOLERANCE,
  };
}

export function diffScenes(beforeSnapshot: SceneSnapshot, afterSnapshot: SceneSnapshot): SceneDiff {
  const before = buildSceneGraph(beforeSnapshot);
  const after = buildSceneGraph(afterSnapshot);
  return diffGraphs(before, after);
}

export function diffGraphs(before: SceneGraph, after: SceneGraph): SceneDiff {
  const kindOf = (graph: SceneGraph, node: GraphNode) =>
    applyLegend(node.style, node.shape, graph.legend, node.symbol).kind;

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const nodes: SceneDiff["nodes"] = { added: [], removed: [], changed: [] };
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      nodes.added.push(node);
      continue;
    }
    const changes: NodeChange[] = [];
    if (prev.label !== node.label) changes.push({ kind: "label", from: prev.label, to: node.label });
    const geometry = movedOrResized(prev.bounds, node.bounds);
    if (geometry.moved) changes.push({ kind: "moved" });
    if (geometry.resized) changes.push({ kind: "resized" });
    if (prev.frameId !== node.frameId) changes.push({ kind: "frame", from: prev.frameId, to: node.frameId });
    const prevKind = kindOf(before, prev);
    const nextKind = kindOf(after, node);
    if (prevKind !== nextKind) changes.push({ kind: "kind", from: prevKind, to: nextKind });
    const tags = setDiff(prev.tags, node.tags);
    if (tags.added.length || tags.removed.length) changes.push({ kind: "tags", ...tags });
    const intents = setDiff(prev.intents, node.intents);
    if (intents.added.length || intents.removed.length) changes.push({ kind: "intents", ...intents });
    if (prev.logic !== node.logic) changes.push({ kind: "logic", from: prev.logic, to: node.logic });
    if (prev.detailFrameId !== node.detailFrameId) {
      changes.push({ kind: "detail", from: prev.detailFrameId, to: node.detailFrameId });
    }
    if (linkText(prev.link) !== linkText(node.link)) {
      changes.push({ kind: "link", from: prev.link, to: node.link });
    }
    if (changes.length) nodes.changed.push({ before: prev, after: node, changes });
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) nodes.removed.push(node);
  }

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const edges: SceneDiff["edges"] = { added: [], removed: [], changed: [] };
  for (const edge of after.edges) {
    const prev = beforeEdges.get(edge.id);
    if (!prev) {
      edges.added.push(edge);
      continue;
    }
    const changes: EdgeChange[] = [];
    if (prev.from !== edge.from || prev.to !== edge.to) {
      changes.push({
        kind: "rewired",
        from: { from: prev.from, to: prev.to },
        to: { from: edge.from, to: edge.to },
      });
    }
    if (prev.label !== edge.label) changes.push({ kind: "label", from: prev.label, to: edge.label });
    const intents = setDiff(prev.intents, edge.intents);
    if (intents.added.length || intents.removed.length) changes.push({ kind: "intents", ...intents });
    if (prev.logic !== edge.logic) changes.push({ kind: "logic", from: prev.logic, to: edge.logic });
    if (prev.toRefined !== edge.toRefined || prev.fromRefined !== edge.fromRefined) {
      changes.push({
        kind: "refined",
        from: { to: prev.toRefined, from: prev.fromRefined },
        to: { to: edge.toRefined, from: edge.fromRefined },
      });
    }
    if (linkText(prev.link) !== linkText(edge.link)) {
      changes.push({ kind: "link", from: prev.link, to: edge.link });
    }
    if (changes.length) edges.changed.push({ before: prev, after: edge, changes });
  }
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) edges.removed.push(edge);
  }

  const beforeFrames = new Map(before.frames.map((f) => [f.id, f]));
  const afterFrames = new Map(after.frames.map((f) => [f.id, f]));
  const frames: SceneDiff["frames"] = { added: [], removed: [], changed: [] };
  for (const frame of after.frames) {
    const prev = beforeFrames.get(frame.id);
    if (!prev) {
      frames.added.push(frame);
      continue;
    }
    const changes: FrameChange[] = [];
    if (prev.name !== frame.name) changes.push({ kind: "renamed", from: prev.name, to: frame.name });
    if (prev.narrative !== frame.narrative) {
      changes.push({ kind: "narrative", from: prev.narrative, to: frame.narrative });
    }
    if (linkText(prev.link) !== linkText(frame.link)) {
      changes.push({ kind: "link", from: prev.link, to: frame.link });
    }
    if (changes.length) frames.changed.push({ before: prev, after: frame, changes });
  }
  for (const frame of before.frames) {
    if (!afterFrames.has(frame.id)) frames.removed.push(frame);
  }

  const empty =
    !nodes.added.length && !nodes.removed.length && !nodes.changed.length &&
    !edges.added.length && !edges.removed.length && !edges.changed.length &&
    !frames.added.length && !frames.removed.length && !frames.changed.length;
  return { nodes, edges, frames, empty };
}

// ---------------------------------------------------------------------------
// the changelog
// ---------------------------------------------------------------------------

const q = (s: string | null) => (s === null ? "—" : `'${s.replace(/\s+/g, " ").trim()}'`);

function nameOf(node: { label: string | null; id: string }): string {
  return node.label ? node.label.replace(/\s+/g, " ").trim() : node.id;
}

/**
 * A link changing is the element pointing somewhere else (D95) — said as
 * the target, because the path is what a reviewer checks.
 */
function describeLinkChange(change: { from: SceneLink | null; to: SceneLink | null }): string {
  const from = linkText(change.from);
  const to = linkText(change.to);
  if (to === null) return `link → ${from} removed`;
  if (from === null) return `link → ${to} added`;
  return `link → ${from} → ${to}`;
}

function describeNodeChange(change: NodeChange): string {
  switch (change.kind) {
    case "label":
      return `renamed ${q(change.from)} → ${q(change.to)}`;
    case "moved":
      return "moved";
    case "resized":
      return "resized";
    case "frame":
      return `moved to frame ${change.to ?? "—"}`;
    case "kind":
      return `kind ${q(change.from)} → ${q(change.to)}`;
    case "tags":
      return [
        ...change.added.map((t) => `tag +${t}`),
        ...change.removed.map((t) => `tag −${t}`),
      ].join(", ");
    case "intents":
      return [
        ...change.added.map((t) => `intent added ${q(t)}`),
        ...change.removed.map((t) => `intent removed ${q(t)}`),
      ].join(", ");
    case "logic":
      return change.to === null ? "logic removed" : change.from === null ? "logic added" : "logic changed";
    case "detail":
      return change.to === null ? "detail layer unlinked" : change.from === null ? "detail layer linked" : "detail layer relinked";
    case "link":
      return describeLinkChange(change);
  }
}

function describeEdgeChange(change: EdgeChange, names: (id: string | null) => string): string {
  switch (change.kind) {
    case "rewired":
      return `rewired ${names(change.from.from)} → ${names(change.from.to)} to ${names(change.to.from)} → ${names(change.to.to)}`;
    case "label":
      return `relabeled ${q(change.from)} → ${q(change.to)}`;
    case "intents":
      return [
        ...change.added.map((t) => `intent added ${q(t)}`),
        ...change.removed.map((t) => `intent removed ${q(t)}`),
      ].join(", ");
    case "logic":
      return change.to === null ? "logic removed" : change.from === null ? "logic added" : "logic changed";
    case "refined":
      return "refinement changed";
    case "link":
      return describeLinkChange(change);
  }
}

function describeFrameChange(change: FrameChange): string {
  switch (change.kind) {
    case "renamed":
      return `frame renamed from ${q(change.from)}`;
    case "narrative":
      return change.to === null ? "narrative removed" : "narrative changed";
    case "link":
      return describeLinkChange(change);
  }
}

/**
 * The changelog: one line per frame (Layer 1 components without a frame
 * fall under "Layer 1"), changes separated by semicolons, in a fixed
 * order — added, removed, changed; components, then edges; then frame
 * renames and narratives. Empty diff → empty string.
 */
export function changelog(diff: SceneDiff, after: SceneGraph, before: SceneGraph): string {
  if (diff.empty) return "";
  const frameName = (graph: SceneGraph, frameId: string | null) =>
    frameId ? (graph.frames.find((f) => f.id === frameId)?.name ?? frameId) : "Layer 1";
  const nodeName = (graph: SceneGraph) => (id: string | null) => {
    if (!id) return "—";
    const node = graph.nodes.find((n) => n.id === id);
    return node ? nameOf(node) : id;
  };
  const byFrame = new Map<string, string[]>();
  const push = (frame: string, text: string) => {
    const list = byFrame.get(frame) ?? [];
    list.push(text);
    byFrame.set(frame, list);
  };
  for (const node of diff.nodes.added) push(frameName(after, node.frameId), `+${nameOf(node)}`);
  for (const node of diff.nodes.removed) push(frameName(before, node.frameId), `−${nameOf(node)}`);
  for (const { after: node, changes } of diff.nodes.changed) {
    push(frameName(after, node.frameId), `${nameOf(node)}: ${changes.map(describeNodeChange).join(", ")}`);
  }
  const afterNames = nodeName(after);
  const beforeNames = nodeName(before);
  for (const edge of diff.edges.added) {
    push(frameName(after, edge.frameId), `+edge ${afterNames(edge.from)} → ${afterNames(edge.to)}`);
  }
  for (const edge of diff.edges.removed) {
    push(frameName(before, edge.frameId), `−edge ${beforeNames(edge.from)} → ${beforeNames(edge.to)}`);
  }
  for (const { after: edge, changes } of diff.edges.changed) {
    push(
      frameName(after, edge.frameId),
      `edge ${afterNames(edge.from)} → ${afterNames(edge.to)}: ${changes.map((c) => describeEdgeChange(c, afterNames)).join(", ")}`,
    );
  }
  for (const frame of diff.frames.added) push(frame.name, "frame added");
  for (const frame of diff.frames.removed) push(frame.name, "frame removed");
  for (const { after: frame, changes } of diff.frames.changed) {
    for (const change of changes) push(frame.name, describeFrameChange(change));
  }
  return [...byFrame.entries()]
    .map(([frame, items]) => `${frame}: ${items.join("; ")}`)
    .join("\n");
}

/** Diff two snapshots and render the changelog in one call. */
export function describeChange(beforeSnapshot: SceneSnapshot, afterSnapshot: SceneSnapshot): {
  diff: SceneDiff;
  changelog: string;
} {
  const before = buildSceneGraph(beforeSnapshot);
  const after = buildSceneGraph(afterSnapshot);
  const diff = diffGraphs(before, after);
  return { diff, changelog: changelog(diff, after, before) };
}

/**
 * The picture, not the meaning: a component that only moved or was resized
 * changed how the diagram is drawn, not what it says. Everything else this
 * file reports — a component or edge or frame added, removed, relabelled,
 * rewired, re-kinded, re-tagged, re-intented, its logic, its narrative, its
 * detail link, its scene link, its frame — is meaning.
 */
const GEOMETRY = new Set<NodeChange["kind"]>(["moved", "resized"]);

/**
 * The meaning-only view of a diff (D73): the same diff with the purely
 * geometric changes dropped. This is what "a tidy changed nothing" is
 * measured against — a formatter that may not move anything could not
 * format, and D73's list of what must be untouched (components, edges,
 * frames, labels, kinds, intents, logic, narratives, the legend) is
 * exactly what survives this filter.
 */
export function meaningOnly(diff: SceneDiff): SceneDiff {
  const changed = diff.nodes.changed
    .map((entry) => ({ ...entry, changes: entry.changes.filter((c) => !GEOMETRY.has(c.kind)) }))
    .filter((entry) => entry.changes.length > 0);
  const nodes = { ...diff.nodes, changed };
  const empty =
    !nodes.added.length && !nodes.removed.length && !nodes.changed.length &&
    !diff.edges.added.length && !diff.edges.removed.length && !diff.edges.changed.length &&
    !diff.frames.added.length && !diff.frames.removed.length && !diff.frames.changed.length;
  return { ...diff, nodes, empty };
}

/**
 * What a change did to the diagram's *meaning* (D73): the changelog with
 * the geometry filtered out. Empty is the guarantee a tidy asserts.
 */
export function describeMeaningChange(beforeSnapshot: SceneSnapshot, afterSnapshot: SceneSnapshot): {
  diff: SceneDiff;
  changelog: string;
} {
  const before = buildSceneGraph(beforeSnapshot);
  const after = buildSceneGraph(afterSnapshot);
  const diff = meaningOnly(diffGraphs(before, after));
  return { diff, changelog: changelog(diff, after, before) };
}
