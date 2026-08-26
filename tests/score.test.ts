/**
 * The craft score (D76): the number the lint carries, measured off the
 * polylines a reader sees. A tidy diagram scores high, a tangled one
 * clearly lower, an arc at a corner (D78) counts as the one bend it draws,
 * and two kinds a reader could not tell apart cost the legend. The last
 * test is the watchdog: what Docent's own pipeline draws must keep scoring.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { idSource, lint, plan, simulate } from "../src/authoring/ops";
import { craftScore, type CraftKey, type CraftPart, type CraftScore } from "../src/authoring/score";
import { arcCorners, CORNER_RADIUS, type Point } from "../src/authoring/route";

/**
 * What an agent-built frame must keep scoring, laid out by Docent's own
 * pipeline (D74, D75). A drop below this is a regression in the pipeline,
 * not in the score — that is what makes it the build's watchdog (D76).
 */
const WATCHDOG = 80;

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

/** An arrow drawn where it says it is: absolute points, relative to its origin. */
const drawn = (id: string, from: string, to: string, points: readonly Point[], frameId = "F") => ({
  ...base, id, type: "arrow", frameId, roundness: { type: 2 },
  x: points[0][0], y: points[0][1],
  width: Math.abs(points[points.length - 1][0] - points[0][0]),
  height: Math.abs(points[points.length - 1][1] - points[0][1]),
  points: points.map((p) => [p[0] - points[0][0], p[1] - points[0][1]]),
  startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow",
});

