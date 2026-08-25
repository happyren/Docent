/**
 * Layout postures (S22, D90): one deterministic pipeline told how its
 * genre reads — straight for a time axis that must not turn back on
 * itself, lanes for a context per row.
 */
import { describe, expect, it } from "vitest";
import { FRAME_HEAD, FRAME_PAD, GAP_X, GAP_Y, LANE_GAP, laneLayout, layeredLayout } from "../src/authoring/layout";

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
