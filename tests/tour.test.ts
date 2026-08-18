import { describe, expect, it, vi } from "vitest";
import { CommandAPI, type SceneReader } from "../src/command/api";
import type { CameraEngine } from "../src/camera/engine";
import { OverlayStore } from "../src/overlay/state";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const demoSnapshot = snapshotFromSceneJSON(
  readFileSync(join(FIXTURES, "demo.excalidraw"), "utf8"),
);

function makeReader(): SceneReader {
  const byId = new Map(demoSnapshot.elements.map((el) => [el.id, el]));
  return {
    getSceneSnapshot: () => demoSnapshot,
    getElementInfo: (id) => {
      const el = byId.get(id);
      return el
        ? ({
            id: el.id,
            type: el.type,
            label: null,
            bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
            angle: 0,
            frameId: el.frameId,
            groupIds: [],
        detailFrameId: null,
            tags: [],
            note: null,
            narrative: null,
            order: null,
            style: {
              strokeColor: "",
              backgroundColor: "",
              strokeStyle: "solid",
              fillStyle: "solid",
              strokeWidth: 2,
            },
          } as ReturnType<SceneReader["getElementInfo"]>)
        : null;
    },
    getFrameInfo: (id) => {
      const el = byId.get(id);
      return el && el.type === "frame"
        ? {
            id: el.id,
            name: el.name ?? "",
            order: null,
            narrative: el.docent.narrative,
            bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
          }
        : null;
    },
    getFrames: () => [],
    getSceneBounds: () => null,
    getEdgeGeometry: () => null,
    getViewport: () => ({ scrollX: 0, scrollY: 0, zoom: 1 }),
    getViewportSize: () => ({ width: 800, height: 600 }),
    onViewportChange: () => () => {},
  };
}

describe("tour (S8/S9, D10)", () => {
  it("narrates frame-focus steps from declared narratives and clears at the end", async () => {
    const narrations: (string | null)[] = [];
    const store = new OverlayStore();
    const api = new CommandAPI(
      makeReader(),
      { flyTo: vi.fn().mockResolvedValue(true), stop: vi.fn() } as unknown as CameraEngine,
      store,
      { narrate: (t) => narrations.push(t) },
    );
    const completed = await api.tour({
      steps: [
        { focus: "f_ingress" },
        { focus: "n_gateway", highlight: ["n_gateway"], narrate: "The edge." },
      ],
      stepMs: 10,
    });
    expect(completed).toBe(2);
    // Frame narrative narrated the first step (author's words, D10).
    expect(narrations[0]).toMatch(/external traffic lands here/i);
    expect(narrations[1]).toBe("The edge.");
    // Tour end clears narration and effects.
    expect(narrations[narrations.length - 1]).toBeNull();
    expect(store.get().highlight).toBeNull();
  });

  it("stopTour interrupts and clears immediately", async () => {
    const narrations: (string | null)[] = [];
    const store = new OverlayStore();
    const api = new CommandAPI(
      makeReader(),
      { flyTo: vi.fn().mockResolvedValue(true), stop: vi.fn() } as unknown as CameraEngine,
      store,
      { narrate: (t) => narrations.push(t) },
    );
    const run = api.tour({
      steps: [{ focus: "f_ingress" }, { focus: "f_core" }, { focus: "f_gw_detail" }],
      stepMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 50));
    api.stopTour();
    const completed = await run;
    expect(completed).toBeLessThan(3);
    expect(narrations[narrations.length - 1]).toBeNull();
    expect(store.get().highlight).toBeNull();
  });
});
