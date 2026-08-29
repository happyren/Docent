/**
 * Edges that flow (D75), read as one stroke (D78), and are axis-aligned or
 * turn (D98): ports spread along a side, sides chosen by route cost whenever
 * the straight line is not one Docent would draw, near-axis lines snapped
 * true by their ports and oblique ones routed, jogs and hairpins simplified
 * away, routed segments nudged off the lines they would share, and every
 * turn drawn as an arc Docent puts down itself — over D72's guarantee that
 * an edge never cuts through a component.
 */
import { describe, expect, it } from "vitest";
import { buildSceneGraph } from "../src/scene/graph";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { absolutePoints, segmentsCrossProperly,
  arcCorners,
  assignPorts,
  AXIS_SNAP,
  bindingFocus,
  chooseSides,
  CORNER_RADIUS,
  dropCollinear,
  edgeWiggles,
  NUDGE,
  nudgeRoutes,
  outlinePoint,
  polylineThroughBox,
  PORT_SPAN,
  ROUTE_PAD,
  routeEdge,
  routeCorners,
  settleApproaches,
  sideTowards,
  simplifyRoute,
  type Point,
} from "../src/authoring/route";
import { idSource, lint, plan, simulate } from "../src/authoring/ops";

const box = (id: string, x: number, y: number, width = 200, height = 200, shape = "rectangle") => ({ id, x, y, width, height, shape });

/**
 * Whether a drawn line is orthogonal (D98): every leg of it runs along an
 * axis, but for the short chords the arc at a corner leaves behind — no
 * chord of an arc of the corner radius is longer than the radius, so a leg
 * that is neither square nor short is a diagonal somebody drew.
 */
const orthogonal = (pts: readonly Point[]) =>
  pts.slice(0, -1).every((p, i) => {
    const q = pts[i + 1];
    return (
      Math.abs(p[0] - q[0]) < 1e-6 ||
      Math.abs(p[1] - q[1]) < 1e-6 ||
      Math.hypot(q[0] - p[0], q[1] - p[1]) <= CORNER_RADIUS
    );
  });

describe("ports spread along a side (D75)", () => {
  // Three sources to the left of one target, so all three arrive on its left.
  const target = box("target", 400, 0);
  const sources = [box("high", 0, 300), box("mid", 0, 0), box("low", 0, -300)];
  const nodes = new Map([target, ...sources].map((n) => [n.id, n]));
  const edges = [
    { id: "e_high", from: "high", to: "target" },
    { id: "e_mid", from: "mid", to: "target" },
    { id: "e_low", from: "low", to: "target" },
  ];

  it("gives three edges on one side three distinct ports, in their sources' order", () => {
    const ports = assignPorts(edges, nodes);
    expect([...ports.keys()].sort()).toEqual(["e_high", "e_low", "e_mid"]);
    for (const id of ["e_high", "e_mid", "e_low"]) expect(ports.get(id)!.end.side).toBe("left");
    const ys = ["e_low", "e_mid", "e_high"].map((id) => ports.get(id)!.end.at[1]);
    // Distinct, and in the order of their sources across the side's cross axis.
    expect(new Set(ys).size).toBe(3);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    // Every port on the side's own line, and inside its middle 70%.
    const middle = target.y + target.height / 2;
    const reach = (PORT_SPAN * target.height) / 2;
    for (const id of ["e_high", "e_mid", "e_low"]) {
      const port = ports.get(id)!.end;
      expect(port.at[0]).toBe(target.x);
      expect(port.at[1]).toBeGreaterThanOrEqual(middle - reach);
      expect(port.at[1]).toBeLessThanOrEqual(middle + reach);
      // The routing port sits directly outside the padded side, on the same line.
      expect(port.outside).toEqual([target.x - ROUTE_PAD, port.at[1]]);
      expect(port.dir).toBe(0);
    }
    expect(ys).toEqual([65, 100, 135]);
  });

  it("puts a lone edge back at the middle of the side, and reads the same twice", () => {
    const one = assignPorts([edges[1]], nodes);
    expect(one.get("e_mid")!.end.at).toEqual([400, 100]);
    expect(one.get("e_mid")!.start.at).toEqual([200, 100]);
    expect(assignPorts(edges, nodes)).toEqual(assignPorts(edges, nodes));
  });

  it("meets an ellipse and a diamond on their own outline, not their box", () => {
    const round = box("round", 0, 0, 200, 100, "ellipse");
    const kite = box("kite", 0, 0, 200, 100, "diamond");
    // Straight above the centre both shapes reach their bounding box.
    expect(outlinePoint(round, "ellipse", [100, 0])).toEqual([100, 0]);
    // A third of the way along the side, the curve is inside the box.
    const on = outlinePoint(round, "ellipse", [150, 0]);
    expect(on[1]).toBeGreaterThan(0);
    expect(on[0]).toBeLessThan(150);
    expect((on[0] - 100) ** 2 / 100 ** 2 + (on[1] - 50) ** 2 / 50 ** 2).toBeCloseTo(1, 6);
    const kiteOn = outlinePoint(kite, "diamond", [150, 0]);
    expect(Math.abs(kiteOn[0] - 100) / 100 + Math.abs(kiteOn[1] - 50) / 50).toBeCloseTo(1, 6);
  });

  it("names the side that faces the other end", () => {
    const b = { x: 0, y: 0, width: 200, height: 100 };
    expect(sideTowards(b, [500, 50])).toBe("right");
    expect(sideTowards(b, [-500, 50])).toBe("left");
    expect(sideTowards(b, [100, 500])).toBe("bottom");
    expect(sideTowards(b, [100, -500])).toBe("top");
  });
});

