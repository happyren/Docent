/**
 * Placement (S19, D60): the one thing an agent is worst at and Docent is
 * best at. Sizes come from labels; new components go into free space
 * inside their frame after what feeds them; frames grow to fit; new
 * frames go to free canvas space. A layered layout re-flows a frame only
 * when asked. Pure and deterministic (I3).
 */
import type { SnapshotElement } from "../adapter/snapshot";
import type { GraphEdge, GraphNode } from "../scene/graph";
import type { Shape } from "./style";

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

/** Labels longer than this wrap rather than stretch the shape (D66). */
export const WRAP_AT = 22;

/** The lines a label takes at the wrap width — what Excalidraw will wrap it to. */
export function wrapLabel(label: string, at = WRAP_AT): string[] {
  const lines: string[] = [];
  for (const para of label.split("\n")) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (line && (line + " " + word).length > at) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Excalifont at 20px runs about 0.72em per character on average. */
export const CHAR_EM = 0.72;
/** The room a shape keeps around its text, before the shape's own growth. */
const PAD_X = 28;
const PAD_Y = 22;
/** Ellipses and diamonds need room beyond the text's box. */
const growFor = (shape: Shape): number => (shape === "rectangle" ? 1 : shape === "ellipse" ? 1.4 : 1.7);
const widthFor = (chars: number, fontSize: number, shape: Shape): number =>
  Math.max(MIN_W, Math.ceil((chars * (fontSize * CHAR_EM) + 2 * PAD_X) * growFor(shape) / 10) * 10);
const heightFor = (lines: number, fontSize: number, shape: Shape): number =>
  Math.max(MIN_H, Math.ceil((Math.max(1, lines) * fontSize * 1.25 + 2 * PAD_Y) * growFor(shape) / 10) * 10);

/** A shape sized to its label at the given font, within the house minimums. */
export function sizeForLabel(label: string | null, fontSize: number, shape: Shape): Size {
  const lines = wrapLabel(label ?? "");
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  return { width: widthFor(longest, fontSize, shape), height: heightFor(lines.length, fontSize, shape) };
}

/**
 * How many characters fit across a shape of this width — the inverse of
 * the metric `sizeForLabel` sizes by, so a label handed a width can be
 * wrapped to it (D80).
 */
export function charsAtWidth(width: number, fontSize: number, shape: Shape): number {
  return Math.max(1, Math.floor((width / growFor(shape) - 2 * PAD_X) / (fontSize * CHAR_EM)));
}

/**
 * A shape held to `width`, as tall as its label needs once wrapped to it:
 * a label longer than its kind's shared width wraps taller rather than
 * widening every sibling (D80).
 */
export function sizeAtWidth(label: string | null, fontSize: number, shape: Shape, width: number): Size {
  const lines = wrapLabel(label ?? "", charsAtWidth(width, fontSize, shape));
  return { width, height: heightFor(lines.length, fontSize, shape) };
}

/**
 * The width the longest single word of a label needs — the floor a kind's
 * shared width never goes under, since no wrapping can break a word (D80).
 */
export function widestWordWidth(label: string | null, fontSize: number, shape: Shape): number {
  const words = (label ?? "").split(/\s+/).filter(Boolean);
  return widthFor(words.reduce((n, w) => Math.max(n, w.length), 0), fontSize, shape);
}

/** Edge labels wrap a little wider than shape labels: they sit on a line, not in a box. */
export const EDGE_WRAP_AT = 28;

/**
 * The room an edge label takes at the edge font — what the gap it sits in
 * must be at least (D70). Zero for no label.
 */
export function edgeLabelSize(label: string | null | undefined, fontSize: number): Size {
  const text = (label ?? "").trim();
  if (!text) return { width: 0, height: 0 };
  const lines = wrapLabel(text, EDGE_WRAP_AT);
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  return { width: Math.ceil(longest * fontSize * 0.72) + 24, height: Math.ceil(lines.length * fontSize * 1.25) + 12 };
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
  /** Nothing goes above this line — the legend's bottom on Layer 1 (D69). */
  floor: number | null = null,
  /** The gap kept from the anchor — at least the label of the edge between them (D70). */
  gapX: number = GAP_X,
): Box {
  const origin = frame
    ? { x: frame.x + FRAME_PAD, y: frame.y + FRAME_HEAD + FRAME_PAD }
    : occupied.length
      ? { x: Math.min(...occupied.map((b) => b.x)), y: Math.min(...occupied.map((b) => b.y)) }
      : { x: 0, y: 0 };
  if (floor !== null && origin.y < floor) origin.y = floor;
  const right = frame ? frame.x + frame.width - FRAME_PAD : Number.POSITIVE_INFINITY;
  const fits = (box: Box) => !occupied.some((o) => overlaps(o, box, Math.min(GAP_X, GAP_Y) / 2));

  // Preferred: right of the anchor, same row; then below it.
  if (anchor) {
    const gap = Math.max(GAP_X, gapX);
    const candidates: Box[] = [
      { x: anchor.x + anchor.width + gap, y: anchor.y, ...size },
      { x: anchor.x, y: anchor.y + anchor.height + GAP_Y, ...size },
      { x: anchor.x + anchor.width + gap, y: anchor.y + anchor.height + GAP_Y, ...size },
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
  for (const y of [...rows].filter((r) => floor === null || r >= floor).sort((a, b) => a - b)) {
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
 * A component's label and the font and shape it is drawn in (D80).
 */
export interface LabelDraw {
  text: string;
  fontSize: number;
  shape: Shape;
}

/**
 * A layered layout of a frame's components by their edges, the Sugiyama
 * pipeline whole (D74): take the returns out of a cycle first — the edges
 * that close one when the graph is walked in the order it was authored
 * (D79) — then rank by the longest path from a source (left to right);
 * order within each rank by repeated median sweeps — down, then back up, a
 * transpose pass after each — until a full sweep stops taking crossings
 * out; then place along the cross axis by Brandes–Köpf, which straightens
 * an edge between neighbouring ranks wherever it can and sits a component
 * on the median of what it joins. Ties break by authored order then id, so
 * two runs of one diagram give one picture (I3). The gap between two
 * columns is at least the widest edge label that sits in it (D70), and a
 * flow of more than `TURN_AFTER` ranks folds into bands that alternate
 * direction (D71) — the map posture's fold, which a straight posture
 * skips (D90). Returns new boxes at the frame's origin; the caller grows
 * the frame.
 */
export interface LayoutOptions {
  /** The room an edge's label takes; nothing when absent. */
  labelSize?: (edge: GraphEdge) => Size;
  /**
   * A component's kind, when the caller can say. Given it, components of
   * one kind share a width and every component in a rank shares one
   * height (D74, D80) — so the boxes that come back carry sizes, not only
   * places, and the caller writes both.
   */
  kindOf?: (id: string) => string | null;
  /**
   * A component's label, when the caller can say. Given it, the shared
   * width of a kind is its typical label's and a longer label wraps
   * taller instead of widening its siblings (D80).
   */
  labelOf?: (id: string) => LabelDraw | null;
  /**
   * The order the components were authored in — the batch's creation
   * order for a frame the agent built. It decides which edge of a cycle
   * is the return (D79) and breaks every tie. Position order (y, then x,
   * then id) when the caller cannot say.
   */
  order?: (id: string) => number;
  /**
   * The posture the genre asks for (D90). "map" — the default — folds a
   * long flow into bands (D71); "straight" never folds, so a flow of any
   * length stays one left-to-right line of ranks, because a time axis
   * must not turn back on itself. One option on one pipeline, never a
   * second engine (I3, I7).
   */
  posture?: "map" | "straight";
}

/**
 * The order the components were authored in, as dense indices: the
 * caller's when it can say, position order otherwise (D79) — left to
 * right first, since that is the way a flow is drawn, by the centre so a
 * taller component in a row does not come first for its lower top, then
 * top to bottom.
 */
function authoredOrder(nodes: readonly GraphNode[], order?: (id: string) => number): Map<string, number> {
  const byId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cx = (n: GraphNode) => n.bounds.x + n.bounds.width / 2;
  const cy = (n: GraphNode) => n.bounds.y + n.bounds.height / 2;
  const sorted = [...nodes].sort(
    order
      ? (a, b) => order(a.id) - order(b.id) || byId(a, b)
      : (a, b) => cx(a) - cx(b) || cy(a) - cy(b) || byId(a, b),
  );
  return new Map(sorted.map((n, i) => [n.id, i]));
}

/**
 * The edges that close a cycle (D79): the graph is walked depth-first in
 * the order the components were authored, out-neighbours in that order
 * too, and an edge reaching a component still on the stack is the return.
 * Their ids come back. A return takes no part in ranking or in ordering —
 * the router draws it over or under the row (D78) — so `a → b → c` with a
 * `c → a` still reads a, b, c. Self-loops are not a cycle the layout can
 * draw and are left out.
 */
export function backEdges(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  order?: (id: string) => number,
): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  const at = authoredOrder(nodes, order);
  const out = new Map<string, { to: string; edge: string }[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!e.from || !e.to || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push({ to: e.to, edge: e.id });
  }
  for (const list of out.values()) {
    list.sort((a, b) => at.get(a.to)! - at.get(b.to)! || (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
  }
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const walk = (id: string): void => {
    state.set(id, "open");
    for (const { to, edge } of out.get(id)!) {
      const seen = state.get(to);
      if (seen === "open") back.add(edge);
      else if (seen === undefined) walk(to);
    }
    state.set(id, "done");
  };
  for (const n of [...nodes].sort((a, b) => at.get(a.id)! - at.get(b.id)!)) if (!state.has(n.id)) walk(n.id);
  return back;
}

/** A flow longer than this many ranks turns (D71). */
export const TURN_AFTER = 5;

/** Ordering sweeps before the order is taken as settled (D74). */
const MAX_SWEEPS = 24;

/** Columns per band for a flow of `ranks` ranks: the smallest balanced fold. */
export function columnsPerBand(ranks: number): number {
  if (ranks <= TURN_AFTER) return Math.max(1, ranks);
  return Math.ceil(Math.sqrt(2 * ranks));
}

/**
 * A place in a rank: a component, or a dummy standing in for an edge
 * passing through on its way further along. Dummies are ordered and
 * placed like everything else — that is what keeps a long edge straight
 * and pushes the components it passes off its line.
 */
interface Slot {
  id: string;
  dummy: boolean;
  size: Size;
  /** Stable tie-break: position order for a component, its feeder's for a dummy. */
  tie: number;
  /** Neighbours one rank back and one rank on. */
  up: Slot[];
  down: Slot[];
  /** Where it currently sits in its rank. */
  index: number;
}

/** The room kept after a slot: half of it after a dummy, which is only a line. */
const gapAfterSlot = (slot: Slot): number => (slot.dummy ? GAP_Y / 2 : GAP_Y);

/** What two neighbours in a rank must keep between their centres. */
const separation = (first: Slot, second: Slot): number =>
  first.size.height / 2 + gapAfterSlot(first) + second.size.height / 2;

/**
 * The weighted median of a slot's neighbour positions (Gansner et al.);
 * -1 when it has none in the rank being read, and such a slot stays put.
 */
function medianPosition(positions: readonly number[]): number {
  if (!positions.length) return -1;
  const p = [...positions].sort((a, b) => a - b);
  const m = Math.floor(p.length / 2);
  if (p.length % 2 === 1) return p[m];
  if (p.length === 2) return (p[0] + p[1]) / 2;
  const left = p[m - 1] - p[0];
  const right = p[p.length - 1] - p[m];
  return left + right === 0 ? (p[m - 1] + p[m]) / 2 : (p[m - 1] * right + p[m] * left) / (left + right);
}

function inversions(pairs: readonly (readonly [number, number])[]): number {
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) count += 1;
    }
  }
  return count;
}

/**
 * How many pairs of edges between two neighbouring ranks cross, given the
 * order of each rank — the number the sweeps bring down (D74). `links`
 * names each edge by the id it leaves in the upper rank and the one it
 * enters in the lower.
 */
export function crossingsBetweenLayers(
  upper: readonly string[],
  lower: readonly string[],
  links: readonly (readonly [string, string])[],
): number {
  const above = new Map(upper.map((id, i) => [id, i]));
  const below = new Map(lower.map((id, i) => [id, i]));
  const pairs: [number, number][] = [];
  for (const [a, b] of links) {
    const i = above.get(a);
    const j = below.get(b);
    if (i !== undefined && j !== undefined) pairs.push([i, j]);
  }
  return inversions(pairs);
}

/** The crossings between a rank and the one after it, as the slots stand. */
function crossingsAfter(upper: readonly Slot[]): number {
  const pairs: [number, number][] = [];
  for (const u of upper) for (const v of u.down) pairs.push([u.index, v.index]);
  return inversions(pairs);
}

function totalCrossings(ranks: readonly Slot[][]): number {
  let total = 0;
  for (let r = 0; r + 1 < ranks.length; r++) total += crossingsAfter(ranks[r]);
  return total;
}

/**
 * What two neighbours in a rank cost, in this order: every pair of their
 * segments whose other ends are the other way round. Swapping the two
 * changes nothing else, so this is the whole question a transpose asks.
 */
function pairCrossings(first: Slot, second: Slot): number {
  let count = 0;
  for (const u of first.up) for (const v of second.up) if (u.index > v.index) count += 1;
  for (const u of first.down) for (const v of second.down) if (u.index > v.index) count += 1;
  return count;
}

function reindex(ranks: readonly Slot[][]): void {
  for (const rank of ranks) {
    rank.forEach((slot, i) => {
      slot.index = i;
    });
  }
}

/**
 * One sweep: every rank re-ordered by the weighted median of what it joins
 * in the rank the sweep came from, barycentre breaking a tie and position
 * order breaking that.
 */
function medianSweep(ranks: readonly Slot[][], downward: boolean): void {
  const visit = downward
    ? ranks.map((_, r) => r).slice(1)
    : ranks.map((_, r) => r).slice(0, -1).reverse();
  for (const r of visit) {
    const rank = ranks[r];
    const keys = new Map<Slot, { median: number; bary: number; here: number }>();
    rank.forEach((slot, i) => {
      const near = (downward ? slot.up : slot.down).map((n) => n.index);
      const bary = near.length ? near.reduce((sum, n) => sum + n, 0) / near.length : -1;
      keys.set(slot, { median: medianPosition(near), bary, here: i });
    });
    rank.sort((a, b) => {
      const ka = keys.get(a)!;
      const kb = keys.get(b)!;
      const pa = ka.median < 0 ? ka.here : ka.median;
      const pb = kb.median < 0 ? kb.here : kb.median;
      return pa - pb || ka.bary - kb.bary || a.tie - b.tie;
    });
    rank.forEach((slot, i) => {
      slot.index = i;
    });
  }
}

/**
 * The transpose pass: neighbouring slots swap whenever the swap costs
 * fewer crossings, left to right, until nothing improves. It catches what
 * the medians cannot see.
 */
function transpose(ranks: readonly Slot[][]): void {
  let improved = true;
  let guard = 0;
  while (improved && guard++ < MAX_SWEEPS) {
    improved = false;
    for (let r = 0; r < ranks.length; r++) {
      const rank = ranks[r];
      for (let i = 0; i + 1 < rank.length; i++) {
        if (pairCrossings(rank[i], rank[i + 1]) <= pairCrossings(rank[i + 1], rank[i])) continue;
        [rank[i], rank[i + 1]] = [rank[i + 1], rank[i]];
        rank[i].index = i;
        rank[i + 1].index = i + 1;
        improved = true;
      }
    }
  }
}

/** Sweeps down and up with a transpose after each, keeping the best order seen. */
function orderRanks(ranks: readonly Slot[][]): void {
  reindex(ranks);
  let best = ranks.map((rank) => [...rank]);
  let fewest = totalCrossings(ranks);
  let stale = 0;
  for (let sweep = 0; sweep < MAX_SWEEPS && fewest > 0; sweep++) {
    medianSweep(ranks, sweep % 2 === 0);
    transpose(ranks);
    const count = totalCrossings(ranks);
    if (count < fewest) {
      fewest = count;
      best = ranks.map((rank) => [...rank]);
      stale = 0;
    } else if (++stale >= 2) {
      // A sweep down and one back up with nothing gained: this is the order.
      break;
    }
  }
  ranks.forEach((rank, r) => rank.splice(0, rank.length, ...best[r]));
  reindex(ranks);
}

const segmentKey = (upper: Slot, lower: Slot): string => `${upper.id} ${lower.id}`;

/**
 * Type-1 conflicts: a segment between two dummies is a long edge passing
 * through, and Brandes–Köpf will not bend one of those for an ordinary
 * edge. The segments that cross one are marked here and refused alignment.
 */
function markConflicts(ranks: readonly Slot[][]): Set<string> {
  const marked = new Set<string>();
  for (let r = 0; r + 1 < ranks.length; r++) {
    const upper = ranks[r];
    const lower = ranks[r + 1];
    let k0 = 0;
    let l = 0;
    for (let l1 = 0; l1 < lower.length; l1++) {
      const v = lower[l1];
      const inner = v.dummy ? v.up.find((u) => u.dummy) : undefined;
      if (l1 !== lower.length - 1 && !inner) continue;
      const k1 = inner ? inner.index : upper.length - 1;
      for (; l <= l1; l++) {
        for (const u of lower[l].up) {
          if (u.index < k0 || u.index > k1) marked.add(segmentKey(u, lower[l]));
        }
      }
      k0 = k1;
    }
  }
  return marked;
}

/** One of Brandes–Köpf's four readings of the ranks. */
interface Alignment {
  /** The ranks in the order this reading walks them, each rank in its own order. */
  ranks: Slot[][];
  /** Which walked rank a slot sits in, and where in it. */
  depth: Map<Slot, number>;
  index: Map<Slot, number>;
  /** The distance to keep between items i and i+1 of `ranks[d]`. */
  gap: number[][];
  /** What a slot aligns to: its neighbours in the rank already walked. */
  behind: (slot: Slot) => Slot[];
  /** Whether that segment is a marked type-1 conflict. */
  conflicted: (slot: Slot, neighbour: Slot) => boolean;
}

/**
 * One alignment: blocks of slots that want the same coordinate, pressed
 * as close to the start of the axis as their rank neighbours allow.
 */
function alignAndCompact(view: Alignment): Map<Slot, number> {
  const all: Slot[] = [];
  const root = new Map<Slot, Slot>();
  const align = new Map<Slot, Slot>();
  for (const rank of view.ranks) {
    for (const v of rank) {
      all.push(v);
      root.set(v, v);
      align.set(v, v);
    }
  }
  for (let d = 1; d < view.ranks.length; d++) {
    let last = -1;
    for (const v of view.ranks[d]) {
      const near = [...view.behind(v)].sort((a, b) => view.index.get(a)! - view.index.get(b)!);
      if (!near.length) continue;
      const low = Math.floor((near.length - 1) / 2);
      const high = Math.ceil((near.length - 1) / 2);
      for (let m = low; m <= high && align.get(v) === v; m++) {
        const u = near[m];
        if (view.conflicted(v, u)) continue;
        const at = view.index.get(u)!;
        if (last >= at) continue;
        align.set(u, v);
        root.set(v, root.get(u)!);
        align.set(v, root.get(v)!);
        last = at;
      }
    }
  }
  const sink = new Map<Slot, Slot>(all.map((v) => [v, v]));
  const shift = new Map<Slot, number>(all.map((v) => [v, Number.POSITIVE_INFINITY]));
  const place = new Map<Slot, number>();
  const placeBlock = (v: Slot): void => {
    if (place.has(v)) return;
    place.set(v, 0);
    let w = v;
    do {
      const d = view.depth.get(w)!;
      const i = view.index.get(w)!;
      if (i > 0) {
        const u = root.get(view.ranks[d][i - 1])!;
        placeBlock(u);
        if (sink.get(v) === v) sink.set(v, sink.get(u)!);
        const gap = view.gap[d][i - 1];
        if (sink.get(v) !== sink.get(u)) {
          const su = sink.get(u)!;
          shift.set(su, Math.min(shift.get(su)!, place.get(v)! - place.get(u)! - gap));
        } else {
          place.set(v, Math.max(place.get(v)!, place.get(u)! + gap));
        }
      }
      w = align.get(w)!;
    } while (w !== v);
  };
  for (const v of all) if (root.get(v) === v) placeBlock(v);
  const out = new Map<Slot, number>();
  for (const v of all) {
    const block = root.get(v)!;
    const moved = shift.get(sink.get(block)!)!;
    out.set(v, place.get(block)! + (moved < Number.POSITIVE_INFINITY ? moved : 0));
  }
  return out;
}

/**
 * Brandes–Köpf coordinate assignment: four alignments — reading the ranks
 * down and up, each biased to the near side and the far side — balanced
 * by aligning them all to the narrowest and averaging the two middle
 * answers, so no single bias decides the picture. Returns the centre of
 * every slot on the cross axis (D74).
 */
function brandesKopf(ranks: readonly Slot[][]): Map<Slot, number> {
  const marked = markConflicts(ranks);
  const runs: { coords: Map<Slot, number>; nearSide: boolean }[] = [];
  for (const downward of [true, false]) {
    for (const nearSide of [true, false]) {
      const walked = downward ? [...ranks] : [...ranks].reverse();
      const depth = new Map<Slot, number>();
      const index = new Map<Slot, number>();
      const view: Alignment = {
        ranks: [],
        depth,
        index,
        gap: [],
        behind: downward ? (slot) => slot.up : (slot) => slot.down,
        conflicted: downward
          ? (slot, neighbour) => marked.has(segmentKey(neighbour, slot))
          : (slot, neighbour) => marked.has(segmentKey(slot, neighbour)),
      };
      walked.forEach((rank, d) => {
        const items = nearSide ? [...rank] : [...rank].reverse();
        items.forEach((slot, i) => {
          depth.set(slot, d);
          index.set(slot, i);
        });
        const gaps: number[] = [];
        for (let i = 0; i + 1 < items.length; i++) {
          // The room to keep is the room the rank's own order asks for,
          // whichever way this reading walks it.
          gaps.push(nearSide ? separation(items[i], items[i + 1]) : separation(items[i + 1], items[i]));
        }
        view.ranks.push(items);
        view.gap.push(gaps);
      });
      const coords = alignAndCompact(view);
      if (!nearSide) for (const [slot, value] of coords) coords.set(slot, -value);
      runs.push({ coords, nearSide });
    }
  }
  const extents = runs.map(({ coords }) => {
    const values = [...coords.values()];
    return { min: Math.min(...values), max: Math.max(...values) };
  });
  let narrowest = 0;
  for (let i = 1; i < extents.length; i++) {
    if (extents[i].max - extents[i].min < extents[narrowest].max - extents[narrowest].min) narrowest = i;
  }
  runs.forEach((run, i) => {
    const delta = run.nearSide ? extents[narrowest].min - extents[i].min : extents[narrowest].max - extents[i].max;
    if (delta) for (const [slot, value] of run.coords) run.coords.set(slot, value + delta);
  });
  const centre = new Map<Slot, number>();
  for (const rank of ranks) {
    for (const slot of rank) {
      const values = runs.map((run) => run.coords.get(slot)!).sort((a, b) => a - b);
      centre.set(slot, Math.round((values[1] + values[2]) / 2));
    }
  }
  // Four feasible placements averaged can leave two slots closer than the
  // room they must keep; one pass down each rank pushes them back apart.
  for (const rank of ranks) {
    for (let i = 1; i < rank.length; i++) {
      const least = centre.get(rank[i - 1])! + separation(rank[i - 1], rank[i]);
      if (centre.get(rank[i])! < least) centre.set(rank[i], least);
    }
  }
  return centre;
}

/** The middle of a list — the mean of the two middle ones when it is even. */
function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Shared sizes (D74, amended by D80): components of one kind are drawn
 * the width their *typical* label needs — the median of their natural
 * widths, never under the widest single word among them — and a member
 * whose label wants more keeps that width and wraps taller, so one long
 * label costs its own component a line instead of costing every sibling
 * half a screen. One of a kind keeps the size it came with. A rank still
 * shares one height, the tallest of its members once wrapped, so a column
 * reads as a row of peers.
 */
function sharedSizes(
  nodes: readonly GraphNode[],
  rank: ReadonlyMap<string, number>,
  sizes: ReadonlyMap<string, Size>,
  kindOf: (id: string) => string | null,
  labelOf?: (id: string) => LabelDraw | null,
): Map<string, Size> {
  const out = new Map<string, Size>(nodes.map((n) => [n.id, { ...(sizes.get(n.id) ?? { width: MIN_W, height: MIN_H }) }]));
  const kinds = new Map<string, string[]>();
  for (const n of nodes) {
    const kind = kindOf(n.id);
    if (!kind) continue;
    const list = kinds.get(kind);
    if (list) list.push(n.id);
    else kinds.set(kind, [n.id]);
  }
  for (const ids of kinds.values()) {
    // One of a kind has no peers to share with: it keeps its own size (D80).
    if (ids.length < 2) continue;
    const draw = (id: string) => labelOf?.(id) ?? null;
    // A label the caller cannot name cannot be re-wrapped either, so the
    // box it came with is both its natural width and its own floor.
    const natural = (id: string) => {
      const d = draw(id);
      return d ? sizeForLabel(d.text, d.fontSize, d.shape).width : out.get(id)!.width;
    };
    const floor = (id: string) => {
      const d = draw(id);
      return d ? widestWordWidth(d.text, d.fontSize, d.shape) : out.get(id)!.width;
    };
    const shared = Math.max(Math.ceil(median(ids.map(natural)) / 10) * 10, ...ids.map(floor));
    for (const id of ids) {
      const d = draw(id);
      const size = out.get(id)!;
      const height = d ? Math.max(size.height, sizeAtWidth(d.text, d.fontSize, d.shape, shared).height) : size.height;
      out.set(id, { width: shared, height });
    }
  }
  const rows = new Map<number, string[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const list = rows.get(r);
    if (list) list.push(n.id);
    else rows.set(r, [n.id]);
  }
  for (const ids of rows.values()) {
    const height = Math.max(...ids.map((id) => out.get(id)!.height));
    for (const id of ids) out.set(id, { ...out.get(id)!, height });
  }
  return out;
}

/**
 * Longest-path ranks over the DAG left when the returns are taken out
 * (D74, D79): a component sits one rank past the furthest thing that
 * feeds it, walked in authored order so two runs rank one graph alike
 * (I3). Every posture ranks this way — lanes change the rows, never the
 * columns (D90).
 */
function longestPathRanks(
  byOrder: readonly GraphNode[],
  edges: readonly GraphEdge[],
  ids: ReadonlySet<string>,
  back: ReadonlySet<string>,
): Map<string, number> {
  const inn = new Map<string, string[]>(byOrder.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!e.from || !e.to || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    // A return takes no part in ranking (D79) — what is left is a DAG.
    if (back.has(e.id)) continue;
    inn.get(e.to)!.push(e.from);
  }
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const from of inn.get(id) ?? []) r = Math.max(r, rankOf(from) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of byOrder) rankOf(n.id);
  return rank;
}

/**
 * The edges a layout lays out, in one canonical order: everything between
 * two members that is neither a self-loop nor a return (D79), read
 * feeder-first by authored order — so the dummies they leave, and every
 * tie those dummies break, are the same whatever order they came in (I3).
 */
function forwardFlows(
  edges: readonly GraphEdge[],
  ids: ReadonlySet<string>,
  back: ReadonlySet<string>,
  order: ReadonlyMap<string, number>,
): GraphEdge[] {
  return edges
    .filter((e) => e.from && e.to && ids.has(e.from) && ids.has(e.to) && e.from !== e.to && !back.has(e.id))
    .sort(
      (a, b) =>
        order.get(a.from!)! - order.get(b.from!)! ||
        order.get(a.to!)! - order.get(b.to!)! ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The label room each column gap must leave (D70), keyed by the rank the
 * gap follows: an edge one rank long puts its label in the gap it spans;
 * a longer one carries its label on a dummy instead.
 */
function labelGaps(
  flows: readonly GraphEdge[],
  rank: ReadonlyMap<string, number>,
  labelOf: (edge: GraphEdge) => Size,
): Map<number, number> {
  const gaps = new Map<number, number>();
  for (const e of flows) {
    const from = rank.get(e.from!)!;
    const to = rank.get(e.to!)!;
    if (Math.abs(to - from) !== 1) continue;
    const low = Math.min(from, to);
    gaps.set(low, Math.max(gaps.get(low) ?? 0, labelOf(e).width));
  }
  return gaps;
}

export function layeredLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  sizes: ReadonlyMap<string, Size>,
  origin: { x: number; y: number },
  options: LayoutOptions = {},
): Map<string, Box> {
  const ids = new Set(nodes.map((n) => n.id));
  // The order the flow was written in decides which edge of a cycle is the
  // return (D79); it also breaks every tie below, so one diagram gives one
  // picture (I3).
  const order = authoredOrder(nodes, options.order);
  const byOrder = [...nodes].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const back = backEdges(nodes, edges, options.order);
  const rank = longestPathRanks(byOrder, edges, ids, back);
  // A kind's shared width, a rank's shared height (D74, D80) — only when
  // the caller can name a kind, since nothing else knows what a peer is.
  const drawn = options.kindOf ? sharedSizes(byOrder, rank, sizes, options.kindOf, options.labelOf) : null;
  const sizeOf = (id: string): Size => drawn?.get(id) ?? sizes.get(id) ?? { width: MIN_W, height: MIN_H };
  // An edge that skips ranks gets a dummy in each rank it passes, so the
  // real components there are pushed off its line instead of under it.
  const layers = new Map<number, Slot[]>();
  const slotOf = new Map<string, Slot>();
  const push = (r: number, slot: Slot) => {
    const list = layers.get(r) ?? [];
    list.push(slot);
    layers.set(r, list);
    slotOf.set(slot.id, slot);
  };
  for (const n of byOrder) {
    const r = rank.get(n.id) ?? 0;
    push(r, { id: n.id, dummy: false, size: sizeOf(n.id), tie: order.get(n.id)!, up: [], down: [], index: 0 });
  }
  let dummies = 0;
  const labelOf = (e: GraphEdge): Size => options.labelSize?.(e) ?? { width: 0, height: 0 };
  const flows = forwardFlows(edges, ids, back, order);
  const gapAfter = labelGaps(flows, rank, labelOf);
  flows.forEach((e, at) => {
    const rf = rank.get(e.from!)!;
    const rt = rank.get(e.to!)!;
    if (rf === rt) return;
    // Every flow left runs forward — the returns were taken out (D79).
    const [low, high] = rt > rf ? [rf, rt] : [rt, rf];
    const label = labelOf(e);
    let previous = slotOf.get(rt > rf ? e.from! : e.to!)!;
    for (let r = low + 1; r < high; r++) {
      const slot: Slot = {
        id: `__dummy${dummies++}`,
        dummy: true,
        size: { width: 0, height: Math.max(Math.round(MIN_H / 2), label.height) },
        tie: previous.tie + 0.5 + at * 1e-6,
        up: [],
        down: [],
        index: 0,
      };
      push(r, slot);
      previous.down.push(slot);
      slot.up.push(previous);
      previous = slot;
    }
    const last = slotOf.get(rt > rf ? e.to! : e.from!)!;
    previous.down.push(last);
    last.up.push(previous);
  });
  const ranks = [...layers.keys()].sort((a, b) => a - b);
  const ordered = ranks.map((r) => layers.get(r)!);
  // Fewest crossings first (D74): sweep the order until it stops improving.
  orderRanks(ordered);
  const centre = brandesKopf(ordered);
  const columns = ranks.map((r, i) => ({
    rank: r,
    layer: ordered[i],
    width: Math.max(0, ...ordered[i].map((slot) => slot.size.width)),
    gap: Math.max(GAP_X, gapAfter.get(r) ?? 0),
  }));
  // Fold into bands (D71): left to right, then right to left beneath. A
  // straight posture takes them all in one band instead — a time axis must
  // not turn back on itself (D90).
  const perBand =
    options.posture === "straight" ? Math.max(1, columns.length) : columnsPerBand(columns.length);
  const result = new Map<string, Box>();
  let bandTop = origin.y;
  // Where the previous band's last column stood: the next band starts under it.
  let lastColumn = { left: origin.x, right: origin.x };
  for (let b = 0; b * perBand < columns.length; b++) {
    const band = columns.slice(b * perBand, (b + 1) * perBand);
    const bandWidth = band.reduce((w, c, i) => w + c.width + (i ? band[i - 1].gap : 0), 0);
    const slotsHere = band.flatMap((c) => c.layer);
    const top = Math.min(...slotsHere.map((slot) => centre.get(slot)! - slot.size.height / 2));
    const bottom = Math.max(...slotsHere.map((slot) => centre.get(slot)! + slot.size.height / 2));
    // A band moves as one piece, so what Brandes–Köpf lined up inside it
    // stays lined up; the band is what is centred on the row's axis (D74).
    const dy = bandTop - top;
    const reversed = b % 2 === 1;
    // A turned band runs right to left from under the column the flow
    // came from, never past the frame's left edge.
    let x = reversed ? Math.max(lastColumn.right, origin.x + bandWidth) : lastColumn.left;
    for (let i = 0; i < band.length; i++) {
      const column = band[i];
      if (reversed) x -= column.width;
      for (const slot of column.layer) {
        if (!slot.dummy) result.set(slot.id, { x, y: Math.round(centre.get(slot)! - slot.size.height / 2 + dy), ...slot.size });
      }
      lastColumn = { left: x, right: x + column.width };
      if (reversed) x -= i + 1 < band.length ? column.gap : 0;
      else x += column.width + (i + 1 < band.length ? column.gap : 0);
    }
    // Room under the band for the turning edge and its label.
    const turning = band[band.length - 1];
    const turnLabel = edges
      .filter((e) => e.from && e.to && !back.has(e.id) && rank.get(e.from) === turning.rank && rank.get(e.to) === turning.rank + 1)
      .reduce((h, e) => Math.max(h, labelOf(e).height), 0);
    bandTop += bottom - top + Math.max(GAP_Y * 2, turnLabel + 40);
  }
  return result;
}

/**
 * The room between two lanes (D90): the caller wraps each lane in a frame,
 * and a frame reaches FRAME_HEAD + FRAME_PAD above what it holds and
 * FRAME_PAD below, so this leaves the two frames 24 of clear air (D86).
 */
export const LANE_GAP = FRAME_HEAD + 2 * FRAME_PAD + 24;

/**
 * What the lanes posture needs beyond a layered layout (D90). The rest of
 * `LayoutOptions` means what it always did; `posture` alone plays no part,
 * since lanes are the posture and lanes never fold.
 */
export interface LaneLayoutOptions extends LayoutOptions {
  /** The lane a component belongs to; null when it names none. */
  laneOf: (id: string) => string | null;
  /** The lanes in declared order — the first is the top row. */
  lanes: readonly string[];
}

/**
 * The lanes posture (D90): the same pipeline read sideways. Rank still
 * runs left to right — the map's ranks, longest-path over the DAG the
 * returns leave behind (D74, D79) — but a component's row is its lane,
 * not what the crossing sweeps chose, so an event flow reads command →
 * event → read model with every context keeping its own row. Columns
 * never fold: this axis is time, and D71's turn is for maps. The column
 * discipline is unchanged — components of one kind share a width (D74,
 * D80), and a gap is at least the widest edge label sitting in it (D70).
 * Components sharing a (lane, rank) cell stack in authored order.
 * Deterministic (I3): there is no sweep to run, since the lane fixes
 * every row.
 */
export function laneLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  sizes: ReadonlyMap<string, Size>,
  origin: { x: number; y: number },
  options: LaneLayoutOptions,
): Map<string, Box> {
  const ids = new Set(nodes.map((n) => n.id));
  const order = authoredOrder(nodes, options.order);
  const byOrder = [...nodes].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const back = backEdges(nodes, edges, options.order);
  const rank = longestPathRanks(byOrder, edges, ids, back);
  const drawn = options.kindOf ? sharedSizes(byOrder, rank, sizes, options.kindOf, options.labelOf) : null;
  const sizeOf = (id: string): Size => drawn?.get(id) ?? sizes.get(id) ?? { width: MIN_W, height: MIN_H };
  const labelOf = (e: GraphEdge): Size => options.labelSize?.(e) ?? { width: 0, height: 0 };
  const gapAfter = labelGaps(forwardFlows(edges, ids, back, order), rank, labelOf);
  // A component whose lane was never declared — or which names none — is
  // neither dropped nor filed under a context it is not in: one extra row
  // beneath the declared lanes holds it, where the author can see it.
  const spare = options.lanes.length;
  const declared = new Map(options.lanes.map((name, i) => [name, i]));
  const laneOf = (id: string): number => {
    const name = options.laneOf(id);
    return (name === null ? undefined : declared.get(name)) ?? spare;
  };
  // Columns are the ranks, in order; every one of them is drawn.
  const columns = [...new Set(byOrder.map((n) => rank.get(n.id)!))].sort((a, b) => a - b);
  const columnWidth = new Map<number, number>();
  for (const n of byOrder) {
    const r = rank.get(n.id)!;
    columnWidth.set(r, Math.max(columnWidth.get(r) ?? 0, sizeOf(n.id).width));
  }
  const columnLeft = new Map<number, number>();
  let x = origin.x;
  for (const r of columns) {
    columnLeft.set(r, x);
    x += columnWidth.get(r)! + Math.max(GAP_X, gapAfter.get(r) ?? 0);
  }
  // What sits in one (lane, rank) cell, in authored order — `byOrder` is
  // already in it, so a stack needs no tie-break of its own.
  const cellKey = (lane: number, r: number): string => `${lane} ${r}`;
  const cells = new Map<string, string[]>();
  for (const n of byOrder) {
    const key = cellKey(laneOf(n.id), rank.get(n.id)!);
    const members = cells.get(key);
    if (members) members.push(n.id);
    else cells.set(key, [n.id]);
  }
  const stackHeight = (members: readonly string[]): number =>
    members.reduce((h, id, i) => h + sizeOf(id).height + (i ? GAP_Y : 0), 0);
  // A lane is as tall as its tallest stack; between two lanes goes the room
  // their frames need.
  const laneCount = spare + 1;
  const laneHeight = Array.from({ length: laneCount }, (_, lane) =>
    Math.max(0, ...columns.map((r) => stackHeight(cells.get(cellKey(lane, r)) ?? []))),
  );
  const laneTop: number[] = [];
  let y = origin.y;
  for (let lane = 0; lane < laneCount; lane++) {
    laneTop.push(y);
    y += laneHeight[lane] + LANE_GAP;
  }
  const result = new Map<string, Box>();
  for (let lane = 0; lane < laneCount; lane++) {
    for (const r of columns) {
      const members = cells.get(cellKey(lane, r));
      if (!members) continue;
      // The stack sits in the middle of its lane, so one component per
      // cell keeps a straight line along the lane however others stack.
      let top = laneTop[lane] + Math.round((laneHeight[lane] - stackHeight(members)) / 2);
      for (const id of members) {
        const size = sizeOf(id);
        result.set(id, { x: columnLeft.get(r)!, y: top, ...size });
        top += size.height + GAP_Y;
      }
    }
  }
  return result;
}

/** The boxes of a frame's live members — what placement must avoid. */
export function memberBoxes(elements: readonly SnapshotElement[], frameId: string | null): Box[] {
  return elements
    .filter(
      (el) =>
        el.frameId === frameId &&
        el.type !== "frame" &&
        !el.containerId &&
        el.type !== "arrow" &&
        // The legend's own drawing is not a member of anything (D69).
        el.docent.legend === null &&
        !el.docent.legendSample,
    )
    .map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }));
}

