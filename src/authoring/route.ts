/**
 * Edge routing (D72): an edge never cuts through a component. The straight
 * line between two components is kept when nothing lies on it; otherwise
 * an orthogonal path is found on the grid the obstacles' padded edges
 * define — fewest bends first, shortest second — and returned as the
 * turning points the adapter draws through. Pure and deterministic (I3).
 */
import type { Box } from "./layout";

export type Point = [number, number];

/** Clearance kept between a routed edge and what it goes around. */
export const ROUTE_PAD = 24;
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

/**
 * The turning points of an edge from `from` to `to`, or null when the
 * straight line is clear. The points are in scene coordinates and all lie
 * outside both ends; the caller draws from each end's outline to the
 * nearest of them. Null also when no path exists on the grid, in which
 * case the straight line is all there is.
 */
export function routeEdge(from: Box, to: Box, obstacles: readonly Box[], clearance = ROUTE_PAD): Point[] | null {
  const near = obstaclesNear(from, to, obstacles).filter((o) => o !== from && o !== to);
  const a = centre(from);
  const b = centre(to);
  // Clear straight line: nothing to do. A near miss (inside the clearance)
  // is let through — it is what hand drawing does.
  if (!near.some((o) => segmentThroughBox(a, b, o, 4))) return null;

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
  const X = [...xs].sort((p, q) => p - q);
  const Y = [...ys].sort((p, q) => p - q);
  const xi = new Map(X.map((v, i) => [v, i]));
  const yi = new Map(Y.map((v, i) => [v, i]));

  // A grid segment is open when it passes through no padded obstacle, and
  // not through the ends' own interiors either (the ports sit on their
  // padded edges; the path must not re-enter).
  const solid = [...blocks, pad(from, 0), pad(to, 0)];
  const open = (p: Point, q: Point) => !solid.some((o) => segmentThroughBox(p, q, o));

  // Ports: the middle of each padded side of each end.
  const ports = (box: Box, c: Point): { at: Point; dir: 0 | 1 }[] => [
    { at: [c[0], box.y], dir: 1 },
    { at: [c[0], box.y + box.height], dir: 1 },
    { at: [box.x, c[1]], dir: 0 },
    { at: [box.x + box.width, c[1]], dir: 0 },
  ];
  const starts = ports(fromPad, a);
  const ends = ports(toPad, b);
  const endKey = new Map(ends.map((e) => [`${xi.get(e.at[0])},${yi.get(e.at[1])}`, e.dir]));

  // Dijkstra over (column, row, direction of arrival); 0 = horizontal, 1 = vertical.
  type State = { i: number; j: number; dir: 0 | 1 };
  const key = (s: State) => (s.i * Y.length + s.j) * 2 + s.dir;
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
  const steps: [number, number, 0 | 1][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 1],
    [0, -1, 1],
  ];
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
  // Walk back, then drop the points that do not turn.
  const path: Point[] = [];
  let k: number | undefined = key(found);
  while (k !== undefined) {
    const cell = Math.floor(k / 2);
    path.push([X[Math.floor(cell / Y.length)], Y[cell % Y.length]]);
    k = prev.get(k);
  }
  path.reverse();
  const turns: Point[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const before = turns[turns.length - 1];
    const after = path[i + 1];
    if (before && after && ((before[0] === p[0] && p[0] === after[0]) || (before[1] === p[1] && p[1] === after[1]))) continue;
    if (before && before[0] === p[0] && before[1] === p[1]) continue;
    turns.push(p);
  }
  return turns;
}

/** The absolute polyline of an arrow from its origin and relative points. */
export function absolutePoints(x: number, y: number, points: readonly (readonly [number, number])[]): Point[] {
  return points.map(([px, py]) => [x + px, y + py]);
}

/** The boxes a polyline passes through, excluding the given ids. */
export function passesThrough<T extends Box & { id: string }>(points: readonly Point[], boxes: readonly T[], except: ReadonlySet<string>): T[] {
  return boxes.filter((b) => !except.has(b.id) && polylineThroughBox(points, b, 2));
}
