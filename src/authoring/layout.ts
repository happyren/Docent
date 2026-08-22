/**
 * Placement (S19, D60): the one thing an agent is worst at and Docent is
 * best at. Sizes come from labels; new components go into free space
 * inside their frame after what feeds them; frames grow to fit; new
 * frames go to free canvas space. A layered layout re-flows a frame only
 * when asked. Pure and deterministic (I3).
 */
import type { SnapshotElement } from "../adapter/snapshot";
import type { GraphEdge, GraphNode } from "../scene/graph";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Gaps in scene units. */
export const GAP_X = 60;
export const GAP_Y = 50;
export const FRAME_PAD = 40;
export const FRAME_HEAD = 36;
export const MIN_W = 150;
export const MIN_H = 70;

/** A shape sized to its label at the given font, within the house minimums. */
export function sizeForLabel(label: string | null, fontSize: number, shape: "rectangle" | "ellipse" | "diamond"): Size {
  const lines = (label ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  // Excalifont at 20px runs about 0.72em per character on average.
  const charW = fontSize * 0.72;
  const textW = longest * charW;
  const textH = Math.max(1, lines.length) * fontSize * 1.25;
  // Ellipses and diamonds need room beyond the text's box.
  const grow = shape === "rectangle" ? 1 : shape === "ellipse" ? 1.4 : 1.7;
  const width = Math.max(MIN_W, Math.ceil((textW + 2 * 28) * grow / 10) * 10);
  const height = Math.max(MIN_H, Math.ceil((textH + 2 * 22) * grow / 10) * 10);
  return { width, height };
}

function overlaps(a: Box, b: Box, pad = 0): boolean {
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

/**
 * Where a new component goes inside a frame: to the right of what feeds
 * it when that is known, else after the last row of content; always on
 * free space, scanning right then down. The frame's own bounds are a
 * preference, not a wall — the caller grows the frame to what comes back.
 */
export function placeInFrame(
  frame: Box | null,
  occupied: readonly Box[],
  size: Size,
  anchor: Box | null,
): Box {
  const origin = frame
    ? { x: frame.x + FRAME_PAD, y: frame.y + FRAME_HEAD + FRAME_PAD }
    : occupied.length
      ? { x: Math.min(...occupied.map((b) => b.x)), y: Math.min(...occupied.map((b) => b.y)) }
      : { x: 0, y: 0 };
  const right = frame ? frame.x + frame.width - FRAME_PAD : Number.POSITIVE_INFINITY;
  const fits = (box: Box) => !occupied.some((o) => overlaps(o, box, Math.min(GAP_X, GAP_Y) / 2));

  // Preferred: right of the anchor, same row; then below it.
  if (anchor) {
    const candidates: Box[] = [
      { x: anchor.x + anchor.width + GAP_X, y: anchor.y, ...size },
      { x: anchor.x, y: anchor.y + anchor.height + GAP_Y, ...size },
      { x: anchor.x + anchor.width + GAP_X, y: anchor.y + anchor.height + GAP_Y, ...size },
    ];
    for (const c of candidates) {
      if (fits(c) && c.x + c.width <= right + size.width) return c;
    }
  }
  // Otherwise: scan rows from the top of the content, left to right.
  const rows = new Set<number>([origin.y]);
  for (const o of occupied) {
    rows.add(o.y);
    rows.add(o.y + o.height + GAP_Y);
  }
  for (const y of [...rows].sort((a, b) => a - b)) {
    let x = origin.x;
    while (x + size.width <= right || x === origin.x) {
      const box = { x, y, ...size };
      if (fits(box)) return box;
      // Jump past whatever blocks this spot.
      const blockers = occupied.filter((o) => overlaps(o, box, Math.min(GAP_X, GAP_Y) / 2));
      const nextX = Math.max(...blockers.map((o) => o.x + o.width)) + GAP_X;
      if (!Number.isFinite(nextX) || nextX <= x) break;
      x = nextX;
      if (x + size.width > right && right !== Number.POSITIVE_INFINITY) break;
    }
  }
  // Below everything.
  const bottom = occupied.length ? Math.max(...occupied.map((o) => o.y + o.height)) + GAP_Y : origin.y;
  return { x: origin.x, y: bottom, ...size };
}

/** A frame grown (never shrunk) to hold the boxes with padding. */
export function growFrame(frame: Box, contents: readonly Box[]): Box {
  if (!contents.length) return frame;
  const minX = Math.min(frame.x, ...contents.map((b) => b.x - FRAME_PAD));
  const minY = Math.min(frame.y, ...contents.map((b) => b.y - FRAME_HEAD - FRAME_PAD));
  const maxX = Math.max(frame.x + frame.width, ...contents.map((b) => b.x + b.width + FRAME_PAD));
  const maxY = Math.max(frame.y + frame.height, ...contents.map((b) => b.y + b.height + FRAME_PAD));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Free canvas space for a new frame: below everything on the tier it
 * belongs to, left-aligned with it — the same place create-on-click puts
 * a detail frame.
 */
export function placeFrame(existing: readonly Box[], size: Size): Box {
  if (!existing.length) return { x: 0, y: 0, ...size };
  const minX = Math.min(...existing.map((b) => b.x));
  const maxY = Math.max(...existing.map((b) => b.y + b.height));
  return { x: minX, y: maxY + 140, ...size };
}

/**
 * A layered layout of a frame's components by their edges: rank by the
 * longest path from a source (left to right), order within a rank by the
 * mean rank-position of what feeds it (fewer crossings), stable
 * tie-breaks by current position then id. Returns new boxes at the
 * frame's origin; the caller grows the frame.
 */
export function layeredLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  sizes: ReadonlyMap<string, Size>,
  origin: { x: number; y: number },
): Map<string, Box> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const inn = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!e.from || !e.to || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(e.to);
    inn.get(e.to)!.push(e.from);
  }
  // Longest-path ranks over a DAG; back edges are broken by position order.
  const byPos = [...nodes].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || (a.id < b.id ? -1 : 1));
  const order = new Map(byPos.map((n, i) => [n.id, i]));
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const from of inn.get(id) ?? []) {
      // Only feeders earlier in position order count — the rest are back edges.
      if ((order.get(from) ?? 0) > (order.get(id) ?? 0) && (inn.get(from) ?? []).includes(id)) continue;
      r = Math.max(r, rankOf(from) + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of byPos) rankOf(n.id);
  const layers = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const list = layers.get(r) ?? [];
    list.push(n);
    layers.set(r, list);
  }
  const positionIn = new Map<string, number>();
  const result = new Map<string, Box>();
  let x = origin.x;
  for (const r of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(r)!;
    layer.sort((a, b) => {
      const bary = (n: GraphNode) => {
        const feeders = (inn.get(n.id) ?? []).filter((f) => positionIn.has(f));
        return feeders.length ? feeders.reduce((s, f) => s + positionIn.get(f)!, 0) / feeders.length : order.get(n.id)! + 1000;
      };
      return bary(a) - bary(b) || order.get(a.id)! - order.get(b.id)!;
    });
    let y = origin.y;
    let colW = 0;
    layer.forEach((n, i) => {
      const size = sizes.get(n.id) ?? { width: MIN_W, height: MIN_H };
      result.set(n.id, { x, y, ...size });
      positionIn.set(n.id, i);
      y += size.height + GAP_Y;
      colW = Math.max(colW, size.width);
    });
    x += colW + GAP_X;
  }
  return result;
}

/** The boxes of a frame's live members — what placement must avoid. */
export function memberBoxes(elements: readonly SnapshotElement[], frameId: string | null): Box[] {
  return elements
    .filter((el) => el.frameId === frameId && el.type !== "frame" && !el.containerId && el.type !== "arrow")
    .map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }));
}
