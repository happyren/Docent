/**
 * Tidy is a formatter (S20, D73). Two things are on trial here: that a
 * scope compiles to the right `layout` ops in the author's own order, and
 * the promise the whole command rests on — a tidy changes the picture and
 * nothing else, so its semantic changelog (D46, geometry aside) is empty
 * on every fixture, hand-drawn, agent-built, or tangled.
 */
import { describe, expect, it, vi } from "vitest";
import { snapshotFromRawElements, type SceneSnapshot } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { describeChange, describeMeaningChange } from "../src/scene/diff";
import { countCrossings } from "../src/authoring/layout";
import { idSource, plan, simulate, type Op } from "../src/authoring/ops";
import { tidyOps, tidyTargets, type TidyScope } from "../src/authoring/tidy";
import { CommandAPI, type SceneReader, type SceneWriter } from "../src/command/api";
import { execute, type AgentShellHooks } from "../src/agent/execute";
import type { CameraEngine } from "../src/camera/engine";
import { OverlayStore } from "../src/overlay/state";

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

/** The hand-drawn fixture the authoring suite uses: a frame, a legend, a flow. */
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
const handDrawn = snapshotFromRawElements(raw as never);

/** The same scene with a component placed so two arrows cross. */
const tangled = snapshotFromRawElements([
  ...raw,
  ...box("left", 40, 300, "Left"),
  arrow("e3", "orders", "left"),
  arrow("e4", "gateway", "db"),
] as never);

/**
 * A frame an agent built in one batch (D66), then applied — the shape of
 * scene the formatter meets most often.
 */
function agentBuilt(): SceneSnapshot {
  const built = plan(
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
    handDrawn,
    idSource(11),
  );
  return simulate(handDrawn, built.write);
}

/** Run a tidy on paper: the ops, planned and simulated, never applied. */
function tidied(snapshot: SceneSnapshot, scope: TidyScope, seed = 5): SceneSnapshot {
  const ops = tidyOps(snapshot, scope);
  expect(ops.length).toBeGreaterThan(0);
  return simulate(snapshot, plan(ops, snapshot, idSource(seed)).write);
}

/** Crossings inside one frame — the measure D66 and D74 are judged on. */
function crossingsIn(snapshot: SceneSnapshot, frameId: string | null): number {
  const graph = buildSceneGraph(snapshot);
  const nodes = graph.nodes.filter((n) => n.frameId === frameId);
  const ids = new Set(nodes.map((n) => n.id));
  return countCrossings(nodes, graph.edges.filter((e) => e.from && e.to && ids.has(e.from) && ids.has(e.to)));
}

const positions = (snapshot: SceneSnapshot) =>
  new Map(buildSceneGraph(snapshot).nodes.map((n) => [n.id, `${n.bounds.x},${n.bounds.y}`]));

