/**
 * The craft score (D76): the lint's number. Pleasing is not computable, but
 * the proxies the evidence ranks are — crossings first, bends next,
 * alignment and the room components leave each other after that,
 * squareness and colour distance last (D99) — so `validate` can hand an
 * agent a 0–100 with its parts and say what would raise it. Measured per
 * frame and for the diagram whole, from the polylines a reader will
 * actually see (D75's ports, nudges and softened corners included), never
 * from tidy centre lines.
 * Pure and deterministic (I3), and dependency-free: even the colour
 * distance is a dozen lines of arithmetic here (I7).
 */
import type { LegendRule, SceneSnapshot } from "../adapter/snapshot";
import { buildSceneGraph, type GraphEdge, type GraphNode, type SceneGraph } from "../scene/graph";
import { GRID, legendBox, type Box } from "./layout";
import { absolutePoints, CORNER_RADIUS, polylineThroughBox, type Point } from "./route";

export type CraftKey = "crossings" | "bends" | "alignment" | "lengths" | "squareness" | "overlaps" | "colour";

export interface CraftPart {
  key: CraftKey;
  /** The measure itself: crossings counted, bends per edge, a share, a CV, ΔE. */
  value: number;
  /** Points lost, 0..weight. */
  penalty: number;
  weight: number;
  /** One line, for a person. */
  detail: string;
}

export interface CraftFrameScore {
  id: string;
  name: string;
  score: number;
  worst: CraftKey | null;
}

export interface CraftScore {
  /** 0..100, integer. */
  score: number;
  parts: CraftPart[];
  perFrame: CraftFrameScore[];
  /** What would raise the score most, costliest first — one to three lines. */
  advice: string[];
}

/**
 * What each part may cost, as the evidence ranks them (D76): crossings are
 * what a reader has to untangle before reading anything, bends are the next
 * worst, alignment and the room components leave each other come after, and
 * the length spread, the squareness of what was drawn and the legend's
 * colour distance are the finish. The weights sum to 100, so the score is
 * what is left of it.
 */
export const CRAFT_WEIGHTS: Record<CraftKey, number> = {
  crossings: 35,
  bends: 20,
  alignment: 15,
  overlaps: 15,
  lengths: 5,
  squareness: 5,
  colour: 5,
};

/** The parts in the order they are reported — dearest weight first. */
const PART_ORDER: CraftKey[] = ["crossings", "bends", "alignment", "overlaps", "lengths", "squareness", "colour"];

/**
 * Every penalty SATURATES: a part costs its whole weight once its measure
 * is as bad as a reader would simply call hopeless, and nothing beyond
 * that. Two consequences, both wanted — one dreadful part can never spend
 * another part's budget, and a diagram with three crossings and one with
 * thirty both read as "tangled" rather than as a bottomless well. Each
 * part's saturation point is written where it is used.
 */
const saturate = (weight: number, measure: number, hopeless: number): number =>
  weight * Math.min(1, Math.max(0, measure) / Math.max(hopeless, 1e-9));

/** A direction change smaller than this is not a bend a reader would name. */
const TURN_DEGREES = 20;
/** Below this, in degrees, a vertex does not turn at all — it is on the line. */
const TURN_EPSILON = 0.5;
/**
 * Within this of an axis, a segment reads as horizontal or vertical. Wide
 * enough that an edge leaving one port and entering another a little
 * higher (D75) is still a straight flow to the eye; a real diagonal is
 * well past it.
 */
const AXIS_DEGREES = 12;
/**
 * The deviation from an axis a DRAWN segment may keep and still read as
 * square (D98, D99). Its partner is route.ts's `AXIS_DEGREES` — what the
 * router itself flattens onto the axis; what the router would snap, the
 * score must not charge for. Mirrored here rather than imported, since
 * route.ts exports no such constant yet; the two are to be reconciled to
 * one when it does.
 */

