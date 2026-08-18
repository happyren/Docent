import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph, sanitizeId } from "../src/scene/graph";
import { applyLegend } from "../src/export/legend";

const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  strokeStyle: "solid",
  fillStyle: "solid",
  strokeWidth: 2,
  opacity: 100,
  groupIds: [],
  frameId: null,
  isDeleted: false,
  locked: false,
};

describe("proximity inference", () => {
  const elements = [
    { ...base, id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
    { ...base, id: "b", type: "rectangle", x: 300, y: 0, width: 100, height: 50 },
    {
      ...base,
      id: "arrow_near",
      type: "arrow",
      x: 110,
      y: 25,
      width: 180,
      height: 0,
      points: [
        [0, 0],
        [180, 0],
      ],
    },
    {
      ...base,
      id: "arrow_far",
      type: "arrow",
      x: 150,
      y: 500,
      width: 50,
      height: 0,
      points: [
        [0, 0],
        [50, 0],
      ],
    },
  ];

  it("resolves endpoints within the pad as inferred links", () => {
    const graph = buildSceneGraph(snapshotFromRawElements(elements));
    const near = graph.edges.find((e) => e.id === "arrow_near");
    expect(near?.from).toBe("a");
    expect(near?.to).toBe("b");
    expect(near?.fromProvenance).toBe("inferred");
  });

  it("drops arrows that resolve nowhere", () => {
    const graph = buildSceneGraph(snapshotFromRawElements(elements));
    expect(graph.edges.some((e) => e.id === "arrow_far")).toBe(false);
  });
});

describe("legend application", () => {
  const legend = [
    { attr: "strokeStyle", value: "dashed", key: "channel", meaning: "async" },
    { attr: "shape", value: "ellipse", key: "kind", meaning: "datastore" },
    { attr: "strokeColor", value: "#e03131", key: "tag", meaning: "hot-path" },
  ] as const;

  const style = (over: Partial<(typeof base)>) => ({
    strokeColor: over.strokeColor ?? "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: over.strokeStyle ?? "solid",
    fillStyle: "solid",
    strokeWidth: 2,
  });

  it("converts matched styling to semantics", () => {
    const facts = applyLegend(
      style({ strokeStyle: "dashed", strokeColor: "#e03131" }),
      "ellipse",
      [...legend],
    );
    expect(facts.props.channel).toBe("async");
    expect(facts.kind).toBe("datastore");
    expect(facts.tags).toEqual(["hot-path"]);
  });

  it("yields nothing for unmapped styling", () => {
    const facts = applyLegend(style({}), "rectangle", [...legend]);
    expect(facts.kind).toBeNull();
    expect(facts.tags).toEqual([]);
    expect(facts.props).toEqual({});
  });
});

describe("graph id sanitization (I6)", () => {
  it("derives stable mermaid-safe ids and resolves collisions", () => {
    const taken = new Set<string>();
    expect(sanitizeId("n_client", taken)).toBe("n_client");
    expect(sanitizeId("abc-def", taken)).toBe("abc_def");
    expect(sanitizeId("abc.def", taken)).toBe("abc_def_2");
    expect(sanitizeId("9lives", taken)).toBe("_9lives");
  });
});


describe("cross-tier edge refinement (D21)", () => {
  // Layer 1: Service A -> Broker, Service B -> Broker. Broker declares a
  // detail frame containing Adapter A and Adapter B. Each edge declares
  // which adapter its traffic lands on.
  const scene = (refineA: string | null, refineB: string | null) => [
    { ...base, id: "svc_a", type: "rectangle", x: 0, y: 0, width: 100, height: 60 },
    { ...base, id: "svc_b", type: "rectangle", x: 0, y: 200, width: 100, height: 60 },
    {
      ...base, id: "broker", type: "rectangle", x: 300, y: 100, width: 120, height: 80,
      customData: { docent: { detail: { frameId: "f_broker" } } },
    },
    { ...base, id: "f_broker", type: "frame", x: 0, y: 20000, width: 600, height: 400, name: "Broker — detail" },
    { ...base, id: "adapter_a", type: "rectangle", x: 40, y: 20040, width: 100, height: 60, frameId: "f_broker" },
    { ...base, id: "adapter_b", type: "rectangle", x: 240, y: 20040, width: 100, height: 60, frameId: "f_broker" },
    { ...base, id: "outsider", type: "rectangle", x: 700, y: 100, width: 80, height: 40 },
    {
      ...base, id: "e_a", type: "arrow", x: 100, y: 30, width: 200, height: 100,
      points: [[0, 0], [200, 100]],
      startBinding: { elementId: "svc_a" }, endBinding: { elementId: "broker" },
      customData: refineA ? { docent: { refine: { to: refineA } } } : undefined,
    },
    {
      ...base, id: "e_b", type: "arrow", x: 100, y: 230, width: 200, height: -90,
      points: [[0, 0], [200, -90]],
      startBinding: { elementId: "svc_b" }, endBinding: { elementId: "broker" },
      customData: refineB ? { docent: { refine: { to: refineB } } } : undefined,
    },
  ];

  it("resolves declared refinements into the graph", () => {
    const graph = buildSceneGraph(
      snapshotFromRawElements(scene("adapter_a", "adapter_b")),
    );
    const eA = graph.edges.find((e) => e.sourceId === "e_a")!;
    const eB = graph.edges.find((e) => e.sourceId === "e_b")!;
    const adapterA = graph.nodes.find((n) => n.sourceId === "adapter_a")!;
    const adapterB = graph.nodes.find((n) => n.sourceId === "adapter_b")!;
    // Coarse endpoints survive - the tier-1 reading stays true.
    expect(eA.to).toBe(graph.nodes.find((n) => n.sourceId === "broker")!.id);
    expect(eA.toRefined).toBe(adapterA.id);
    expect(eB.toRefined).toBe(adapterB.id);
    expect(eA.fromRefined).toBeNull();
  });

  it("drops refinements that don't live in the endpoint's detail frame", () => {
    const graph = buildSceneGraph(
      snapshotFromRawElements(scene("outsider", "ghost_element")),
    );
    expect(graph.edges.find((e) => e.sourceId === "e_a")!.toRefined).toBeNull();
    expect(graph.edges.find((e) => e.sourceId === "e_b")!.toRefined).toBeNull();
  });

  it("drops refinements when the endpoint has no detail diagram", () => {
    const elements = scene("adapter_a", null).map((el) =>
      el.id === "broker" ? { ...el, customData: undefined } : el,
    );
    const graph = buildSceneGraph(snapshotFromRawElements(elements));
    expect(graph.edges.find((e) => e.sourceId === "e_a")!.toRefined).toBeNull();
  });
});
