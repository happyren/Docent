/**
 * Edge routing (D72), edges that flow (D75), and an edge that reads as one
 * stroke (D78): an edge never cuts through a component, it leaves and
 * enters at a port spread along the side it uses, and when its straight
 * line is blocked the sides it leaves and enters are the pair that routes
 * cheapest — so a back edge along a row goes over it as a U rather than out
 * of the side facing its target and straight back down. The straight line
 * between two ports is kept when nothing lies on it; otherwise an
 * orthogonal path is found on the grid the obstacles' padded edges define —
 * fewest bends first, shortest second. The route is then simplified (jogs
 * collapsed, hairpins removed, no leg shorter than a corner), segments that
 * would run along one line are nudged apart, and every turn is drawn as an
 * explicit circular arc, so what Excalidraw draws is exactly the route.
 * Pure and deterministic (I3).
 */
import type { Box } from "./layout";

export type Point = [number, number];

/** Clearance kept between a routed edge and what it goes around. */
export const ROUTE_PAD = 24;
/** How far apart two routed segments that would share a line are pushed (D75). */
export const NUDGE = 12;
/** The radius a right-angle turn is rounded to (D75); less on a short leg. */
export const CORNER_RADIUS = 24;
/** Ports keep to this share of a side, centred — a corner never carries one (D75). */
export const PORT_SPAN = 0.7;
/** What one bend costs, in scene units of length. */
const BEND_COST = 80;
/** Obstacles farther than this from the pair's bounding box are not in the way. */
const REACH = 240;

function centre(b: Box): Point {
  return [b.x + b.width / 2, b.y + b.height / 2];
}

function pad(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

/** Whether a segment passes through the interior of a box (touching does not count). */
export function segmentThroughBox(a: Point, b: Point, box: Box, inset = 0): boolean {
  const x0 = box.x + inset;
  const y0 = box.y + inset;
  const x1 = box.x + box.width - inset;
  const y1 = box.y + box.height - inset;
  if (x1 <= x0 || y1 <= y0) return false;
  // Liang–Barsky clip of the open segment against the open box.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 - t0 > 1e-9;
}

/** Whether a polyline passes through a box's interior. */
export function polylineThroughBox(points: readonly Point[], box: Box, inset = 0): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    if (segmentThroughBox(points[i], points[i + 1], box, inset)) return true;
  }
  return false;
}

/** The obstacles that could lie between two boxes: near their joint bounds. */
export function obstaclesNear(from: Box, to: Box, all: readonly Box[]): Box[] {
  const minX = Math.min(from.x, to.x) - REACH;
  const minY = Math.min(from.y, to.y) - REACH;
  const maxX = Math.max(from.x + from.width, to.x + to.width) + REACH;
  const maxY = Math.max(from.y + from.height, to.y + to.height) + REACH;
  return all.filter((o) => o.x < maxX && o.x + o.width > minX && o.y < maxY && o.y + o.height > minY);
}

// ---------------------------------------------------------------------------
// ports: where an edge meets a component (D75)
// ---------------------------------------------------------------------------

export type Side = "top" | "right" | "bottom" | "left";

export interface Port {
  side: Side;
  /** Where the edge meets the component's own outline, in scene coordinates. */
  at: Point;
  /** The point just outside the padded side, where routing starts and ends. */
  outside: Point;
  /** The leg leaving the port: 0 = horizontal, 1 = vertical. */
  dir: 0 | 1;
}

export interface PortEnds {
  start: Port;
  end: Port;
}

export interface PortEdge {
  id: string;
  from: string;
  to: string;
}

/** A component as the port assignment sees it: a box and the shape drawn in it. */
export interface PortNode extends Box {
  shape?: string;
}

/**
 * Where the ray from a box's centre towards `to` leaves the shape drawn in
 * it — a rectangle's side, an ellipse's curve, a diamond's edge — so the
 * arrow meets the drawing and not its bounding box. The adapter draws with
 * the same rule; this is its pure twin, so the authoring layer sees the
 * polyline the reader will see.
 */
export function outlinePoint(box: Box, shape: string | undefined, to: Point): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = to[0] - cx;
  const dy = to[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const a = box.width / 2;
  const b = box.height / 2;
  let t: number;
  if (shape === "ellipse") {
    t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  } else if (shape === "diamond") {
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  } else {
    const sx = dx !== 0 ? a / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? b / Math.abs(dy) : Infinity;
    t = Math.min(sx, sy);
  }
  return [cx + dx * t, cy + dy * t];
}