/** Centres this close on the cross axis read as lined up. */
const ALIGN_PX = 2;
/**
 * Turns closer together than this along the line are ONE bend: D78 draws a
 * right-angle corner as an arc of the corner radius, which arrives as a
 * handful of small turns over about a radius and a half of line — well
 * inside this window — and which the eye reads as one bend.
 */
const SOFT_SPAN = 2 * CORNER_RADIUS;
/**
 * Segments no longer than a softened corner's own legs ARE the softening,
 * not a diagonal anyone drew, so the alignment share passes over them.
 */
const SHORT_SEGMENT = 2 * CORNER_RADIUS;
/**
 * What a box off the grid may cost of the squareness part (D99). A
 * diagonal is the loud fault — the eye reads it as unfinished — and a box
 * a few units off a grid line the quiet one, so it takes the smaller
 * share and a picture of square lines can still lose a little for it.
 */
const OFF_GRID_SHARE = 0.25;
/** Two kind fills closer than this in CIELAB read as one colour (D77). */
const MIN_DELTA_E = 25;
/** A frame this crowded is a tiering problem, not a layout one (D63, D76). */
const CROWDED_FRAME = 12;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** An edge as the score sees it: its two ends and the line the reader sees. */
interface EdgeGeom {
  edge: GraphEdge;
  from: GraphNode;
  to: GraphNode;
  points: Point[];
  length: number;
}

const centre = (b: Box): Point => [b.x + b.width / 2, b.y + b.height / 2];

const round2 = (v: number): number => Math.round(v * 100) / 100;

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  return total;
}

/**
 * The drawn polyline of every edge that joins two components — the arrow's
 * own points when it has them, the line between the centres when it has
 * none (an arrow drawn by hand and never routed). A dangling edge is the
 * lint's business, not the score's.
 */
function geometryOf(snapshot: SceneSnapshot, graph: SceneGraph): EdgeGeom[] {
  const byId = new Map(snapshot.elements.map((el) => [el.id, el]));
  const byNode = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: EdgeGeom[] = [];
  for (const edge of graph.edges) {
    const from = edge.from ? byNode.get(edge.from) : undefined;
    const to = edge.to ? byNode.get(edge.to) : undefined;
    if (!from || !to || from.id === to.id) continue;
    const el = byId.get(edge.sourceId);
    const drawn = el?.points && el.points.length >= 2 ? absolutePoints(el.x, el.y, el.points) : null;
    const points = drawn ?? [centre(from.bounds), centre(to.bounds)];
    out.push({ edge, from, to, points, length: polylineLength(points) });
  }
  return out;
}

/** Whether two segments properly cross — touching at an end does not count. */
function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(b1, b2, a1);
  const d2 = side(b1, b2, a2);
  const d3 = side(a1, a2, b1);
  const d4 = side(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function polylinesCross(a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

/** Whether two component boxes share more than a hairline of area. */
function boxesOverlap(a: Box, b: Box): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 1 && h > 1;
}

/**
 * Ranks by longest path over the scope's edges — the layout's own idea of a
 * rank (D74), recomputed here because the score reads a drawing and not a
 * layout run. An edge that closes a cycle starts the count again, so a
 * cyclic flow ranks rather than hangs.
 */
function ranksOf(nodes: readonly GraphNode[], edges: readonly EdgeGeom[]): Map<string, number> {
  const feeders = new Map<string, string[]>();
  for (const n of nodes) feeders.set(n.id, []);
  for (const e of edges) feeders.get(e.to.id)?.push(e.from.id);
  const rank = new Map<string, number>();
  const busy = new Set<string>();
  const of = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (busy.has(id)) return 0;
    busy.add(id);
    let r = 0;
    for (const from of feeders.get(id) ?? []) r = Math.max(r, of(from) + 1);
    busy.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of nodes) of(n.id);
  return rank;
}

// ---------------------------------------------------------------------------
// colour distance (D76, D77)
// ---------------------------------------------------------------------------

