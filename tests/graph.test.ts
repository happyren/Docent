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
