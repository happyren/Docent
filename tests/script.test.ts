/**
 * Derived walkthroughs (D58): stops from structure, words from declared
 * meaning, inferred lines marked, deterministic.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { flowOrder, scriptTour } from "../src/agent/script";

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, opacity: 100, groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const box = (id: string, x: number, y: number, label: string, extra: Record<string, unknown> = {}) => [
  { ...base, id, type: "rectangle", x, y, width: 160, height: 80, frameId: "F", boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, frameId: "F" },
];
const arrow = (id: string, from: string, to: string) => ({
  ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, frameId: "F",
  points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to },
});
const frame = {
  ...base, id: "F", type: "frame", name: "02 Core Services", x: 0, y: 0, width: 900, height: 400,
  customData: { docent: { narrative: "Every order passes through here before money moves." } },
};
const raw = [
  frame,
  // Drawn left-to-right as payments, orders, gateway — the edges say otherwise.
  ...box("payments", 40, 100, "Payments"),
  ...box("orders", 340, 100, "Orders", { customData: { docent: { intents: ["retries failed charges", "owns the order state"], logic: "if charge fails: retry 3x then park" } } }),
  ...box("gateway", 640, 100, "API Gateway"),
  arrow("e1", "gateway", "orders"),
  arrow("e2", "orders", "payments"),
];
const snapshot = snapshotFromRawElements(raw as never);
const graph = buildSceneGraph(snapshot);

describe("flowOrder", () => {
  it("puts what feeds before what is fed, position breaking ties and cycles", () => {
    const order = flowOrder(graph.nodes, graph.edges).map((n) => n.label);
    expect(order).toEqual(["API Gateway", "Orders", "Payments"]);
    // A cycle: the topmost goes first, the rest follows the edges.
    const cyc = buildSceneGraph(snapshotFromRawElements([frame, ...box("a", 0, 200, "A"), ...box("b", 300, 0, "B"), arrow("x", "a", "b"), arrow("y", "b", "a")] as never));
    expect(flowOrder(cyc.nodes, cyc.edges).map((n) => n.label)).toEqual(["B", "A"]);
  });
});

describe("scriptTour", () => {
  it("derives the stops and the author's words, marking what it inferred", () => {
    const script = scriptTour(graph, snapshot);
    expect(script.frame).toBeNull();
    expect(script.steps.map((s) => s.focus)).toEqual([
      graph.frames[0].id,
      ...["API Gateway", "Orders", "Payments"].map((l) => graph.nodes.find((n) => n.label === l)!.id),
    ]);
    const [f, gw, orders, pay] = script.steps;
    expect(f.narrate).toBe("Every order passes through here before money moves.");
    expect(f.provenance).toBe("declared");
    expect(orders.narrate).toBe("Orders: retries failed charges. owns the order state. Its logic: if charge fails: retry 3x then park.");
    expect(orders.provenance).toBe("declared");
    expect(orders.highlight).toEqual([orders.focus]);
    expect(gw.provenance).toBe("inferred");
    expect(gw.narrate).toBe("API Gateway sends to Orders.");
    expect(pay.narrate).toBe("Payments receives from Orders.");
    expect(script.declared).toBe(2);
  });

  it("scopes to a frame, names the tier, and refuses unknown frames", () => {
    const one = scriptTour(graph, snapshot, { frame: "F" });
    expect(one.frame).toEqual({ id: graph.frames[0].id, name: "02 Core Services" });
    expect(one.tier).toBe(1);
    expect(one.steps).toHaveLength(4);
    expect(() => scriptTour(graph, snapshot, { frame: "nope" })).toThrow(/Unknown frame/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(scriptTour(graph, snapshot))).toBe(JSON.stringify(scriptTour(graph, snapshot)));
  });
});

// ---------------------------------------------------------------------------
// scenarios (D89): the same derivation, along the path the author named
// ---------------------------------------------------------------------------

const labelled = (id: string, from: string, to: string, text: string, extra: Record<string, unknown> = {}) => [
  { ...arrow(id, from, to), boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: 0, y: 0, width: 80, height: 20, text, containerId: id, frameId: "F" },
];
const storyRaw = [
  frame,
  ...box("gateway", 40, 100, "API Gateway"),
  ...box("orders", 340, 100, "Orders"),
  ...box("payments", 640, 100, "Payments"),
  ...labelled("e1", "gateway", "orders", "hand off", {
    customData: { docent: { note: "only signed requests" } },
  }),
  arrow("e2", "orders", "payments"),
];
const storySnapshot = snapshotFromRawElements(storyRaw as never);
const storyGraph = buildSceneGraph(storySnapshot);
const checkout = {
  name: "Checkout",
  description: "A customer places an order.",
  path: ["e1", "e2"],
};

describe("scriptTour({scenario})", () => {
  it("opens with the author's words, then walks a stop per step", () => {
    const script = scriptTour(storyGraph, storySnapshot, { scenario: checkout });
    expect(script.frame).toBeNull();
    expect(script.scenario).toEqual({ name: "Checkout", description: "A customer places an order." });
    const [intro, first, second] = script.steps;
    expect(script.steps).toHaveLength(3);
    // The introduction is declared: the name and the description are the
    // author's, and the whole path is lit behind them.
    expect(intro.narrate).toBe("Checkout. A customer places an order.");
    expect(intro.provenance).toBe("declared");
    expect(intro.highlight).toEqual(["e1", "e2"]);
    expect(intro.focus).toBeUndefined();
    // Each step focuses its edge and pulses it, said in the edge's own words.
    expect(first).toMatchObject({ focus: "e1", about: "e1", flow: ["e1"], provenance: "declared" });
    expect(first.narrate).toBe("Step 1. hand off: API Gateway to Orders. only signed requests.");
    // An edge with nothing declared gets the plain factual line, marked.
    expect(second).toMatchObject({ focus: "e2", flow: ["e2"], provenance: "inferred" });
    expect(second.narrate).toBe("Step 2. Orders to Payments.");
    expect(script.declared).toBe(2);
  });

  it("says the story without a description, and says a hole where one is", () => {
    const bare = scriptTour(storyGraph, storySnapshot, {
      scenario: { name: "Checkout", path: ["e1", "gone"] },
    });
    expect(bare.scenario).toEqual({ name: "Checkout", description: null });
    // Nothing of the author's beyond the name, so the opener is inferred.
    expect(bare.steps[0].narrate).toBe("Checkout: 2 steps through the diagram.");
    expect(bare.steps[0].provenance).toBe("inferred");
    expect(bare.steps[0].highlight).toEqual(["e1"]);
    // A step whose edge has gone keeps its number and says so (I5).
    expect(bare.steps[2]).toMatchObject({ about: "gone", provenance: "inferred" });
    expect(bare.steps[2].narrate).toBe("Step 2 points at an edge that is gone.");
    expect(bare.steps[2].focus).toBeUndefined();
  });

  it("walks a frame or a scenario, never both, and stays deterministic", () => {
    expect(() => scriptTour(storyGraph, storySnapshot, { frame: "F", scenario: checkout })).toThrow(/never both/);
    expect(JSON.stringify(scriptTour(storyGraph, storySnapshot, { scenario: checkout }))).toBe(
      JSON.stringify(scriptTour(storyGraph, storySnapshot, { scenario: checkout })),
    );
  });
});