/**
 * sRGB hex → CIELAB under D65, the few lines ΔE76 needs. Written out rather
 * than installed: the authoring layer takes no runtime dependency (I7).
 */
export function labOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = parseInt(digits, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The CIE76 distance between two sRGB hexes; null when either is not one. */
export function deltaE76(a: string, b: string): number | null {
  const p = labOf(a);
  const q = labOf(b);
  if (!p || !q) return null;
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** What the legend says each kind is filled with, in kind order. */
function kindFills(legend: readonly LegendRule[]): { kind: string; fill: string }[] {
  const byKind = new Map<string, string>();
  for (const rule of legend) {
    // A kind that means a library icon is not Docent's colour to judge:
    // the brand chose it (D84).
    if (rule.key !== "kind" || rule.attr === "symbol") continue;
    for (const c of [{ attr: rule.attr, value: rule.value }, ...(rule.also ?? [])]) {
      if (c.attr === "backgroundColor" && c.value !== "transparent" && !byKind.has(rule.meaning)) byKind.set(rule.meaning, c.value);
    }
  }
  return [...byKind]
    .map(([kind, fill]) => ({ kind, fill }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** The closest pair of kind fills, or null when there is nothing to tell apart. */
function closestKinds(legend: readonly LegendRule[]): { a: string; b: string; distance: number } | null {
  const fills = kindFills(legend);
  let best: { a: string; b: string; distance: number } | null = null;
  for (let i = 0; i < fills.length; i++) {
    for (let j = i + 1; j < fills.length; j++) {
      const d = deltaE76(fills[i].fill, fills[j].fill);
      if (d === null) continue;
      if (!best || d < best.distance) best = { a: fills[i].kind, b: fills[j].kind, distance: d };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// the parts
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What a reader's eye has to untangle: pairs of arrows that actually cross. */
function crossingsPart(edges: readonly EdgeGeom[]): CraftPart {
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i];
      const b = edges[j];
      // Edges meeting at a component share a point by construction, not by accident.
      if (a.from.id === b.from.id || a.from.id === b.to.id || a.to.id === b.from.id || a.to.id === b.to.id) continue;
      if (polylinesCross(a.points, b.points)) crossings += 1;
    }
  }
  // Hopeless at one crossing for every two edges: past that the picture is
  // a knot, and counting further tells the reader nothing new.
  const penalty = saturate(CRAFT_WEIGHTS.crossings, crossings, Math.max(1, edges.length / 2));
  return {
    key: "crossings",
    value: crossings,
    penalty,
    weight: CRAFT_WEIGHTS.crossings,
    detail: crossings ? `${plural(crossings, "pair")} of arrows cross` : "no arrows cross",
  };
}

/** Bends per edge, an arc counted as the one bend it draws (D75, D78). */
function bendsPart(edges: readonly EdgeGeom[]): CraftPart {
  let bends = 0;
  for (const e of edges) {
    // Turns within a corner's length of each other are ONE bend, and their
    // angles ADD: D78 draws a right angle as an arc of several small turns,
    // none of which a reader would name on its own but which together are
    // the one corner they round.
    let started = Number.NEGATIVE_INFINITY;
    let turned = 0;
    let along = 0;
    const close = () => {
      if (turned > TURN_DEGREES) bends += 1;
      turned = 0;
    };
    for (let i = 1; i + 1 < e.points.length; i++) {
      const prev = e.points[i - 1];
      const p = e.points[i];
      const next = e.points[i + 1];
      along += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      const inAngle = Math.atan2(p[1] - prev[1], p[0] - prev[0]);
      const outAngle = Math.atan2(next[1] - p[1], next[0] - p[0]);
      let turn = Math.abs(((outAngle - inAngle) * 180) / Math.PI);
      if (turn > 180) turn = 360 - turn;
      if (turn <= TURN_EPSILON) continue;
      if (along - started > SOFT_SPAN) {
        close();
        started = along;
      }
      turned += turn;
    }
    close();
  }
  const perEdge = edges.length ? bends / edges.length : 0;
  // Hopeless at two bends on the average edge: a line that turns twice on
  // its way is no longer a line the eye follows.
  const penalty = saturate(CRAFT_WEIGHTS.bends, perEdge, 2);
  return {
    key: "bends",
    value: round2(perEdge),
    penalty,
    weight: CRAFT_WEIGHTS.bends,
    detail: bends ? `${plural(bends, "bend")} over ${plural(edges.length, "edge")} — ${round2(perEdge)} each` : "every edge runs straight",
  };
}

/**
 * Two shares of one fault, averaged: segments that run off the axis, and
 * neighbours one rank apart that an edge joins without their centres
 * lining up on the cross axis. Straight, aligned flows are what make a
 * drawing look intended (D74).
 */
function alignmentPart(nodes: readonly GraphNode[], edges: readonly EdgeGeom[]): CraftPart {
  let segments = 0;
  let offAxis = 0;
  for (const e of edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      const dx = e.points[i + 1][0] - e.points[i][0];
      const dy = e.points[i + 1][1] - e.points[i][1];
      if (Math.hypot(dx, dy) <= SHORT_SEGMENT) continue;
      segments += 1;
      const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      if (Math.min(angle, 90 - angle) > AXIS_DEGREES) offAxis += 1;
    }
  }
  // A straight edge of a fan — one parent to several children, or the
  // reverse — is a diagonal by nature; it is counted as the fan's shape,
  // not as a segment off the axis.
  const fanEdges = new Set<EdgeGeom>();
  {
    const outs = new Map<string, number>();
    const ins = new Map<string, number>();
    for (const e of edges) {
      outs.set(e.from.id, (outs.get(e.from.id) ?? 0) + 1);
      ins.set(e.to.id, (ins.get(e.to.id) ?? 0) + 1);
    }
    for (const e of edges) if (e.points.length === 2 && ((outs.get(e.from.id) ?? 0) > 1 || (ins.get(e.to.id) ?? 0) > 1)) fanEdges.add(e);
  }
  for (const e of fanEdges) {
    const [p, q] = [e.points[0], e.points[1]];
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= SHORT_SEGMENT) continue;
    const angle = (Math.atan2(Math.abs(q[1] - p[1]), Math.abs(q[0] - p[0])) * 180) / Math.PI;
    if (Math.min(angle, 90 - angle) > AXIS_DEGREES) {
      offAxis -= 1;
    }
  }
  const rank = ranksOf(nodes, edges);
  // Only a one-to-one link can be level: a parent of three children is level
  // with one of them at best, and the other two are no fault of the layout.
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const e of edges) {
    outDegree.set(e.from.id, (outDegree.get(e.from.id) ?? 0) + 1);
    inDegree.set(e.to.id, (inDegree.get(e.to.id) ?? 0) + 1);
  }
  let pairs = 0;
  let offLine = 0;
  for (const e of edges) {
    const a = rank.get(e.from.id);
    const b = rank.get(e.to.id);
    if (a === undefined || b === undefined || Math.abs(a - b) !== 1) continue;
    if ((outDegree.get(e.from.id) ?? 0) !== 1 || (inDegree.get(e.to.id) ?? 0) !== 1) continue;
    pairs += 1;
    const p = centre(e.from.bounds);
    const q = centre(e.to.bounds);
    // The cross axis is the one the pair does NOT travel along.
    const off = Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) ? Math.abs(q[1] - p[1]) : Math.abs(q[0] - p[0]);
    if (off > ALIGN_PX) offLine += 1;
  }
  const shares: number[] = [];
  if (segments) shares.push(offAxis / segments);
  if (pairs) shares.push(offLine / pairs);
  const share = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  // A share is already 0..1: everything off the axis is the hopeless case.
  const penalty = saturate(CRAFT_WEIGHTS.alignment, share, 1);
  const said = [
    segments ? `${Math.round((offAxis / segments) * 100)}% of segments run off the axis` : null,
    pairs ? `${Math.round((offLine / pairs) * 100)}% of joined neighbours are not lined up` : null,
  ].filter((s): s is string => s !== null);
  return {
    key: "alignment",
    value: round2(share),
    penalty,
    weight: CRAFT_WEIGHTS.alignment,
    detail: said.length ? said.join(", ") : "nothing long enough to line up",
  };
}

/** How evenly the edges are spread: the coefficient of variation of their lengths. */
function lengthsPart(edges: readonly EdgeGeom[]): CraftPart {
  if (edges.length < 2) {
    return { key: "lengths", value: 0, penalty: 0, weight: CRAFT_WEIGHTS.lengths, detail: "too few edges to vary" };
  }
  const lengths = edges.map((e) => e.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, l) => a + (l - mean) ** 2, 0) / lengths.length;
  const cv = mean > 1e-9 ? Math.sqrt(variance) / mean : 0;
  // Hopeless at a spread as wide as the mean itself.
  // One routed edge among short ones already varies lengths by their mean;
  // a spread of twice the mean is where a frame reads as scattered.
  const penalty = saturate(CRAFT_WEIGHTS.lengths, cv, 2);
  return {
    key: "lengths",
    value: round2(cv),
    penalty,
    weight: CRAFT_WEIGHTS.lengths,
    detail: cv > 0.01 ? `edge lengths vary by ${Math.round(cv * 100)}% of their mean` : "edges are all one length",
  };
}

