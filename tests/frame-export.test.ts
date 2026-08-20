import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { exportFrameSidecar } from "../src/export/frame";

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

// Frame F holds two shapes and an arrow; the "worker" shape links a deeper
// detail frame G with its own contents. Exporting F must carry F's tier and
// nothing of G's — not even the pointer.
const scene = [
  { ...base, id: "F", type: "frame", name: "Core Services", x: 0, y: 0, width: 600, height: 400 },
  { ...base, id: "G", type: "frame", name: "Worker internals", x: 0, y: 30000, width: 600, height: 400 },
  {
    ...base,
    id: "api",
    type: "rectangle",
    x: 40,
    y: 60,
    width: 160,
    height: 80,
    frameId: "F",
    boundElements: [{ id: "api_label", type: "text" }],
  },
  // Bound label with frameId deliberately unset — it must ride with its
  // container anyway.
  { ...base, id: "api_label", type: "text", x: 60, y: 80, width: 120, height: 20, text: "API", containerId: "api" },
  {
    ...base,
    id: "worker",
    type: "rectangle",
    x: 340,
    y: 60,
    width: 160,
    height: 80,
    frameId: "F",
    customData: { docent: { detail: { frameId: "G" } } },
  },
  {
    ...base,
    id: "flow",
    type: "arrow",
    x: 205,
    y: 100,
    width: 130,
    height: 0,
    frameId: "F",
    points: [
      [0, 0],
      [130, 0],
    ],
    startBindingId: "api",
    endBindingId: "worker",
  },
  { ...base, id: "queue", type: "rectangle", x: 40, y: 30060, width: 160, height: 80, frameId: "G" },
  { ...base, id: "outside", type: "rectangle", x: 900, y: 60, width: 100, height: 100 },
];

describe("frame-scoped semantic export", () => {
  it("carries the frame's own tier: members, labels, edges, and the frame itself", () => {
    const { name, sidecar } = exportFrameSidecar(snapshotFromRawElements(scene), "F");
    const doc = JSON.parse(sidecar);
    expect(name).toBe("Core Services");
    const nodeIds = doc.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain("api");
    expect(nodeIds).toContain("worker");
    expect(doc.nodes.find((n: { id: string }) => n.id === "api")?.label).toBe("API");
    expect(doc.edges).toHaveLength(1);
    expect(doc.frames.map((f: { id: string }) => f.id)).toEqual(["F"]);
  });

  it("never copies the nested layer — no contents, no dangling pointer", () => {
    const { sidecar } = exportFrameSidecar(snapshotFromRawElements(scene), "F");
    expect(sidecar).not.toContain("queue");
    expect(sidecar).not.toContain("Worker internals");
    const worker = JSON.parse(sidecar).nodes.find(
      (n: { id: string }) => n.id === "worker",
    );
    expect(worker.detail).toBeUndefined();
  });

  it("leaves elements outside the frame behind", () => {
    const { sidecar } = exportFrameSidecar(snapshotFromRawElements(scene), "F");
    expect(sidecar).not.toContain("outside");
  });

  it("refuses anything that is not a frame", () => {
    const snapshot = snapshotFromRawElements(scene);
    expect(() => exportFrameSidecar(snapshot, "api")).toThrow(/only a frame/);
    expect(() => exportFrameSidecar(snapshot, "missing")).toThrow(/only a frame/);
  });

  it("is deterministic", () => {
    const snapshot = snapshotFromRawElements(scene);
    expect(exportFrameSidecar(snapshot, "F").sidecar).toBe(
      exportFrameSidecar(snapshot, "F").sidecar,
    );
  });
});
