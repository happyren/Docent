/**
 * The review plan (S16, D48): what to show for one changed scene. Takes
 * the semantic diff (D46) and turns it into crops — one per changed
 * frame, at the one rectangle both the before and the after picture are
 * rendered at — plus the marks to draw on each picture and the ghosts to
 * draw on the live overlay when the author flies to a change. Pure and
 * deterministic (I3): no canvas, no network, same inputs → same plan.
 */
import type { SceneSnapshot, SnapshotElement } from "../adapter/snapshot";
import { changelog, diffGraphs, type SceneDiff } from "../scene/diff";
import { buildSceneGraph, type SceneGraph } from "../scene/graph";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MarkKind = "added" | "changed" | "removed";

/** One rectangle to outline on a picture: added/changed on the after, removed on the before. */
export interface ReviewMark {
  id: string;
  kind: MarkKind;
  label: string;
  rect: Rect;
}

/** A removed entity drawn as a ghost on the live overlay (I2 — never written). */
export interface ReviewGhost {
  id: string;
  label: string;
  rect: Rect;
}

export interface ReviewCrop {
  /** Stable per frame: the frame's source id, or `layer-1` for unframed changes. */
  key: string;
  /** The frame's *source* id — what the adapter crops at — or null for Layer 1. */
  frameId: string | null;
  /** The frame's name as the changelog spells it — may be empty; "Layer 1" when unframed. */
  frameName: string;
  /** The identical rectangle before and after are rendered at. */
  rect: Rect;
  marks: ReviewMark[];
  ghosts: ReviewGhost[];
  /** The changelog items for this frame, one per change. */
  lines: string[];
}

export interface ReviewPlan {
  diff: SceneDiff;
  changelog: string;
  crops: ReviewCrop[];
}

/** Breathing room around the changed cluster, in scene units. */
const CROP_PAD = 48;
/** A crop never comes out smaller than this, so a one-line rename is still a picture. */
const MIN_CROP = 240;
export const LAYER_ONE_KEY = "layer-1";

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return { ...b };
  return { x, y, width: right - x, height: bottom - y };
}