/**
 * The legend's area, padded — the one place nothing may be placed (D69).
 * Null when the scene has no legend.
 */
export function legendBox(elements: readonly SnapshotElement[]): Box | null {
  const parts = elements.filter((el) => el.docent.legend !== null || el.docent.legendSample);
  if (!parts.length) return null;
  const pad = 30;
  const minX = Math.min(...parts.map((p) => p.x)) - pad;
  const minY = Math.min(...parts.map((p) => p.y)) - pad;
  const maxX = Math.max(...parts.map((p) => p.x + p.width)) + pad;
  const maxY = Math.max(...parts.map((p) => p.y + p.height)) + pad;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Whether two segments cross (touching at an endpoint does not count). */
function segmentsCross(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const d = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * How many pairs of edges cross, taking each edge as the straight line
 * between its components' centres — what a reader's eye has to untangle
 * (D66). Edges sharing a component never count.
 */
export function countCrossings(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number {
  const centre = new Map(nodes.map((n) => [n.id, [n.bounds.x + n.bounds.width / 2, n.bounds.y + n.bounds.height / 2] as [number, number]]));
  const lines = edges
    .filter((e) => e.from && e.to && centre.has(e.from) && centre.has(e.to) && e.from !== e.to)
    .map((e) => ({ from: e.from!, to: e.to!, a: centre.get(e.from!)!, b: centre.get(e.to!)! }));
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i];
      const q = lines[j];
      if (p.from === q.from || p.from === q.to || p.to === q.from || p.to === q.to) continue;
      if (segmentsCross(p.a, p.b, q.a, q.b)) count += 1;
    }
  }
  return count;
}

