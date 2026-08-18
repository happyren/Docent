import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
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


describe("grouped composites (D22)", () => {
  // A library icon: a box, two drawn strokes, and a text label, grouped —
  // one component, not four. An arrow binds to one of its parts.
  const icon = (extra: Record<string, unknown> = {}) => [
    { ...base, id: "icon_box", type: "rectangle", x: 100, y: 0, width: 80, height: 80, groupIds: ["g_icon"], ...extra },
    { ...base, id: "icon_s1", type: "line", x: 110, y: 10, width: 60, height: 60, groupIds: ["g_icon"], points: [[0, 0], [60, 60]] },
    { ...base, id: "icon_s2", type: "freedraw", x: 110, y: 70, width: 60, height: -60, groupIds: ["g_icon"], points: [[0, 0], [60, -60]] },
    { ...base, id: "icon_txt", type: "text", x: 100, y: 90, width: 80, height: 20, groupIds: ["g_icon"], text: "Lambda" },
    { ...base, id: "caller", type: "rectangle", x: 0, y: 200, width: 80, height: 40 },
    {
      ...base, id: "e_call", type: "arrow", x: 80, y: 210, width: 60, height: -150,
      points: [[0, 0], [60, -150]],
      startBinding: { elementId: "caller" }, endBinding: { elementId: "icon_s1" },
    },
  ];

  it("collapses a drawn glyph group into one node", () => {
    const graph = buildSceneGraph(snapshotFromRawElements(icon()));
    const iconNodes = graph.nodes.filter((n) =>
      ["icon_box", "icon_s1", "icon_s2", "icon_txt"].includes(n.sourceId),
    );
    expect(iconNodes).toHaveLength(1);
    const node = iconNodes[0];
    expect(node.composite).toEqual({ members: 4, provenance: "inferred" });
    // It speaks for its parts: the label comes from the grouped text and
    // the box spans the whole glyph.
    expect(node.label).toBe("Lambda");
    expect(node.bounds).toEqual({ x: 100, y: 0, width: 80, height: 110 });
    // A collapsed group is a node, not also a group.
    expect(graph.groups.find((g) => g.id === "g_icon")).toBeUndefined();
  });

  it("routes an edge bound to any part to the one component", () => {
    const graph = buildSceneGraph(snapshotFromRawElements(icon()));
    const composite = graph.nodes.find((n) => n.composite)!;
    const edge = graph.edges.find((e) => e.sourceId === "e_call")!;
    expect(edge.to).toBe(composite.id);
  });

  it("collapses a shape-only glyph whose parts touch (cylinder, stack)", () => {
    // A database cylinder: two ellipses and a body, overlapping, unlabelled.
    // No primitives involved, so only the cluster signature can catch it.
    const graph = buildSceneGraph(
      snapshotFromRawElements([
        { ...base, id: "cyl_top", type: "ellipse", x: 0, y: 0, width: 100, height: 30, groupIds: ["g_db"] },
        { ...base, id: "cyl_body", type: "rectangle", x: 0, y: 15, width: 100, height: 70, groupIds: ["g_db"] },
        { ...base, id: "cyl_bottom", type: "ellipse", x: 0, y: 70, width: 100, height: 30, groupIds: ["g_db"] },
      ]),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].composite).toEqual({ members: 3, provenance: "inferred" });
  });

  it("treats lettering drawn inside the glyph as decoration, not a label", () => {
    // A Textract-style icon: caption below, plus a "T" drawn inside the
    // badge. Two texts, but only one of them names the component.
    const graph = buildSceneGraph(
      snapshotFromRawElements([
        { ...base, id: "badge", type: "rectangle", x: 0, y: 0, width: 100, height: 100, groupIds: ["g_icon"] },
        { ...base, id: "mark", type: "line", x: 10, y: 10, width: 40, height: 40, groupIds: ["g_icon"], points: [[0, 0], [40, 40]] },
        { ...base, id: "letter", type: "text", x: 40, y: 35, width: 20, height: 30, groupIds: ["g_icon"], text: "T" },
        { ...base, id: "caption", type: "text", x: 0, y: 115, width: 100, height: 20, groupIds: ["g_icon"], text: "Textract" },
      ]),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].composite).toEqual({ members: 4, provenance: "inferred" });
    // The caption names it, not the lettering.
    expect(graph.nodes[0].label).toBe("Textract");
  });

  it("keeps labelled components separate even when they touch", () => {
    // Two services side by side, each carrying its own bound label: a
    // grouping of real components, not one glyph.
    const graph = buildSceneGraph(
      snapshotFromRawElements([
        { ...base, id: "svc_a", type: "rectangle", x: 0, y: 0, width: 80, height: 40, groupIds: ["g_pair"], boundElements: [{ id: "lbl_a", type: "text" }] },
        { ...base, id: "lbl_a", type: "text", x: 5, y: 10, width: 70, height: 20, text: "Service A", containerId: "svc_a" },
        { ...base, id: "svc_b", type: "rectangle", x: 82, y: 0, width: 80, height: 40, groupIds: ["g_pair"], boundElements: [{ id: "lbl_b", type: "text" }] },
        { ...base, id: "lbl_b", type: "text", x: 87, y: 10, width: 70, height: 20, text: "Service B", containerId: "svc_b" },
      ]),
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((n) => n.composite === null)).toBe(true);
    expect(graph.nodes.map((n) => n.label).sort()).toEqual(["Service A", "Service B"]);
  });

  it("leaves a plain grouping of real shapes alone", () => {
    const elements = [
      { ...base, id: "svc_a", type: "rectangle", x: 0, y: 0, width: 80, height: 40, groupIds: ["g_layout"] },
      { ...base, id: "svc_b", type: "rectangle", x: 100, y: 0, width: 80, height: 40, groupIds: ["g_layout"] },
    ];
    const graph = buildSceneGraph(snapshotFromRawElements(elements));
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((n) => n.composite === null)).toBe(true);
    expect(graph.groups.find((g) => g.id === "g_layout")?.members).toHaveLength(2);
  });

  it("honours the author's declaration over the heuristic", () => {
    // Declared split: the glyph group stays as separate components.
    const split = buildSceneGraph(
      snapshotFromRawElements(icon({ customData: { docent: { composite: { g_icon: false } } } })),
    );
    expect(split.nodes.filter((n) => n.composite)).toHaveLength(0);
    expect(split.nodes.filter((n) => n.sourceId.startsWith("icon_")).length).toBeGreaterThan(1);

    // Declared merge: a plain shape grouping becomes one component.
    const merged = buildSceneGraph(
      snapshotFromRawElements([
        { ...base, id: "svc_a", type: "rectangle", x: 0, y: 0, width: 80, height: 40, groupIds: ["g_layout"], customData: { docent: { composite: { g_layout: true } } } },
        { ...base, id: "svc_b", type: "rectangle", x: 100, y: 0, width: 80, height: 40, groupIds: ["g_layout"] },
      ]),
    );
    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0].composite).toEqual({ members: 2, provenance: "declared" });
  });

  it("carries a member's detail link and intent onto the composite", () => {
    const elements = [
      ...icon(),
      { ...base, id: "f_inner", type: "frame", x: 0, y: 20000, width: 400, height: 300, name: "Lambda — detail" },
    ].map((el) =>
      el.id === "icon_s1"
        ? {
            ...el,
            customData: {
              docent: { detail: { frameId: "f_inner" }, tags: ["serverless"] },
            },
          }
        : el,
    );
    const graph = buildSceneGraph(snapshotFromRawElements(elements));
    const composite = graph.nodes.find((n) => n.composite)!;
    expect(composite.detailFrameId).toBe(
      graph.frames.find((f) => f.sourceId === "f_inner")!.id,
    );
    expect(composite.tags).toContain("serverless");
  });
});