const legend = [
  { attr: "backgroundColor", value: "#a5d8ff", also: [{ attr: "shape", value: "ellipse" }], key: "kind", meaning: "datastore" },
  { attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" },
];

/** The tidy fixture the rest of the authoring tests use. */
const raw = [
  { ...base, id: "F", type: "frame", name: "02 Core Services", x: 0, y: 0, width: 900, height: 400, customData: { docent: { narrative: "Orders pass through here." } } },
  { ...base, id: "legend", type: "text", x: 0, y: -120, width: 200, height: 40, text: "Legend", locked: true, customData: { docent: { legend } } },
  ...box("gateway", 40, 100, "API Gateway", { backgroundColor: "#ffec99", customData: { docent: { note: "rate-limits at the edge" } } }),
  ...box("orders", 340, 100, "Orders", { backgroundColor: "#ffec99", customData: { docent: { note: "owns order state" } } }),
  { ...base, id: "db", type: "ellipse", x: 640, y: 100, width: 180, height: 90, frameId: "F", backgroundColor: "#a5d8ff", boundElements: [{ id: "db_t", type: "text" }] },
  { ...base, id: "db_t", type: "text", x: 660, y: 130, width: 140, height: 20, text: "Postgres", containerId: "db", frameId: "F", fontFamily: 5, fontSize: 20 },
  arrow("e1", "gateway", "orders"),
  arrow("e2", "orders", "db"),
];
const snapshot = snapshotFromRawElements(raw as never);

/**
 * A knot: two arrows that cross, and one drawn straight through the box
 * between its ends.
 */
const tangled = snapshotFromRawElements([
  { ...base, id: "F", type: "frame", name: "Knot", x: -100, y: -100, width: 1200, height: 600, customData: { docent: { narrative: "A tangle." } } },
  { ...base, id: "legend", type: "text", x: 0, y: -400, width: 200, height: 40, text: "Legend", locked: true, customData: { docent: { legend } } },
  ...box("a", 0, 0, "A", { backgroundColor: "#ffec99" }),
  ...box("b", 400, 0, "B", { backgroundColor: "#ffec99" }),
  ...box("c", 0, 300, "C", { backgroundColor: "#ffec99" }),
  ...box("d", 400, 300, "D", { backgroundColor: "#ffec99" }),
  ...box("e", 800, 0, "E", { backgroundColor: "#ffec99" }),
  drawn("x1", "a", "d", [[80, 40], [480, 340]]),
  drawn("x2", "c", "b", [[80, 340], [480, 40]]),
  drawn("x3", "a", "e", [[80, 40], [880, 40]]),
] as never);

const part = (score: CraftScore, key: CraftKey): CraftPart => score.parts.find((p) => p.key === key)!;

describe("the craft score (D76)", () => {
  it("scores a tidy diagram high, with nothing crossing and nothing on top of anything", () => {
    const score = craftScore(snapshot);
    expect(score.score).toBeGreaterThanOrEqual(85);
    expect(part(score, "crossings").value).toBe(0);
    expect(part(score, "crossings").penalty).toBe(0);
    expect(part(score, "overlaps").value).toBe(0);
    expect(part(score, "overlaps").penalty).toBe(0);
    // Every part is reported, weighted as the evidence ranks them.
    expect(score.parts.map((p) => p.key)).toEqual(["crossings", "bends", "alignment", "overlaps", "lengths", "squareness", "colour"]);
    expect(score.parts.reduce((sum, p) => sum + p.weight, 0)).toBe(100);
    expect(score.perFrame).toEqual([{ id: "F", name: "02 Core Services", score: score.score, worst: "alignment" }]);
  });

  it("scores a tangled one clearly lower and says what to do about it", () => {
    const knot = craftScore(tangled);
    expect(knot.score).toBeLessThan(craftScore(snapshot).score - 20);
    expect(part(knot, "crossings").value).toBe(1);
    expect(part(knot, "crossings").penalty).toBeGreaterThan(0);
    // The arrow from A to E is drawn straight through B.
    expect(part(knot, "overlaps").value).toBe(1);
    expect(part(knot, "overlaps").penalty).toBeGreaterThan(0);
    expect(part(knot, "overlaps").detail).toContain("cut through a component");
    // The dearest part comes first, in Docent's own vocabulary.
    expect(knot.advice[0]).toContain("crossings");
    expect(knot.advice.join(" ")).toMatch(/tidy\(|layout\(/);
    expect(knot.advice.length).toBeGreaterThanOrEqual(1);
    expect(knot.advice.length).toBeLessThanOrEqual(3);
    expect(knot.perFrame[0].worst).toBe("crossings");
  });

  it("counts an arc as the one bend it draws, and a straight line as none", () => {
    const corners: Point[] = [[100, 30], [350, 30], [350, 430], [600, 430]];
    const softened = arcCorners(corners);
    // D78 draws each right angle as an arc: two tangent points and four between.
    expect(softened.length).toBe(corners.length + 2 * 5);
    for (const p of softened) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
    expect(CORNER_RADIUS).toBe(24);
    const withCorners = snapshotFromRawElements([
      { ...base, id: "F", type: "frame", name: "Turns", x: -100, y: -100, width: 1000, height: 700, customData: { docent: { narrative: "Two turns." } } },
      ...box("p", 0, 0, "P"),
      ...box("q", 600, 400, "Q"),
      drawn("bendy", "p", "q", softened),
    ] as never);
    expect(part(craftScore(withCorners), "bends").value).toBe(2);

    const straight = snapshotFromRawElements([
      { ...base, id: "F", type: "frame", name: "Straight", x: -100, y: -100, width: 1000, height: 400, customData: { docent: { narrative: "No turns." } } },
      ...box("p", 0, 0, "P"),
      ...box("q", 600, 0, "Q"),
      // Collinear points along one line: no turn at all.
      drawn("flat", "p", "q", [[160, 40], [300, 40], [450, 40], [600, 40]]),
    ] as never);
    const flat = craftScore(straight);
    expect(part(flat, "bends").value).toBe(0);
    expect(part(flat, "bends").penalty).toBe(0);
  });

  it("penalises two kinds a reader could not tell apart, and leaves distinct ones alone", () => {
    const withFills = (a: string, b: string) =>
      craftScore(
        snapshotFromRawElements([
          { ...base, id: "legend", type: "text", x: 0, y: -400, width: 200, height: 40, text: "Legend", locked: true,
            customData: { docent: { legend: [
              { attr: "backgroundColor", value: a, key: "kind", meaning: "service" },
              { attr: "backgroundColor", value: b, key: "kind", meaning: "datastore" },
            ] } } },
          ...box("one", 0, 0, "One", { backgroundColor: a }),
          ...box("two", 400, 0, "Two", { backgroundColor: b }),
        ] as never),
      );
    const alike = withFills("#a5d8ff", "#a8daff");
    expect(part(alike, "colour").value).toBeLessThan(25);
    expect(part(alike, "colour").penalty).toBeGreaterThan(4);
    expect(alike.advice.some((line) => line.includes("define_kind"))).toBe(true);
    // Two of Okabe–Ito's colour-blind-safe eight (D77).
    const apart = withFills("#0072b2", "#d55e00");
    expect(part(apart, "colour").value).toBeGreaterThan(25);
    expect(part(apart, "colour").penalty).toBe(0);
  });

  it("gives the same answer twice, to the last decimal", () => {
    expect(craftScore(tangled)).toEqual(craftScore(tangled));
    expect(JSON.stringify(craftScore(snapshot))).toBe(JSON.stringify(craftScore(snapshot)));
  });

  it("rides along with the lint, as a finding and as the number", () => {
    const report = lint(snapshot);
    expect(report.score.score).toBe(craftScore(snapshot).score);
    const said = report.findings.find((f) => f.message.startsWith("craft score"))!;
    expect(said.level).toBe("info");
    expect(said.message).toContain(`craft score ${report.score.score} of 100`);
  });
});

describe("squared away (D98, D99)", () => {
  /** Two components in one row, and one arrow drawn between them. */
  const twoInARow = (id: string, points: readonly Point[], top = 0) =>
    snapshotFromRawElements([
      { ...base, id: "F", type: "frame", name: "Square", x: -80, y: -80, width: 800, height: 320, customData: { docent: { narrative: "A pair." } } },
      ...box("p", 0, top, "P"),
      ...box("q", 400, top, "Q"),
      drawn(id, "p", "q", points),
    ] as never);

  it("costs a drawn segment that runs on the slant, and nothing for the same picture squared", () => {
    // The same pair, joined once: on the slant, then along the axis (D98).
    const slanted = craftScore(twoInARow("slant", [[160, 72], [400, 8]]));
    const square = craftScore(twoInARow("square", [[160, 40], [400, 40]]));
    expect(part(slanted, "squareness").penalty).toBeGreaterThan(0);
    expect(part(slanted, "squareness").detail).toContain("oblique");
    expect(part(square, "squareness").penalty).toBe(0);
    expect(part(square, "squareness").detail).toBe("every line is square and every box is on the grid");
    expect(slanted.score).toBeLessThan(square.score);
  });

  it("costs a box off the grid, lightly, and names it", () => {
    // The same square picture, four units off the grid (D99).
    const onGrid = craftScore(twoInARow("square", [[160, 40], [400, 40]]));
    const off = craftScore(twoInARow("square", [[160, 44], [400, 44]], 4));
    expect(part(off, "squareness").penalty).toBeGreaterThan(0);
    expect(part(off, "squareness").detail).toContain("off the 8-grid");
    expect(off.score).toBeLessThan(onGrid.score);
    // Lightly: a diagonal costs more than drift does.
    expect(part(off, "squareness").penalty).toBeLessThan(part(craftScore(twoInARow("slant", [[160, 72], [400, 8]])), "squareness").penalty);
    // It is what the lint calls worst, in the part's new name.
    expect(off.perFrame[0].worst).toBe("squareness");
    const said = lint(twoInARow("square", [[160, 44], [400, 44]], 4)).findings.find((f) => f.message.startsWith("craft score"))!;
    expect(said.message).toContain("worst: squareness");
    expect(said.message).toContain("squareness costs");
  });
});

describe("the watchdog (D76)", () => {
  it(`scores an agent-built frame at least ${WATCHDOG}`, () => {
    // The D66 fixture: five components named in an order that would tangle
    // a sequential placer, laid out by the pipeline (D74) and routed (D75).
    const result = plan(
      [
        { op: "add_frame", ref: "$f", name: "Ritual", narrative: "One sitting, both markets." },
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
    const after = simulate(snapshot, result.write);
    const graph = buildSceneGraph(after);
    const score = craftScore(after, graph);
    const ritual = score.perFrame.find((f) => f.name === "Ritual")!;
    expect(ritual.score).toBeGreaterThanOrEqual(WATCHDOG);
    // Nothing crosses and nothing sits on top of anything in what it drew.
    expect(part(score, "crossings").value).toBe(0);
    expect(part(score, "overlaps").value).toBe(0);
  });
});