/** The side of `box` that faces `to` — the side the straight line exits through. */
export function sideTowards(box: Box, to: Point): Side {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = to[0] - cx;
  const dy = to[1] - cy;
  if (dx === 0 && dy === 0) return "right";
  const sx = dx !== 0 ? box.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? box.height / 2 / Math.abs(dy) : Infinity;
  if (sx <= sy) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

/** The port at `pos` along `side`: its outline point, its padded point, its leg. */
function portAt(box: Box, shape: string | undefined, side: Side, pos: number, clearance: number): Port {
  const onBox: Point =
    side === "top" ? [pos, box.y]
    : side === "bottom" ? [pos, box.y + box.height]
    : side === "left" ? [box.x, pos]
    : [box.x + box.width, pos];
  const outside: Point =
    side === "top" ? [pos, box.y - clearance]
    : side === "bottom" ? [pos, box.y + box.height + clearance]
    : side === "left" ? [box.x - clearance, pos]
    : [box.x + box.width + clearance, pos];
  return { side, at: outlinePoint(box, shape, onBox), outside, dir: side === "left" || side === "right" ? 0 : 1 };
}

/** The sides in the order a tie between two equal routes is broken (D78). */
export const SIDE_ORDER: readonly Side[] = ["top", "right", "bottom", "left"];

/** The outward normal of each side — which way an edge leaves through it. */
const NORMAL: Record<Side, Point> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/** The middle of a side, in the coordinate the port is positioned along. */
function middleOf(box: Box, side: Side): number {
  return side === "top" || side === "bottom" ? box.x + box.width / 2 : box.y + box.height / 2;
}

/** The pair of sides an edge leaves and enters through. */
export interface SidePair {
  start: Side;
  end: Side;
}

/**
 * Ports for a set of edges (D75). Every edge leaves and enters through the
 * side that faces its other end — or, when `sides` names a pair chosen by
 * route cost (D78), through those — and the edges sharing one side are
 * spread evenly across the middle of it, in the order of their other ends
 * across the side's cross axis, so they arrive in the order they come from
 * and do not cross each other at the component. Ties break by edge id, so
 * two runs of the same diagram give one picture (I3).
 */
export function assignPorts(
  edges: readonly PortEdge[],
  nodes: ReadonlyMap<string, PortNode>,
  clearance = ROUTE_PAD,
  sides?: ReadonlyMap<string, SidePair>,
): Map<string, PortEnds> {
  interface Slot {
    edgeId: string;
    /** 0 = this is the edge's start, 1 = its end. */
    which: 0 | 1;
    node: string;
    side: Side;
    /** The other end's centre along the side's cross axis — the sort key. */
    across: number;
  }
  const groups = new Map<string, Slot[]>();
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to || edge.from === edge.to) continue;
    const a = centre(from);
    const b = centre(to);
    const pairs: [0 | 1, string, Box, Point][] = [
      [0, edge.from, from, b],
      [1, edge.to, to, a],
    ];
    for (const [which, nodeId, box, other] of pairs) {
      const picked = sides?.get(edge.id);
      const side = (which === 0 ? picked?.start : picked?.end) ?? sideTowards(box, other);
      const across = side === "top" || side === "bottom" ? other[0] : other[1];
      const key = `${side}:${nodeId}`;
      const list = groups.get(key) ?? [];
      list.push({ edgeId: edge.id, which, node: nodeId, side, across });
      groups.set(key, list);
    }
  }
  const half = new Map<string, { start?: Port; end?: Port }>();
  // Groups in a stable order, so the map is built the same way every run.
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!;
    list.sort((p, q) => p.across - q.across || (p.edgeId < q.edgeId ? -1 : p.edgeId > q.edgeId ? 1 : p.which - q.which));
    const node = nodes.get(list[0].node)!;
    const side = list[0].side;
    const along = side === "top" || side === "bottom" ? node.width : node.height;
    const middle = side === "top" || side === "bottom" ? node.x + node.width / 2 : node.y + node.height / 2;
    for (let i = 0; i < list.length; i++) {
      const pos = middle + ((i + 1) / (list.length + 1) - 0.5) * PORT_SPAN * along;
      const port = portAt(node, node.shape, side, pos, clearance);
      const slot = half.get(list[i].edgeId) ?? {};
      if (list[i].which === 0) slot.start = port;
      else slot.end = port;
      half.set(list[i].edgeId, slot);
    }
  }
  // Edges in the order they were given, so the result reads like the input.
  const out = new Map<string, PortEnds>();
  for (const edge of edges) {
    const slot = half.get(edge.id);
    if (slot?.start && slot.end) out.set(edge.id, { start: slot.start, end: slot.end });
  }
  return out;
}

export interface RouteOptions {
  /**
   * When set, the straight line is kept only if it heads outward from both
   * ports' sides. The sides were chosen by route cost (D78), so a line that
   * grazes along one of them is not the route that was costed.
   */
  leaveBySide?: boolean;
}

/**
 * The turning points of an edge from `from` to `to`, or null when the
 * straight line is clear. The points are in scene coordinates and all lie
 * outside both ends; the caller draws from each end's outline to the
 * nearest of them. Null also when no path exists on the grid, in which
 * case the straight line is all there is. With `ports` the path starts and
 * ends at the given ports (D75); without them, at the middle of a side, as
 * D72 alone did.
 */
