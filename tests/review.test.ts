/**
 * The review plan (D48): crops per changed frame at one rectangle, marks
 * on the pictures, ghosts for the overlay, changelog lines routed to the
 * frame they speak of.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { LAYER_ONE_KEY, planReview } from "../src/review/plan";

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

const rect = (id: string, x: number, label: string, frameId: string | null = "F", extra: Record<string, unknown> = {}) => [
  { ...base, id, type: "rectangle", x, y: 100, width: 160, height: 80, frameId, boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: 120, width: 140, height: 20, text: label, containerId: id, frameId },
];
const arrow = (id: string, from: string, to: string, x: number) => ({
  ...base,
  id,
  type: "arrow",
  x,
  y: 140,
  width: 100,
  height: 0,
  frameId: "F",
  points: [[0, 0], [100, 0]],
  startBinding: { elementId: from },
  endBinding: { elementId: to },
});
const frame = { ...base, id: "F", type: "frame", name: "Core Services", x: 0, y: 0, width: 900, height: 400 };

const before = snapshotFromRawElements([
  frame,
  ...rect("orders", 40, "Orders"),
  ...rect("payments", 340, "Payments"),
  ...rect("legacy", 640, "Legacy sync"),
  arrow("e1", "orders", "payments", 205),
  ...rect("loose", 40, "Loose note", null),
]);

const after = snapshotFromRawElements([
  frame,
  ...rect("orders", 40, "Orders", "F", { customData: { docent: { intents: ["retries on failure"] } } }),
  ...rect("payments", 340, "Payments"),
  ...rect("retry", 640, "Retry queue"),
  arrow("e2", "orders", "retry", 205),
  ...rect("loose", 40, "Loose note", null),
]);

describe("review plan (D48)", () => {
  it("crops each changed frame at one rectangle, clamped to the frame, with marks and ghosts", () => {
    const plan = planReview(before, after);
    expect(plan.diff.empty).toBe(false);
    expect(plan.crops).toHaveLength(1);
    const crop = plan.crops[0];
    expect(crop.key).toBe("F");
    expect(crop.frameId).toBe("F");
    expect(crop.frameName).toBe("Core Services");
    // The rectangle covers every mark and stays inside the frame.
    const right = crop.rect.x + crop.rect.width;
    const bottom = crop.rect.y + crop.rect.height;
    expect(crop.rect.x).toBeGreaterThanOrEqual(0);
    expect(crop.rect.y).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(900);
    expect(bottom).toBeLessThanOrEqual(400);
    for (const mark of crop.marks) {
      expect(mark.rect.x).toBeGreaterThanOrEqual(crop.rect.x);
      expect(mark.rect.x + mark.rect.width).toBeLessThanOrEqual(right);
    }
    const kinds = Object.fromEntries(crop.marks.map((m) => [m.label, m.kind]));
    expect(kinds).toEqual({
      "Retry queue": "added",
      "Legacy sync": "removed",
      Orders: "changed",
      "Orders → Retry queue": "added",
      "Orders → Payments": "removed",
    });
    // Removed things are ghosts for the overlay; the rest are not.
    expect(crop.ghosts.map((g) => g.label).sort()).toEqual(["Legacy sync", "Orders → Payments"]);
    // The changelog's lines for this frame ride the crop.
    expect(crop.lines).toContain("+Retry queue");
    expect(crop.lines).toContain("−Legacy sync");
    expect(crop.lines.some((l) => l.startsWith("Orders: intent added"))).toBe(true);
    expect(plan.changelog.startsWith("Core Services: ")).toBe(true);
  });

  it("is deterministic and empty when nothing changed", () => {
    expect(JSON.stringify(planReview(before, after))).toBe(JSON.stringify(planReview(before, after)));
    const same = planReview(after, after);
    expect(same.diff.empty).toBe(true);
    expect(same.crops).toEqual([]);
    expect(same.changelog).toBe("");
  });

  it("puts unframed changes under Layer 1 and handles a scene with no before", () => {
    const moved = snapshotFromRawElements([
      frame,
      ...rect("orders", 40, "Orders"),
      ...rect("payments", 340, "Payments"),
      ...rect("legacy", 640, "Legacy sync"),
      arrow("e1", "orders", "payments", 205),
      ...rect("loose", 40, "Loose note, edited", null),
    ]);
    const plan = planReview(before, moved);
    expect(plan.crops.map((c) => c.key)).toEqual([LAYER_ONE_KEY]);
    expect(plan.crops[0].frameId).toBeNull();
    expect(plan.crops[0].frameName).toBe("Layer 1");
    expect(plan.crops[0].marks.map((m) => m.kind)).toEqual(["changed"]);
    // A new scene: everything is added, the frame crops at its own bounds.
    const fresh = planReview(null, after);
    const core = fresh.crops.find((c) => c.key === "F");
    expect(core).toBeDefined();
    expect(core?.rect).toEqual({ x: 0, y: 0, width: 900, height: 400 });
    expect(core?.marks.every((m) => m.kind === "added")).toBe(true);
    // A deleted scene: everything is a ghost.
    const gone = planReview(before, null);
    expect(gone.crops.find((c) => c.key === "F")?.ghosts.length).toBeGreaterThan(0);
  });
});
