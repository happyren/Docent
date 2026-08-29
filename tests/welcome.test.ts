/**
 * The welcome scene (D126): the first thing a new person ever sees, so it
 * is held to the grammar it teaches — an explainer with a live scenario, a
 * detail layer to dive, narrated frames, and nothing for its own lint to
 * complain about. A refactor that breaks the greeting fails here, not on a
 * stranger's first launch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { lint } from "../src/authoring/ops";

const sceneJSON = readFileSync(path.resolve("public/samples/welcome.excalidraw"), "utf8");
const snapshot = snapshotFromSceneJSON(sceneJSON);
const graph = buildSceneGraph(snapshot);

describe("the welcome scene (D126)", () => {
  it("is an explainer with a scenario whose every step is alive", () => {
    expect(graph.genre).toBe("explainer");
    expect(graph.scenarios.length).toBeGreaterThanOrEqual(1);
    const edges = new Set(graph.edges.map((e) => e.sourceId));
    for (const scenario of graph.scenarios) {
      expect(scenario.path.length).toBeGreaterThanOrEqual(3);
      for (const step of scenario.path) expect(edges.has(step), `${scenario.name}: ${step}`).toBe(true);
    }
  });

  it("teaches dive with a real detail layer, and narrates every frame", () => {
    expect(graph.frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of graph.frames) {
      expect((frame.narrative ?? "").length, frame.name ?? frame.id).toBeGreaterThan(20);
    }
    expect(graph.nodes.some((n) => n.detailFrameId)).toBe(true);
  });

  it("keeps its own grammar quiet — the greeting must not scold", () => {
    const said = lint(snapshot).findings.filter((f) => /^Explainer:/.test(f.message));
    expect(said.map((f) => f.message)).toEqual([]);
  });
});
