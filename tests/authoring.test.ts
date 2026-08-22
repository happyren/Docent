/**
 * Agent authoring (S19): meaning in, one write out — in the diagram's own
 * style, placed politely, validated whole, simulated for the diff, linted.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { describeChange } from "../src/scene/diff";
import { houseStyle, resolveLook } from "../src/authoring/style";
import { columnsPerBand, edgeLabelSize, layeredLayout, placeInFrame, sizeForLabel } from "../src/authoring/layout";
import { absolutePoints, polylineThroughBox, routeEdge } from "../src/authoring/route";
import { idSource, lint, plan, PlanError, simulate } from "../src/authoring/ops";

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
  groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const box = (id: string, x: number, y: number, label: string, extra: Record<string, unknown> = {}) => [
  { ...base, id, type: "rectangle", x, y, width: 160, height: 80, frameId: "F", boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, frameId: "F", fontFamily: 5, fontSize: 20 },
];
const arrow = (id: string, from: string, to: string) => ({
  ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, frameId: "F", roundness: { type: 2 },
  points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow",
});
const legend = [
  { attr: "backgroundColor", value: "#a5d8ff", also: [{ attr: "shape", value: "ellipse" }], key: "kind", meaning: "datastore" },
  { attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" },
];
const raw = [
  { ...base, id: "F", type: "frame", name: "02 Core Services", x: 0, y: 0, width: 900, height: 400, customData: { docent: { narrative: "Orders pass through here." } } },
  { ...base, id: "legend", type: "text", x: 0, y: -120, width: 200, height: 40, text: "Legend", locked: true, customData: { docent: { legend } } },
  ...box("gateway", 40, 100, "API Gateway", { backgroundColor: "#ffec99", customData: { docent: { note: "rate-limits at the edge" } } }),
  ...box("orders", 340, 100, "Orders", { backgroundColor: "#ffec99", strokeWidth: 2, customData: { docent: { note: "owns order state" } } }),
  { ...base, id: "db", type: "ellipse", x: 640, y: 100, width: 180, height: 90, frameId: "F", backgroundColor: "#a5d8ff", boundElements: [{ id: "db_t", type: "text" }] },
  { ...base, id: "db_t", type: "text", x: 660, y: 130, width: 140, height: 20, text: "Postgres", containerId: "db", frameId: "F", fontFamily: 5, fontSize: 20 },
  arrow("e1", "gateway", "orders"),
  arrow("e2", "orders", "db"),
];
const snapshot = snapshotFromRawElements(raw as never);
const graph = buildSceneGraph(snapshot);

describe("house style (D59)", () => {
  it("reads the author's conventions and the legend's kinds", () => {
    const house = houseStyle(snapshot, graph);
    expect(house.shape.strokeColor).toBe("#1e1e1e");
    expect(house.shape.fontFamily).toBe(5);
    expect(house.shape.roundness).toBe(3);
    expect(house.arrow.endArrowhead).toBe("arrow");
    expect(house.defaultShape).toBe("rectangle");
    // A legend kind resolves through the legend: datastore = blue ellipse.
    const ds = resolveLook("datastore", house, graph.legend);
    expect(ds).toMatchObject({ shape: "ellipse", source: "legend" });
    expect(ds.style.backgroundColor).toBe("#a5d8ff");
    // A kind drawn but not in the legend resolves from what the author drew.
    expect(resolveLook("nope", house, graph.legend).source).toBe("house");
  });
});

describe("layout (D60)", () => {
  it("sizes to the label and places after the anchor on free space", () => {
    const size = sizeForLabel("Retry queue", 20, "rectangle");
    expect(size.width).toBeGreaterThanOrEqual(150);
    const frame = { x: 0, y: 0, width: 900, height: 400 };
    const occupied = [{ x: 40, y: 100, width: 160, height: 80 }];
    const placed = placeInFrame(frame, occupied, size, occupied[0]);
    expect(placed.x).toBe(40 + 160 + 60);
    expect(placed.y).toBe(100);
    // No anchor: first free spot in the first row.
    const free = placeInFrame(frame, occupied, size, null);
    expect(free.y).toBeLessThanOrEqual(100 + 80 + 50);
  });

  it("layers by flow, feeders left of what they feed", () => {
    const sizes = new Map(graph.nodes.map((n) => [n.id, { width: 160, height: 80 }]));
    const boxes = layeredLayout(graph.nodes, graph.edges, sizes, { x: 0, y: 0 });
    const x = (label: string) => boxes.get(graph.nodes.find((n) => n.label === label)!.id)!.x;
    expect(x("API Gateway")).toBeLessThan(x("Orders"));
    expect(x("Orders")).toBeLessThan(x("Postgres"));
  });
});

describe("plan (D59, D62)", () => {
  it("compiles a batch into one write, in the house style, with refs resolved", () => {
    const result = plan(
      [
        { op: "add_node", ref: "$retry", label: "Retry queue", kind: "service", frame: "F", intents: ["retries failed charges"], logic: "if charge fails: retry 3x then park", after: "orders" },
        { op: "add_edge", from: "orders", to: "$retry", label: "park", intents: ["only after three failures"] },
        { op: "update", id: "gateway", intents: ["rate-limits at the edge", "terminates TLS"] },
      ],
      snapshot,
      idSource(7),
    );
    const retry = result.write.shapes![0];
    expect(retry.label).toBe("Retry queue");
    expect(retry.type).toBe("rectangle");
    expect(retry.style.backgroundColor).toBe("#ffec99"); // service, from the legend
    expect(retry.frameId).toBe("F");
    // Right of Orders is Postgres, so it goes below Orders — never on top of anything.
    expect(retry.x).toBe(340);
    expect(retry.y).toBe(100 + 80 + 50);
    expect(retry.meaning).toEqual({ intents: ["retries failed charges"], logic: "if charge fails: retry 3x then park" });
    expect(result.ids["$retry"]).toBe(retry.id);
    const edge = result.write.arrows![0];
    expect(edge.from).toBe("orders");
    expect(edge.to).toBe(retry.id);
    expect(edge.frameId).toBe("F");
    expect(edge.endArrowhead).toBe("arrow");
    expect(result.write.patches).toEqual([{ id: "gateway", meaning: { intents: ["rate-limits at the edge", "terminates TLS"] } }]);
    expect(result.touched).toContain("gateway");
  });

  it("adds to an author's intents rather than replacing them, and sits new nodes next to their feeder", () => {
    const result = plan(
      [
        { op: "update", id: "gateway", addIntents: ["terminates TLS"], addTags: ["edge"] },
        { op: "add_node", ref: "$ledger", label: "Ledger", kind: "datastore", frame: "F" },
        { op: "add_edge", from: "db", to: "$ledger" },
      ],
      snapshot,
      idSource(5),
    );
    expect(result.write.patches![0].meaning).toEqual({ tags: ["edge"], intents: ["rate-limits at the edge", "terminates TLS"] });
    // Postgres feeds the ledger, so the ledger goes below Postgres (right of it is outside the frame's row).
    const ledger = result.write.shapes![0];
    expect(ledger.x).toBe(640);
    expect(ledger.y).toBe(100 + 90 + 50);
  });

  it("refuses a bad batch whole, naming every problem", () => {
    expect(() =>
      plan(
        [
          { op: "add_node", label: "Orders", frame: "F" },
          { op: "add_edge", from: "orders", to: "$nope" },
          { op: "remove", id: "db" },
          { op: "update", id: "F", label: "x" },
        ],
        snapshot,
      ),
    ).toThrow(PlanError);
    try {
      plan([{ op: "add_node", label: "Orders", frame: "F" }, { op: "add_edge", from: "orders", to: "$nope" }], snapshot);
    } catch (err) {
      const problems = (err as PlanError).problems;
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/already exists/);
      expect(problems[1]).toMatch(/unknown ref/);
    }
  });

  it("grows a frame to hold what it gains, and defines kinds into the legend", () => {
    const result = plan(
      [
        { op: "define_kind", kind: "queue", shape: "diamond" },
        { op: "add_node", label: "A very long component label indeed", kind: "queue", frame: "F" },
        { op: "add_node", label: "Second", kind: "queue", frame: "F" },
        { op: "add_node", label: "Third", kind: "queue", frame: "F" },
      ],
      snapshot,
      idSource(1),
    );
    expect(result.write.legend!.some((r) => r.key === "kind" && r.meaning === "queue" && r.also?.[0].value === "diamond")).toBe(true);
    expect(result.write.shapes!.every((s) => s.type === "diamond")).toBe(true);
    const fill = result.write.legend!.find((r) => r.meaning === "queue")!.value;
    expect(result.write.shapes![0].style.backgroundColor).toBe(fill);
    // Three more boxes did not fit the first row: the frame grew.
    const grown = result.write.patches!.find((p) => p.id === "F");
    expect(grown).toBeDefined();
    expect(grown!.height!).toBeGreaterThan(400);
  });

  it("removes with its edges and labels; a detail layer needs cascade", () => {
    const withDetail = snapshotFromRawElements([
      ...raw,
      { ...base, id: "D", type: "frame", name: "Orders — detail", x: 0, y: 21000, width: 700, height: 300 },
      ...box("inner", 40, 21100, "State machine").map((el) => ({ ...el, frameId: "D" })),
    ].map((el) => (el.id === "orders" ? { ...el, customData: { docent: { note: "owns order state", detail: { frameId: "D" } } } } : el)) as never);
    expect(() => plan([{ op: "remove", id: "orders" }], withDetail)).toThrow(/cascade/);
    const result = plan([{ op: "remove", id: "orders", cascade: true }], withDetail);
    expect(new Set(result.write.remove)).toEqual(new Set(["orders", "e1", "e2", "D", "inner", "inner_t"]));
  });
});

describe("no crossings (D66)", () => {
  it("lays out an agent-built frame by flow so arrows do not cross, and wraps long labels", () => {
    // Five components named in an order that would tangle a sequential placer.
    const result = plan(
      [
        { op: "add_frame", ref: "$f", name: "Ritual" },
        { op: "add_node", ref: "$sheet", label: "22:30 · THE EVENING RITUAL — one sitting, both markets", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$us", label: "US funnel runs", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$asx", label: "ASX funnel runs", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$open", label: "10:00 ASX open", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$morning", label: "Morning check", frame: "$f", intents: ["x"] },
        { op: "add_edge", from: "$us", to: "$sheet", label: "US sheet drafted" },
        { op: "add_edge", from: "$asx", to: "$sheet", label: "ASX sheet drafted" },
        { op: "add_edge", from: "$sheet", to: "$open", label: "orders placed" },
        { op: "add_edge", from: "$sheet", to: "$morning", label: "overnight fills" },
        { op: "add_edge", from: "$open", to: "$morning" },
      ],
      snapshot,
      idSource(11),
    );
    const shapes = result.write.shapes!;
    const x = (label: string) => shapes.find((s) => s.label?.startsWith(label))!.x;
    // Feeders left of what they feed, column by column.
    expect(x("US funnel")).toBeLessThan(x("22:30"));
    expect(x("ASX funnel")).toBeLessThan(x("22:30"));
    expect(x("22:30")).toBeLessThan(x("10:00"));
    expect(x("10:00")).toBeLessThan(x("Morning"));
    // The long label wrapped: the shape is not a 900-unit ellipse.
    const sheet = shapes.find((s) => s.label?.startsWith("22:30"))!;
    expect(sheet.width).toBeLessThan(450);
    expect(sheet.height).toBeGreaterThan(70);
    // And the plan says so.
    expect(result.notes.some((n) => n.includes("laid out by flow") && n.includes("no crossings"))).toBe(true);
    // The frame holds them all.
    const frame = result.write.frames![0];
    for (const sh of shapes) {
      expect(sh.x).toBeGreaterThanOrEqual(frame.x);
      expect(sh.x + sh.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(sh.y + sh.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });

  it("counts crossings in the lint", () => {
    // Two edges that cross: gateway→db and orders→a node left of gateway.
    const tangled = snapshotFromRawElements([
      ...raw,
      ...box("left", 40, 300, "Left"),
      arrow("e3", "orders", "left"),
      arrow("e4", "gateway", "db"),
    ] as never);
    const { findings } = lint(tangled);
    expect(findings.some((f) => f.message.includes("arrow crossing"))).toBe(true);
    expect(lint(snapshot).findings.some((f) => f.message.includes("crossing"))).toBe(false);
  });
});

describe("an edge is as long as its words (D70)", () => {
  it("keeps the gap after a feeder at least as wide as the edge label", () => {
    const label = "hygiene survivors of the weekly pass";
    const room = edgeLabelSize(label, 16).width;
    expect(room).toBeGreaterThan(100);
    const frame = { x: 0, y: 0, width: 1200, height: 400 };
    const anchor = { x: 40, y: 100, width: 160, height: 80 };
    const placed = placeInFrame(frame, [anchor], { width: 160, height: 80 }, anchor, null, room);
    expect(placed.x - (anchor.x + anchor.width)).toBeGreaterThanOrEqual(room);
    // Through the planner: the new node lands after its feeder by the label's width.
    const sparse = snapshotFromRawElements(raw.filter((el) => !["orders", "orders_t", "db", "db_t", "e1", "e2"].includes(el.id as string)) as never);
    const result = plan(
      [
        { op: "add_node", ref: "$n", label: "Tradeable", kind: "service", frame: "F", intents: ["x"] },
        { op: "add_edge", from: "gateway", to: "$n", label },
      ],
      sparse,
      idSource(3),
    );
    const node = result.write.shapes![0];
    const gateway = sparse.elements.find((el) => el.id === "gateway")!;
    expect(node.y).toBe(gateway.y);
    expect(node.x - (gateway.x + gateway.width)).toBeGreaterThanOrEqual(room);
  });

  it("widens the column gap of a laid-out frame to its widest label", () => {
    const sizes = new Map(graph.nodes.map((n) => [n.id, { width: 160, height: 80 }]));
    const wide = layeredLayout(graph.nodes, graph.edges, sizes, { x: 0, y: 0 }, {
      labelSize: (e) => (e.id === graph.edges[0].id ? { width: 300, height: 20 } : { width: 0, height: 0 }),
    });
    const ordered = [...wide.values()].sort((a, b) => a.x - b.x);
    expect(ordered[1].x - (ordered[0].x + ordered[0].width)).toBeGreaterThanOrEqual(300);
    expect(ordered[2].x - (ordered[1].x + ordered[1].width)).toBe(60);
  });
});

describe("long flows turn (D71)", () => {
  it("folds a long chain into balanced bands that alternate direction", () => {
    expect(columnsPerBand(4)).toBe(4);
    expect(columnsPerBand(5)).toBe(5);
    expect(columnsPerBand(8)).toBe(4);
    expect(columnsPerBand(10)).toBe(5);
    const n = 8;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, bounds: { x: i * 10, y: 0, width: 160, height: 80 } })) as never[];
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, from: `s${i}`, to: `s${i + 1}`, label: null })) as never[];
    const sizes = new Map(Array.from({ length: n }, (_, i) => [`s${i}`, { width: 160, height: 80 }]));
    const boxes = layeredLayout(nodes, edges, sizes, { x: 0, y: 0 });
    const at = (i: number) => boxes.get(`s${i}`)!;
    // First band left to right, on one row.
    for (let i = 0; i < 3; i++) expect(at(i).x).toBeLessThan(at(i + 1).x);
    for (let i = 0; i < 4; i++) expect(at(i).y).toBe(0);
    // Second band below, right to left, starting under the turn.
    expect(at(4).y).toBeGreaterThan(at(3).y + 80);
    expect(at(4).x + at(4).width).toBe(at(3).x + at(3).width);
    for (let i = 4; i < 7; i++) expect(at(i).x).toBeGreaterThan(at(i + 1).x);
    // Compact: about half the width of one long row.
    const width = Math.max(...[...boxes.values()].map((b) => b.x + b.width));
    expect(width).toBeLessThan(n * 220 * 0.6);
  });

  it("keeps a short flow on one row", () => {
    const sizes = new Map(graph.nodes.map((n) => [n.id, { width: 160, height: 80 }]));
    const boxes = layeredLayout(graph.nodes, graph.edges, sizes, { x: 0, y: 0 });
    expect(new Set([...boxes.values()].map((b) => b.y)).size).toBe(1);
  });
});

describe("an edge never cuts through a component (D72)", () => {
  const from = { x: 0, y: 0, width: 160, height: 80 };
  const to = { x: 600, y: 0, width: 160, height: 80 };
  const between = { x: 300, y: -20, width: 160, height: 120 };

  it("keeps a clear straight line, and routes around what is in the way", () => {
    expect(routeEdge(from, to, [{ x: 300, y: 300, width: 160, height: 80 }])).toBeNull();
    const via = routeEdge(from, to, [between])!;
    expect(via).not.toBeNull();
    expect(via.length).toBeGreaterThanOrEqual(2);
    // Orthogonal: each leg is horizontal or vertical.
    for (let i = 0; i + 1 < via.length; i++) expect(via[i][0] === via[i + 1][0] || via[i][1] === via[i + 1][1]).toBe(true);
    // Outside every box, and through none of them.
    const line = [[80, 40] as [number, number], ...via, [680, 40] as [number, number]];
    expect(polylineThroughBox(line, between)).toBe(false);
    for (const pt of via) {
      expect(pt[0] < from.x || pt[0] > from.x + from.width || pt[1] < from.y || pt[1] > from.y + from.height).toBe(true);
    }
    // Deterministic.
    expect(routeEdge(from, to, [between])).toEqual(via);
  });

  it("gives a planned edge its turning points, and the simulated scene is clean", () => {
    // `gateway` and `db` have `orders` between them in the fixture.
    const result = plan([{ op: "add_edge", from: "gateway", to: "db", label: "direct" }], snapshot, idSource(5));
    const edge = result.write.arrows![0];
    expect(edge.via).toBeDefined();
    expect(edge.via!.length).toBeGreaterThanOrEqual(2);
    expect(result.notes).toContain("1 edge routed around components");
    const after = simulate(snapshot, result.write);
    expect(lint(after).findings.some((f) => f.message.includes("passes through"))).toBe(false);
    const el = after.elements.find((e) => e.id === edge.id)!;
    const orders = snapshot.elements.find((e) => e.id === "orders")!;
    expect(polylineThroughBox(absolutePoints(el.x, el.y, el.points!), orders, 2)).toBe(false);
  });

  it("re-routes the edges of a frame it lays out, and the lint names a pass-through", () => {
    // A straight hand-drawn arrow from the gateway through Orders to Postgres.
    const through = snapshotFromRawElements([
      ...raw,
      { ...arrow("e3", "gateway", "db"), x: 200, y: 140, width: 440, height: 0, points: [[0, 0], [440, 0]] },
    ] as never);
    const { findings } = lint(through);
    expect(findings.some((f) => f.message.includes("API Gateway → Postgres passes through Orders"))).toBe(true);
    // Laying the frame out moves its components and re-routes that edge.
    const result = plan([{ op: "layout", frame: "F" }], through, idSource(7));
    const viaPatch = result.write.patches!.find((p) => p.id === "e3");
    expect(viaPatch?.via).toBeDefined();
    const after = simulate(through, result.write);
    expect(lint(after).findings.some((f) => f.message.includes("passes through"))).toBe(false);
  });
});

describe("the drawn legend (D69)", () => {
  const legendParts = [
    { ...base, id: "lg_t", type: "text", x: 0, y: -200, width: 80, height: 24, text: "Legend", locked: true, customData: { docent: { legend } } },
    { ...base, id: "lg_s1", type: "ellipse", x: 0, y: -160, width: 72, height: 30, backgroundColor: "#a5d8ff", locked: true, customData: { docent: { legendSample: true } } },
    { ...base, id: "lg_l1", type: "text", x: 92, y: -155, width: 120, height: 20, text: "kind: datastore", locked: true, customData: { docent: { legendSample: true } } },
    { ...base, id: "lg_s2", type: "arrow", x: 0, y: -110, width: 64, height: 0, points: [[0, 0], [64, 0]], strokeStyle: "dashed", locked: true, customData: { docent: { legendSample: true } } },
  ];
  const withLegend = snapshotFromRawElements([...raw.filter((el) => el.id !== "legend"), ...legendParts] as never);

  it("is never a component, an edge, or a vote for the house style", () => {
    const g = buildSceneGraph(withLegend);
    expect(g.nodes.map((n) => n.sourceId)).not.toContain("lg_s1");
    expect(g.nodes.map((n) => n.sourceId)).not.toContain("lg_l1");
    expect(g.edges.map((e) => e.sourceId)).not.toContain("lg_s2");
    expect(g.legend).toEqual(legend);
    // Two blue legend ellipses do not make the house shape an ellipse.
    const house = houseStyle(withLegend, g);
    expect(house.defaultShape).toBe("rectangle");
    expect(lint(withLegend).findings.every((f) => !["lg_s1", "lg_l1"].includes(f.about ?? ""))).toBe(true);
  });

  it("is never drawn over: loose components and new frames keep clear of it", () => {
    const result = plan(
      [
        { op: "add_node", ref: "$loose", label: "Loose", kind: "service" },
        { op: "add_frame", ref: "$f", name: "09 New" },
      ],
      withLegend,
      idSource(2),
    );
    const loose = result.write.shapes![0];
    const legendBottom = -110 + 30;
    expect(loose.y).toBeGreaterThanOrEqual(legendBottom);
    const frame = result.write.frames![0];
    expect(frame.y).toBeGreaterThan(legendBottom);
    expect(frame.y).toBeGreaterThan(400); // below the existing frame too
  });
});

describe("simulate + diff (D46, D62)", () => {
  it("predicts the changelog of a batch without touching anything", () => {
    const result = plan(
      [
        { op: "add_node", ref: "$retry", label: "Retry queue", kind: "service", frame: "F" },
        { op: "add_edge", from: "orders", to: "$retry" },
        { op: "remove", id: "db" },
      ],
      snapshot,
      idSource(3),
    );
    const after = simulate(snapshot, result.write);
    const { changelog } = describeChange(snapshot, after);
    expect(changelog).toContain("+Retry queue");
    expect(changelog).toContain("−Postgres");
    expect(changelog).toContain("+edge Orders → Retry queue");
    expect(changelog).toContain("−edge Orders → Postgres");
    // The new node is a real graph node with its kind and frame.
    const g = buildSceneGraph(after);
    const retry = g.nodes.find((n) => n.label === "Retry queue")!;
    expect(retry.frameId).toBe(g.frames[0].id);
  });
});

describe("lint (D62, D63)", () => {
  it("says what a reviewer would", () => {
    const { findings, summary } = lint(snapshot);
    const messages = findings.map((f) => f.message);
    expect(messages).toContain("Postgres has no intent");
    expect(messages.some((m) => m.includes("has no label or intent"))).toBe(true);
    expect(messages.every((m) => !m.includes("no narrative"))).toBe(true);
    expect(summary).toMatch(/warning/);
  });
});