/**
 * Squared away (D98, D99): a drawn segment is axis-aligned or it turns,
 * and every box sits on the grid. Two faults in one share — the oblique
 * segments among those long enough to be a line anyone drew, and the boxes
 * off the grid — the second weighted lightly, since a diagonal shouts and
 * four units of drift only murmurs. Measured off what is drawn, so a
 * picture the router squared costs nothing here.
 */
function squarenessPart(nodes: readonly GraphNode[], edges: readonly EdgeGeom[]): CraftPart {
  let segments = 0;
  let oblique = 0;
  for (const e of edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      const dx = e.points[i + 1][0] - e.points[i][0];
      const dy = e.points[i + 1][1] - e.points[i][1];
      // A leg no longer than a softened corner's own is the softening
      // (D78), not a diagonal anyone drew.
      if (Math.hypot(dx, dy) <= SHORT_SEGMENT) continue;
      segments += 1;
      const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      if (Math.min(angle, 90 - angle) > AXIS_DEGREES) oblique += 1;
    }
  }
  const onGrid = (value: number): boolean => value % GRID === 0;
  const offGrid = nodes.filter((n) => !onGrid(n.bounds.x) || !onGrid(n.bounds.y)).length;
  const measure =
    (segments ? oblique / segments : 0) * (1 - OFF_GRID_SHARE) + (nodes.length ? offGrid / nodes.length : 0) * OFF_GRID_SHARE;
  // A share is already 0..1: every line oblique and every box adrift is the
  // hopeless case.
  const penalty = saturate(CRAFT_WEIGHTS.squareness, measure, 1);
  const said = [
    oblique ? `${Math.round((oblique / segments) * 100)}% of segments run oblique` : null,
    offGrid ? `${plural(offGrid, "box", "boxes")} off the ${GRID}-grid` : null,
  ].filter((s): s is string => s !== null);
  return {
    key: "squareness",
    value: round2(measure),
    penalty,
    weight: CRAFT_WEIGHTS.squareness,
    detail: said.length ? said.join(", ") : "every line is square and every box is on the grid",
  };
}

