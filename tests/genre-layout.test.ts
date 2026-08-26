/**
 * Layout postures (S22, D90): one deterministic pipeline told how its
 * genre reads — straight for a time axis that must not turn back on
 * itself, lanes for a context per row. And the rhythm every posture keeps:
 * everything sits on the grid (D99).
 */
import { describe, expect, it } from "vitest";
import {
  FRAME_GAP,
  FRAME_HEAD,
  FRAME_PAD,
  GAP_X,
  GAP_Y,
  GRID,
  LANE_GAP,
  growFrame,
  laneLayout,
  layeredLayout,
  separateFrames,
  snapUp,
  type Box,
} from "../src/authoring/layout";

const W = 160;
const H = 80;

/** A chain of `n` components, each feeding the next — one rank apiece. */
const chain = (n: number) => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, bounds: { x: i * 200, y: 0, width: W, height: H } })) as never[],
  edges: Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, from: `s${i}`, to: `s${i + 1}`, label: null })) as never[],
  sizes: new Map(Array.from({ length: n }, (_, i) => [`s${i}`, { width: W, height: H }])),
});

/** A component and the lane it belongs to, authored left to right. */
const lanesOf = (spec: readonly (readonly [string, string | null])[]) => ({
  nodes: spec.map(([id], i) => ({ id, bounds: { x: i * 200, y: 0, width: W, height: H } })) as never[],
  sizes: new Map(spec.map(([id]) => [id, { width: W, height: H }])),
  laneOf: (id: string) => spec.find(([n]) => n === id)?.[1] ?? null,
});

const flow = (ids: readonly string[]) =>
  ids.slice(1).map((to, i) => ({ id: `e${i}`, from: ids[i], to, label: null })) as never[];

describe("a straight posture never folds (D90)", () => {
  it("keeps a twelve-rank flow on one left-to-right line", () => {
    const { nodes, edges, sizes } = chain(12);
    const boxes = layeredLayout(nodes, edges, sizes, { x: 0, y: 0 }, { posture: "straight" });
    for (let i = 0; i + 1 < 12; i++) {
      expect(boxes.get(`s${i}`)!.x).toBeLessThan(boxes.get(`s${i + 1}`)!.x);
      // One row: time runs one way and never comes back.
      expect(boxes.get(`s${i + 1}`)!.y).toBe(boxes.get("s0")!.y);
    }
  });

  it("leaves the map posture folding as it always did (D71)", () => {
    const { nodes, edges, sizes } = chain(12);
    const folded = layeredLayout(nodes, edges, sizes, { x: 0, y: 0 });
    // More than one band: the chain turned.
    expect(new Set([...folded.values()].map((b) => b.y)).size).toBeGreaterThan(1);
    // And naming the default posture changes nothing about it.
    const named = layeredLayout(nodes, edges, sizes, { x: 0, y: 0 }, { posture: "map" });
    expect([...named]).toEqual([...folded]);
  });
});

