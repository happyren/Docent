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

  it("a step that shows without focusing frames what it shows (D37)", async () => {
    const flyTo = vi.fn().mockResolvedValue(true);
    // Zoomed far out: the gateway is in view but microscopic, which is
    // exactly the failure content-aware touring exists to catch.
    const reader = makeReader();
    reader.getViewport = () => ({ scrollX: 20000, scrollY: 20000, zoom: 0.01 });
    const api = new CommandAPI(
      reader,
      { flyTo, stop: vi.fn() } as unknown as CameraEngine,
      new OverlayStore(),
      { narrate: () => {} },
    );
    await api.tour({
      steps: [{ highlight: ["n_gateway"], narrate: "The edge." }],
      stepMs: 10,
    });
    expect(flyTo).toHaveBeenCalledTimes(1);
    const gateway = demoSnapshot.elements.find((el) => el.id === "n_gateway")!;
    const [bounds] = flyTo.mock.calls[0];
    expect(bounds.x).toBe(gateway.x);
    expect(bounds.width).toBe(gateway.width);
  });

  it("targets that already read well stay unframed", async () => {
    const flyTo = vi.fn().mockResolvedValue(true);
    const gateway = demoSnapshot.elements.find((el) => el.id === "n_gateway")!;
    // A viewport sitting right on the gateway with room to spare: framing
    // again would fight the framing an agent (or user) already chose.
    const reader = makeReader();
    reader.getViewport = () => ({
      scrollX: -(gateway.x - 100),
      scrollY: -(gateway.y - 100),
      zoom: 1,
    });
    const api = new CommandAPI(
      reader,
      { flyTo, stop: vi.fn() } as unknown as CameraEngine,
      new OverlayStore(),
      { narrate: () => {} },
    );
    await api.frameTargets(["n_gateway"]);
    expect(flyTo).not.toHaveBeenCalled();
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