/** What sits on top of what: components, edges over components, edges over the legend. */
function overlapsPart(nodes: readonly GraphNode[], edges: readonly EdgeGeom[], legendArea: Box | null): CraftPart {
  let stacked = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (boxesOverlap(nodes[i].bounds, nodes[j].bounds)) stacked += 1;
    }
  }
  let cutting = 0;
  let overLegend = 0;
  for (const e of edges) {
    for (const n of nodes) {
      if (n.id === e.from.id || n.id === e.to.id) continue;
      if (polylineThroughBox(e.points, n.bounds, 2)) cutting += 1;
    }
    if (legendArea && polylineThroughBox(e.points, legendArea, 2)) overLegend += 1;
  }
  const total = stacked + cutting + overLegend;
  // Hopeless at one collision for every two components: a drawing where
  // half of everything is under something else has no reading order left.
  const penalty = saturate(CRAFT_WEIGHTS.overlaps, total, Math.max(1, nodes.length / 2));
  const said = [
    stacked ? `${plural(stacked, "pair")} of components overlap` : null,
    cutting ? `${plural(cutting, "edge")} cut through a component` : null,
    overLegend ? `${plural(overLegend, "edge")} cross the legend` : null,
  ].filter((s): s is string => s !== null);
  return {
    key: "overlaps",
    value: total,
    penalty,
    weight: CRAFT_WEIGHTS.overlaps,
    detail: said.length ? said.join(", ") : "nothing sits on top of anything",
  };
}

