import { describe, expect, it, vi } from "vitest";
import type { EdgeGeometry } from "../src/adapter";
import { CommandAPI, type SceneReader } from "../src/command/api";
import { OverlayStore } from "../src/overlay/state";
import type { CameraEngine } from "../src/camera/engine";
import { edgePath, shapePath } from "../src/overlay/geometry";
import { mergeOverlapping, spotlightHoles } from "../src/overlay/OverlayLayer";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const demoJSON = readFileSync(join(FIXTURES, "demo.excalidraw"), "utf8");
const demoSnapshot = snapshotFromSceneJSON(demoJSON);

/**
 * Mock reader over the demo fixture. This object has ONLY read methods —
 * `SceneReader` contains no write surface, which is how I2 holds for every
 * command by construction.
 */
function makeReader(): SceneReader {
  const byId = new Map(demoSnapshot.elements.map((el) => [el.id, el]));
  return {
    getSceneSnapshot: () => demoSnapshot,
    getElementInfo: (id) => {
      const el = byId.get(id);
      if (!el) return null;
      return {
        id: el.id,
        type: el.type,
        label: null,
        bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
        angle: el.angle,
        frameId: el.frameId,
        groupIds: [],
        detailFrameId: null,
        tags: [],
        note: null,
        intents: [],
        logic: null,
        narrative: null,
        order: null,
        style: {
          strokeColor: el.strokeColor,
          backgroundColor: el.backgroundColor,
          strokeStyle: el.strokeStyle,
          fillStyle: el.fillStyle,
          strokeWidth: el.strokeWidth,
        },
      };
    },
    getFrameInfo: (id) => {
      const el = byId.get(id);
      if (!el || el.type !== "frame") return null;
      return {
        id: el.id,
        name: el.name ?? "",
        order: null,
        narrative: null,
        bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
      };
    },
    getFrames: () => [],
    getSceneBounds: () => null,
    getEdgeGeometry: (id) => {
      const el = byId.get(id);
      if (!el || el.type !== "arrow" || !el.points) return null;
      return {
        points: el.points,
        x: el.x,
        y: el.y,
        rounded: false,
        elbowed: false,
      };
    },
    getViewport: () => ({ scrollX: 0, scrollY: 0, zoom: 1 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    onViewportChange: () => () => {},
  };
}

function makeCamera() {
  return { flyTo: vi.fn().mockResolvedValue(true) } as unknown as CameraEngine;
}

// A grouped "library icon" scene: r_icon (a node) and l_icon (a line — NOT
// a graph node type) share one group, the shape library import pattern.
const ICON_ELEMENT_BASE = {
  angle: 0,
  strokeColor: "#000000",
  backgroundColor: "transparent",
  strokeStyle: "solid",
  fillStyle: "solid",
  strokeWidth: 1,
  frameId: null,
  isDeleted: false,
};
const iconSceneJSON = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [
    { ...ICON_ELEMENT_BASE, id: "r_icon", type: "rectangle", x: 0, y: 0, width: 60, height: 60, groupIds: ["g_icon"] },
    { ...ICON_ELEMENT_BASE, id: "l_icon", type: "line", x: 10, y: 10, width: 40, height: 40, groupIds: ["g_icon"], points: [[0, 0], [40, 40]] },
    { ...ICON_ELEMENT_BASE, id: "r_plain", type: "rectangle", x: 200, y: 0, width: 80, height: 40, groupIds: [] },
  ],
});
const iconSnapshot = snapshotFromSceneJSON(iconSceneJSON);

function makeIconReader(): SceneReader {
  const byId = new Map(iconSnapshot.elements.map((el) => [el.id, el]));
  const base = makeReader();
  return {
    ...base,
    getSceneSnapshot: () => iconSnapshot,
    getElementInfo: (id) => {
      const el = byId.get(id);
      if (!el) return null;
      return {
        id: el.id,
        type: el.type,
        label: null,
        bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
        angle: el.angle,
        frameId: el.frameId,
        groupIds: el.groupIds,
        detailFrameId: null,
        tags: [],
        note: null,
        intents: [],
        logic: null,
        narrative: null,
        order: null,
        style: {
          strokeColor: el.strokeColor,
          backgroundColor: el.backgroundColor,
          strokeStyle: el.strokeStyle,
          fillStyle: el.fillStyle,
          strokeWidth: el.strokeWidth,
        },
      };
    },
    getFrameInfo: () => null,
    getEdgeGeometry: (id) => {
      const el = byId.get(id);
      if (!el || !el.points || (el.type !== "arrow" && el.type !== "line")) {
        return null;
      }
      return { points: el.points, x: el.x, y: el.y, rounded: false, elbowed: false };
    },
  };
}