describe("real library icon (maintainer-reported)", () => {
  // The exact clipboard payload from an excalidraw.com library item:
  // a filled box, two drawn strokes, and a text label, in NESTED groups
  // (strokes share an inner group, everything shares an outer one), with
  // an arrow bound to the box.
  const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
  const graph = buildSceneGraph(
    snapshotFromSceneJSON(
      readFileSync(join(FIXTURES, "library-icon.excalidraw"), "utf8"),
    ),
  );

  it("reads as ONE component, not a bunch of shapes", () => {
    // Two components total: the caller service and the icon.
    expect(graph.nodes).toHaveLength(2);
    const icon = graph.nodes.find((n) => n.composite)!;
    expect(icon.composite).toEqual({ members: 4, provenance: "inferred" });
    expect(icon.label).toBe("IconAdapter\n-UpsertIncident");
  });

  it("collapses at the outer group despite nested sub-groups", () => {
    const icon = graph.nodes.find((n) => n.composite)!;
    // The strokes' own inner group must not become a second component.
    expect(graph.nodes.filter((n) => n.composite)).toHaveLength(1);
    // Its box spans the whole glyph including the label below it.
    expect(icon.bounds.width).toBeGreaterThan(400);
    expect(icon.bounds.height).toBeGreaterThan(300);
  });

  it("routes the bound arrow to the component", () => {
    const icon = graph.nodes.find((n) => n.composite)!;
    const edge = graph.edges[0];
    expect(edge.to).toBe(icon.id);
    expect(edge.toProvenance).toBe("explicit");
  });
});