/** The legend's least colour distance: meanings that differ should look different (D77). */
function colourPart(legend: readonly LegendRule[]): CraftPart & { pair: { a: string; b: string } | null } {
  const closest = closestKinds(legend);
  if (!closest) {
    return {
      key: "colour",
      value: MIN_DELTA_E * 4,
      penalty: 0,
      weight: CRAFT_WEIGHTS.colour,
      detail: "one kind or none — nothing to tell apart",
      pair: null,
    };
  }
  // Hopeless at ΔE zero — two kinds drawn in one colour are one kind to the
  // reader, whatever the legend says.
  const penalty = saturate(CRAFT_WEIGHTS.colour, MIN_DELTA_E - Math.min(closest.distance, MIN_DELTA_E), MIN_DELTA_E);
  return {
    key: "colour",
    value: round2(closest.distance),
    penalty,
    weight: CRAFT_WEIGHTS.colour,
    detail:
      closest.distance < MIN_DELTA_E
        ? `${closest.a} and ${closest.b} are only ΔE ${Math.round(closest.distance)} apart`
        : `the closest kinds, ${closest.a} and ${closest.b}, are ΔE ${Math.round(closest.distance)} apart`,
    pair: { a: closest.a, b: closest.b },
  };
}

// ---------------------------------------------------------------------------
// the score
// ---------------------------------------------------------------------------

function partsFor(nodes: readonly GraphNode[], edges: readonly EdgeGeom[], legend: readonly LegendRule[], legendArea: Box | null): CraftPart[] {
  const { pair: _pair, ...colour } = colourPart(legend);
  const measured: Record<CraftKey, CraftPart> = {
    crossings: crossingsPart(edges),
    bends: bendsPart(edges),
    alignment: alignmentPart(nodes, edges),
    overlaps: overlapsPart(nodes, edges, legendArea),
    lengths: lengthsPart(edges),
    squareness: squarenessPart(nodes, edges),
    colour,
  };
  return PART_ORDER.map((key) => ({ ...measured[key], penalty: round2(measured[key].penalty) }));
}

const scoreOf = (parts: readonly CraftPart[]): number =>
  Math.max(0, Math.min(100, Math.round(100 - parts.reduce((sum, p) => sum + p.penalty, 0))));

/** The costliest part first; ties by weight, then by name, so two runs agree. */
const byCost = (a: CraftPart, b: CraftPart): number => b.penalty - a.penalty || b.weight - a.weight || (a.key < b.key ? -1 : 1);

const worstOf = (parts: readonly CraftPart[]): CraftKey | null => {
  const ranked = [...parts].sort(byCost);
  return ranked.length && ranked[0].penalty > 0 ? ranked[0].key : null;
};

/**
 * What would raise the score most, in Docent's own vocabulary — the fix an
 * agent can actually call, naming the frame the part costs most in where a
 * frame is what is wrong. A part under half a point is not worth a line.
 */