/** The drawn extent of an element — a linear element's from its points. */
export function elementRect(el: SnapshotElement): Rect {
  if (el.points && el.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of el.points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { x: el.x + minX, y: el.y + minY, width: maxX - minX, height: maxY - minY };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

const clean = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() : "");

/** Plan the review of one scene. Either side may be absent: a new scene has no before, a deleted one no after. */
export function planReview(before: SceneSnapshot | null, after: SceneSnapshot | null): ReviewPlan {
  const empty: SceneSnapshot = { elements: [] };
  const beforeGraph = buildSceneGraph(before ?? empty);
  const afterGraph = buildSceneGraph(after ?? empty);
  const diff = diffGraphs(beforeGraph, afterGraph);
  const log = changelog(diff, afterGraph, beforeGraph);
  if (diff.empty) return { diff, changelog: log, crops: [] };

  const beforeEls = new Map((before ?? empty).elements.map((el) => [el.id, el]));
  const afterEls = new Map((after ?? empty).elements.map((el) => [el.id, el]));

  // Frames by graph id, on either side: the crop key is the *source* id so
  // it survives sanitization and names the frame the adapter crops at.
  const frameOf = (graph: SceneGraph, id: string | null) =>
    id ? (graph.frames.find((f) => f.id === id) ?? null) : null;

  interface Bucket {
    key: string;
    frameId: string | null;
    frameName: string;
    frameRect: Rect | null;
    marks: ReviewMark[];
    ghosts: ReviewGhost[];
    lines: string[];
    extent: Rect | null;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (graph: SceneGraph, frameGraphId: string | null): Bucket => {
    const frame = frameOf(graph, frameGraphId);
    const key = frame ? frame.sourceId : LAYER_ONE_KEY;
    let bucket = buckets.get(key);
    if (!bucket) {
      // The frame's rectangle is the union of both sides, so a frame that
      // grew still crops at one rectangle.
      const beforeFrame = beforeGraph.frames.find((f) => f.sourceId === key);
      const afterFrame = afterGraph.frames.find((f) => f.sourceId === key);
      let frameRect: Rect | null = null;
      if (beforeFrame) frameRect = union(frameRect, beforeFrame.bounds);
      if (afterFrame) frameRect = union(frameRect, afterFrame.bounds);
      bucket = {
        key,
        frameId: frame ? frame.sourceId : null,
        // Exactly the changelog's name for the frame, so its lines route here.
        frameName: frame ? frame.name : "Layer 1",
        frameRect,
        marks: [],
        ghosts: [],
        lines: [],
        extent: null,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  const mark = (bucket: Bucket, m: ReviewMark) => {
    bucket.marks.push(m);
    bucket.extent = union(bucket.extent, m.rect);
  };
  const nodeName = (graph: SceneGraph, id: string | null) => {
    if (!id) return "—";
    const node = graph.nodes.find((n) => n.id === id);
    return node ? clean(node.label) || node.id : id;
  };
  const edgeLabel = (graph: SceneGraph, edge: SceneGraph["edges"][number]) =>
    `${nodeName(graph, edge.from)} → ${nodeName(graph, edge.to)}`;
  const rectOfEdge = (els: Map<string, SnapshotElement>, sourceId: string, fallback: Rect | null) => {
    const el = els.get(sourceId);
    return el ? elementRect(el) : fallback;
  };

  for (const node of diff.nodes.added) {
    mark(bucketFor(afterGraph, node.frameId), {
      id: node.sourceId,
      kind: "added",
      label: clean(node.label) || node.id,
      rect: node.bounds,
    });
  }
  for (const node of diff.nodes.removed) {
    const bucket = bucketFor(beforeGraph, node.frameId);
    const label = clean(node.label) || node.id;
    mark(bucket, { id: node.sourceId, kind: "removed", label, rect: node.bounds });
    bucket.ghosts.push({ id: node.sourceId, label, rect: node.bounds });
  }
  for (const { before: prev, after: node } of diff.nodes.changed) {
    const bucket = bucketFor(afterGraph, node.frameId);
    mark(bucket, {
      id: node.sourceId,
      kind: "changed",
      label: clean(node.label) || node.id,
      rect: node.bounds,
    });
    // A component that moved is shown where it was, too — as a ghost.
    if (prev.frameId !== node.frameId || prev.bounds.x !== node.bounds.x || prev.bounds.y !== node.bounds.y) {
      const origin = bucketFor(beforeGraph, prev.frameId);
      if (origin !== bucket || Math.hypot(prev.bounds.x - node.bounds.x, prev.bounds.y - node.bounds.y) > 4) {
        const label = clean(prev.label) || prev.id;
        mark(origin, { id: `${node.sourceId}:was`, kind: "removed", label, rect: prev.bounds });
        origin.ghosts.push({ id: `${node.sourceId}:was`, label, rect: prev.bounds });
      }
    }
  }
  for (const edge of diff.edges.added) {
    const rect = rectOfEdge(afterEls, edge.sourceId, null);
    if (rect) mark(bucketFor(afterGraph, edge.frameId), { id: edge.sourceId, kind: "added", label: edgeLabel(afterGraph, edge), rect });
  }
  for (const edge of diff.edges.removed) {
    const rect = rectOfEdge(beforeEls, edge.sourceId, null);
    if (!rect) continue;
    const bucket = bucketFor(beforeGraph, edge.frameId);
    const label = edgeLabel(beforeGraph, edge);
    mark(bucket, { id: edge.sourceId, kind: "removed", label, rect });
    bucket.ghosts.push({ id: edge.sourceId, label, rect });
  }
  for (const { after: edge } of diff.edges.changed) {
    const rect = rectOfEdge(afterEls, edge.sourceId, null);
    if (rect) mark(bucketFor(afterGraph, edge.frameId), { id: edge.sourceId, kind: "changed", label: edgeLabel(afterGraph, edge), rect });
  }
  // Frame-level changes crop at the whole frame: there is no smaller area
  // that shows a rename, a narrative, or a frame that came or went.
  for (const frame of diff.frames.added) {
    const bucket = bucketFor(afterGraph, frame.id);
    bucket.extent = union(bucket.extent, frame.bounds);
  }
  for (const frame of diff.frames.removed) {
    const bucket = bucketFor(beforeGraph, frame.id);
    bucket.extent = union(bucket.extent, frame.bounds);
    bucket.ghosts.push({ id: frame.sourceId, label: frame.name || "frame", rect: frame.bounds });
  }
  for (const { after: frame } of diff.frames.changed) {
    const bucket = bucketFor(afterGraph, frame.id);
    bucket.extent = union(bucket.extent, frame.bounds);
  }

  // The changelog lines, routed to the frame they speak of by name — the
  // changelog names frames exactly as `frameName` does here.
  for (const line of log.split("\n")) {
    const colon = line.indexOf(": ");
    if (colon < 0) continue;
    const frameName = line.slice(0, colon);
    const items = line.slice(colon + 2).split("; ");
    const bucket = [...buckets.values()].find((b) => b.frameName === frameName);
    if (bucket) bucket.lines.push(...items);
  }

  const crops: ReviewCrop[] = [];
  for (const bucket of buckets.values()) {
    const extent = bucket.extent ?? bucket.frameRect;
    if (!extent) continue;
    let rect: Rect = {
      x: extent.x - CROP_PAD,
      y: extent.y - CROP_PAD,
      width: extent.width + CROP_PAD * 2,
      height: extent.height + CROP_PAD * 2,
    };
    if (rect.width < MIN_CROP) {
      rect = { ...rect, x: rect.x - (MIN_CROP - rect.width) / 2, width: MIN_CROP };
    }
    if (rect.height < MIN_CROP) {
      rect = { ...rect, y: rect.y - (MIN_CROP - rect.height) / 2, height: MIN_CROP };
    }
    // Clamped to the frame: a frame is the unit of reading (S10), and what
    // lies outside it is another frame's business.
    if (bucket.frameRect) rect = intersect(bucket.frameRect, rect);
    rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    crops.push({
      key: bucket.key,
      frameId: bucket.frameId,
      frameName: bucket.frameName,
      rect,
      marks: bucket.marks,
      ghosts: bucket.ghosts,
      lines: bucket.lines,
    });
  }
  crops.sort((a, b) => (a.key === LAYER_ONE_KEY ? -1 : b.key === LAYER_ONE_KEY ? 1 : a.frameName.localeCompare(b.frameName)));
  return { diff, changelog: log, crops };
}