export function routeEdge(
  from: Box,
  to: Box,
  obstacles: readonly Box[],
  clearance = ROUTE_PAD,
  ports?: PortEnds,
  options?: RouteOptions,
): Point[] | null {
  const near = obstaclesNear(from, to, obstacles).filter((o) => o !== from && o !== to);
  const a = centre(from);
  const b = centre(to);
  // Clear straight line: nothing to do. A near miss (inside the clearance)
  // is let through — it is what hand drawing does. The line tested is the
  // one that will be drawn: between the ports when there are ports.
  const lineA = ports ? ports.start.at : a;
  const lineB = ports ? ports.end.at : b;
  // Sides chosen by route cost (D78) must actually be left through: a line
  // that runs along the side it claims to leave — the whole shape of a back
  // edge drawn straight over the tops of a row — is not a straight edge, it
  // is the route refusing to turn.
  const outward =
    !ports || !options?.leaveBySide
      ? true
      : (lineB[0] - lineA[0]) * NORMAL[ports.start.side][0] + (lineB[1] - lineA[1]) * NORMAL[ports.start.side][1] > 1e-6 &&
        (lineA[0] - lineB[0]) * NORMAL[ports.end.side][0] + (lineA[1] - lineB[1]) * NORMAL[ports.end.side][1] > 1e-6;
  if (outward && !near.some((o) => segmentThroughBox(lineA, lineB, o, 4))) return null;

  const blocks = near.map((o) => pad(o, clearance));
  const fromPad = pad(from, clearance);
  const toPad = pad(to, clearance);
  const xs = new Set<number>([a[0], b[0], fromPad.x, fromPad.x + fromPad.width, toPad.x, toPad.x + toPad.width]);
  const ys = new Set<number>([a[1], b[1], fromPad.y, fromPad.y + fromPad.height, toPad.y, toPad.y + toPad.height]);
  for (const o of blocks) {
    xs.add(o.x);
    xs.add(o.x + o.width);
    ys.add(o.y);
    ys.add(o.y + o.height);
  }
  // The chosen ports are grid lines too, so the path can start and end on them.
  if (ports) {
    for (const p of [ports.start.outside, ports.end.outside]) {
      xs.add(p[0]);
      ys.add(p[1]);
    }
  }
  const X = [...xs].sort((p, q) => p - q);
  const Y = [...ys].sort((p, q) => p - q);
  const xi = new Map(X.map((v, i) => [v, i]));
  const yi = new Map(Y.map((v, i) => [v, i]));

  // A grid segment is open when it passes through no padded obstacle, and
  // not through the ends' own interiors either (the ports sit on their
  // padded edges; the path must not re-enter).
  const solid = [...blocks, pad(from, 0), pad(to, 0)];
  const open = (p: Point, q: Point) => !solid.some((o) => segmentThroughBox(p, q, o));

  // The four ports D72 knew: the middle of each padded side of each end.
  const sidePorts = (box: Box, c: Point): { at: Point; dir: 0 | 1 }[] => [
    { at: [c[0], box.y], dir: 1 },
    { at: [c[0], box.y + box.height], dir: 1 },
    { at: [box.x, c[1]], dir: 0 },
    { at: [box.x + box.width, c[1]], dir: 0 },
  ];

  // Dijkstra over (column, row, direction of arrival); 0 = horizontal, 1 = vertical.
  type State = { i: number; j: number; dir: 0 | 1 };
  const key = (s: State) => (s.i * Y.length + s.j) * 2 + s.dir;
  const steps: [number, number, 0 | 1][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 1],
    [0, -1, 1],
  ];
  const search = (starts: { at: Point; dir: 0 | 1 }[], ends: { at: Point; dir: 0 | 1 }[]): Point[] | null => {
    const endKey = new Map(ends.map((e) => [`${xi.get(e.at[0])},${yi.get(e.at[1])}`, e.dir]));
    const best = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap: { cost: number; s: State }[] = [];
    const push = (item: { cost: number; s: State }) => {
      heap.push(item);
      let k = heap.length - 1;
      while (k > 0) {
        const parent = (k - 1) >> 1;
        if (heap[parent].cost <= heap[k].cost) break;
        [heap[parent], heap[k]] = [heap[k], heap[parent]];
        k = parent;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l].cost < heap[m].cost) m = l;
          if (r < heap.length && heap[r].cost < heap[m].cost) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    for (const s of starts) {
      const st: State = { i: xi.get(s.at[0])!, j: yi.get(s.at[1])!, dir: s.dir };
      best.set(key(st), 0);
      push({ cost: 0, s: st });
    }
    let found: State | null = null;
    let foundCost = Number.POSITIVE_INFINITY;
    while (heap.length) {
      const { cost, s } = pop();
      if (cost > (best.get(key(s)) ?? Number.POSITIVE_INFINITY)) continue;
      const arrival = endKey.get(`${s.i},${s.j}`);
      if (arrival !== undefined) {
        const total = cost + (arrival === s.dir ? 0 : BEND_COST);
        if (total < foundCost) {
          foundCost = total;
          found = s;
        }
        continue;
      }
      if (cost >= foundCost) continue;
      for (const [di, dj, dir] of steps) {
        const ni = s.i + di;
        const nj = s.j + dj;
        if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
        const p: Point = [X[s.i], Y[s.j]];
        const q: Point = [X[ni], Y[nj]];
        if (!open(p, q)) continue;
        const next: State = { i: ni, j: nj, dir };
        const c = cost + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + (dir === s.dir ? 0 : BEND_COST);
        const k = key(next);
        if (c < (best.get(k) ?? Number.POSITIVE_INFINITY)) {
          best.set(k, c);
          prev.set(k, key(s));
          push({ cost: c, s: next });
        }
      }
    }
    if (!found) return null;
    const path: Point[] = [];
    let k: number | undefined = key(found);
    while (k !== undefined) {
      const cell = Math.floor(k / 2);
      path.push([X[Math.floor(cell / Y.length)], Y[cell % Y.length]]);
      k = prev.get(k);
    }
    path.reverse();
    return path;
  };

  // With ports, the path must start and end where the edge meets the
  // component (D75); when nothing gets through from there, the four
  // side-middle ports are tried, so D72's guarantee never depends on D75.
  let path = ports
    ? search([{ at: ports.start.outside, dir: ports.start.dir }], [{ at: ports.end.outside, dir: ports.end.dir }])
    : null;
  if (path && ports) path = [ports.start.outside, ...path, ports.end.outside];
  if (!path) path = search(sidePorts(fromPad, a), sidePorts(toPad, b));
  if (!path) return null;
  // Drop the points that do not turn.
  return dropCollinear(path);
}