describe("binding focus keeps a port when the shape moves (D75)", () => {
  const b = { x: 0, y: 0, width: 200, height: 100 };

  it("is the port's offset along the side, and zero for a line aimed at the centre", () => {
    // A port 30 right of the top's middle is 30/100 of the way to the corner.
    expect(bindingFocus(b, "rectangle", [130, 0], [130, -60])).toBeCloseTo(0.3, 6);
    expect(bindingFocus(b, "rectangle", [70, 0], [70, -60])).toBeCloseTo(-0.3, 6);
    expect(bindingFocus(b, "rectangle", [200, 70], [260, 70])).toBeCloseTo(0.4, 6);
    expect(bindingFocus(b, "rectangle", [0, 70], [-60, 70])).toBeCloseTo(-0.4, 6);
    expect(bindingFocus(b, "rectangle", [130, 100], [130, 160])).toBeCloseTo(-0.3, 6);
    // The middle of a side, and any line through the centre, is focus zero.
    expect(bindingFocus(b, "rectangle", [100, 0], [100, -60])).toBeCloseTo(0, 6);
    expect(bindingFocus(b, "rectangle", [200, 50], [400, 50])).toBeCloseTo(0, 6);
    expect(bindingFocus(b, "ellipse", [200, 50], [400, 50])).toBeCloseTo(0, 6);
  });

  it("stays inside Excalidraw's [-1, 1]", () => {
    for (const u of [-99, -50, 0, 50, 99]) {
      expect(Math.abs(bindingFocus(b, "rectangle", [100 + u, 0], [100 + u, -60]))).toBeLessThanOrEqual(1);
    }
  });
});

describe("segments that would share a line are nudged apart (D75)", () => {
  const a: Point[] = [[0, 0], [100, 0], [100, 200], [200, 200]];
  const c: Point[] = [[0, 50], [100, 50], [100, 300], [200, 300]];

  it("separates two overlapping segments by the gap, centred on the line they shared", () => {
    const out = nudgeRoutes([
      { id: "b_edge", points: c, obstacles: [] },
      { id: "a_edge", points: a, obstacles: [] },
    ]);
    // Parted by the gap — and in the order that does NOT cross the pair
    // (D138): id order put a_edge's lower horizontal through b_edge's line,
    // so the twins swapped sides and the drawing lost a crossing.
    expect(out.get("a_edge")![1][0]).toBe(100 + NUDGE / 2);
    expect(out.get("a_edge")![2][0]).toBe(100 + NUDGE / 2);
    expect(out.get("b_edge")![1][0]).toBe(100 - NUDGE / 2);
    expect(out.get("b_edge")![2][0]).toBe(100 - NUDGE / 2);
    expect(out.get("a_edge")![1][0] - out.get("b_edge")![1][0]).toBe(NUDGE);
    // The legs that meet the components keep their ports, and stay orthogonal.
    expect(out.get("a_edge")![0]).toEqual([0, 0]);
    expect(out.get("a_edge")![3]).toEqual([200, 200]);
    for (const line of [out.get("a_edge")!, out.get("b_edge")!]) {
      for (let i = 0; i + 1 < line.length; i++) {
        expect(line[i][0] === line[i + 1][0] || line[i][1] === line[i + 1][1]).toBe(true);
      }
    }
  });

  it("leaves segments that never overlap, and segments on different lines, alone", () => {
    const far: Point[] = [[0, 400], [300, 400], [300, 600], [400, 600]];
    const out = nudgeRoutes([{ id: "a_edge", points: a, obstacles: [] }, { id: "z_edge", points: far, obstacles: [] }]);
    expect(out.get("a_edge")).toEqual(a);
    expect(out.get("z_edge")).toEqual(far);
  });

  it("keeps the original line rather than push a segment into a component", () => {
    // A box hard against the left of the shared line: a_edge cannot move left.
    const blocker = { x: 100 - NUDGE, y: 80, width: NUDGE - 1, height: 40 };
    const out = nudgeRoutes([
      { id: "a_edge", points: a, obstacles: [blocker] },
      { id: "b_edge", points: c, obstacles: [] },
    ]);
    // a_edge cannot go left, so the pair settles with a_edge on the right —
    // clear of the blocker, parted, and uncrossed (D138).
    expect(out.get("a_edge")![1][0]).toBe(100 + NUDGE / 2);
    expect(out.get("b_edge")![1][0]).toBe(100 - NUDGE / 2);
    expect(polylineThroughBox(out.get("a_edge")!, blocker)).toBe(false);
  });

  it("reads the same twice", () => {
    const call = () => nudgeRoutes([{ id: "a_edge", points: a, obstacles: [] }, { id: "b_edge", points: c, obstacles: [] }]);
    expect(call()).toEqual(call());
  });
});