describe("lanes are rows, ranks are columns (D90)", () => {
  const spec = [
    ["place-order", "Ordering"],
    ["order-placed", "Ordering"],
    ["open-orders", "Reporting"],
    ["issue-invoice", "Billing"],
    ["invoice-issued", "Billing"],
    ["revenue", "Reporting"],
    ["send-reminder", "Billing"],
  ] as const;
  const lanes = ["Ordering", "Billing", "Reporting"] as const;
  const { nodes, sizes, laneOf } = lanesOf(spec);
  const edges = flow(spec.map(([id]) => id));

  it("keeps every context in its own band, in declared order, time left to right", () => {
    const boxes = laneLayout(nodes, edges, sizes, { x: 0, y: 0 }, { lanes, laneOf });
    // Rank runs left to right along the zigzag: command, event, read model.
    for (let i = 0; i + 1 < spec.length; i++) {
      expect(boxes.get(spec[i][0])!.x).toBeLessThan(boxes.get(spec[i + 1][0])!.x);
    }
    // The band a lane occupies, from what landed in it.
    const bands = lanes.map((lane) => {
      const own = spec.filter(([, l]) => l === lane).map(([id]) => boxes.get(id)!);
      return { top: Math.min(...own.map((b) => b.y)), bottom: Math.max(...own.map((b) => b.y + b.height)) };
    });
    // Declared order, top to bottom, with room between for a frame each.
    for (let i = 0; i + 1 < bands.length; i++) {
      expect(bands[i + 1].top - bands[i].bottom).toBeGreaterThanOrEqual(LANE_GAP);
    }
    // Every component sits inside its own band and inside no other.
    for (const [id, lane] of spec) {
      const box = boxes.get(id)!;
      const mine = bands[lanes.indexOf(lane)];
      expect(box.y).toBeGreaterThanOrEqual(mine.top);
      expect(box.y + box.height).toBeLessThanOrEqual(mine.bottom);
      for (const other of bands.filter((b) => b !== mine)) {
        expect(box.y >= other.bottom || box.y + box.height <= other.top).toBe(true);
      }
    }
  });

  it("gives one graph one picture (I3)", () => {
    const once = laneLayout(nodes, edges, sizes, { x: 0, y: 0 }, { lanes, laneOf });
    const twice = laneLayout(nodes, edges, sizes, { x: 0, y: 0 }, { lanes, laneOf });
    expect([...twice]).toEqual([...once]);
  });

  it("stacks what shares a lane and a rank, and never overlaps it", () => {
    const stacked = [
      ["place-order", "Ordering"],
      ["cancel-order", "Ordering"],
      ["order-placed", "Ordering"],
    ] as const;
    const fixture = lanesOf(stacked);
    const boxes = laneLayout(
      fixture.nodes,
      [{ id: "e0", from: "place-order", to: "order-placed", label: null }] as never[],
      fixture.sizes,
      { x: 0, y: 0 },
      { lanes, laneOf: fixture.laneOf },
    );
    // Both commands are sources, so both sit in rank 0 of one lane.
    const first = boxes.get("place-order")!;
    const second = boxes.get("cancel-order")!;
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y + first.height + GAP_Y);
    // The event is one rank on, not on top of either.
    expect(boxes.get("order-placed")!.x).toBeGreaterThan(first.x + first.width);
  });

  it("puts a component of no declared lane in a row of its own, below them all", () => {
    const strays = [["place-order", "Ordering"], ["outbox", null], ["dead-letters", "Nowhere"]] as const;
    const fixture = lanesOf(strays);
    const boxes = laneLayout(fixture.nodes, [] as never[], fixture.sizes, { x: 0, y: 0 }, { lanes, laneOf: fixture.laneOf });
    const declared = boxes.get("place-order")!;
    for (const id of ["outbox", "dead-letters"]) {
      expect(boxes.get(id)!.y).toBeGreaterThanOrEqual(declared.y + declared.height + LANE_GAP);
    }
    // Both strays share that one trailing row, stacked.
    expect(boxes.get("dead-letters")!.y).toBe(boxes.get("outbox")!.y + H + GAP_Y);
  });

  it("widens a column gap to the edge label that sits in it (D70)", () => {
    const boxes = laneLayout(nodes, edges, sizes, { x: 0, y: 0 }, {
      lanes,
      laneOf,
      labelSize: (e) => (e.id === "e0" ? { width: 300, height: 20 } : { width: 0, height: 0 }),
    });
    const first = boxes.get("place-order")!;
    const second = boxes.get("order-placed")!;
    expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(300);
    // Every other gap keeps the house minimum.
    expect(boxes.get("open-orders")!.x - (second.x + second.width)).toBe(GAP_X);
  });

  it("leaves a lane room enough to be framed (D86)", () => {
    expect(LANE_GAP).toBeGreaterThanOrEqual(FRAME_HEAD + 2 * FRAME_PAD + 24);
  });
});