describe("the guarantee (D73): a tidy changes nothing but the picture", () => {
  it("leaves a hand-drawn frame's meaning exactly where it was", () => {
    const after = tidied(handDrawn, { frame: "F" });
    const { diff, changelog } = describeMeaningChange(handDrawn, after);
    expect(changelog).toBe("");
    expect(diff.empty).toBe(true);
  });

  it("leaves an agent-built frame's meaning alone, narrative, intents and all", () => {
    const before = agentBuilt();
    const ritual = buildSceneGraph(before).frames.find((f) => f.name === "Ritual")!;
    const after = tidied(before, { frame: ritual.id }, 13);
    expect(describeMeaningChange(before, after).changelog).toBe("");
  });

  it("unpicks a tangle: components move, crossings do not grow, meaning holds", () => {
    const before = tangled;
    expect(crossingsIn(before, "F")).toBeGreaterThan(0);
    const after = tidied(before, { frame: "F" }, 17);
    expect(describeMeaningChange(before, after).changelog).toBe("");
    // Something moved — otherwise the formatter formatted nothing …
    const was = positions(before);
    const now = positions(after);
    expect([...now.entries()].some(([id, at]) => was.get(id) !== at)).toBe(true);
    // … and the tangle is no worse for it.
    expect(crossingsIn(after, "F")).toBeLessThanOrEqual(crossingsIn(before, "F"));
  });

  it("tidies the whole diagram, every region, with meaning intact", () => {
    const before = agentBuilt();
    const after = tidied(before, { all: true }, 23);
    expect(describeMeaningChange(before, after).changelog).toBe("");
  });

  it("is a picture change, not no change at all — the full changelog says 'moved'", () => {
    // What the guarantee excludes, said out loud: the raw diff DOES report
    // geometry, and that is the only thing a tidy is allowed to report.
    const after = tidied(tangled, { frame: "F" }, 17);
    const { diff, changelog } = describeChange(tangled, after);
    expect(changelog).not.toBe("");
    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    for (const entry of diff.nodes.changed) {
      for (const change of entry.changes) expect(["moved", "resized"]).toContain(change.kind);
    }
    expect(diff.edges.changed).toEqual([]);
    expect(diff.frames.changed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scopes
// ---------------------------------------------------------------------------

/** Two Layer-1 frames in declared order, a detail tier, and a loose component. */
const multi = snapshotFromRawElements([
  { ...base, id: "fb", type: "frame", name: "01 Beta", x: 0, y: 0, width: 400, height: 300, customData: { docent: { order: 2 } } },
  { ...base, id: "fa", type: "frame", name: "02 Alpha", x: 500, y: 0, width: 400, height: 300, customData: { docent: { order: 1 } } },
  { ...base, id: "fd", type: "frame", name: "Alpha internals", x: 0, y: 30000, width: 400, height: 300 },
  { ...base, id: "b1", type: "rectangle", x: 40, y: 60, width: 160, height: 80, frameId: "fb" },
  { ...base, id: "a1", type: "rectangle", x: 540, y: 60, width: 160, height: 80, frameId: "fa", customData: { docent: { detail: { frameId: "fd" } } } },
  { ...base, id: "d1", type: "rectangle", x: 40, y: 30060, width: 160, height: 80, frameId: "fd" },
  { ...base, id: "loose", type: "rectangle", x: 0, y: 500, width: 160, height: 80 },
] as never);

const frames = (ops: Op[]) => ops.map((op) => (op.op === "layout" ? op.frame : op.op));

describe("what a scope names (D73)", () => {
  it("a frame is that frame, by graph id or by the element id under it", () => {
    expect(frames(tidyOps(multi, { frame: "fa" }))).toEqual(["fa"]);
    expect(frames(tidyOps(multi, { frame: null }))).toEqual([null]);
  });

  it("a tier is its frames in the author's order, and Layer 1 keeps its loose components", () => {
    // Declared order wins over the name: '02 Alpha' is order 1.
    expect(frames(tidyOps(multi, { tier: 1 }))).toEqual(["fa", "fb", null]);
    expect(frames(tidyOps(multi, { tier: 2 }))).toEqual(["fd"]);
  });

  it("everything is every tier, shallowest first, the unframed last", () => {
    expect(frames(tidyOps(multi, { all: true }))).toEqual(["fa", "fb", "fd", null]);
  });

  it("a selection is the distinct frames its elements live in", () => {
    expect(frames(tidyOps(multi, { selection: ["a1"] }))).toEqual(["fa"]);
    expect(frames(tidyOps(multi, { selection: ["loose", "b1", "b1"] }))).toEqual(["fb", null]);
    // A frame selected outright is itself; a detail frame is reachable too.
    expect(frames(tidyOps(multi, { selection: ["fd", "a1"] }))).toEqual(["fa", "fd"]);
    expect(frames(tidyOps(multi, { selection: ["nobody"] }))).toEqual([]);
  });

  it("counts what it would re-flow, and drops the regions holding nothing", () => {
    const all = tidyTargets(multi, { all: true });
    expect(all.frames).toBe(3);
    expect(all.components).toBe(4);
    // An empty frame is not a region worth an op.
    const empty = snapshotFromRawElements([
      { ...base, id: "fe", type: "frame", name: "Empty", x: 0, y: 0, width: 200, height: 200 },
    ] as never);
    expect(tidyOps(empty, { all: true })).toEqual([]);
  });

  it("is deterministic: the same scene and scope give the same ops", () => {
    expect(tidyOps(multi, { all: true })).toEqual(tidyOps(multi, { all: true }));
  });
});

// ---------------------------------------------------------------------------
// the tool, and the Command API under it
// ---------------------------------------------------------------------------

/**
 * A canvas that really applies writes, so undo has something to put back.
 * `sabotage` stands in for a canvas that does something other than what the
 * write said — the case the guarantee exists to catch.
 */
function makeCanvas(initial: SceneSnapshot, sabotage?: (after: SceneSnapshot) => SceneSnapshot) {
  let current = initial;
  const reader: SceneReader = {
    getSceneSnapshot: () => current,
    getElementInfo: () => null,
    getFrameInfo: () => null,
    getFrames: () => [],
    getSceneBounds: () => null,
    getEdgeGeometry: () => null,
    getViewport: () => ({ scrollX: 0, scrollY: 0, zoom: 1 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    onViewportChange: () => () => {},
  };
  const reports: string[] = [];
  const working: boolean[] = [];
  const writer: SceneWriter = {
    applyWrite: (write) => {
      const next = simulate(current, write);
      current = sabotage ? sabotage(next) : next;
    },
    captureScene: () => current,
    restoreScene: (captured) => {
      current = captured as SceneSnapshot;
    },
    canEdit: () => true,
    working: (on) => working.push(on),
    report: (line) => reports.push(line),
  };
  const camera = { flyTo: vi.fn().mockResolvedValue(true) } as unknown as CameraEngine;
  const api = new CommandAPI(reader, camera, new OverlayStore(), { narrate: () => {} }, writer);
  return { api, reports, working, snapshot: () => current };
}

describe("the tidy tool (D73)", () => {
  const shell = {} as AgentShellHooks;
  const fake = (scopes: TidyScope[]) =>
    ({
      tidy: async (scope: TidyScope) => {
        scopes.push(scope);
        return { tidied: { frames: 1, components: 3 }, next: "…" };
      },
    }) as unknown as CommandAPI;

  it("passes exactly one scope through to the Command API", async () => {
    const scopes: TidyScope[] = [];
    const answer = (await execute(fake(scopes), shell, "tidy", { frame: "f_core" })) as { tidied: unknown };
    expect(answer.tidied).toEqual({ frames: 1, components: 3 });
    await execute(fake(scopes), shell, "tidy", { frame: null });
    await execute(fake(scopes), shell, "tidy", { tier: 2 });
    await execute(fake(scopes), shell, "tidy", { all: true });
    await execute(fake(scopes), shell, "tidy", { selection: ["n_a"] });
    expect(scopes).toEqual([{ frame: "f_core" }, { frame: null }, { tier: 2 }, { all: true }, { selection: ["n_a"] }]);
  });

  it("refuses a call that names none or two — a scope must be unambiguous", async () => {
    await expect(execute(fake([]), shell, "tidy", {})).rejects.toThrow(/exactly one/);
    await expect(execute(fake([]), shell, "tidy", { tier: 1, all: true })).rejects.toThrow(/exactly one/);
    await expect(execute(fake([]), shell, "tidy", { all: false })).rejects.toThrow(/all:true/);
    await expect(execute(fake([]), shell, "tidy", { selection: [] })).rejects.toThrow(/non-empty/);
  });
});

describe("CommandAPI.tidy (D73)", () => {
  it("lands as one undo step, reports what it tidied, and undoes back to the pixel", async () => {
    const canvas = makeCanvas(tangled);
    const before = canvas.snapshot();
    const result = await canvas.api.tidy({ frame: "F" });
    expect(result.tidied).toEqual({ frames: 1, components: 4 });
    expect(result.next).toContain("changelog");
    expect(canvas.reports).toEqual(["Tidied 4 components"]);
    expect(canvas.working[0]).toBe(true);
    expect(positions(canvas.snapshot())).not.toEqual(positions(before));
    // One step: one undo puts the scene back exactly as it was.
    expect(canvas.api.undoAgentEdit()).toBe(true);
    expect(canvas.snapshot()).toBe(before);
    expect(canvas.api.undoAgentEdit()).toBe(false);
  });

  it("answers an empty scope without touching the canvas", async () => {
    const canvas = makeCanvas(handDrawn);
    const before = canvas.snapshot();
    const result = await canvas.api.tidy({ tier: 4 });
    expect(result.tidied).toEqual({ frames: 0, components: 0 });
    expect(canvas.snapshot()).toBe(before);
    expect(canvas.reports).toEqual([]);
  });

  it("puts the scene back and says so if a tidy ever changed meaning", async () => {
    // A canvas that loses a component while laying out is what the promise
    // exists to catch — whatever the cause, such a tidy must not land.
    const canvas = makeCanvas(tangled, (after) => ({
      ...after,
      elements: after.elements.filter((el) => el.id !== "left" && el.id !== "left_t"),
    }));
    const before = canvas.snapshot();
    await expect(canvas.api.tidy({ frame: "F" })).rejects.toThrow(/changed the diagram's meaning/);
    expect(canvas.snapshot()).toBe(before);
    // Nothing landed, so there is nothing on the undo stack either.
    expect(canvas.api.undoAgentEdit()).toBe(false);
    expect(canvas.reports).toEqual([]);
  });
});
