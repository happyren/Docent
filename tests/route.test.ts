/**
 * Edges that flow (D75): ports spread along a side, routed segments nudged
 * off the lines they would share, and right-angle turns softened into arcs
 * — over D72's guarantee that an edge never cuts through a component.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import {
  assignPorts,
  bindingFocus,
  CORNER_RADIUS,
  dropCollinear,
  NUDGE,
  nudgeRoutes,
  outlinePoint,
  polylineThroughBox,
  PORT_SPAN,
  ROUTE_PAD,
  routeEdge,
  sideTowards,
  softenCorners,
  type Point,
} from "../src/authoring/route";
import { idSource, lint, plan, simulate } from "../src/authoring/ops";

const box = (id: string, x: number, y: number, width = 200, height = 200, shape = "rectangle") => ({ id, x, y, width, height, shape });

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
    // Ordered by edge id, not by the order they came in.
    expect(out.get("a_edge")![1][0]).toBe(100 - NUDGE / 2);
    expect(out.get("a_edge")![2][0]).toBe(100 - NUDGE / 2);
    expect(out.get("b_edge")![1][0]).toBe(100 + NUDGE / 2);
    expect(out.get("b_edge")![2][0]).toBe(100 + NUDGE / 2);
    expect(out.get("b_edge")![1][0] - out.get("a_edge")![1][0]).toBe(NUDGE);
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
    expect(out.get("a_edge")![1][0]).toBe(100);
    expect(out.get("b_edge")![1][0]).toBe(100 + NUDGE / 2);
    expect(polylineThroughBox(out.get("a_edge")!, blocker)).toBe(false);
  });

  it("reads the same twice", () => {
    const call = () => nudgeRoutes([{ id: "a_edge", points: a, obstacles: [] }, { id: "b_edge", points: c, obstacles: [] }]);
    expect(call()).toEqual(call());
  });
});

describe("right-angle turns are softened into arcs (D75)", () => {
  it("replaces a corner with two points at the radius", () => {
    const soft = softenCorners([[0, 0], [100, 0], [100, 100]]);
    expect(soft).toEqual([[0, 0], [100 - CORNER_RADIUS, 0], [100, CORNER_RADIUS], [100, 100]]);
  });

  it("takes a shorter radius when a leg is shorter than twice the radius", () => {
    const soft = softenCorners([[0, 0], [30, 0], [30, 100]]);
    expect(soft).toEqual([[0, 0], [15, 0], [30, 15], [30, 100]]);
  });

  it("leaves a straight run and the two ends alone", () => {
    expect(softenCorners([[0, 0], [50, 0], [100, 0]])).toEqual([[0, 0], [50, 0], [100, 0]]);
    expect(softenCorners([[0, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
  });

  it("survives the drop of points that do not turn — they do turn, slightly", () => {
    const soft = softenCorners([[0, 0], [100, 0], [100, 100]]);
    expect(dropCollinear(soft)).toEqual(soft);
    // What is truly collinear still goes, and so do duplicates.
    expect(dropCollinear([[0, 0], [50, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
    expect(dropCollinear([[0, 0], [0, 0], [100, 0]])).toEqual([[0, 0], [100, 0]]);
  });

  it("softens every corner of a routed edge without leaving its corridor", () => {
    const from = { x: 0, y: 0, width: 160, height: 80 };
    const to = { x: 600, y: 0, width: 160, height: 80 };
    const between = { x: 300, y: -20, width: 160, height: 120 };
    const via = routeEdge(from, to, [between])!;
    const line: Point[] = [[160, 40], ...via, [600, 40]];
    const soft = dropCollinear(softenCorners(line));
    expect(soft.length).toBeGreaterThan(line.length);
    expect(polylineThroughBox(soft, between)).toBe(false);
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
    expect(routeEdge(from, to, [{ x: 300, y: 400, width: 160, height: 80 }], ROUTE_PAD, ports)).toBeNull();
    expect(routeEdge(from, to, [between])).not.toBeNull();
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
    // All three arrive on the hub's left side, inside its middle 70%.
    for (const e of ends) {
      expect(e.end[0]).toBe(600);
      expect(e.end[1]).toBeGreaterThanOrEqual(200 - (PORT_SPAN * 80) / 2);
      expect(e.end[1]).toBeLessThanOrEqual(200 + (PORT_SPAN * 80) / 2);
    }
    // And the simulated scene draws from those ports.
    const after = simulate(snapshot, result.write);
    for (const arrow of result.write.arrows!) {
      const el = after.elements.find((el) => el.id === arrow.id)!;
      expect([el.x, el.y]).toEqual(arrow.ends!.start);
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
    const verticals = (line: Point[]) =>
      line.slice(0, -1).map((p, i) => [p, line[i + 1]] as const).filter(([p, q]) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) > 1);
    const [first, second] = lines.map((line) => verticals(line).map(([p]) => p[0]).sort((p, q) => p - q));
    expect(first).toHaveLength(second.length);
    // Every long vertical of one edge sits a full gap from the other's.
    for (let i = 0; i < first.length; i++) expect(Math.abs(first[i] - second[i])).toBeCloseTo(NUDGE, 6);
    const wall = { x: 300, y: -60, width: 160, height: 1200 };
    for (const line of lines) expect(polylineThroughBox(line, wall, 2)).toBe(false);
    // And D72 stands: the scene the write would make has nothing crossed.
    const after = simulate(walled, result.write);
    expect(lint(after).findings.some((f) => f.message.includes("passes through"))).toBe(false);
  });
});