/** Two coordinates this close share a line. */
const TIGHT = 1e-6;

/** Whether two points share a row or a column — the ends of one orthogonal leg. */
function aligned(p: Point, q: Point): boolean {
  return Math.abs(p[0] - q[0]) < TIGHT || Math.abs(p[1] - q[1]) < TIGHT;
}

/**
 * What a drawn polyline costs the way the router counts: its length plus a
 * fixed price for every turn. This is the number the choice of sides is made
 * on (D78), so the choice and the search agree about what is expensive.
 */
export function routeCost(points: readonly Point[], bendCost = BEND_COST): number {
  const pts = dropCollinear(points);
  let cost = 0;
  for (let i = 0; i + 1 < pts.length; i++) cost += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return cost + Math.max(0, pts.length - 2) * bendCost;
}

/**
 * The pair of sides an edge should leave and enter through (D78), or null
 * when the straight line between the centres is clear and D75's facing
 * sides stand. Every pair of sides is routed once, from the middle of each,
 * and the cheapest whole drawn line wins — length plus what its turns cost.
 * A back edge along a row therefore leaves over or under the row and comes
 * back along one channel, rather than out of the side that faces its target
 * and straight back down. Ties go to the facing sides, then to a fixed side
 * order, so two runs of the same diagram give one picture (I3).
 */
export function chooseSides(from: PortNode, to: PortNode, obstacles: readonly Box[], clearance = ROUTE_PAD): SidePair | null {
  const near = obstaclesNear(from, to, obstacles).filter((o) => o !== from && o !== to);
  const a = centre(from);
  const b = centre(to);
  if (!near.some((o) => segmentThroughBox(a, b, o, 4))) return null;
  const facing: SidePair = { start: sideTowards(from, b), end: sideTowards(to, a) };
  // Sixteen probes at most, over the obstacle list the caller already has.
  let best: { pair: SidePair; cost: number; rank: number } | null = null;
  for (const start of SIDE_ORDER) {
    for (const end of SIDE_ORDER) {
      const ports: PortEnds = {
        start: portAt(from, from.shape, start, middleOf(from, start), clearance),
        end: portAt(to, to.shape, end, middleOf(to, end), clearance),
      };
      const turns = routeEdge(from, to, near, clearance, ports, { leaveBySide: true });
      // A route the router had to take from a side's middle instead is not
      // this pair's route, and says nothing about what this pair costs.
      if (turns && !(aligned(ports.start.at, turns[0]) && aligned(ports.end.at, turns[turns.length - 1]))) continue;
      const line: Point[] = turns ? [ports.start.at, ...turns, ports.end.at] : [ports.start.at, ports.end.at];
      const cost = routeCost(line);
      const rank =
        (start === facing.start && end === facing.end ? 0 : 1) * 100 + SIDE_ORDER.indexOf(start) * 4 + SIDE_ORDER.indexOf(end);
      if (!best || cost < best.cost - TIGHT || (cost < best.cost + TIGHT && rank < best.rank)) best = { pair: { start, end }, cost, rank };
    }
  }
  return best ? best.pair : null;
}

