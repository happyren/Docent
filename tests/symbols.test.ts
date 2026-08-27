/**
 * Symbols (S21, D83–D85): a library icon is a component. It is placed at the
 * catalog's own size, arrows bind to the carrier on the icon's bounds, the
 * scene graph reads the whole group as ONE node, the legend may mean an
 * icon, and the layout treats it like anything else.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { exportSidecar } from "../src/export/sidecar";
import { applyLegend } from "../src/export/legend";
import { craftScore } from "../src/authoring/score";
import { idSource, lint, plan, PlanError, simulate, type Op } from "../src/authoring/ops";
import { placeSymbol, symbolEntry } from "../src/authoring/symbols";

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

const LAMBDA = symbolEntry("aws/lambda")!;

const placeLambda = (extra: Op[] = []) =>
  plan(
    [
      { op: "add_node", ref: "$lambda", symbol: "aws/lambda", label: "Order processor", frame: "F", intents: ["runs the fulfilment step"] },
      { op: "add_edge", from: "gateway", to: "$lambda", label: "invoke" },
      ...extra,
    ],
    snapshot,
    idSource(11),
  );

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("the catalog in the pure layer (D81)", () => {
  it("knows aws/lambda and its measurements", () => {
    expect(LAMBDA.name).toBe("Lambda");
    expect(LAMBDA.library).toBe("aws-architecture-icons");
    expect(LAMBDA.icon.width).toBeGreaterThan(0);
    expect(symbolEntry("aws/no-such-thing")).toBeNull();
  });

  it("places the icon at its native size, the label under it, wrapped to the icon", () => {
    // A label the caption's own room already holds leaves the item's size —
    // give or take the line the house font is a hair taller in.
    const one = placeSymbol(LAMBDA, "Fn", 20);
    expect(one.size.width).toBe(LAMBDA.size.width);
    expect(one.size.height).toBeGreaterThanOrEqual(LAMBDA.size.height);
    expect(one.size.height).toBeLessThan(LAMBDA.size.height + 5);
    expect(one.label.lines).toEqual(["Fn"]);
    // The label sits under the icon's middle and inside the component's box.
    expect(one.label.y).toBeGreaterThan(one.icon.y);
    expect(Math.abs(one.label.x + one.label.width / 2 - (one.icon.x + one.icon.width / 2))).toBeLessThanOrEqual(1);
    // A longer label wraps to the icon's width and makes the box taller, not
    // wider than the wrap allows (D80's spirit, D83's wrapping).
    const many = placeSymbol(LAMBDA, "Order fulfilment processor worker", 20);
    expect(many.label.lines.length).toBeGreaterThan(1);
    expect(many.size.height).toBeGreaterThan(one.size.height);
  });
});

describe("a symbol is a component (D83)", () => {
  it("writes one symbol at the catalog size, with the edge on the icon's border", () => {
    const result = placeLambda();
    expect(result.write.shapes).toBeUndefined();
    expect(result.write.symbols).toHaveLength(1);
    const symbol = result.write.symbols![0];
    expect(symbol.symbol).toBe("aws/lambda");
    expect(symbol.library).toBe("aws-architecture-icons");
    expect(symbol.index).toBe(LAMBDA.index);
    expect(symbol.label).toBe("Order processor");
    expect(symbol.frameId).toBe("F");
    expect(symbol.icon.width).toBe(LAMBDA.icon.width);
    expect(symbol.icon.height).toBe(LAMBDA.icon.height);
    // The house dresses the label only; the icon keeps its brand drawing.
    expect(symbol.labelStyle.fontFamily).toBe(5);
    expect(symbol.labelStyle.fontSize).toBe(20);

    // The component's box for placement is icon ∪ label, never smaller than
    // the item's own size — and it lands on free space.
    const shape = placeSymbol(LAMBDA, "Order processor", 20);
    expect(shape.size.width).toBeGreaterThanOrEqual(LAMBDA.size.width);
    expect(shape.size.height).toBeGreaterThanOrEqual(LAMBDA.size.height);
    const placed = { x: symbol.x - shape.item.x, y: symbol.y - shape.item.y, ...shape.size };
    for (const other of [
      { x: 40, y: 100, width: 160, height: 80 },
      { x: 340, y: 100, width: 160, height: 80 },
      { x: 640, y: 100, width: 180, height: 90 },
    ]) {
      expect(overlaps(placed, other)).toBe(false);
    }

    // The arrow binds to the carrier — the component's stable id — and lands
    // on the ICON's boundary, never out in the caption's room.
    const edge = result.write.arrows![0];
    expect(edge.to).toBe(symbol.id);
    expect(result.ids["$lambda"]).toBe(symbol.id);
    const end = edge.ends!.end;
    const onIcon =
      Math.abs(end[0] - symbol.icon.x) < 0.001 ||
      Math.abs(end[0] - (symbol.icon.x + symbol.icon.width)) < 0.001 ||
      Math.abs(end[1] - symbol.icon.y) < 0.001 ||
      Math.abs(end[1] - (symbol.icon.y + symbol.icon.height)) < 0.001;
    expect(onIcon).toBe(true);
    expect(end[0]).toBeGreaterThanOrEqual(symbol.icon.x - 0.001);
    expect(end[0]).toBeLessThanOrEqual(symbol.icon.x + symbol.icon.width + 0.001);
    expect(end[1]).toBeGreaterThanOrEqual(symbol.icon.y - 0.001);
    expect(end[1]).toBeLessThanOrEqual(symbol.icon.y + symbol.icon.height + 0.001);
  });

  it("refuses a symbol the catalog does not know, and says how to find one", () => {
    expect(() =>
      plan([{ op: "add_node", symbol: "aws/lamda", label: "Typo", frame: "F" }], snapshot, idSource(3)),
    ).toThrow(PlanError);
    try {
      plan([{ op: "add_node", symbol: "aws/lamda", label: "Typo", frame: "F" }], snapshot, idSource(3));
    } catch (err) {
      expect((err as PlanError).problems[0]).toContain("unknown symbol aws/lamda");
      expect((err as PlanError).problems[0]).toContain("find_symbol");
    }
  });

  it("reads back as ONE component with the agent's label and its symbol", () => {
    const result = placeLambda();
    const after = simulate(snapshot, result.write);
    const graph = buildSceneGraph(after);
    const node = graph.nodes.find((n) => n.symbol === "aws/lambda");
    expect(node).toBeDefined();
    expect(node!.label).toBe("Order processor");
    expect(node!.sourceId).toBe(result.write.symbols![0].id);
    expect(node!.composite).toEqual({ members: 2, provenance: "declared" });
    expect(node!.intents).toEqual(["runs the fulfilment step"]);
    // Exactly one node stands for it: the carrier and the label are one thing.
    expect(graph.nodes.filter((n) => n.label === "Order processor")).toHaveLength(1);
    // The edge resolves to it.
    const edge = graph.edges.find((e) => e.sourceId === result.write.arrows![0].id)!;
    expect(edge.to).toBe(node!.id);
    expect(edge.toProvenance).toBe("explicit");
    // Nothing overlaps and nothing is cut through.
    const report = lint(after);
    const bad = report.findings.filter(
      (f) => f.message.includes("passes through") || f.message.includes("overlap"),
    );
    expect(bad).toEqual([]);
  });

  it("is deterministic: the same batch twice gives the same write", () => {
    expect(JSON.stringify(placeLambda().write)).toBe(JSON.stringify(placeLambda().write));
  });

  it("removes the icon, the carrier and the label together, and its edges", () => {
    const after = simulate(snapshot, placeLambda().write);
    const carrierId = buildSceneGraph(after).nodes.find((n) => n.symbol === "aws/lambda")!.sourceId;
    const group = after.elements.find((el) => el.id === carrierId)!.groupIds[0];
    const gone = plan([{ op: "remove", id: carrierId }], after, idSource(17));
    for (const el of after.elements.filter((e) => e.groupIds.includes(group))) {
      expect(gone.write.remove).toContain(el.id);
    }
    expect(buildSceneGraph(simulate(after, gone.write)).nodes.some((n) => n.symbol)).toBe(false);
  });

  it("keeps the library's drawing when a kind would paint it", () => {
    const after = simulate(snapshot, placeLambda().write);
    const carrierId = buildSceneGraph(after).nodes.find((n) => n.symbol === "aws/lambda")!.sourceId;
    const changed = plan([{ op: "update", id: carrierId, kind: "service" }], after, idSource(19));
    expect(changed.write.patches?.some((p) => p.id === carrierId && p.style)).toBeFalsy();
    expect(changed.notes.some((n) => n.includes("does not dress an icon"))).toBe(true);
  });
});

describe("symbols in the legend and the exports (D84)", () => {
  const defined = plan(
    [
      { op: "define_kind", kind: "function", symbol: "aws/lambda" },
      { op: "add_node", ref: "$fn", symbol: "aws/lambda", label: "Order processor", frame: "F", intents: ["runs the fulfilment step"] },
    ],
    snapshot,
    idSource(5),
  );

  it("define_kind writes a symbol rule and picks no colour", () => {
    const rule = defined.write.legend!.find((r) => r.meaning === "function")!;
    expect(rule).toEqual({ attr: "symbol", value: "aws/lambda", key: "kind", meaning: "function" });
    expect(defined.notes.some((n) => n.includes("legend: function → symbol aws/lambda"))).toBe(true);
  });

  it("a component placed with that symbol exports the kind and the symbol", () => {
    const after = simulate(snapshot, defined.write);
    const graph = buildSceneGraph(after);
    const node = graph.nodes.find((n) => n.symbol === "aws/lambda")!;
    expect(applyLegend(node.style, node.shape, graph.legend, node.symbol).kind).toBe("function");
    // …and a component without the symbol does not accidentally match.
    const other = graph.nodes.find((n) => n.label === "Orders")!;
    expect(applyLegend(other.style, other.shape, graph.legend, other.symbol).kind).toBe("service");
    const sidecar = JSON.parse(exportSidecar(graph)) as { nodes: Record<string, unknown>[] };
    const entity = sidecar.nodes.find((n) => n.symbol === "aws/lambda")!;
    expect(entity.kind).toBe("function");
    expect((entity.provenance as Record<string, string>).symbol).toBe("declared");
  });

  it("a kind that means a symbol places the icon without naming it again", () => {
    const after = simulate(snapshot, defined.write);
    const second = plan(
      [{ op: "add_node", kind: "function", label: "Receipt mailer", frame: "F" }],
      after,
      idSource(9),
    );
    expect(second.write.symbols?.[0]?.symbol).toBe("aws/lambda");
    expect(second.write.symbols?.[0]?.label).toBe("Receipt mailer");
  });

  it("the craft score's colour part ignores a symbol kind", () => {
    const withSymbol = craftScore(simulate(snapshot, defined.write), buildSceneGraph(simulate(snapshot, defined.write)));
    const colour = withSymbol.parts.find((p) => p.key === "colour")!;
    // datastore and service are still the pair judged; `function` has no fill.
    expect(colour.detail).not.toContain("function");
  });
});

describe("symbols lay out like anything else (D85)", () => {
  it("moves the carrier and keeps the icon's native size", () => {
    const after = simulate(snapshot, placeLambda().write);
    const carrierId = buildSceneGraph(after).nodes.find((n) => n.symbol === "aws/lambda")!.sourceId;
    const before = after.elements.find((el) => el.id === carrierId)!;
    const laid = plan([{ op: "layout", frame: "F" }], after, idSource(13));
    const patch = laid.write.patches!.find((p) => p.id === carrierId);
    expect(patch).toBeDefined();
    // A symbol is never resized: the library drew it at this size.
    expect(patch!.width).toBeUndefined();
    expect(patch!.height).toBeUndefined();
    // …and the whole group follows the carrier.
    const moved = simulate(after, laid.write);
    const labelBefore = after.elements.find((el) => el.groupIds.length && el.type === "text" && el.groupIds[0] === before.groupIds[0])!;
    const labelAfter = moved.elements.find((el) => el.id === labelBefore.id)!;
    expect(labelAfter.x - labelBefore.x).toBe(patch!.x! - before.x);
    expect(labelAfter.y - labelBefore.y).toBe(patch!.y! - before.y);
    const wasBounds = buildSceneGraph(after).nodes.find((n) => n.symbol === "aws/lambda")!.bounds;
    const node = buildSceneGraph(moved).nodes.find((n) => n.symbol === "aws/lambda")!;
    expect(node.bounds.width).toBe(wasBounds.width);
    expect(node.bounds.height).toBe(wasBounds.height);
    const carrier = moved.elements.find((el) => el.id === carrierId)!;
    expect(carrier.width).toBe(before.width);
    expect(carrier.height).toBe(before.height);
  });

  it("routes around the whole component, caption included", () => {
    // A second symbol between the gateway and the first one: the edge must
    // clear the WHOLE box (icon ∪ label), not just the icon.
    const result = plan(
      [
        { op: "add_node", ref: "$a", symbol: "aws/lambda", label: "Order processor", frame: "F", intents: ["x"] },
        { op: "add_node", ref: "$b", symbol: "aws/lambda", label: "Receipt mailer", frame: "F", intents: ["y"] },
        { op: "add_edge", from: "$a", to: "$b", label: "then" },
      ],
      snapshot,
      idSource(21),
    );
    const symbols = result.write.symbols!;
    expect(symbols).toHaveLength(2);
    // Same symbol, same size (D85) — the labels differ but the icon does not.
    expect(symbols[0].icon.width).toBe(symbols[1].icon.width);
    expect(symbols[0].icon.height).toBe(symbols[1].icon.height);
    const after = simulate(snapshot, result.write);
    const report = lint(after);
    expect(report.findings.filter((f) => f.message.includes("passes through"))).toEqual([]);
    // The two components' whole boxes — icon ∪ label — do not touch.
    const boxes = symbols.map((s) => {
      const shape = placeSymbol(LAMBDA, s.label, 20);
      return { x: s.x - shape.item.x, y: s.y - shape.item.y, ...shape.size };
    });
    expect(overlaps(boxes[0], boxes[1])).toBe(false);
  });
});

describe("an edge keeps clear of its own caption (D83, D72)", () => {
  it("routes out of a symbol without crossing the caption under its icon", () => {
    // Two lambdas stacked: the edge must leave the upper one downward —
    // and the caption sits exactly there.
    const result = plan(
      [
        { op: "add_node", ref: "$a", symbol: "aws/lambda", label: "Upper" },
        { op: "add_node", ref: "$b", symbol: "aws/lambda", label: "Lower" },
        { op: "add_edge", ref: "$e", from: "$a", to: "$b", label: "invokes" },
        { op: "layout", frame: null },
      ],
      snapshotFromRawElements([] as never),
      idSource(21),
    );
    const shapes = new Map((result.write.symbols ?? []).map((s) => [s.id, s]));
    const a = shapes.get(result.ids.$a)!;
    const b = shapes.get(result.ids.$b)!;
    const arrowEl = result.write.arrows!.find((ar) => ar.id === result.ids.$e)! as unknown as {
      ends?: { start: [number, number]; end: [number, number] };
      via?: [number, number][];
    };
    // The caption strip: the component's box below the icon.
    // WriteSymbol carries the icon (the carrier box) and labelBox (caption).
    const strip = (s: typeof a) => {
      const lb = (s as unknown as { labelBox: { x: number; y: number; width: number; height: number } }).labelBox;
      return { x: lb.x, y: lb.y, width: lb.width, height: lb.height };
    };
    const pts: [number, number][] = arrowEl.ends ? [arrowEl.ends.start, ...(arrowEl.via ?? []), arrowEl.ends.end] : [];
    const crosses = (box: { x: number; y: number; width: number; height: number }) => {
      if (box.height <= 0) return false;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i]; const [x2, y2] = pts[i + 1];
        // conservative: segment's bbox strictly inside test via sampling
        for (let t = 0.02; t < 1; t += 0.04) {
          const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
          if (x > box.x + 1 && x < box.x + box.width - 1 && y > box.y + 1 && y < box.y + box.height - 1) return true;
        }
      }
      return false;
    };
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(crosses(strip(a))).toBe(false);
    expect(crosses(strip(b))).toBe(false);
  });
});
