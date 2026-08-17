import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { snapshotFromRawElements, snapshotFromSceneJSON } from "../src/adapter/snapshot";
import {
  arrangeMoves,
  bandPlacement,
  bandY,
  computeTiers,
  tierOfElement,
  trailAt,
} from "../src/scene/tiers";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const demoSnapshot = snapshotFromSceneJSON(
  readFileSync(join(FIXTURES, "demo.excalidraw"), "utf8"),
);

describe("tier model (S11 layering)", () => {
  const info = computeTiers(demoSnapshot);

  it("assigns tiers from the drill-link graph, not positions", () => {
    expect(info.frameTier.get("f_ingress")).toBe(1);
    expect(info.frameTier.get("f_core")).toBe(1);
    expect(info.frameTier.get("f_gw_detail")).toBe(2);
    expect(info.frameTier.get("f_router_detail")).toBe(3);
    expect(info.maxTier).toBe(3);
  });

  it("records who links each detail frame", () => {
    expect(info.detailParent.get("f_gw_detail")?.elementId).toBe("n_gateway");
    expect(info.detailParent.get("f_gw_detail")?.parentFrameId).toBe("f_ingress");
    expect(info.detailParent.get("f_router_detail")?.elementId).toBe("n_router");
  });

  it("tier-1 bounds exclude every detail tier", () => {
    const b = info.tier1Bounds!;
    // Tier-2 band sits ~20k below the layer-1 content in the fixture.
    expect(b.y + b.height).toBeLessThan(10_000);
    expect(b.width).toBeGreaterThan(500);
  });

  it("elements inherit their context's tier", () => {
    expect(tierOfElement(info, demoSnapshot, "n_gateway")).toBe(1);
    expect(tierOfElement(info, demoSnapshot, "n_router")).toBe(2);
    expect(tierOfElement(info, demoSnapshot, "n_lb")).toBe(3);
  });

  it("bands are far enough apart that fitting one never shows another", () => {
    expect(bandY(info, 2) - bandY(info, 1)).toBeGreaterThanOrEqual(20_000);
  });

  it("places new frames right of existing band siblings", () => {
    const placement = bandPlacement(info, demoSnapshot, 2);
    const gw = demoSnapshot.elements.find((el) => el.id === "f_gw_detail")!;
    expect(placement.x).toBeGreaterThan(gw.x + gw.width);
    expect(placement.y).toBe(bandY(info, 2));
  });
});

describe("structural breadcrumb trail", () => {
  const info = computeTiers(demoSnapshot);

  it("is empty on Layer 1", () => {
    expect(trailAt(info, demoSnapshot, { x: 400, y: 175 })).toEqual([]);
  });

  it("walks tier chain from a deep point back to Layer 1", () => {
    const router = demoSnapshot.elements.find((el) => el.id === "f_router_detail")!;
    const point = { x: router.x + 10, y: router.y + 10 };
    const trail = trailAt(info, demoSnapshot, point);
    expect(trail.map((c) => c.frameId)).toEqual(["f_gw_detail", "f_router_detail"]);
    expect(trail[1].linkingElementId).toBe("n_router");
    expect(trail[0].linkingElementId).toBe("n_gateway");
    expect(trail[0].parentFrameId).toBe("f_ingress");
  });
});

describe("arrange moves", () => {
  it("no-ops for a scene already in bands", () => {
    const info = computeTiers(demoSnapshot);
    expect(arrangeMoves(info, demoSnapshot)).toEqual([]);
  });

  it("moves scattered detail frames into bands with members and labels", () => {
    const base = {
      angle: 0,
      strokeColor: "",
      backgroundColor: "",
      strokeStyle: "solid",
      fillStyle: "solid",
      strokeWidth: 2,
      opacity: 100,
      groupIds: [],
      isDeleted: false,
      locked: false,
    };
    const snapshot = snapshotFromRawElements([
      { ...base, id: "root", type: "frame", x: 0, y: 0, width: 500, height: 200, name: "L1" },
      {
        ...base,
        id: "sys",
        type: "rectangle",
        x: 50,
        y: 50,
        width: 100,
        height: 60,
        frameId: "root",
        customData: { docent: { detail: { frameId: "d1" } } },
      },
      // Detail frame drawn right next to layer 1 (the messy case).
      { ...base, id: "d1", type: "frame", x: 600, y: 40, width: 400, height: 200, name: "sys — detail" },
      { ...base, id: "inner", type: "rectangle", x: 650, y: 90, width: 80, height: 40, frameId: "d1" },
      // Label bound to an element inside the detail frame but frameless itself.
      { ...base, id: "lbl", type: "text", x: 660, y: 100, width: 40, height: 20, containerId: "inner", frameId: null, text: "X" },
    ]);
    const info = computeTiers(snapshot);
    const moves = arrangeMoves(info, snapshot);
    expect(moves).toHaveLength(1);
    expect(moves[0].frameId).toBe("d1");
    expect(moves[0].dy).toBeGreaterThan(15_000);
    expect(moves[0].memberIds).toContain("inner");
    expect(moves[0].memberIds).toContain("lbl");
  });
});