/** How far off a straight line a point must sit to count as a turn, in scene units. */
const COLLINEAR = 0.01;

/**
 * A polyline without its points that do not turn — duplicates, and points
 * that sit on the line between their neighbours. The tolerance is a
 * hundredth of a scene unit, so the two points a softened corner leaves
 * either side of a bend (D75) survive: they do turn, slightly.
 */
export function dropCollinear(points: readonly Point[], tolerance = COLLINEAR): Point[] {
  const kept: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = kept[kept.length - 1];
    const r = points[i + 1];
    if (q && Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9) continue;
    if (q && r) {
      const span = Math.hypot(r[0] - q[0], r[1] - q[1]);
      const cross = (p[0] - q[0]) * (r[1] - q[1]) - (p[1] - q[1]) * (r[0] - q[0]);
      if (span > 1e-9 && Math.abs(cross) / span <= tolerance) continue;
    }
    kept.push([p[0], p[1]]);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// simplification (D78)
// ---------------------------------------------------------------------------

/** The unit direction of a leg, or null when it has no length. */
function legDir(p: Point, q: Point): Point | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return [dx / len, dy / len];
}

/** How nearly two leg directions must agree to count as one direction. */
const SAME_DIR = 0.999;

/**
 * One simplification of an orthogonal route, or null when none applies and
 * none is refused (D78). Legs alternate axis, so every short interior leg is
 * either a JOG — the two legs either side run the same way, and the shorter
 * of them slides onto the other's line — or a HAIRPIN, where they run
 * opposite ways and the two turns are replaced by the one corner they were
 * pretending to be. A simplification that would put the edge through
 * something is refused: D72 outranks the stroke.
 */
