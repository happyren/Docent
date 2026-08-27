/**
 * Agent authoring (S19): meaning in, one write out — in the diagram's own
 * style, placed politely, validated whole, simulated for the diff, linted.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { describeChange } from "../src/scene/diff";
import { houseStyle, resolveLook } from "../src/authoring/style";
import { backEdges, columnsPerBand, countCrossings, crossingsBetweenLayers, edgeLabelSize, GAP_X, GAP_Y, GRID, layeredLayout, placeInFrame, sizeAtWidth, sizeForLabel, snapUp } from "../src/authoring/layout";
import { absolutePoints, CORNER_RADIUS, NUDGE, polylineThroughBox, routeEdge, type Point } from "../src/authoring/route";
import { idSource, lint, plan, PlanError, simulate } from "../src/authoring/ops";
import { tidyOps } from "../src/authoring/tidy";

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
    // After the anchor by the house gap, both on the grid (D99).
    expect(placed.x).toBe(40 + 160 + GAP_X);
    expect(placed.y).toBe(snapUp(100));
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
    // Right of Orders is Postgres, so it goes below Orders — never on top of
    // anything — and on the grid (D99).
    expect(retry.x).toBe(snapUp(340));
    expect(retry.y).toBe(snapUp(100 + 80 + GAP_Y));
    expect(retry.meaning).toEqual({ intents: ["retries failed charges"], logic: "if charge fails: retry 3x then park" });
    expect(result.ids["$retry"]).toBe(retry.id);
    const edge = result.write.arrows![0];
    expect(edge.from).toBe("orders");
    expect(edge.to).toBe(retry.id);
    expect(edge.frameId).toBe("F");
    expect(edge.endArrowhead).toBe("arrow");
    expect(result.write.patches).toEqual([
      { id: "gateway", meaning: { intents: ["rate-limits at the edge", "terminates TLS"] } },
      // The frame was drawn 900 wide, which is not a grid multiple: the
      // write that puts a component in it leaves it grid-true (D99).
      { id: "F", x: 0, y: 0, width: 904, height: 400 },
    ]);
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
    expect(ledger.y).toBe(snapUp(100 + 90 + GAP_Y));
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
    // The gateway's own row, on the grid: the fixture drew it at 100, which
    // is not a grid line, and a box Docent places always is (D99).
    expect(node.y).toBe(snapUp(gateway.y));
    expect(node.x - (gateway.x + gateway.width)).toBeGreaterThanOrEqual(room);
  });

  it("widens the column gap of a laid-out frame to its widest label", () => {
    const sizes = new Map(graph.nodes.map((n) => [n.id, { width: 160, height: 80 }]));
    const wide = layeredLayout(graph.nodes, graph.edges, sizes, { x: 0, y: 0 }, {
      labelSize: (e) => (e.id === graph.edges[0].id ? { width: 300, height: 20 } : { width: 0, height: 0 }),
    });
    const ordered = [...wide.values()].sort((a, b) => a.x - b.x);
    expect(ordered[1].x - (ordered[0].x + ordered[0].width)).toBeGreaterThanOrEqual(300);
    expect(ordered[2].x - (ordered[1].x + ordered[1].width)).toBe(GAP_X);
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

describe("the layered pipeline, whole (D74)", () => {
  const SIZE = { width: 160, height: 80 };
  const nodesAt = (rows: readonly (readonly [string, number])[]) =>
    rows.map(([id, y]) => ({ id, bounds: { x: 0, y, ...SIZE } })) as never[];
  const link = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, label: null }) as never;
  const sizesFor = (rows: readonly (readonly [string, number])[]) => new Map(rows.map(([id]) => [id, SIZE]));
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;

  it("sweeps down and back up until the crossings are gone", () => {
    // Two feeders share a component and a third feeds the one between
    // them: no order of the second rank saves it, so the crossing only
    // goes when the sweep back up re-orders the sources themselves.
    const rows = [["p", 0], ["m", 50], ["q", 200], ["n", 250], ["r", 400]] as const;
    const nodes = nodesAt(rows);
    const edges = [link("p", "m"), link("q", "n"), link("r", "m")];
    // As they arrive, the two ranks cross once.
    expect(crossingsBetweenLayers(["p", "q", "r"], ["m", "n"], [["p", "m"], ["q", "n"], ["r", "m"]])).toBe(1);
    const boxes = layeredLayout(nodes, edges, sizesFor(rows), { x: 0, y: 0 });
    const placed = [...boxes.entries()].map(([id, bounds]) => ({ id, bounds })) as never[];
    expect(countCrossings(placed, edges)).toBe(0);
    // r came last and now sits above q — what the second sweep found.
    expect(middle(boxes.get("r")!)).toBeLessThan(middle(boxes.get("q")!));
  });

  it("sits a parent on the median of its children, with the children balanced about it", () => {
    const rows = [["parent", 0], ["first", 0], ["middle", 200], ["last", 400]] as const;
    const boxes = layeredLayout(
      nodesAt(rows),
      [link("parent", "first"), link("parent", "middle"), link("parent", "last")],
      sizesFor(rows),
      { x: 0, y: 0 },
    );
    const at = (id: string) => middle(boxes.get(id)!);
    expect(Math.abs(at("parent") - at("middle"))).toBeLessThanOrEqual(1);
    expect(Math.abs(at("parent") - (at("first") + at("last")) / 2)).toBeLessThanOrEqual(1);
  });

  it("draws a chain of neighbouring ranks straight", () => {
    const rows = [["a", 0], ["b", 300], ["c", 100], ["d", 200], ["e", 400]] as const;
    const boxes = layeredLayout(
      nodesAt(rows),
      [link("a", "b"), link("b", "c"), link("c", "d"), link("d", "e")],
      sizesFor(rows),
      { x: 0, y: 0 },
    );
    expect(new Set([...boxes.values()].map(middle)).size).toBe(1);
  });

  it("draws one width for a kind and one height for a rank", () => {
    const rows = [["svcA", 0], ["storeX", 200], ["svcB", 0], ["storeY", 200]] as const;
    const nodes = nodesAt(rows);
    const sizes = new Map([
      ["svcA", { width: 160, height: 80 }],
      ["storeX", { width: 200, height: 70 }],
      ["svcB", { width: 140, height: 100 }],
      ["storeY", { width: 180, height: 60 }],
    ]);
    const boxes = layeredLayout(nodes, [link("svcA", "svcB"), link("storeX", "storeY")], sizes, { x: 0, y: 0 }, {
      kindOf: (id) => (id.startsWith("svc") ? "service" : "datastore"),
    });
    const box = (id: string) => boxes.get(id)!;
    // One kind, one width. With no label to re-wrap, the median can go no
    // narrower than the widest member — nothing else would still fit (D80).
    expect(box("svcA").width).toBe(160);
    expect(box("svcB").width).toBe(160);
    expect(box("storeX").width).toBe(200);
    expect(box("storeY").width).toBe(200);
    // One rank, one height — the tallest of that rank, rounded up to the
    // grid (D99). Height is the rank's business alone now: a long label
    // wraps taller than its kind (D80).
    expect(box("svcA").height).toBe(80);
    expect(box("storeX").height).toBe(80);
    expect(box("svcB").height).toBe(snapUp(100));
    expect(box("storeY").height).toBe(snapUp(100));
  });

  it("gives one picture, whatever order the components arrive in", () => {
    const rows = [["a", 0], ["b", 100], ["c", 200], ["d", 300], ["e", 400]] as const;
    const nodes = nodesAt(rows);
    const edges = [link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d"), link("a", "d"), link("d", "e")];
    const run = (from: readonly never[]) =>
      Object.fromEntries([...layeredLayout(from, edges, sizesFor(rows), { x: 0, y: 0 }).entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
    const once = run(nodes);
    expect(run(nodes)).toEqual(once);
    expect(run([...nodes].reverse())).toEqual(once);
  });
});

describe("cycles and sizes (D79, D80)", () => {
  const SIZE = { width: 160, height: 80 };
  const inARow = (ids: readonly string[]) =>
    ids.map((id, i) => ({ id, bounds: { x: i * 300, y: 0, ...SIZE } })) as never[];
  const link = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, label: null }) as never;
  const sizesFor = (ids: readonly string[]) => new Map(ids.map((id) => [id, SIZE]));
  // a → b → c → d, written in that order, with two returns.
  const chain = ["a", "b", "c", "d"];
  const withReturns = [link("a", "b"), link("b", "c"), link("c", "d"), link("c", "a"), link("d", "b")];

  it("names the edges that close a cycle and ranks the rest by the authored order", () => {
    const nodes = inARow(chain);
    // The walk starts at a and finds both returns on the stack (D79).
    expect([...backEdges(nodes, withReturns)].sort()).toEqual(["c-a", "d-b"]);
    const boxes = layeredLayout(nodes, withReturns, sizesFor(chain), { x: 0, y: 0 });
    const x = (id: string) => boxes.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(x("c")).toBeLessThan(x("d"));
    // Four ranks, four columns — the returns bought nobody a place.
    expect(new Set([...boxes.values()].map((b) => b.x)).size).toBe(4);
    // And the picture is the same however the components arrive.
    const again = layeredLayout([...nodes].reverse(), withReturns, sizesFor(chain), { x: 0, y: 0 });
    expect(Object.fromEntries(again)).toEqual(Object.fromEntries(boxes));
  });

  it("keeps a two-cycle in the order it was written", () => {
    const nodes = inARow(["a", "b"]);
    const boxes = layeredLayout(nodes, [link("a", "b"), link("b", "a")], sizesFor(["a", "b"]), { x: 0, y: 0 });
    expect(backEdges(nodes, [link("a", "b"), link("b", "a")])).toEqual(new Set(["b-a"]));
    expect(boxes.get("a")!.x).toBeLessThan(boxes.get("b")!.x);
  });

  it("ranks a frame the agent built by the order the ops were written", () => {
    const result = plan(
      [
        { op: "add_frame", ref: "$f", name: "Publishing loop" },
        { op: "add_node", ref: "$a", label: "Draft", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$b", label: "Review", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$c", label: "Publish", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$d", label: "Archive", frame: "$f", intents: ["x"] },
        { op: "add_edge", from: "$a", to: "$b" },
        { op: "add_edge", from: "$b", to: "$c" },
        { op: "add_edge", from: "$c", to: "$d" },
        { op: "add_edge", from: "$c", to: "$a", label: "rework" },
        { op: "add_edge", from: "$d", to: "$b", label: "re-review" },
      ],
      snapshot,
      idSource(23),
    );
    const x = (label: string) => result.write.shapes!.find((s) => s.label === label)!.x;
    expect(x("Draft")).toBeLessThan(x("Review"));
    expect(x("Review")).toBeLessThan(x("Publish"));
    expect(x("Publish")).toBeLessThan(x("Archive"));
  });

  it("ranks hand-placed components a `layout` op re-flows by the order they read in", () => {
    const cyclic = snapshotFromRawElements([
      { ...base, id: "F", type: "frame", name: "Publishing loop", x: 0, y: 0, width: 1400, height: 400 },
      ...box("a", 40, 100, "Draft"),
      ...box("b", 340, 100, "Review"),
      ...box("c", 640, 100, "Publish"),
      ...box("d", 940, 100, "Archive"),
      arrow("e1", "a", "b"),
      arrow("e2", "b", "c"),
      arrow("e3", "c", "d"),
      arrow("e4", "c", "a"),
      arrow("e5", "d", "b"),
    ] as never);
    const result = plan([{ op: "layout", frame: "F" }], cyclic, idSource(29));
    const was = new Map([["a", 40], ["b", 340], ["c", 640], ["d", 940]]);
    const x = (id: string) => result.write.patches!.find((p) => p.id === id)?.x ?? was.get(id)!;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(x("c")).toBeLessThan(x("d"));
  });

  it("gives a kind the width of its typical label, and wraps the long one taller", () => {
    const long = "MORNING GLANCE reconcile fills update lifecycle recompute stops";
    const short = ["EVENING SITTING", "US FUNNEL PASS", "ASX FUNNEL PASS", "OPEN THE BOOKS"];
    const labels = [short[0], short[1], long, short[2], short[3]];
    const result = plan(
      [
        { op: "add_frame", ref: "$f", name: "The ritual" },
        ...labels.map((label, i) => ({ op: "add_node" as const, ref: `$r${i}`, label, kind: "ritual", shape: "ellipse" as const, frame: "$f", intents: ["x"] })),
        ...labels.slice(1).map((_, i) => ({ op: "add_edge" as const, from: `$r${i}`, to: `$r${i + 1}` })),
      ],
      snapshot,
      idSource(31),
    );
    const shapes = result.write.shapes!;
    const of = (label: string) => shapes.find((s) => s.label === label)!;
    const font = of(long).style.fontSize;
    // One long label does not widen its siblings: the shared width is the
    // median of what the five labels need, not the widest of them (D80).
    expect(sizeForLabel(long, font, "ellipse").width).toBeGreaterThan(500);
    for (const label of labels) expect(of(label).width).toBeLessThan(500);
    expect(new Set(labels.map((label) => of(label).width)).size).toBe(1);
    // The shared width is that typical label's, rounded up to the grid (D99).
    expect(of(long).width).toBe(snapUp(sizeForLabel(short[0], font, "ellipse").width));
    // It costs its own component lines instead.
    expect(of(long).height).toBeGreaterThan(of(short[0]).height);
    expect(of(long).height).toBe(snapUp(sizeAtWidth(long, font, "ellipse", of(long).width).height));
  });

  it("leaves one of a kind its own size, and still gives a rank one height", () => {
    const ids = ["only", "twinA", "twinB", "tall"];
    const nodes = [
      { id: "only", bounds: { x: 0, y: 0, ...SIZE } },
      { id: "twinA", bounds: { x: 0, y: 200, ...SIZE } },
      { id: "twinB", bounds: { x: 300, y: 0, ...SIZE } },
      { id: "tall", bounds: { x: 300, y: 200, ...SIZE } },
    ] as never[];
    const sizes = new Map([
      ["only", { width: 420, height: 90 }],
      ["twinA", { width: 200, height: 80 }],
      ["twinB", { width: 300, height: 80 }],
      ["tall", { width: 160, height: 130 }],
    ]);
    const boxes = layeredLayout(nodes, [link("only", "twinB"), link("twinA", "tall")], sizes, { x: 0, y: 0 }, {
      kindOf: (id) => (id.startsWith("twin") ? "twin" : id),
    });
    // The only one of its kind keeps the width it came with, on the grid (D99).
    expect(boxes.get("only")!.width).toBe(snapUp(420));
    expect(boxes.get("tall")!.width).toBe(160);
    // The pair share one: unlabelled, that is the widest that still fits.
    expect(boxes.get("twinA")!.width).toBe(snapUp(300));
    expect(boxes.get("twinB")!.width).toBe(snapUp(300));
    // A rank is one height throughout.
    expect(boxes.get("only")!.height).toBe(boxes.get("twinA")!.height);
    expect(boxes.get("twinB")!.height).toBe(boxes.get("tall")!.height);
    expect(boxes.get("twinB")!.height).toBe(snapUp(130));
    expect(ids.every((id) => boxes.has(id))).toBe(true);
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

describe("frames keep their distance (D86)", () => {
  const twoFrames = [
    ...raw,
    { ...base, id: "F2", type: "frame", name: "03 Below", x: 0, y: 430, width: 900, height: 300, frameId: null },
    ...box("solo", 40, 500, "Solo").map((el) => ({ ...el, frameId: "F2" })),
  ];

  it("parts a frame that grew into its neighbour, carrying the members", () => {
    const snap = snapshotFromRawElements(twoFrames as never);
    // Enough new components that frame F must grow past y=430 into F2.
    const ops = Array.from({ length: 6 }, (_, i) => ({
      op: "add_node" as const,
      label: `Extra ${i}`,
      kind: "service",
      frame: "F",
      intents: ["x"],
    }));
    const result = plan(ops, snap, idSource(9));
    const after = simulate(snap, result.write);
    const frames = after.elements.filter((el) => el.type === "frame");
    const gapless = (a: typeof frames[number], b: typeof frames[number]) =>
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        expect(gapless(frames[i], frames[j])).toBe(true);
      }
    }
    // The neighbour's member moved with it.
    const f2 = frames.find((f) => f.id === "F2")!;
    const solo = after.elements.find((el) => el.id === "solo")!;
    expect(solo.y).toBeGreaterThanOrEqual(f2.y);
    expect(solo.y + solo.height).toBeLessThanOrEqual(f2.y + f2.height);
    expect(result.notes.some((n) => n.includes("moved clear"))).toBe(true);
  });

  it("keeps every frame off the legend and reads the same twice", () => {
    const snap = snapshotFromRawElements(twoFrames as never);
    const ops = Array.from({ length: 6 }, (_, i) => ({
      op: "add_node" as const,
      label: `Extra ${i}`,
      kind: "service",
      frame: "F",
      intents: ["x"],
    }));
    const one = plan(ops, snap, idSource(9));
    const two = plan(ops, snap, idSource(9));
    expect(one).toEqual(two);
    const after = simulate(snap, one.write);
    const legendParts = after.elements.filter((el) => el.docent.legend !== null || el.docent.legendSample);
    const frames = after.elements.filter((el) => el.type === "frame");
    for (const f of frames) {
      for (const part of legendParts) {
        const clear = part.x + part.width <= f.x || f.x + f.width <= part.x || part.y + part.height <= f.y || f.y + f.height <= part.y;
        expect(clear).toBe(true);
      }
    }
  });
});

describe("Layer 1 is arranged whole (D100)", () => {
  /** A component, framed or loose — the fixture below needs both. */
  const comp = (id: string, x: number, y: number, label: string, frameId: string | null) => [
    { ...base, id, type: "rectangle", x, y, width: 180, height: 80, frameId, boundElements: [{ id: `${id}_t`, type: "text" }] },
    { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 160, height: 20, text: label, containerId: id, frameId, fontFamily: 5, fontSize: 20 },
  ];
  const wire = (id: string, from: string, to: string) => ({
    ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, frameId: null, roundness: { type: 2 },
    points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow",
  });

  /**
   * The field case, drawn the way the pipeline used to leave it: a frame of
   * four laid out properly, and every component around it stranded in a row
   * in the sky with long diagonals raining down onto the frame.
   */
  const field = snapshotFromRawElements([
    { ...base, id: "FC", type: "frame", name: "Core", x: 0, y: 900, width: 900, height: 460 },
    ...comp("m1", 60, 1000, "Ingest", "FC"),
    ...comp("m2", 300, 1000, "Route", "FC"),
    ...comp("m3", 540, 1000, "Settle", "FC"),
    ...comp("m4", 300, 1160, "Audit", "FC"),
    ...Array.from({ length: 6 }, (_, i) => comp(`x${i}`, i * 240, 0, `External ${i}`, null)).flat(),
    ...Array.from({ length: 2 }, (_, i) => comp(`s${i}`, 1600 + i * 240, 0, `Sink ${i}`, null)).flat(),
    wire("a0", "x0", "m1"), wire("a1", "x1", "m1"), wire("a2", "x2", "m2"),
    wire("a3", "x3", "m2"), wire("a4", "x4", "m3"), wire("a5", "x5", "m4"),
    wire("b0", "m3", "s0"), wire("b1", "m4", "s1"),
    wire("c0", "m1", "m2"), wire("c1", "m2", "m3"), wire("c2", "m2", "m4"),
  ] as never);

  /** Axis-aligned, allowing the short legs an arc at a corner draws (D78, D98). */
  const orthogonal = (pts: readonly Point[]) =>
    pts.slice(0, -1).every((p, i) => {
      const q = pts[i + 1];
      return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6 || Math.hypot(q[0] - p[0], q[1] - p[1]) <= CORNER_RADIUS;
    });

  const composed = (seed = 5) => {
    const ops = tidyOps(field, { all: true });
    const result = plan(ops, field, idSource(seed));
    return { result, after: simulate(field, result.write) };
  };

  it("ranks the externals before the frame and the sinks after it", () => {
    const { result, after } = composed();
    const graph = buildSceneGraph(after);
    const frame = after.elements.find((el) => el.id === "FC")!;
    const at = (label: string) => graph.nodes.find((n) => n.label === label)!.bounds;
    // Sources take the columns before what they feed …
    for (let i = 0; i < 6; i++) {
      const box = at(`External ${i}`);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x);
    }
    // … and sinks the columns after.
    for (let i = 0; i < 2; i++) expect(at(`Sink ${i}`).x).toBeGreaterThanOrEqual(frame.x + frame.width);
    // The members went with their frame, every one of them still inside it.
    for (const label of ["Ingest", "Route", "Settle", "Audit"]) {
      const box = at(label);
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(box.y).toBeGreaterThanOrEqual(frame.y);
      expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    // One line for the tier, not one per frame.
    expect(result.notes.filter((n) => n === "Layer 1: arranged whole — sources lead, sinks follow (D100)")).toHaveLength(1);
  });

  it("draws every edge square, through nothing, and never clean across the frame", () => {
    const { after } = composed();
    const graph = buildSceneGraph(after);
    const els = new Map(after.elements.map((el) => [el.id, el]));
    const frame = els.get("FC")!;
    const boxes = graph.nodes.map((n) => ({ id: n.id, ...n.bounds }));
    let drawn = 0;
    for (const edge of graph.edges) {
      const el = els.get(edge.sourceId)!;
      expect(el.points).not.toBeNull();
      const line = absolutePoints(el.x, el.y, el.points!);
      // The router the meta-pass uses is the one D98 squared away.
      expect(orthogonal(line)).toBe(true);
      // D72's guarantee still stands over the composed picture.
      for (const b of boxes) {
        if (b.id === edge.from || b.id === edge.to) continue;
        expect(polylineThroughBox(line, b, 2)).toBe(false);
      }
      // And no edge crosses the frame's body: what feeds a member stops
      // inside it, what a member feeds starts inside it.
      const inside = (id: string | null) => graph.nodes.find((n) => n.id === id)?.frameId !== null;
      if (!inside(edge.from) && inside(edge.to)) expect(Math.max(...line.map((p) => p[0]))).toBeLessThanOrEqual(frame.x + frame.width);
      if (inside(edge.from) && !inside(edge.to)) expect(Math.min(...line.map((p) => p[0]))).toBeGreaterThanOrEqual(frame.x);
      drawn += 1;
    }
    expect(drawn).toBe(11);
  });

  it("leaves every box grid-true and reads the same twice (D99, I3)", () => {
    const { result, after } = composed();
    const frame = after.elements.find((el) => el.id === "FC")!;
    for (const b of [...buildSceneGraph(after).nodes.map((n) => n.bounds), frame]) {
      for (const v of [b.x, b.y, b.width, b.height]) expect(v % GRID).toBe(0);
    }
    expect(composed().result.write).toEqual(result.write);
  });

  it("composes what a batch built whole, without being asked (D66 one tier up)", () => {
    // Nothing on Layer 1 but this batch's own work: no hand placement in it
    // for D60 to guard, so it is arranged the way a frame the agent built is.
    const built = plan(
      [
        { op: "add_frame", ref: "$f", name: "Core", narrative: "The engine." },
        { op: "add_node", ref: "$in", label: "Ingest", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$out", label: "Settle", frame: "$f", intents: ["x"] },
        { op: "add_node", ref: "$up", label: "Upstream", intents: ["x"] },
        { op: "add_node", ref: "$down", label: "Downstream", intents: ["x"] },
        { op: "add_edge", from: "$in", to: "$out" },
        { op: "add_edge", from: "$up", to: "$in", label: "feeds" },
        { op: "add_edge", from: "$out", to: "$down", label: "reports" },
      ],
      snapshotFromRawElements([] as never),
      idSource(47),
    );
    const frame = built.write.frames![0];
    const shape = (label: string) => built.write.shapes!.find((s) => s.label === label)!;
    expect(shape("Upstream").x + shape("Upstream").width).toBeLessThanOrEqual(frame.x);
    expect(shape("Downstream").x).toBeGreaterThanOrEqual(frame.x + frame.width);
    expect(built.notes.filter((n) => n.includes("arranged whole"))).toHaveLength(1);
  });

  /** Two frames and a loose component: what a batch inside one must not disturb. */
  const neighbours = snapshotFromRawElements([
    { ...base, id: "P1", type: "frame", name: "01 One", x: 0, y: 0, width: 600, height: 300 },
    { ...base, id: "P2", type: "frame", name: "02 Two", x: 0, y: 700, width: 600, height: 300 },
    ...comp("p1a", 40, 100, "Alpha", "P1"),
    ...comp("p1b", 320, 100, "Beta", "P1"),
    ...comp("p2a", 40, 800, "Gamma", "P2"),
    ...comp("far", 1400, 40, "Far away", null),
    wire("w1", "p1a", "p1b"),
    wire("w2", "far", "p2a"),
  ] as never);
  const stayed = (write: ReturnType<typeof plan>["write"], ids: readonly string[]) =>
    ids.every((id) => !(write.patches ?? []).some((p) => p.id === id && (p.x !== undefined || p.y !== undefined)));

  it("arranges nothing outer for a batch that only edited inside one frame (D60)", () => {
    const result = plan(
      [
        { op: "add_node", ref: "$new", label: "Delta", frame: "P1", intents: ["x"] },
        { op: "add_edge", from: "p1b", to: "$new" },
      ],
      neighbours,
      idSource(41),
    );
    expect(stayed(result.write, ["P2", "p2a", "far"])).toBe(true);
    expect(result.notes.some((n) => n.includes("arranged whole"))).toBe(false);
  });

  it("arranges nothing outer for a tidy of one frame either (D60, D73)", () => {
    const result = plan(tidyOps(neighbours, { frame: "P1" }), neighbours, idSource(43));
    expect(stayed(result.write, ["P2", "p2a", "far"])).toBe(true);
    expect(result.notes.some((n) => n.includes("arranged whole"))).toBe(false);
    // Asking for the whole diagram IS the asking, and then it composes.
    const whole = plan(tidyOps(neighbours, { all: true }), neighbours, idSource(43));
    expect(whole.notes.filter((n) => n.includes("arranged whole"))).toHaveLength(1);
    const after = simulate(neighbours, whole.write);
    const graph = buildSceneGraph(after);
    // The loose component feeds a member of P2, so it leads it.
    const far = graph.nodes.find((n) => n.label === "Far away")!.bounds;
    const p2 = after.elements.find((el) => el.id === "P2")!;
    expect(far.x + far.width).toBeLessThanOrEqual(p2.x);
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

describe("twin edges from one shape stay apart (D75)", () => {
  const loose = (id: string, x: number, y: number, label: string) => [
    { ...base, id, type: "rectangle", x, y, width: 160, height: 80, boundElements: [{ id: `${id}_t`, type: "text" }] },
    { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20 },
  ];
  it("two routed edges to stacked targets keep the nudge gap on shared runs", () => {
    const scene = snapshotFromRawElements([
      ...loose("hub", 0, 0, "Hub"),
      ...loose("top", 480, 240, "Top"),
      ...loose("bot", 480, 520, "Bot"),
    ] as never);
    const result = plan(
      [
        { op: "add_edge", ref: "$e1", from: "hub", to: "top", label: "ICOM sync" },
        { op: "add_edge", ref: "$e2", from: "hub", to: "bot", label: "MDT sync" },
      ],
      scene,
      idSource(31),
    );
    const abs = (id: string): [number, number][] => {
      const ar = result.write.arrows!.find((a) => a.id === result.ids[id])! as unknown as {
        ends?: { start: [number, number]; end: [number, number] };
        via?: [number, number][];
      };
      return ar.ends ? [ar.ends.start, ...(ar.via ?? []), ar.ends.end] : [];
    };
    const a = abs("$e1");
    const b = abs("$e2");
    // Both oblique pairs must route (D98) — no bare diagonals.
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(b.length).toBeGreaterThanOrEqual(2);
    // Any pair of colinear runs (one from each edge) sharing more than a
    // corner's worth of length must sit at least the nudge gap apart —
    // twin edges read as two strokes, not one doubled line (D75).
    const segs = (pts: [number, number][]) => {
      const out: { vertical: boolean; at: number; lo: number; hi: number }[] = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i]; const [x2, y2] = pts[i + 1];
        if (Math.abs(x1 - x2) < 1 && Math.abs(y1 - y2) > 24) out.push({ vertical: true, at: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
        if (Math.abs(y1 - y2) < 1 && Math.abs(x1 - x2) > 24) out.push({ vertical: false, at: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
      }
      return out;
    };
    for (const s1 of segs(a)) for (const s2 of segs(b)) {
      if (s1.vertical !== s2.vertical) continue;
      const shared = Math.min(s1.hi, s2.hi) - Math.max(s1.lo, s2.lo);
      if (shared > 24) expect(Math.abs(s1.at - s2.at)).toBeGreaterThanOrEqual(NUDGE - 0.01);
    }
  });
});
