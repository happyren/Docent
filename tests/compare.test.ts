/**
 * The compare lens's arithmetic (D134): two graphs matched by stable id
 * (I6), sorted into added, removed (as placed ghosts), and changed — and
 * the proposal's case (D135) riding the carrier like the scenarios do.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { compareGraphs } from "../src/scene/compare";
import { idSource, plan, simulate, type Op } from "../src/authoring/ops";

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#e9ecef", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
  groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const node = (id: string, x: number, y: number, label: string) => [
  { ...base, id, type: "rectangle", x, y, width: 160, height: 80, boundElements: [{ id: `${id}_t`, type: "text" }] },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20, backgroundColor: "transparent" },
];
const link = (id: string, from: string, to: string) => [{
  ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, roundness: { type: 2 },
  points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow", backgroundColor: "transparent",
}];
const graphOf = (raw: unknown[]) => buildSceneGraph(snapshotFromRawElements(raw as never));

describe("the compare lens (D134)", () => {
  const before = graphOf([
    ...node("a", 0, 0, "Gateway"),
    ...node("b", 400, 0, "Orders"),
    ...node("gone", 800, 0, "Old worker"),
    ...link("e1", "a", "b"),
    ...link("e2", "b", "gone"),
  ]);

  it("sorts a change into added, removed ghosts, and changed", () => {
    const after = graphOf([
      ...node("a", 0, 0, "Gateway"),
      ...node("b", 400, 300, "Orders"), // moved beyond tolerance
      ...node("q", 800, 300, "Order queue"), // added
      ...link("e1", "a", "b"),
      ...link("e3", "b", "q"), // added
    ]);
    const view = compareGraphs(before, after);
    expect(view.counts).toEqual({ added: 2, removed: 2, changed: 1 });
    expect(view.added).toContain("q");
    expect(view.added).toContain("e3");
    expect(view.changed).toEqual(["b"]);
    const ghost = view.ghosts.find((g) => g.sourceId === "gone");
    expect(ghost).toMatchObject({ label: "Old worker", frame: false, bounds: { x: 800, y: 0, width: 160, height: 80 } });
    expect(view.ghosts.some((g) => g.sourceId === "e2")).toBe(true);
  });

  it("is quiet when nothing moved further than a settle", () => {
    const after = graphOf([
      ...node("a", 3, -2, "Gateway"),
      ...node("b", 400, 0, "Orders"),
      ...node("gone", 800, 0, "Old worker"),
      ...link("e1", "a", "b"),
      ...link("e2", "b", "gone"),
    ]);
    const view = compareGraphs(before, after);
    expect(view.counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe("the proposal's case (D135)", () => {
  const empty = snapshotFromRawElements([] as never);
  const run = (snapshot: typeof empty, ops: Op[]) => {
    const result = plan(ops, snapshot, idSource(7));
    return { result, after: simulate(snapshot, result.write) };
  };

  it("records, replaces, and clears beside the legend", () => {
    const { result, after } = run(empty, [
      { op: "define_proposal", title: "Move billing to events", against: "base", wins: ["Scales without the gateway"], costs: ["One more hop"] },
    ]);
    expect(result.notes.join(" ")).toContain('proposal "Move billing to events" recorded (1 win, 1 cost)');
    const graph = buildSceneGraph(after);
    expect(graph.proposal).toEqual({
      title: "Move billing to events",
      against: "base",
      wins: ["Scales without the gateway"],
      costs: ["One more hop"],
    });
    const { after: cleared } = run(after, [{ op: "define_proposal", clear: true }]);
    expect(buildSceneGraph(cleared).proposal).toBeNull();
  });

  it("refuses a case with no title", () => {
    expect(() => run(empty, [{ op: "define_proposal", wins: ["free"] }])).toThrow(/title is empty/);
  });
});