describe("command API (B4, I5)", () => {
  it("errors loudly on unknown ids — never silently no-ops", async () => {
    const api = new CommandAPI(makeReader(), makeCamera(), new OverlayStore());
    await expect(api.focus({ id: "nope" })).rejects.toThrow(/Unknown/);
    expect(() => api.highlight({ ids: ["nope"] })).toThrow(/Unknown/);
    await expect(api.flow({ path: ["nope"] })).rejects.toThrow(/Unknown/);
  });

  it("rejects flow over non-edges", async () => {
    const api = new CommandAPI(makeReader(), makeCamera(), new OverlayStore());
    await expect(api.flow({ path: ["n_client"] })).rejects.toThrow(/Unknown edge/);
  });

  it("accepts graph ids and drives the camera for focus", async () => {
    const camera = makeCamera();
    const api = new CommandAPI(makeReader(), camera, new OverlayStore());
    await api.focus({ id: "f_ingress" });
    expect(camera.flyTo).toHaveBeenCalledOnce();
  });

  it("effects land on raw elements the graph doesn't model (library icons)", async () => {
    const store = new OverlayStore();
    const camera = makeCamera();
    const api = new CommandAPI(makeIconReader(), camera, store);
    // A line inside a grouped icon is no graph node — raw id still glows.
    api.highlight({ ids: ["l_icon"], style: "glow" });
    expect(store.get().highlight?.ids).toContain("l_icon");
    // ...focuses...
    await api.focus({ id: "l_icon" });
    expect(camera.flyTo).toHaveBeenCalled();
    // ...and pulses as a flow segment.
    await api.flow({ path: ["l_icon"], speed: 1000 });
    expect(store.get().flow?.path).toContain("l_icon");
    // Unknown ids stay loud (I5).
    expect(() => api.highlight({ ids: ["ghost"] })).toThrow(/Unknown/);
  });

  it("group ids expand to their member elements", () => {
    const store = new OverlayStore();
    const api = new CommandAPI(makeIconReader(), makeCamera(), store);
    api.highlight({ ids: ["g_icon"], style: "spotlight" });
    // The group's graph-node member resolves; the highlight is non-empty.
    expect(store.get().highlight?.ids.length).toBeGreaterThan(0);
  });

  it("a group lights as one target, not one per stroke (D39)", () => {
    const store = new OverlayStore();
    const api = new CommandAPI(makeIconReader(), makeCamera(), store);
    api.highlight({ ids: ["g_icon"], style: "glow" });
    const highlight = store.get().highlight!;
    // Every member is lit, but the renderer is handed targets: each target
    // with several members becomes ONE glow path / ONE hole.
    expect(highlight.ids.length).toBeGreaterThan(0);
    expect(highlight.targets.flat().sort()).toEqual(highlight.ids);
    for (const target of highlight.targets) expect(target.length).toBeGreaterThan(0);
  });

  it("overlapping boxes merge into one enclosing box", () => {
    const merged = mergeOverlapping([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 50, y: 50, width: 100, height: 100 },
      { x: 500, y: 500, width: 10, height: 10 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("spotlight holes never overlap — evenodd would re-darken the overlap", () => {
    const box = (id: string, x: number, y: number, w: number, h: number) => ({
      id,
      d: shapePath("rectangle", { x, y, width: w, height: h }, 0),
      isEdge: false,
      bounds: { x, y, width: w, height: h },
      angle: 0,
    });
    // Two strokes of one icon, overlapping: one hole, not two cancelling ones.
    const holes = spotlightHoles([box("a", 0, 0, 100, 100), box("b", 40, 40, 100, 100)]);
    expect((holes.match(/M/g) ?? []).length).toBe(1);
    // Two far-apart plain shapes: two holes, each its own outline.
    const apart = spotlightHoles([box("a", 0, 0, 100, 100), box("b", 900, 900, 100, 100)]);
    expect((apart.match(/M/g) ?? []).length).toBe(2);
  });

  it("highlight is idempotent and clearable (S6)", () => {
    const store = new OverlayStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const api = new CommandAPI(makeReader(), makeCamera(), store);
    api.highlight({ ids: ["n_gateway", "n_db"], style: "glow" });
    const callsAfterFirst = listener.mock.calls.length;
    api.highlight({ ids: ["n_db", "n_gateway"], style: "glow" });
    expect(listener.mock.calls.length).toBe(callsAfterFirst); // no-op
    api.highlight({ ids: [] });
    expect(store.get().highlight).toBeNull();
  });

  it("flow resolves edges and stores the ordered path", async () => {
    const store = new OverlayStore();
    const api = new CommandAPI(makeReader(), makeCamera(), store);
    const done = api.flow({ path: ["e_req", "e_verify"], speed: 100 });
    expect(store.get().flow?.path).toEqual(["e_req", "e_verify"]);
    await done;
  });

  it("a scenario replay numbers its steps on the edge middles (D89)", async () => {
    const store = new OverlayStore();
    const api = new CommandAPI(makeReader(), makeCamera(), store);
    await api.flow({ path: ["e_req", "e_verify"], speed: 1000, steps: true });
    // Half the arc length along each edge's absolute polyline.
    expect(store.get().steps).toEqual([
      { x: 280, y: 175, n: 1 },
      { x: 610, y: 175, n: 2 },
    ]);
    // A plain pulse raises none: the numbers belong to a named story.
    await api.flow({ path: ["e_query"], speed: 1000 });
    expect(store.get().steps).toEqual([]);
  });

  it("step badges walk the polyline, not the bounding box", async () => {
    const store = new OverlayStore();
    const bent: SceneReader = {
      ...makeReader(),
      getEdgeGeometry: (id) =>
        id === "bend"
          ? { points: [[0, 0], [100, 0], [100, 100]], x: 0, y: 0, rounded: false, elbowed: true }
          : null,
    };
    const api = new CommandAPI(bent, makeCamera(), store);
    await api.flow({ path: ["bend"], speed: 1000, steps: true });
    // 200 units of stroke: the middle is the corner, not the box centre.
    expect(store.get().steps).toEqual([{ x: 100, y: 0, n: 1 }]);
  });

  it("the badges go when the flow they belong to goes (I2)", async () => {
    const store = new OverlayStore();
    const api = new CommandAPI(makeReader(), makeCamera(), store);
    await api.flow({ path: ["e_req"], speed: 1000, steps: true });
    expect(store.get().steps).toHaveLength(1);
    api.clearEffects();
    expect(store.get().steps).toEqual([]);
    expect(store.get().flow).toBeNull();
    // Clearing the flow with an empty path takes them too — no stale "1".
    await api.flow({ path: ["e_req"], speed: 1000, steps: true });
    await api.flow({ path: [] });
    expect(store.get().steps).toEqual([]);
  });

  it("scene content is untouched by any command sequence (I2/Q3)", async () => {
    const reader = makeReader();
    const before = JSON.stringify(reader.getSceneSnapshot());
    const api = new CommandAPI(reader, makeCamera(), new OverlayStore());
    api.highlight({ ids: ["n_gateway"], style: "spotlight" });
    await api.flow({ path: ["e_req"], speed: 1000 });
    await api.focus({ id: "n_db" });
    api.clearEffects();
    expect(JSON.stringify(reader.getSceneSnapshot())).toBe(before);
  });
});

describe("overlay geometry (D4)", () => {
  const straight: EdgeGeometry = {
    points: [
      [0, 0],
      [100, 0],
    ],
    x: 10,
    y: 20,
    rounded: false,
    elbowed: false,
  };

  it("renders 2-point arrows as a line in absolute scene coords", () => {
    expect(edgePath(straight)).toBe("M10 20 L110 20");
  });

  it("renders rounded multi-point arrows as cubic curves", () => {
    const curved: EdgeGeometry = {
      ...straight,
      points: [
        [0, 0],
        [60, 60],
        [0, 120],
      ],
      rounded: true,
    };
    const d = edgePath(curved);
    expect(d.startsWith("M10 20")).toBe(true);
    expect(d).toContain("C");
  });

  it("renders elbow routes as polylines with rounded corners", () => {
    const elbow: EdgeGeometry = {
      ...straight,
      points: [
        [0, 0],
        [100, 0],
        [100, 80],
      ],
      elbowed: true,
    };
    const d = edgePath(elbow);
    expect(d).toContain("Q"); // corner arc at the bend
    expect(d).not.toContain("C");
  });

  it("shape outlines close and respect padding", () => {
    const d = shapePath("diamond", { x: 0, y: 0, width: 100, height: 60 }, 5);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("M50 -5");
  });
});

describe("status marks are namespaced by author (D150)", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 50 };
  const mark = (by: string, id: string, state: "ok" | "fail" | "warn" | "note") => ({
    id,
    by,
    state,
    corner: "top-left" as const,
    bounds,
  });

  it("replaces one author's set and leaves the others standing", () => {
    const store = new OverlayStore();
    store.setStatusMarks("aws-health", [mark("aws-health", "n_api", "ok"), mark("aws-health", "n_db", "fail")]);
    store.setStatusMarks("ci", [mark("ci", "n_api", "warn")]);
    expect(store.get().statusMarks.map((m) => `${m.by}:${m.id}:${m.state}`).sort()).toEqual([
      "aws-health:n_api:ok",
      "aws-health:n_db:fail",
      "ci:n_api:warn",
    ]);
    // A new set from one author is that author's whole word.
    store.setStatusMarks("aws-health", [mark("aws-health", "n_db", "ok")]);
    expect(store.get().statusMarks.map((m) => `${m.by}:${m.id}:${m.state}`).sort()).toEqual([
      "aws-health:n_db:ok",
      "ci:n_api:warn",
    ]);
  });

  it("clears one author or every author, and the same set is a no-op", () => {
    const store = new OverlayStore();
    let emits = 0;
    store.subscribe(() => {
      emits += 1;
    });
    const base = emits;
    store.setStatusMarks("a", [mark("a", "n1", "ok")]);
    store.setStatusMarks("a", [mark("a", "n1", "ok")]);
    expect(emits - base).toBe(1);
    store.setStatusMarks("b", [mark("b", "n2", "note")]);
    store.clearStatusMarks("a");
    expect(store.get().statusMarks.map((m) => m.by)).toEqual(["b"]);
    store.clearStatusMarks();
    expect(store.get().statusMarks).toEqual([]);
    // clear() takes the marks with everything else (I2: effects are ephemeral).
    store.setStatusMarks("a", [mark("a", "n1", "fail")]);
    store.clear();
    expect(store.get().statusMarks).toEqual([]);
  });
});