/** What `separateFrames` is told about one frame. */
export interface FramePlacement {
  id: string;
  box: Box;
  /** Its tier: frames are kept apart within a tier, never across bands. */
  tier: number;
  /** Declared order index — the later frame is the one that moves. */
  order: number;
}

/** The gap two frames always keep (D86). */
export const FRAME_GAP = 60;

/**
 * Frames keep their distance (D86): within each tier, any two frames that
 * overlap — or sit closer than the gap — are parted by moving the one
 * later in the declared order, along the axis their centres already
 * differ on most, in the direction they already differ, so what is left
 * of what and what is above what stays true; the legend is immovable and
 * pushes frames the same way. Returns the moves, empty when nothing
 * overlaps. Deterministic (I3).
 */
export function separateFrames(
  frames: readonly FramePlacement[],
  legend: Box | null = null,
  gap = FRAME_GAP,
): Map<string, { dx: number; dy: number }> {
  const moved = new Map<string, { dx: number; dy: number }>();
  const boxes = new Map(frames.map((f) => [f.id, { ...f.box }]));
  const byTier = new Map<number, FramePlacement[]>();
  for (const f of frames) {
    const list = byTier.get(f.tier) ?? [];
    list.push(f);
    byTier.set(f.tier, list);
  }
  const centre = (b: Box): [number, number] => [b.x + b.width / 2, b.y + b.height / 2];
  // Only a true overlap is parted — a person's tighter-than-the-gap spacing
  // is theirs to keep — but what is parted is parted to the full gap.
  const TOUCH = 2;
  const apart = (a: Box, b: Box) =>
    a.x + a.width - TOUCH <= b.x || b.x + b.width - TOUCH <= a.x || a.y + a.height - TOUCH <= b.y || b.y + b.height - TOUCH <= a.y;
  const push = (fixed: Box, moving: Box): { dx: number; dy: number } => {
    const [cx, cy] = centre(fixed);
    const [mx, my] = centre(moving);
    const dxc = mx - cx;
    const dyc = my - cy;
    // The axis their centres differ on most, scaled by the pair's extent,
    // in the direction they already differ — below stays below, right of
    // stays right of.
    const horizontal = Math.abs(dxc) * (fixed.height + moving.height) >= Math.abs(dyc) * (fixed.width + moving.width);
    if (horizontal) {
      const dir = dxc >= 0 ? 1 : -1;
      return { dx: dir >= 0 ? fixed.x + fixed.width + gap - moving.x : fixed.x - gap - (moving.x + moving.width), dy: 0 };
    }
    const dir = dyc >= 0 ? 1 : -1;
    return { dx: 0, dy: dir >= 0 ? fixed.y + fixed.height + gap - moving.y : fixed.y - gap - (moving.y + moving.height) };
  };
  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const list = [...byTier.get(tier)!].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    // Bounded sweeps: each pass parts every overlapping pair once; a scene
    // of frames settles in a few.
    for (let sweep = 0; sweep < 12; sweep++) {
      let any = false;
      for (let j = 0; j < list.length; j++) {
        const b = boxes.get(list[j].id)!;
        if (tier === 1 && legend && !apart(legend, b)) {
          const d = push(legend, b);
          b.x += d.dx;
          b.y += d.dy;
          const total = moved.get(list[j].id) ?? { dx: 0, dy: 0 };
          moved.set(list[j].id, { dx: total.dx + d.dx, dy: total.dy + d.dy });
          any = true;
        }
        for (let i = 0; i < j; i++) {
          const a = boxes.get(list[i].id)!;
          if (apart(a, b)) continue;
          const d = push(a, b);
          b.x += d.dx;
          b.y += d.dy;
          const total = moved.get(list[j].id) ?? { dx: 0, dy: 0 };
          moved.set(list[j].id, { dx: total.dx + d.dx, dy: total.dy + d.dy });
          any = true;
        }
      }
      if (!any) break;
    }
  }
  return moved;
}