function adviceFor(
  parts: readonly CraftPart[],
  frames: readonly { frame: CraftFrameScore; parts: CraftPart[] }[],
  crowded: ReadonlySet<string>,
  colour: { a: string; b: string } | null,
): string[] {
  // The frame a part costs the most in is the frame to name; a part that
  // costs nothing inside any frame is the diagram's own (unframed Layer 1).
  const worstFrame = (key: CraftKey): CraftFrameScore | null => {
    const cost = (f: { parts: CraftPart[] }) => f.parts.find((p) => p.key === key)?.penalty ?? 0;
    const blamed = frames
      .filter((f) => cost(f) > 0)
      .sort((a, b) => cost(b) - cost(a) || (a.frame.id < b.frame.id ? -1 : 1));
    return blamed[0]?.frame ?? null;
  };
  const lines: string[] = [];
  for (const part of [...parts].sort(byCost)) {
    if (part.penalty < 0.5 || lines.length === 3) break;
    const frame = worstFrame(part.key);
    const cost = `${Math.round(part.penalty)} of ${part.weight}`;
    const tidy = frame ? `tidy({scope:'${frame.id}'})` : "tidy({scope:'diagram'})";
    switch (part.key) {
      case "crossings":
        lines.push(
          frame && crowded.has(frame.id)
            ? `crossings cost ${cost} — ${frame.name} holds more than ${CROWDED_FRAME} components, so add_detail_layer moves the tangle a tier down`
            : `crossings cost ${cost} — ${tidy} lays it out by flow, or layout({frame:${frame ? `'${frame.id}'` : "null"}}) for a frame you built`,
        );
        break;
      case "bends":
        lines.push(`bends cost ${cost} — ${tidy} straightens what can run straight and softens the rest`);
        break;
      case "alignment":
        lines.push(`alignment costs ${cost} — ${tidy} puts what an edge joins on one line`);
        break;
      case "overlaps":
        lines.push(`overlaps cost ${cost} — ${tidy} re-places what sits on top and takes the edges around it`);
        break;
      case "lengths":
        lines.push(`edge lengths cost ${cost} — ${tidy} evens the columns`);
        break;
      case "squareness":
        lines.push(`squareness costs ${cost} — ${tidy} squares what was drawn on the slant and puts every box on the grid`);
        break;
      case "colour":
        lines.push(
          colour
            ? `colour costs ${cost} — define_kind({kind:'${colour.b}'}) again with a backgroundColor further from ${colour.a}`
            : `colour costs ${cost} — define_kind with a more distinct backgroundColor`,
        );
        break;
    }
  }
  return lines;
}

/**
 * The craft score of a whole diagram, with its parts, a score for every
 * frame and the advice that would raise it most (D76). The graph may be
 * handed in when the caller already built one — the score never builds a
 * second.
 */
export function craftScore(snapshot: SceneSnapshot, graph: SceneGraph = buildSceneGraph(snapshot)): CraftScore {
  const geometry = geometryOf(snapshot, graph);
  const legendArea = legendBox(snapshot.elements);
  const parts = partsFor(graph.nodes, geometry, graph.legend, legendArea);
  const colour = colourPart(graph.legend).pair;
  const crowded = new Set<string>();
  const framed: { frame: CraftFrameScore; parts: CraftPart[] }[] = [];
  for (const frame of graph.frames) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    const ids = new Set(members.map((n) => n.id));
    const within = geometry.filter((e) => ids.has(e.from.id) && ids.has(e.to.id));
    if (members.length > CROWDED_FRAME) crowded.add(frame.id);
    const inside = partsFor(members, within, graph.legend, legendArea);
    framed.push({ frame: { id: frame.id, name: frame.name, score: scoreOf(inside), worst: worstOf(inside) }, parts: inside });
  }
  const perFrame = framed.map((f) => f.frame);
  return { score: scoreOf(parts), parts, perFrame, advice: adviceFor(parts, framed, crowded, colour) };
}
