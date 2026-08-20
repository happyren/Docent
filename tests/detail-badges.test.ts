import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { detailBadges } from "../src/scene/detailBadges";

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