describe("Docent draws the arcs itself (D78)", () => {
  it("puts a right angle's points on a circle of the corner radius, tangent at both ends", () => {
    const arc = arcCorners([[0, 0], [100, 0], [100, 100]]);
    // Two tangent points and four between them, plus the two ends.
    expect(arc).toHaveLength(8);
    expect(arc[0]).toEqual([0, 0]);
    expect(arc[arc.length - 1]).toEqual([100, 100]);
    // Tangent where the arc meets each leg: a radius back along it.
    expect(arc[1][0]).toBeCloseTo(100 - CORNER_RADIUS, 6);
    expect(arc[1][1]).toBeCloseTo(0, 6);
    expect(arc[arc.length - 2][0]).toBeCloseTo(100, 6);
    expect(arc[arc.length - 2][1]).toBeCloseTo(CORNER_RADIUS, 6);
    // Every point of the arc a radius from the centre of the turn.
    const centre = [100 - CORNER_RADIUS, CORNER_RADIUS];
    for (const p of arc.slice(1, -1)) {
      expect(Math.hypot(p[0] - centre[0], p[1] - centre[1])).toBeCloseTo(CORNER_RADIUS, 1);
      expect(Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - CORNER_RADIUS)).toBeLessThan(0.5);
    }
    // And it sweeps the quarter turn in order, never doubling back.
    const angles = arc.slice(1, -1).map((p) => Math.atan2(p[1] - centre[1], p[0] - centre[0]));
    for (let i = 0; i + 1 < angles.length; i++) expect(angles[i + 1]).toBeGreaterThan(angles[i]);
  });

  it("halves the radius when a leg is too short to carry it", () => {
    const arc = arcCorners([[0, 0], [30, 0], [30, 100]]);
    expect(arc[1][0]).toBeCloseTo(15, 6);
    expect(arc[arc.length - 2][1]).toBeCloseTo(15, 6);
    const centre = [15, 15];
    for (const p of arc.slice(1, -1)) expect(Math.hypot(p[0] - centre[0], p[1] - centre[1])).toBeCloseTo(15, 6);
  });

  it("leaves a straight run and the two ends alone", () => {
    expect(arcCorners([[0, 0], [50, 0], [100, 0]])).toEqual([[0, 0], [50, 0], [100, 0]]);
    expect(arcCorners([[0, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
    // A turn under ten degrees is not a corner and keeps its point.
    expect(arcCorners([[0, 0], [100, 0], [200, 10]])).toEqual([[0, 0], [100, 0], [200, 10]]);
  });

  it("survives the drop of points that do not turn — they do turn, slightly", () => {
    const arc = arcCorners([[0, 0], [100, 0], [100, 100]]);
    expect(dropCollinear(arc)).toEqual(arc);
    // What is truly collinear still goes, and so do duplicates.
    expect(dropCollinear([[0, 0], [50, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
    expect(dropCollinear([[0, 0], [0, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
  });

  it("reads the arc back as the one corner it rounds", () => {
    const line: Point[] = [[0, 0], [100, 0], [100, 100]];
    const back = routeCorners(arcCorners(line));
    expect(back).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(back[i][0]).toBeCloseTo(line[i][0], 6);
      expect(back[i][1]).toBeCloseTo(line[i][1], 6);
    }
    expect(edgeWiggles(arcCorners(line))).toBe(false);
  });

  it("arcs every corner of a routed edge without leaving its corridor", () => {
    const from = { x: 0, y: 0, width: 160, height: 80 };
    const to = { x: 600, y: 0, width: 160, height: 80 };
    const between = { x: 300, y: -20, width: 160, height: 120 };
    const via = routeEdge(from, to, [between])!;
    const line: Point[] = [[160, 40], ...via, [600, 40]];
    const drawn = dropCollinear(arcCorners(line));
    expect(drawn.length).toBeGreaterThan(line.length);
    expect(polylineThroughBox(drawn, between)).toBe(false);
  });
});

describe("a route is simplified before it is drawn (D78)", () => {
  it("collapses a jog shorter than a corner", () => {
    const jog: Point[] = [[0, 0], [60, 0], [60, 10], [200, 10], [200, 120]];
    expect(simplifyRoute(jog, [])).toEqual([[0, 0], [200, 0], [200, 120]]);
  });

  it("removes a hairpin — two turns that double straight back", () => {
    const hairpin: Point[] = [[0, 0], [100, 0], [100, 20], [40, 20], [40, 200]];
    expect(simplifyRoute(hairpin, [])).toEqual([[0, 0], [40, 0], [40, 200]]);
  });

  it("refuses a collapse that would put the edge through a component", () => {
    const jog: Point[] = [[0, 0], [60, 0], [60, 10], [200, 10], [200, 120]];
    // A box sitting on the line the collapse would slide the leg onto.
    const blocker = { x: 100, y: -20, width: 40, height: 25 };
    expect(simplifyRoute(jog, [blocker])).toEqual(jog);
    expect(polylineThroughBox(simplifyRoute(jog, [blocker]), blocker, 2)).toBe(false);
  });

  it("leaves no interior leg shorter than a corner", () => {
    const stairs: Point[] = [[0, 0], [40, 0], [40, 10], [100, 10], [100, 20], [160, 20], [160, 100]];
    const out = simplifyRoute(stairs, []);
    expect(out).toEqual([[0, 0], [160, 0], [160, 100]]);
    for (let i = 1; i + 2 < out.length; i++) {
      expect(Math.hypot(out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1])).toBeGreaterThanOrEqual(CORNER_RADIUS);
    }
  });

  it("leaves the ports where they are, and a clean route alone", () => {
    const clean: Point[] = [[0, 0], [0, -24], [600, -24], [600, 0]];
    expect(simplifyRoute(clean, [])).toEqual(clean);
    const jog: Point[] = [[0, 0], [60, 0], [60, 10], [200, 10], [200, 120]];
    const out = simplifyRoute(jog, []);
    expect(out[0]).toEqual(jog[0]);
    expect(out[out.length - 1]).toEqual(jog[jog.length - 1]);
  });

  it("reads the same twice", () => {
    const jog: Point[] = [[0, 0], [60, 0], [60, 10], [200, 10], [200, 120]];
    expect(simplifyRoute(jog, [])).toEqual(simplifyRoute(jog, []));
  });
});

describe("the lint sees a wiggle (D78)", () => {
  it("names a leg shorter than a corner and a hairpin, and passes a clean route", () => {
    expect(edgeWiggles([[0, 0], [60, 0], [60, 10], [200, 10], [200, 120]])).toBe(true);
    expect(edgeWiggles([[0, 0], [100, 0], [100, 20], [40, 20], [40, 200]])).toBe(true);
    expect(edgeWiggles([[0, 0], [600, 0]])).toBe(false);
    // A U over a row is two turns far apart: one stroke, not a wiggle.
    expect(edgeWiggles([[750, 150], [750, 126], [150, 126], [150, 150]])).toBe(false);
  });
});

describe("the router starts and ends at the ports it is given (D75)", () => {
  const from = { x: 0, y: 0, width: 160, height: 160 };
  const to = { x: 600, y: 0, width: 160, height: 160 };
  const between = { x: 300, y: -20, width: 160, height: 200 };
  const nodes = new Map([
    ["from", { ...from, shape: "rectangle" }],
    ["to", { ...to, shape: "rectangle" }],
  ]);

  it("leaves and enters on the chosen ports, orthogonally, around what is in the way", () => {
    const ports = assignPorts([{ id: "e", from: "from", to: "to" }], nodes).get("e")!;
    const via = routeEdge(from, to, [between], ROUTE_PAD, ports)!;
    expect(via).not.toBeNull();
    const line: Point[] = [ports.start.at, ...via, ports.end.at];
    for (let i = 0; i + 1 < line.length; i++) {
      expect(line[i][0] === line[i + 1][0] || line[i][1] === line[i + 1][1]).toBe(true);
    }
    expect(polylineThroughBox(line, between)).toBe(false);
    // Two runs, one picture.
    expect(routeEdge(from, to, [between], ROUTE_PAD, ports)).toEqual(via);
  });

  it("still keeps a clear straight line, and D72's four side-middle ports without ports", () => {
    const ports = assignPorts([{ id: "e", from: "from", to: "to" }], nodes).get("e")!;
    // The two ends are level, so the clear line is square and stands (D98).
    expect(routeEdge(from, to, [{ x: 300, y: 400, width: 160, height: 80 }], ROUTE_PAD, ports)).toBeNull();
    expect(routeEdge(from, to, [between])).not.toBeNull();
  });
});

describe("an edge is axis-aligned or it turns (D98)", () => {
  const portsFor = (from: ReturnType<typeof box>, to: ReturnType<typeof box>) =>
    assignPorts([{ id: "e", from: from.id, to: to.id }], new Map([from, to].map((b) => [b.id, b]))).get("e")!;
  /** Whether every leg of a drawn line runs along one axis. */
  const squareAll = (line: readonly Point[]) =>
    line.slice(0, -1).every((p, i) => Math.abs(p[0] - line[i + 1][0]) < 1e-6 || Math.abs(p[1] - line[i + 1][1]) < 1e-6);
  const from = box("from", 0, 0, 160, 80);

  it("routes an oblique pair with nothing in its way, every segment square", () => {
    const to = box("to", 600, 300, 160, 80);
    const ports = portsFor(from, to);
    const via = routeEdge(from, to, [], ROUTE_PAD, ports);
    // Nothing is in the way and the line is clear — and it turns all the same.
    expect(via).not.toBeNull();
    const line: Point[] = [ports.start.at, ...via!, ports.end.at];
    expect(squareAll(line)).toBe(true);
    // At least one corner: two ends and a turn between them.
    expect(routeCorners(line).length).toBeGreaterThanOrEqual(3);
    // Nothing was snapped — the ports are where D75 spread them.
    expect(ports.start.at).toEqual([160, 40]);
    expect(ports.end.at).toEqual([600, 340]);
    // Centre to centre, where there is no port to slide, it turns too.
    const bare = routeEdge(from, to, [])!;
    expect(bare).not.toBeNull();
    expect(squareAll([[80, 40], ...bare, [680, 340]])).toBe(true);
  });

  it("snaps a near-axis pair exactly true, by its ports, and keeps the straight line", () => {
    const to = box("to", 600, 3, 160, 80);
    const ports = portsFor(from, to);
    // Three px of slope between the ports before the router sees them.
    expect([ports.start.at, ports.end.at]).toEqual([[160, 40], [600, 43]]);
    expect(routeEdge(from, to, [], ROUTE_PAD, ports)).toBeNull();
    // Both ends gave half, and the drawn line is exactly horizontal.
    expect(ports.end.at[1] - ports.start.at[1]).toBe(0);
    expect(ports.start.at).toEqual([160, 41.5]);
    expect(ports.end.at).toEqual([600, 41.5]);
    // Each port still on its own side, inside the spread D75 gives it, with
    // its routing point carried along.
    expect([ports.start.side, ports.end.side]).toEqual(["right", "left"]);
    expect(ports.start.outside).toEqual([160 + ROUTE_PAD, 41.5]);
    expect(ports.end.outside).toEqual([600 - ROUTE_PAD, 41.5]);
    for (const port of [ports.start, ports.end]) {
      expect(Math.abs(port.at[1] - 41.5)).toBeLessThanOrEqual((PORT_SPAN * 80) / 2);
    }
    // The same holds down the other axis, where the ports slide along a top
    // and a bottom instead.
    const below = box("below", 3, 400, 160, 80);
    const down = portsFor(from, below);
    expect([down.start.side, down.end.side]).toEqual(["bottom", "top"]);
    expect(routeEdge(from, below, [], ROUTE_PAD, down)).toBeNull();
    expect(down.end.at[0] - down.start.at[0]).toBe(0);
    expect(down.start.at).toEqual([81.5, 80]);
  });

  it("routes a pair past the tolerance rather than magnet it into line", () => {
    // Fifteen px of slope: past the snap, and well under a corner — the
    // tolerance is a snap, not a magnet.
    const to = box("to", 600, 15, 160, 80);
    const ports = portsFor(from, to);
    const via = routeEdge(from, to, [], ROUTE_PAD, ports);
    expect(via).not.toBeNull();
    expect(ports.start.at).toEqual([160, 40]);
    expect(ports.end.at).toEqual([600, 55]);
    const line: Point[] = [ports.start.at, ...via!, ports.end.at];
    expect(squareAll(line)).toBe(true);
    expect(routeCorners(line).length).toBeGreaterThanOrEqual(3);
    // Either side of the tolerance itself: at it the line is snapped, one px
    // past it the edge turns.
    const at = box("at", 600, AXIS_SNAP, 160, 80);
    const atPorts = portsFor(from, at);
    expect(routeEdge(from, at, [], ROUTE_PAD, atPorts)).toBeNull();
    expect(atPorts.end.at[1] - atPorts.start.at[1]).toBe(0);
    const past = box("past", 600, AXIS_SNAP + 1, 160, 80);
    expect(routeEdge(from, past, [], ROUTE_PAD, portsFor(from, past))).not.toBeNull();
  });

  it("keeps the last-resort straight when the grid has no path", () => {
    const boxed = box("boxed", 400, 300, 100, 100);
    const small = box("small", 0, 0, 100, 100);
    // A component so wide that nothing gets round it: no grid line is open,
    // and a diagonal that cannot route beats no edge at all.
    const swallow = { x: -400, y: -400, width: 1600, height: 1600 };
    const ports = portsFor(small, boxed);
    const line: Point[] = [ports.start.at, ports.end.at];
    // Oblique and blocked, so a null here can only be the last resort.
    expect(Math.abs(line[1][0] - line[0][0])).toBeGreaterThan(AXIS_SNAP);
    expect(Math.abs(line[1][1] - line[0][1])).toBeGreaterThan(AXIS_SNAP);
    expect(polylineThroughBox(line, swallow)).toBe(true);
    expect(routeEdge(small, boxed, [swallow], ROUTE_PAD, ports)).toBeNull();
    // And the ports it was given come back untouched: nothing was snapped.
    expect([ports.start.at, ports.end.at]).toEqual([[100, 50], [400, 350]]);
  });

  it("costs an oblique clear pair as the route it will be, not as a free line", () => {
    const to = box("to", 600, 300, 160, 80);
    // D78 read a clear line as the end of it and left the facing sides
    // alone; the line is clear here, and no longer straight, so the sides
    // are costed like any route — and out of the right into the top is one
    // turn where the facing pair would have taken two.
    expect(sideTowards(to, [80, 40])).toBe("left");
    expect(chooseSides(from, to, [])).toEqual({ start: "right", end: "top" });
    // A clear line that is square is still drawn: the facing sides stand.
    expect(chooseSides(from, box("level", 600, 0, 160, 80), [])).toBeNull();
    expect(chooseSides(from, box("nearly", 600, 3, 160, 80), [])).toBeNull();
  });
});

describe("a planned batch draws flowing edges (D75)", () => {
  const base = {
    angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
    fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
    groupIds: [], frameId: null, isDeleted: false, locked: false,
  };
  const node = (id: string, x: number, y: number, label: string) => [
    { ...base, id, type: "rectangle", x, y, width: 160, height: 80, boundElements: [{ id: `${id}_t`, type: "text" }] },
    { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20 },
  ];
  const raw = [
    ...node("a", 0, 0, "Alpha"),
    ...node("b", 0, 200, "Beta"),
    ...node("c", 0, 400, "Gamma"),
    ...node("hub", 600, 160, "Hub"),
  ];
  const snapshot = snapshotFromRawElements(raw as never);
  const batch = [
    { op: "add_edge" as const, from: "a", to: "hub", label: "one" },
    { op: "add_edge" as const, from: "b", to: "hub", label: "two" },
    { op: "add_edge" as const, from: "c", to: "hub", label: "three" },
  ];

  it("gives every drawn edge its own port on the hub, all distinct", () => {
    const result = plan(batch, snapshot, idSource(1));
    const ends = result.write.arrows!.map((a) => a.ends!);
    expect(ends.every(Boolean)).toBe(true);
    const arriving = ends.map((e) => `${e.end[0]},${e.end[1]}`);
    expect(new Set(arriving).size).toBe(3);
    // Every leg arrives on the hub's own outline, inside the middle 70% of
    // the side it uses. Until D98 all three came in on the left, the side
    // that faces them, because all three were drawn as straight diagonals;
    // now each turns, and the sides are the pair its route costs least from
    // — the two above and below the hub come in over its top and under its
    // bottom, which is one turn where the left side would have been two.
    const hub = { x: 600, y: 160, width: 160, height: 80 };
    for (const [x, y] of ends.map((e) => e.end)) {
      const upright = x === hub.x || x === hub.x + hub.width;
      expect(upright || y === hub.y || y === hub.y + hub.height).toBe(true);
      const along = upright ? y : x;
      const middle = upright ? hub.y + hub.height / 2 : hub.x + hub.width / 2;
      const span = upright ? hub.height : hub.width;
      expect(Math.abs(along - middle)).toBeLessThanOrEqual((PORT_SPAN * span) / 2);
    }
    expect(arriving.sort()).toEqual(["600,200", "680,160", "680,240"]);
    // And the simulated scene draws from those ports.
    const after = simulate(snapshot, result.write);
    for (const arrow of result.write.arrows!) {
      const el = after.elements.find((el) => el.id === arrow.id)!;
      expect([el.x, el.y]).toEqual(arrow.ends!.start);
    }
    // Every leg is square: no diagonal survives (D98).
    for (const arrow of result.write.arrows!) {
      expect(orthogonal([arrow.ends!.start, ...(arrow.via ?? []), arrow.ends!.end])).toBe(true);
    }
  });

  it("reads the same twice", () => {
    expect(plan(batch, snapshot, idSource(1))).toEqual(plan(batch, snapshot, idSource(1)));
  });

  // A wall too long to go under: both edges take the same way over it, so
  // their segments would run together until D75 pushes them apart.
  const walled = snapshotFromRawElements([
    ...node("a1", 0, 0, "Alpha in"),
    ...node("a2", 600, 0, "Alpha out"),
    ...node("b1", 0, 200, "Beta in"),
    ...node("b2", 600, 200, "Beta out"),
    { ...base, id: "wall", type: "rectangle", x: 300, y: -60, width: 160, height: 1200 },
  ] as never);
  const twoWays = [
    { op: "add_edge" as const, from: "a1", to: "a2" },
    { op: "add_edge" as const, from: "b1", to: "b2" },
  ];

  it("nudges two routed edges off the line they would share, through nothing", () => {
    const result = plan(twoWays, walled, idSource(3));
    const lines = result.write.arrows!.map((a) => [a.ends!.start, ...a.via!, a.ends!.end] as Point[]);
    expect(lines).toHaveLength(2);
    // Both edges cross the wall along one line above it (D78 takes each of
    // them over the top rather than out of a side and straight back down).
    const horizontals = (line: Point[]) =>
      line.slice(0, -1).map((p, i) => [p, line[i + 1]] as const).filter(([p, q]) => Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[0] - q[0]) > 100);
    const [first, second] = lines.map((line) => horizontals(line).map(([p]) => p[1]).sort((p, q) => p - q));
    expect(first).toHaveLength(second.length);
    expect(first.length).toBeGreaterThan(0);
    // Every long run of one edge sits a full gap from the other's.
    for (let i = 0; i < first.length; i++) expect(Math.abs(first[i] - second[i])).toBeCloseTo(NUDGE, 6);
    const wall = { x: 300, y: -60, width: 160, height: 1200 };
    for (const line of lines) expect(polylineThroughBox(line, wall, 2)).toBe(false);
    // And D72 stands: the scene the write would make has nothing crossed.
    const after = simulate(walled, result.write);
    expect(lint(after).findings.some((f) => f.message.includes("passes through"))).toBe(false);
  });
});

describe("a routed edge reads as one stroke (D78)", () => {
  const base = {
    angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
    fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
    groupIds: [], frameId: null, isDeleted: false, locked: false,
  };
  /** A hand-placed component of the row: a 220 × 110 ellipse with its label. */
  const oval = (id: string, x: number, label: string) => [
    { ...base, id, type: "ellipse", x, y: 150, width: 220, height: 110, boundElements: [{ id: `${id}_t`, type: "text" }] },
    { ...base, id: `${id}_t`, type: "text", x: x + 20, y: 195, width: 180, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20 },
  ];
  /** An arrow drawn where it says it is — absolute points, relative to its origin. */
  const drawn = (id: string, from: string, to: string, points: readonly Point[]) => ({
    ...base, id, type: "arrow", roundness: { type: 2 }, endArrowhead: "arrow",
    x: points[0][0], y: points[0][1],
    width: Math.abs(points[points.length - 1][0] - points[0][0]),
    height: Math.abs(points[points.length - 1][1] - points[0][1]),
    points: points.map((p) => [p[0] - points[0][0], p[1] - points[0][1]]),
    startBinding: { elementId: from }, endBinding: { elementId: to },
  });
  // A row of four, left to right, each edge straight between the outlines.
  const row = snapshotFromRawElements([
    ...oval("a", 40, "Alpha"),
    ...oval("b", 340, "Beta"),
    ...oval("c", 640, "Gamma"),
    ...oval("d", 940, "Delta"),
    drawn("ab", "a", "b", [[260, 205], [340, 205]]),
    drawn("bc", "b", "c", [[560, 205], [640, 205]]),
    drawn("cd", "c", "d", [[860, 205], [940, 205]]),
  ] as never);
  const backEdge = [{ op: "add_edge" as const, from: "c", to: "a", label: "retry" }];

  it("takes the back edge over or under the row, in one channel, with two turns", () => {
    const result = plan(backEdge, row, idSource(11));
    const arrow = result.write.arrows![0];
    const line: Point[] = [arrow.ends!.start, ...arrow.via!, arrow.ends!.end];
    // It leaves Gamma through the top or the bottom, and enters Alpha the same way.
    expect([150, 260]).toContain(arrow.ends!.start[1]);
    expect(arrow.ends!.end[1]).toBe(arrow.ends!.start[1]);
    expect(arrow.ends!.start[0]).toBe(750);
    expect(arrow.ends!.end[0]).toBe(150);
    // Two turns, no more: out of the row, along one channel, and back in.
    const corners = routeCorners(line);
    expect(corners).toHaveLength(4);
    // No leg between the turns is shorter than a corner.
    for (let i = 1; i + 2 < corners.length; i++) {
      expect(Math.hypot(corners[i + 1][0] - corners[i][0], corners[i + 1][1] - corners[i][1])).toBeGreaterThanOrEqual(CORNER_RADIUS);
    }
    expect(edgeWiggles(line)).toBe(false);
    // Through nothing, and the lint has nothing to say about it.
    const boxes = [{ id: "b", x: 340, y: 150, width: 220, height: 110 }, { id: "d", x: 940, y: 150, width: 220, height: 110 }];
    for (const box of boxes) expect(polylineThroughBox(line, box, 2)).toBe(false);
    const after = simulate(row, result.write);
    expect(lint(after).findings.filter((f) => f.level === "warn" && f.message.includes("Gamma → Alpha"))).toEqual([]);
  });

  it("chooses those sides by what the route costs, not by which one faces", () => {
    const boxOf = (x: number) => ({ x, y: 150, width: 220, height: 110, shape: "ellipse" });
    const others = [{ x: 340, y: 150, width: 220, height: 110 }, { x: 940, y: 150, width: 220, height: 110 }];
    // Gamma faces Alpha with its left side; the cheap way home is over the row.
    expect(sideTowards(boxOf(640), [150, 205])).toBe("left");
    expect(chooseSides(boxOf(640), boxOf(40), others)).toEqual({ start: "top", end: "top" });
    // With nothing in the way the facing sides stand, as D75 left them.
    expect(chooseSides(boxOf(640), boxOf(40), [])).toBeNull();
  });

  it("flags the routed arrow sharp, so Excalidraw draws the arcs and not its own curve", () => {
    const result = plan(backEdge, row, idSource(11));
    const arrow = result.write.arrows![0];
    expect(arrow.via!.length).toBeGreaterThan(0);
    expect(arrow.sharp).toBe(true);
    // And the scene the write would make carries a sharp polyline.
    const after = simulate(row, result.write);
    expect(after.elements.find((el) => el.id === arrow.id)!.look.roundness).toBeNull();
  });

  it("reads the same twice", () => {
    expect(plan(backEdge, row, idSource(11))).toEqual(plan(backEdge, row, idSource(11)));
  });
});

describe("tidy re-routes every bound edge in its scope (D73, amended by A19)", () => {
  const base = {
    angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
    fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
    groupIds: [], frameId: null, isDeleted: false, locked: false,
  };
  const box = (id: string, x: number, y: number, label: string) => [
    { ...base, id, type: "rectangle", x, y, width: 160, height: 80, frameId: "F", boundElements: [{ id: `${id}_t`, type: "text" }] },
    { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, frameId: "F", fontFamily: 5, fontSize: 20 },
  ];
  const arrow = (id: string, from: string, to: string) => ({
    ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, frameId: "F", roundness: { type: 2 },
    points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow",
  });
  const raw = [
    { ...base, id: "F", type: "frame", name: "Flow", x: 0, y: 0, width: 900, height: 400, customData: { docent: { narrative: "One flow." } } },
    ...box("one", 40, 100, "One"),
    ...box("two", 340, 100, "Two"),
    ...box("three", 640, 100, "Three"),
    arrow("e1", "one", "two"),
    arrow("e2", "two", "three"),
  ];

  /** The frame after one tidy: every component where the layout puts it. */
  const settled = simulate(snapshotFromRawElements(raw as never), plan([{ op: "layout", frame: "F" }], snapshotFromRawElements(raw as never), idSource(21)).write);
  // One edge hand-drawn as a zigzag, its ends left exactly where they are.
  const zigzagged = {
    elements: settled.elements.map((el) =>
      el.id === "e1"
        ? { ...el, x: 200, y: 140, points: [[0, 0], [60, 0], [60, 10], [100, 10], [100, -40], [160, -40], [160, 0]] as [number, number][] }
        : el,
    ),
  };

  it("re-routes an edge whose ends did not move, and draws it as one stroke", () => {
    const result = plan([{ op: "layout", frame: "F" }], zigzagged, idSource(22));
    const patches = result.write.patches ?? [];
    // Nothing moved: a second tidy has nothing left to place.
    for (const id of ["one", "two", "three"]) {
      const patch = patches.find((p) => p.id === id);
      expect(patch?.x).toBeUndefined();
      expect(patch?.y).toBeUndefined();
    }
    // The zigzag is re-routed all the same, because the frame was re-laid.
    const patch = patches.find((p) => p.id === "e1");
    expect(patch).toBeDefined();
    expect(patch!.via).toBeDefined();
    expect(patch!.ends).toBeDefined();
    const line: Point[] = [patch!.ends!.start, ...patch!.via!, patch!.ends!.end];
    // Straight, or two turns at most — never the six the hand left.
    expect(routeCorners(line).length).toBeLessThanOrEqual(4);
    expect(edgeWiggles(line)).toBe(false);
    expect(patch!.sharp).toBe(patch!.via!.length > 0);
    // And the lint stops saying the edge doubles back.
    expect(lint(zigzagged).findings.some((f) => f.message.includes("doubles back"))).toBe(true);
    expect(lint(simulate(zigzagged, result.write)).findings.some((f) => f.message.includes("doubles back"))).toBe(false);
  });

  it("leaves the untouched edges of an ordinary edit alone", () => {
    const added = plan([{ op: "add_node", label: "Four", kind: "service" }], zigzagged, idSource(23));
    expect((added.write.patches ?? []).some((p) => p.id === "e1")).toBe(false);
  });

  it("reads the same twice", () => {
    expect(plan([{ op: "layout", frame: "F" }], zigzagged, idSource(22))).toEqual(plan([{ op: "layout", frame: "F" }], zigzagged, idSource(22)));
  });
});

describe("the fan stays untangled (D75)", () => {
it("a hub's fan never crosses itself (D75)", () => {
  const snap = snapshotFromRawElements([] as never);
  const ops: any[] = [
    { op: "define_kind", kind: "svc", shape: "rectangle" },
    { op: "add_frame", ref: "$f", name: "Hub" },
    { op: "add_node", ref: "$hub", label: "Hub", kind: "svc", frame: "$f", intents: ["x"] },
  ];
  for (let i = 0; i < 6; i++) {
    ops.push({ op: "add_node", ref: `$t${i}`, label: `Target ${i}`, kind: "svc", frame: "$f", intents: ["x"] });
    ops.push({ op: "add_edge", from: "$hub", to: `$t${i}`, label: `call ${i}` });
  }
  for (let i = 0; i < 2; i++) {
    ops.push({ op: "add_node", ref: `$u${i}`, label: `Deep ${i}`, kind: "svc", frame: "$f", intents: ["x"] });
    ops.push({ op: "add_edge", from: `$t${i}`, to: `$u${i}`, label: `next ${i}` });
  }
  ops.push({ op: "add_edge", from: "$t5", to: "$hub", label: "report back" });
  const r = plan(ops, snap, idSource(3));
    const after = simulate(snap, r.write);
  const g = buildSceneGraph(after);
  const els = new Map(after.elements.map((e) => [e.id, e]));
  const lines: any[] = [];
  for (const e of g.edges) {
    const el = els.get(e.sourceId)!;
    if (el.points) lines.push({ id: e.id, pts: absolutePoints(el.x, el.y, el.points), from: e.from, to: e.to });
  }
  // The two-way pair (hub↔t5) has interleaved ports at both ends, so once
  // D138 honestly parts their coincident stretch — two wires on one line
  // were the hidden version of the same defect — planarity forces exactly
  // one crossing between THEM. Every other pair stays untangled.
  const twins = (u: { from: string; to: string }, v: { from: string; to: string }) =>
    u.from === v.to && u.to === v.from;
  let total = 0;
  let twinTotal = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    for (let s = 0; s + 1 < lines[i].pts.length; s++) for (let t = 0; t + 1 < lines[j].pts.length; t++)
      if (segmentsCrossProperly(lines[i].pts[s], lines[i].pts[s+1], lines[j].pts[t], lines[j].pts[t+1])) {
        if (twins(lines[i], lines[j])) twinTotal++;
        else total++;
      }
  }
  expect(total).toBe(0);
  expect(twinTotal).toBeLessThanOrEqual(1);
  // And every leg of every one of them runs along an axis (D98): the fan is
  // orthogonal and untangled at once, which is the whole of the claim.
  expect(lines).toHaveLength(9);
  for (const line of lines) expect(orthogonal(line.pts)).toBe(true);
});
});

describe("a bottom port stands past the caption (D83)", () => {
  it("routes a vertical pair from the foot, never through the words", () => {
    const upper = { x: 0, y: 0, width: 80, height: 80, foot: 120 };
    const lower = { x: 0, y: 300, width: 80, height: 80, foot: 420 };
    const jobs = [{ id: "e", from: "a", to: "b" }];
    const nodes = new Map([["a", upper], ["b", lower]]);
    const ports = assignPorts(jobs, nodes, ROUTE_PAD, new Map([["e", { start: "bottom", end: "top" } as const]]));
    const pe = ports.get("e")!;
    // The start stands on the component's foot — below the caption strip —
    // and the straight vertical line between the ports crosses no words.
    expect(pe.start.side).toBe("bottom");
    expect(pe.start.at[1]).toBe(120);
    expect(pe.end.at[1]).toBe(300);
    const route = routeEdge(upper, lower, [], ROUTE_PAD, pe);
    // Axis-aligned clear pair: the fast path stands (D98) — from the foot.
    expect(route).toBeNull();
  });
});

describe("the arrowhead earns a runway (D137)", () => {
  // A cramped tail: the run rides y=140, the port sits at y=128, and the
  // drop onto the port column happens inside the last stub — the maintainer's
  // "you cannot see the arrow" report, in four points.
  const to = { id: "b", x: 400, y: 100, width: 120, height: 80 };
  const from = { id: "a", x: 0, y: 100, width: 100, height: 80 };
  const port = () => ({
    start: { side: "right" as const, at: [100, 140] as Point, outside: [124, 140] as Point, dir: 0 as const },
    end: { side: "left" as const, at: [400, 128] as Point, outside: [376, 128] as Point, dir: 0 as const },
  });
  const cramped = (): Point[] => [
    [100, 140],
    [376, 140],
    [376, 128],
    [400, 128],
  ];

  it("walks the port onto the run's line when the seat is free", () => {
    const ports = port();
    const settled = settleApproaches(cramped(), ports, from, to, [], () => false);
    expect(settled).toEqual([
      [100, 140],
      [400, 140],
    ]);
    // The walked port is handed back — the caller draws what was settled.
    expect(ports.end.at).toEqual([400, 140]);
    expect(ports.end.outside).toEqual([376, 140]);
  });

  it("steps the turn back a full corner when a sibling holds the seat", () => {
    const ports = port();
    const settled = settleApproaches(cramped(), ports, from, to, [], (which) => which === "end");
    expect(settled).toEqual([
      [100, 140],
      [352, 140],
      [352, 128],
      [400, 128],
    ]);
    // The final straight into the arrowhead is stub plus corner.
    expect(400 - 352).toBe(ROUTE_PAD + CORNER_RADIUS);
    expect(ports.end.at).toEqual([400, 128]);
  });

  it("stands honestly when geometry allows neither", () => {
    const ports = port();
    // A block square across both the walked line and the stepped-back drop.
    const wall = { x: 340, y: 125, width: 24, height: 40 };
    const settled = settleApproaches(cramped(), ports, from, to, [wall], () => false);
    expect(settled).toEqual(cramped());
    expect(ports.end.at).toEqual([400, 128]);
  });

  it("leaves a clean approach alone", () => {
    const ports = port();
    const clean: Point[] = [
      [100, 140],
      [300, 140],
      [300, 128],
      [400, 128],
    ];
    const settled = settleApproaches(clean, ports, from, to, [], () => false);
    expect(settled).toEqual(clean);
  });

  it("settles the head the same way", () => {
    const ports = port();
    // The cramped end is the SOURCE: a drop inside the first stub.
    const pts: Point[] = [
      [100, 140],
      [124, 140],
      [124, 152],
      [380, 152],
      [380, 128],
      [400, 128],
    ];
    const settled = settleApproaches(pts, ports, from, to, [], () => false);
    // Both ends were cramped; both ports walk onto the run's line and the
    // whole edge becomes the one straight stroke it always wanted to be.
    expect(settled).toEqual([
      [100, 152],
      [400, 152],
    ]);
    expect(ports.start.at).toEqual([100, 152]);
    expect(ports.end.at).toEqual([400, 152]);
  });
});

describe("the pure L walks the other port (D137)", () => {
  it("moves the source port so the drop column steps back, taking what the span affords", () => {
    // The run rides the source port's own column: an L whose approach into
    // the target is 12px — the other port must walk, and the full runway
    // would walk it out of its span, so the graceful rung takes 24.
    const from = { id: "a", x: 0, y: 0, width: 100, height: 100 };
    const to = { id: "b", x: 62, y: 300, width: 200, height: 80 };
    const ports = {
      start: { side: "bottom" as const, at: [50, 100] as Point, outside: [50, 124] as Point, dir: 1 as const },
      end: { side: "left" as const, at: [62, 340] as Point, outside: [38, 340] as Point, dir: 0 as const },
    };
    const pts: Point[] = [
      [50, 100],
      [50, 340],
      [62, 340],
    ];
    const settled = settleApproaches(pts, ports, from, to, [], () => false);
    expect(settled).toEqual([
      [38, 100],
      [38, 340],
      [62, 340],
    ]);
    expect(ports.start.at).toEqual([38, 100]);
    expect(ports.end.at).toEqual([62, 340]);
  });
});

describe("the words own their air (D138)", () => {
  // Long parallel runs with room to give on every leg.
  const line = (y: number): Point[] => [
    [0, y - 100],
    [80, y - 100],
    [80, y],
    [1000, y],
    [1000, y - 100],
    [1080, y - 100],
  ];

  it("spreads a labelled pair to the label's height, not the wire gap", () => {
    const out = nudgeRoutes([
      { id: "a", points: line(500), obstacles: [], labelHeight: 20 },
      { id: "b", points: line(500), obstacles: [] },
    ]);
    const ya = out.get("a")![2][1];
    const yb = out.get("b")![2][1];
    // The label segment claims 10 + 4 of air; the bare line claims 6.
    expect(Math.abs(ya - yb)).toBeCloseTo(20, 5);
    expect((ya + yb) / 2).toBeCloseTo(500, 5);
  });

  it("counts near-coincident strangers as one corridor and stands off locked lines", () => {
    // Three runs three units apart — the maintainer's screenshot — with the
    // middle one a standing line from outside the batch.
    const out = nudgeRoutes([
      { id: "a", points: line(497), obstacles: [], labelHeight: 20 },
      { id: "wall", points: line(500), obstacles: [], locked: true, labelHeight: 20 },
      { id: "b", points: line(503), obstacles: [], labelHeight: 20 },
    ]);
    // The wall never moves and never comes back as a result.
    expect(out.has("wall")).toBe(false);
    const ya = out.get("a")![2][1];
    const yb = out.get("b")![2][1];
    // Both movable lines give the whole way: 14 + 14 of air each side.
    expect(500 - ya).toBeGreaterThanOrEqual(27.5);
    expect(yb - 500).toBeGreaterThanOrEqual(27.5);
  });

  it("leaves distinct corridors alone", () => {
    const out = nudgeRoutes([
      { id: "a", points: line(500), obstacles: [], labelHeight: 20 },
      { id: "b", points: line(560), obstacles: [], labelHeight: 20 },
    ]);
    expect(out.get("a")![2][1]).toBe(500);
    expect(out.get("b")![2][1]).toBe(560);
  });
});