function simplifyOnce(pts: readonly Point[], radius: number, clear: (candidate: readonly Point[]) => boolean): Point[] | null {
  const last = pts.length - 1;
  for (let i = 1; i + 2 <= last; i++) {
    const before = legDir(pts[i - 1], pts[i]);
    const after = legDir(pts[i + 1], pts[i + 2]);
    if (!before || !after) continue;
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const agree = before[0] * after[0] + before[1] * after[1];
    // The axis the two parallel legs are offset along: the leg between them.
    const cross = Math.abs(before[0]) > 0.5 ? 1 : 0;
    if (agree < -SAME_DIR && len <= 2 * radius) {
      // A hairpin: one corner where the line went out and came straight back.
      const corner: Point = cross === 1 ? [pts[i + 2][0], pts[i][1]] : [pts[i][0], pts[i + 2][1]];
      const candidate = dropCollinear([...pts.slice(0, i), corner, ...pts.slice(i + 2)]);
      if (clear(candidate)) return candidate;
      continue;
    }
    if (agree > SAME_DIR && len < radius) {
      // A jog: slide the shorter of the two parallel legs onto the other's
      // line. A leg that carries a port cannot move — the port is where the
      // edge meets the component (D75).
      const movePrev = i - 1 > 0;
      const moveNext = i + 2 < last;
      const lenPrev = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const lenNext = Math.hypot(pts[i + 2][0] - pts[i + 1][0], pts[i + 2][1] - pts[i + 1][1]);
      const order: ("prev" | "next")[] = lenPrev <= lenNext ? ["prev", "next"] : ["next", "prev"];
      for (const which of order) {
        if (which === "prev" ? !movePrev : !moveNext) continue;
        const copy = pts.map((p): Point => [p[0], p[1]]);
        if (which === "prev") {
          const onto = pts[i + 1][cross];
          copy[i - 1][cross] = onto;
          copy[i][cross] = onto;
        } else {
          const onto = pts[i][cross];
          copy[i + 1][cross] = onto;
          copy[i + 2][cross] = onto;
        }
        const candidate = dropCollinear(copy);
        if (clear(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * A route simplified before it is drawn (D78): a jog shorter than a corner
 * collapsed, a hairpin removed, and no leg left shorter than the corner
 * radius except the two port stubs. Each step is refused when the polyline
 * it would leave passes through an obstacle — D72 outranks the stroke — and
 * the ports at either end never move. Pure and deterministic (I3).
 */
export function simplifyRoute(points: readonly Point[], obstacles: readonly Box[], radius = CORNER_RADIUS, inset = 2): Point[] {
  let pts = dropCollinear(points);
  const clear = (candidate: readonly Point[]) => !obstacles.some((o) => polylineThroughBox(candidate, o, inset));
  // Every step drops at least one point, so the run is bounded by the input.
  for (let guard = points.length + 4; guard > 0; guard--) {
    const next = simplifyOnce(pts, radius, clear);
    if (!next) break;
    pts = next;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// nudging (D75)
// ---------------------------------------------------------------------------

export interface NudgeRoute {
  id: string;
  /** The whole drawn polyline: the start port, the turning points, the end port. */
  points: readonly Point[];
  /** What this edge must not cross — its own two ends already left out. */
  obstacles: readonly Box[];
}

/** Two segments count as sharing a line when their coordinates differ by less. */
const SAME_LINE = 0.5;

/**
 * Routed segments that would run along one line, pushed apart (D75). Two
 * lines on top of each other are one line to the eye, so segments sharing a
 * grid line with overlapping extents are spread by `gap`, centred on the
 * line they shared and ordered by edge id — deterministically, and never
 * into an obstacle: a nudge that would put the edge through a component is
 * given up and the original line kept. Returns each route's new polyline.
 */
export function nudgeRoutes(routes: readonly NudgeRoute[], gap = NUDGE): Map<string, Point[]> {
  const work = routes.map((r) => ({ route: r, pts: r.points.map((p): Point => [p[0], p[1]]) }));
  interface Seg {
    /** Index into `work`. */
    r: number;
    /** The segment runs from `pts[i]` to `pts[i + 1]`. */
    i: number;
    /** 0 = horizontal (shares a y), 1 = vertical (shares an x). */
    axis: 0 | 1;
    coord: number;
    lo: number;
    hi: number;
  }
  const segs: Seg[] = [];
  for (let r = 0; r < work.length; r++) {
    const pts = work[r].pts;
    // Only the segments between turning points move: the legs that meet the
    // components stay on their ports, and a turning point moved sideways
    // keeps its legs axis-aligned, because a turn is a right angle.
    for (let i = 1; i + 2 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      // A leg either side that could not absorb the shift would come out of
      // the nudge shorter than a corner — a jog the simplification (D78)
      // just took out. Only legs with room to give are nudged.
      const room = Math.min(
        Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]),
        Math.hypot(pts[i + 2][0] - q[0], pts[i + 2][1] - q[1]),
      );
      if (room < CORNER_RADIUS + 2 * gap) continue;
      if (Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) > 1e-6) {
        segs.push({ r, i, axis: 1, coord: p[0], lo: Math.min(p[1], q[1]), hi: Math.max(p[1], q[1]) });
      } else if (Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[0] - q[0]) > 1e-6) {
        segs.push({ r, i, axis: 0, coord: p[1], lo: Math.min(p[0], q[0]), hi: Math.max(p[0], q[0]) });
      }
    }
  }
  // Clusters: same axis, coordinates within half a unit, extents overlapping.
  const order = segs.map((_, k) => k).sort((k, l) => segs[k].axis - segs[l].axis || segs[k].coord - segs[l].coord || segs[k].lo - segs[l].lo);
  const clusters: number[][] = [];
  let band: number[] = [];
  for (const k of order) {
    const last = band.length ? segs[band[band.length - 1]] : null;
    if (last && segs[k].axis === last.axis && Math.abs(segs[k].coord - last.coord) <= SAME_LINE) band.push(k);
    else {
      if (band.length) clusters.push(band);
      band = [k];
    }
  }
  if (band.length) clusters.push(band);
  const shifts = new Map<number, number>();
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    // Within a band, only the segments that actually overlap share a line.
    const groups: number[][] = [];
    for (const k of cluster) {
      const found = groups.find((g) => g.some((l) => segs[k].lo < segs[l].hi && segs[l].lo < segs[k].hi));
      if (found) found.push(k);
      else groups.push([k]);
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((k, l) => {
        const a = work[segs[k].r].route.id;
        const b = work[segs[l].r].route.id;
        return a < b ? -1 : a > b ? 1 : segs[k].i - segs[l].i;
      });
      for (let n = 0; n < sorted.length; n++) shifts.set(sorted[n], (n - (sorted.length - 1) / 2) * gap);
    }
  }
  for (const [k, by] of [...shifts.entries()].sort((p, q) => p[0] - q[0])) {
    const seg = segs[k];
    const pts = work[seg.r].pts;
    const before: Point[] = [pts[seg.i], pts[seg.i + 1]].map((p): Point => [p[0], p[1]]);
    for (const p of [pts[seg.i], pts[seg.i + 1]]) p[seg.axis === 1 ? 0 : 1] = seg.coord + by;
    if (work[seg.r].route.obstacles.some((o) => polylineThroughBox(pts, o, 2))) {
      pts[seg.i] = before[0];
      pts[seg.i + 1] = before[1];
    }
  }
  return new Map(work.map((w) => [w.route.id, w.pts]));
}

/** A turn shallower than this is not a corner; it gets no arc (D78). */
const ARC_DEGREES = 10;
/** Interior points an arc gets per right angle — fewer on a shallower turn. */
const ARC_POINTS_PER_QUARTER = 4;

/**
 * A polyline with every turn drawn as a circular arc tangent to both its
 * legs (D78). The radius is the corner radius, or half the shorter of the
 * two legs when there is not room for it, and the arc arrives as explicit
 * points — four per right angle, fewer on a shallower turn — so what
 * Excalidraw draws is exactly the route rather than its own curvature
 * through the turning points. A turn under ten degrees is not a corner and
 * keeps its point. The eye follows a line by continuity; a cusp ends one
 * line and starts another, and an overshooting curve says the line was not
 * drawn on purpose.
 */
export function arcCorners(points: readonly Point[], radius = CORNER_RADIUS): Point[] {
  if (points.length < 3) return points.map((p): Point => [p[0], p[1]]);
  const out: Point[] = [[points[0][0], points[0][1]]];
  for (let i = 1; i + 1 < points.length; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const next = points[i + 1];
    const d1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    if (d1 < 1e-9 || d2 < 1e-9) {
      out.push([p[0], p[1]]);
      continue;
    }
    const u1: Point = [(p[0] - prev[0]) / d1, (p[1] - prev[1]) / d1];
    const u2: Point = [(next[0] - p[0]) / d2, (next[1] - p[1]) / d2];
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const dot = u1[0] * u2[0] + u1[1] * u2[1];
    const turn = Math.atan2(Math.abs(cross), dot);
    if ((turn * 180) / Math.PI < ARC_DEGREES) {
      out.push([p[0], p[1]]);
      continue;
    }
    // The tangent length a radius needs at this turn, capped by the legs it
    // has to fit between — a short leg halves the radius rather than the arc
    // running past the next corner.
    let r = Math.min(radius, d1 / 2, d2 / 2);
    const bite = Math.tan(turn / 2);
    let t = r * bite;
    if (t > Math.min(d1, d2) / 2) {
      t = Math.min(d1, d2) / 2;
      r = t / bite;
    }
    if (r < 1e-6 || t < 1e-6) {
      out.push([p[0], p[1]]);
      continue;
    }
    const a: Point = [p[0] - u1[0] * t, p[1] - u1[1] * t];
    const b: Point = [p[0] + u2[0] * t, p[1] + u2[1] * t];
    // The centre sits a radius off the incoming leg, on the side it turns to.
    const sign = cross >= 0 ? 1 : -1;
    const centreOfArc: Point = [a[0] - u1[1] * r * sign, a[1] + u1[0] * r * sign];
    const from = Math.atan2(a[1] - centreOfArc[1], a[0] - centreOfArc[0]);
    const steps = Math.max(1, Math.round((ARC_POINTS_PER_QUARTER * turn) / (Math.PI / 2)));
    out.push(a);
    for (let k = 1; k <= steps; k++) {
      const angle = from + sign * turn * (k / (steps + 1));
      out.push([centreOfArc[0] + Math.cos(angle) * r, centreOfArc[1] + Math.sin(angle) * r]);
    }
    out.push(b);
  }
  const last = points[points.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

// ---------------------------------------------------------------------------
// what the lint sees in a drawn edge (D78)
// ---------------------------------------------------------------------------

/** Turns this far apart along the line are two corners; nearer, they are one arc. */
const CORNER_SPAN = 2 * CORNER_RADIUS;
/** A direction change smaller than this, in degrees, is not a turn. */
const TURN_EPSILON = 0.5;
/**
 * A turn this sharp is a corner in its own right and joins no arc: an arc
 * of Docent's own is several SMALL turns (a right angle in four points
 * turns eighteen degrees at a time), so anything near a right angle is a
 * corner the route really has.
 */
const SHARP_DEGREES = 45;

/** Where two infinite lines cross, or null when they are parallel. */
function lineCross(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/**
 * The corners of a drawn polyline: its two ends and one point per turn,
 * with the several small turns of an arc (D78) read back as the single
 * corner they round. Each corner is where the straight legs either side of
 * the arc would have met, so the legs measured between them are the legs
 * the route actually has.
 */
export function routeCorners(points: readonly Point[], span = CORNER_SPAN): Point[] {
  const pts = dropCollinear(points);
  if (pts.length < 3) return pts;
  const turns: { i: number; along: number; sharp: boolean }[] = [];
  let along = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const u1 = legDir(pts[i - 1], pts[i]);
    const u2 = legDir(pts[i], pts[i + 1]);
    if (!u1 || !u2) continue;
    const angle = (Math.atan2(Math.abs(u1[0] * u2[1] - u1[1] * u2[0]), u1[0] * u2[0] + u1[1] * u2[1]) * 180) / Math.PI;
    if (angle > TURN_EPSILON) turns.push({ i, along, sharp: angle >= SHARP_DEGREES });
  }
  const clusters: { i: number; along: number; sharp: boolean }[][] = [];
  for (const turn of turns) {
    const band = clusters[clusters.length - 1];
    const joins = band && !turn.sharp && !band[0].sharp && turn.along - band[0].along <= span;
    if (joins) band.push(turn);
    else clusters.push([turn]);
  }
  const out: Point[] = [pts[0]];
  for (const band of clusters) {
    const first = band[0].i;
    const last = band[band.length - 1].i;
    const met = lineCross(pts[first - 1], pts[first], pts[last], pts[last + 1]);
    // Legs that all but line up meet a long way off; that is not a corner
    // anyone drew, so the cluster's own first point stands for it.
    const near = met && Math.hypot(met[0] - pts[first][0], met[1] - pts[first][1]) <= 4 * span;
    out.push(near ? met! : pts[first]);
  }
  out.push(pts[pts.length - 1]);
  return dropCollinear(out);
}

/**
 * Whether a drawn edge wiggles (D78): a leg between two corners shorter
 * than the corner radius — the port stubs at either end do not count — or
 * two turns that double back on each other within a corner's length. Both
 * say the same thing to a reader: this line was not drawn on purpose. Arc
 * points are read back into their corners first, so an arc is never a wiggle.
 */
export function edgeWiggles(points: readonly Point[], radius = CORNER_RADIUS): boolean {
  const corners = routeCorners(points, 2 * radius);
  const legs = corners.slice(0, -1).map((p, i) => ({
    len: Math.hypot(corners[i + 1][0] - p[0], corners[i + 1][1] - p[1]),
    dir: legDir(p, corners[i + 1]),
  }));
  for (let i = 1; i + 1 < legs.length; i++) if (legs[i].len < radius - 1e-6) return true;
  for (let i = 0; i + 2 < legs.length; i++) {
    const a = legs[i].dir;
    const b = legs[i + 2].dir;
    if (!a || !b || legs[i + 1].len > 2 * radius) continue;
    if (a[0] * b[0] + a[1] * b[1] < -SAME_DIR) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// binding focus (D75)
// ---------------------------------------------------------------------------

function segmentCross(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/**
 * The binding focus Excalidraw stores for an arrow that meets `box` at `at`
 * coming from `from` — the oriented ratio in [-1, 1] that tells it where on
 * the shape to keep the arrow when the shape moves, so a port spread along
 * a side (D75) survives a drag. The arithmetic mirrors Excalidraw 0.18's
 * own `determineFocusDistance`; it is ported, not imported, because the
 * authoring layer sees no Excalidraw (B1). A line aimed at the centre gives
 * zero, which is what an unported edge already had.
 */
export function bindingFocus(box: Box, shape: string | undefined, at: Point, from: Point): number {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = at[0] - from[0];
  const dy = at[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const sign = -Math.sign(dx * (at[1] - cy) - dy * (at[0] - cx));
  const reach = Math.max(box.width * 2, box.height * 2);
  const tip: Point = [at[0] + (dx / len) * reach, at[1] + (dy / len) * reach];
  const w = box.width;
  const h = box.height;
  // Excalidraw measures the focus against the shape's own axes: the two
  // extended diagonals of a rectangle or ellipse, the two extended mid-lines
  // of a diamond.
  const interceptees: [Point, Point][] =
    shape === "diamond"
      ? [
          [[cx, box.y - h], [cx, box.y + 2 * h]],
          [[box.x - w, cy], [box.x + 2 * w, cy]],
        ]
      : [
          [[box.x - w, box.y - h], [box.x + 2 * w, box.y + 2 * h]],
          [[box.x + 2 * w, box.y - h], [box.x - w, box.y + 2 * h]],
        ];
  const scale = shape === "diamond" ? [h / 2, w / 2] : [Math.hypot(w, h) / 2, Math.hypot(w, h) / 2];
  const ratios = interceptees
    .map((s) => segmentCross(at, tip, s[0], s[1]))
    .filter((p): p is Point => p !== null)
    .sort((p, q) => (p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2 - ((q[0] - at[0]) ** 2 + (q[1] - at[1]) ** 2))
    .map((p, idx) => (sign * Math.hypot(p[0] - cx, p[1] - cy)) / (scale[idx] || 1))
    .sort((p, q) => Math.abs(p) - Math.abs(q));
  return ratios[0] ?? 0;
}

/** The absolute polyline of an arrow from its origin and relative points. */
export function absolutePoints(x: number, y: number, points: readonly (readonly [number, number])[]): Point[] {
  return points.map(([px, py]) => [x + px, y + py]);
}

/** The boxes a polyline passes through, excluding the given ids. */
export function passesThrough<T extends Box & { id: string }>(points: readonly Point[], boxes: readonly T[], except: ReadonlySet<string>): T[] {
  return boxes.filter((b) => !except.has(b.id) && polylineThroughBox(points, b, 2));
}
