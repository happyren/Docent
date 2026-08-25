import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { detailBadges, linkBadges } from "../src/scene/detailBadges";

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

const frame = {
  ...base,
  id: "f1",
  type: "frame",
  name: "Broker internals",
  x: 0,
  y: 30000,
  width: 800,
  height: 600,
};

describe("detail badges", () => {
  it("marks a component with a live detail link, and only that one", () => {
    const badges = detailBadges(
      snapshotFromRawElements([
        frame,
        {
          ...base,
          id: "broker",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          customData: { docent: { detail: { frameId: "f1" } } },
        },
        { ...base, id: "plain", type: "rectangle", x: 400, y: 100, width: 200, height: 100 },
      ]),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].diveElementId).toBe("broker");
    expect(badges[0].bounds).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  });

  it("shows nothing for a dangling link — the frame is gone", () => {
    const badges = detailBadges(
      snapshotFromRawElements([
        {
          ...base,
          id: "orphan",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          customData: { docent: { detail: { frameId: "deleted-frame" } } },
        },
      ]),
    );
    expect(badges).toHaveLength(0);
  });

  it("gives a composite one badge on the whole glyph, diving through the carrier member", () => {
    // A library-icon-style group: a primitive stroke plus a shape, where the
    // detail link lives on a member that is not the representative.
    const badges = detailBadges(
      snapshotFromRawElements([
        frame,
        {
          ...base,
          id: "z_stroke",
          type: "line",
          x: 10,
          y: 10,
          width: 40,
          height: 40,
          groupIds: ["g1"],
          points: [
            [0, 0],
            [40, 40],
          ],
        },
        {
          ...base,
          id: "z_box",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 60,
          height: 60,
          groupIds: ["g1"],
          customData: { docent: { detail: { frameId: "f1" } } },
        },
      ]),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].bounds).toEqual({ x: 0, y: 0, width: 60, height: 60 });
    expect(badges[0].diveElementId).toBe("z_box");
  });

  it("clamps the chip so small shapes keep theirs and large ones stay subtle", () => {
    const badges = detailBadges(
      snapshotFromRawElements([
        frame,
        {
          ...base,
          id: "tiny",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          customData: { docent: { detail: { frameId: "f1" } } },
        },
        {
          ...base,
          id: "vast",
          type: "rectangle",
          x: 500,
          y: 0,
          width: 900,
          height: 700,
          customData: { docent: { detail: { frameId: "f1" } } },
        },
      ]),
    );
    const tiny = badges.find((b) => b.diveElementId === "tiny");
    const vast = badges.find((b) => b.diveElementId === "vast");
    expect(tiny?.size).toBe(12);
    expect(vast?.size).toBe(22);
  });
});

describe("link markers (D96)", () => {
  it("marks a component that goes elsewhere, and only that one", () => {
    const badges = linkBadges(
      snapshotFromRawElements([
        {
          ...base,
          id: "orders",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          customData: {
            docent: { link: { scene: "payments/events", project: "Billing", at: "n_hub" } },
          },
        },
        { ...base, id: "plain", type: "rectangle", x: 400, y: 100, width: 200, height: 100 },
      ]),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].elementId).toBe("orders");
    expect(badges[0].link).toEqual({
      scene: "payments/events",
      project: "Billing",
      at: "n_hub",
    });
    expect(badges[0].bounds).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(badges[0].size).toBe(22);
  });

  it("reads a half-target as no link at all, so nothing is marked (I5)", () => {
    const badges = linkBadges(
      snapshotFromRawElements([
        {
          ...base,
          id: "half",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          customData: { docent: { link: { project: "Billing", at: "n_hub" } } },
        },
      ]),
    );
    expect(badges).toHaveLength(0);
  });

  it("a component that goes deeper AND elsewhere wears both markers", () => {
    const snapshot = snapshotFromRawElements([
      frame,
      {
        ...base,
        id: "broker",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        customData: {
          docent: { detail: { frameId: "f1" }, link: { scene: "payments/events" } },
        },
      },
    ]);
    const dives = detailBadges(snapshot);
    const links = linkBadges(snapshot);
    expect(dives.map((b) => b.diveElementId)).toEqual(["broker"]);
    expect(links.map((b) => b.elementId)).toEqual(["broker"]);
    // One graph node, so one id and one chip: the two markers differ only
    // in the corner OverlayLayer puts them on.
    expect(links[0].id).toBe(dives[0].id);
    expect(links[0].size).toBe(dives[0].size);
  });

  it("gives a composite one marker off whichever member declares it (D22)", () => {
    const badges = linkBadges(
      snapshotFromRawElements([
        {
          ...base,
          id: "i1",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 80,
          height: 80,
          groupIds: ["g"],
          customData: { docent: { composite: { g: true } } },
        },
        {
          ...base,
          id: "i2",
          type: "line",
          x: 10,
          y: 10,
          width: 60,
          height: 60,
          groupIds: ["g"],
          points: [
            [0, 0],
            [60, 60],
          ],
          customData: { docent: { composite: { g: true }, link: { scene: "aws/lambda notes" } } },
        },
      ]),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].elementId).toBe("i1");
    expect(badges[0].link).toEqual({ scene: "aws/lambda notes" });
  });
});
