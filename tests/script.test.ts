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
