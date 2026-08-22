/**
 * Intents and logic (D41, D42): several declared intents per element with
 * file compatibility by construction, and free-form logic — through the
 * snapshot, the graph, and the sidecar.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { exportSidecar } from "../src/export/sidecar";
import { parseIntents } from "../src/shell/IntentPanel";

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

const rect = (id: string, x: number, docent: Record<string, unknown>) => ({
  ...base,
  id,
  type: "rectangle",
  x,
  y: 0,
  width: 100,
  height: 60,
  customData: { docent },
});

describe("intents (D41)", () => {
  it("a lone note reads as the one-item intent list, and stays a note", () => {
    const snapshot = snapshotFromRawElements([rect("a", 0, { note: "rate-limited" })]);
    expect(snapshot.elements[0].docent.intents).toEqual(["rate-limited"]);
    expect(snapshot.elements[0].docent.note).toBe("rate-limited");
    const sidecar = JSON.parse(exportSidecar(buildSceneGraph(snapshot)));
    expect(sidecar.nodes[0].note).toBe("rate-limited");
    expect(sidecar.nodes[0].intents).toBeUndefined();
  });

  it("several intents ride as a list beside the note, declared", () => {
    const snapshot = snapshotFromRawElements([
      rect("a", 0, { note: "carries orders", intents: ["carries orders", "retries on failure"] }),
    ]);
    const node = buildSceneGraph(snapshot).nodes[0];
    expect(node.intents).toEqual(["carries orders", "retries on failure"]);
    expect(node.note).toBe("carries orders");
    const sidecar = JSON.parse(exportSidecar(buildSceneGraph(snapshot)));
    expect(sidecar.nodes[0].intents).toEqual(["carries orders", "retries on failure"]);
    expect(sidecar.nodes[0].provenance.intents).toBe("declared");
  });

  it("an arrow carries intents and logic like a node", () => {
    const snapshot = snapshotFromRawElements([
      rect("a", 0, {}),
      rect("b", 300, {}),
      {
        ...base,
        id: "e",
        type: "arrow",
        x: 105,
        y: 30,
        width: 190,
        height: 0,
        points: [
          [0, 0],
          [190, 0],
        ],
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
        customData: { docent: { intents: ["order placed", "payment captured"], logic: "retry ≤3" } },
      },
    ]);
    const sidecar = JSON.parse(exportSidecar(buildSceneGraph(snapshot)));
    const edge = sidecar.edges.find((e: { id: string }) => e.id === "e");
    expect(edge.note).toBe("order placed");
    expect(edge.intents).toEqual(["order placed", "payment captured"]);
    expect(edge.logic).toBe("retry ≤3");
    expect(edge.provenance.logic).toBe("declared");
  });

  it("the panel's one-per-line field drops blank lines", () => {
    expect(parseIntents("a\n\n  b  \n")).toEqual(["a", "b"]);
  });
});

describe("logic (D42)", () => {
  it("is exported as declared text and otherwise absent", () => {
    const withLogic = snapshotFromRawElements([rect("a", 0, { logic: "if x: y" })]);
    const without = snapshotFromRawElements([rect("a", 0, {})]);
    const a = JSON.parse(exportSidecar(buildSceneGraph(withLogic))).nodes[0];
    const b = JSON.parse(exportSidecar(buildSceneGraph(without))).nodes[0];
    expect(a.logic).toBe("if x: y");
    expect(a.provenance.logic).toBe("declared");
    expect(b.logic).toBeUndefined();
  });
});