describe("everything sits on the grid (D99)", () => {
  const onGrid = (value: number) => value % GRID === 0;
  const gridTrue = (box: Box) => onGrid(box.x) && onGrid(box.y) && onGrid(box.width) && onGrid(box.height);
  const apart = (a: Box, b: Box) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

  /** Odd sizes, an odd origin, and a flow long enough to fold (D71). */
  const awkward = (n: number) => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, bounds: { x: i * 37, y: i * 13, width: 151, height: 73 } })) as never[],
    edges: Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, from: `s${i}`, to: `s${i + 1}`, label: null })) as never[],
    sizes: new Map(Array.from({ length: n }, (_, i) => [`s${i}`, { width: 151 + i, height: 73 + i }])),
  });

  it("answers every box of a layered layout on the grid, whatever it was handed", () => {
    const { nodes, edges, sizes } = awkward(9);
    const boxes = layeredLayout(nodes, edges, sizes, { x: -13, y: 7 }, {
      labelSize: (e) => (e.id === "e2" ? { width: 181, height: 23 } : { width: 0, height: 0 }),
    });
    const placed = [...boxes.values()];
    expect(placed).toHaveLength(9);
    for (const box of placed) expect(gridTrue(box)).toBe(true);
    // A box never lost room to the rounding, and none of it made an overlap.
    for (const [id, box] of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(sizes.get(id)!.width);
      expect(box.height).toBeGreaterThanOrEqual(sizes.get(id)!.height);
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(apart(placed[i], placed[j])).toBe(true);
    }
  });

  it("answers every box of a lane layout on the grid", () => {
    const spec = [["place-order", "Ordering"], ["order-placed", "Ordering"], ["open-orders", "Reporting"], ["stray", null]] as const;
    const fixture = lanesOf(spec);
    const sizes = new Map(spec.map(([id], i) => [id, { width: 153 + i, height: 71 + i * 3 }]));
    const boxes = laneLayout(fixture.nodes, flow(spec.map(([id]) => id)), sizes, { x: 5, y: -9 }, {
      lanes: ["Ordering", "Billing", "Reporting"],
      laneOf: fixture.laneOf,
      labelSize: () => ({ width: 111, height: 19 }),
    });
    for (const box of boxes.values()) expect(gridTrue(box)).toBe(true);
  });

  it("rounds a kind's shared size UP to the grid, never under its widest member (D80)", () => {
    const nodes = [
      { id: "a", bounds: { x: 0, y: 0, width: 150, height: 70 } },
      { id: "b", bounds: { x: 300, y: 0, width: 202, height: 70 } },
    ] as never[];
    const sizes = new Map([
      ["a", { width: 150, height: 70 }],
      ["b", { width: 202, height: 70 }],
    ]);
    const boxes = layeredLayout(nodes, [{ id: "e", from: "a", to: "b", label: null }] as never[], sizes, { x: 0, y: 0 }, {
      kindOf: () => "service",
    });
    // 202 is the floor a shared width may not go under; the grid takes it up.
    expect(boxes.get("a")!.width).toBe(snapUp(202));
    expect(boxes.get("b")!.width).toBe(snapUp(202));
    expect(boxes.get("a")!.width).toBeGreaterThanOrEqual(202);
    expect(boxes.get("a")!.height).toBe(snapUp(70));
  });

  it("rounds a label's column gap UP, so the label still fits (D70)", () => {
    const { nodes, edges, sizes } = chain(3);
    // 300 is not a grid multiple: rounding down would take the label's room.
    const boxes = layeredLayout(nodes, edges, sizes, { x: 0, y: 0 }, {
      labelSize: (e) => (e.id === "e0" ? { width: 300, height: 20 } : { width: 0, height: 0 }),
    });
    const gap = boxes.get("s1")!.x - (boxes.get("s0")!.x + boxes.get("s0")!.width);
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(gap).toBe(snapUp(300));
    // Every other gap is the house minimum, itself a grid multiple.
    expect(boxes.get("s2")!.x - (boxes.get("s1")!.x + boxes.get("s1")!.width)).toBe(GAP_X);
    expect(onGrid(GAP_X) && onGrid(GAP_Y) && onGrid(LANE_GAP) && onGrid(FRAME_GAP)).toBe(true);
  });

  it("grows a frame outward to the grid, never in on its members", () => {
    const frame = { x: 5, y: 5, width: 100, height: 100 };
    const member = { x: 37, y: 41, width: 151, height: 73 };
    const grown = growFrame(frame, [member]);
    expect(gridTrue(grown)).toBe(true);
    // Outward on every side: the frame it was given is still inside it, and
    // so is the room its member asks for.
    expect(grown.x).toBeLessThanOrEqual(frame.x);
    expect(grown.y).toBeLessThanOrEqual(frame.y);
    expect(grown.x + grown.width).toBeGreaterThanOrEqual(frame.x + frame.width);
    expect(grown.y + grown.height).toBeGreaterThanOrEqual(frame.y + frame.height);
    expect(grown.x).toBeLessThanOrEqual(member.x - FRAME_PAD);
    expect(grown.y).toBeLessThanOrEqual(member.y - FRAME_HEAD - FRAME_PAD);
    expect(grown.x + grown.width).toBeGreaterThanOrEqual(member.x + member.width + FRAME_PAD);
    expect(grown.y + grown.height).toBeGreaterThanOrEqual(member.y + member.height + FRAME_PAD);
  });

  it("parts two frames by a grid multiple, and leaves them grid-true (D86)", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 400, height: 200 },
      { x: 240, y: 40, width: 400, height: 200 },
    ];
    const moved = separateFrames([
      { id: "A", box: boxes[0], tier: 1, order: 0 },
      { id: "B", box: boxes[1], tier: 1, order: 1 },
    ]);
    const push = moved.get("B")!;
    expect(moved.has("A")).toBe(false);
    expect(onGrid(push.dx) && onGrid(push.dy)).toBe(true);
    const parted = { ...boxes[1], x: boxes[1].x + push.dx, y: boxes[1].y + push.dy };
    expect(gridTrue(parted)).toBe(true);
    // The clearing rounded up, so the gap D86 asks for is still there.
    expect(parted.x - (boxes[0].x + boxes[0].width)).toBeGreaterThanOrEqual(FRAME_GAP);
    expect(apart(boxes[0], parted)).toBe(true);
  });
});
