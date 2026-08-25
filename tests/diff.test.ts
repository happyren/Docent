/**
 * Semantic scene diff (D46): what changed, in the diagram's own terms, and
 * the changelog a reviewer reads in the commit and the PR.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { describeChange, diffScenes } from "../src/scene/diff";

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

const rect = (id: string, x: number, label: string, extra: Record<string, unknown> = {}) => [
  { ...base, id, type: "rectangle", x, y: 100, width: 160, height: 80, frameId: "F", boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: 120, width: 140, height: 20, text: label, containerId: id, frameId: "F" },
];
const arrow = (id: string, from: string, to: string, x: number, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});
const frame = { ...base, id: "F", type: "frame", name: "Core Services", x: 0, y: 0, width: 900, height: 400 };

const before = snapshotFromRawElements([
  frame,
  ...rect("orders", 40, "Orders"),
  ...rect("payments", 340, "Payments"),
  ...rect("legacy", 640, "Legacy sync"),
  arrow("e1", "orders", "payments", 205),
]);

const after = snapshotFromRawElements([
  frame,
  ...rect("orders", 40, "Orders", { customData: { docent: { intents: ["retries on failure"] } } }),
  ...rect("payments", 340, "Payments"),
  ...rect("retry", 640, "Retry queue"),
  arrow("e2", "orders", "retry", 205),
]);

describe("semantic scene diff (D46)", () => {
  it("sees components, edges, and declared meaning by stable id", () => {
    const diff = diffScenes(before, after);
    expect(diff.empty).toBe(false);
    expect(diff.nodes.added.map((n) => n.label)).toEqual(["Retry queue"]);
    expect(diff.nodes.removed.map((n) => n.label)).toEqual(["Legacy sync"]);
    const orders = diff.nodes.changed.find((c) => c.after.id === "orders")!;
    expect(orders.changes).toEqual([{ kind: "intents", added: ["retries on failure"], removed: [] }]);
    expect(diff.edges.removed.map((e) => e.id)).toEqual(["e1"]);
    expect(diff.edges.added.map((e) => e.id)).toEqual(["e2"]);
  });

  it("renders a changelog in the author's terms, grouped by frame", () => {
    const { changelog } = describeChange(before, after);
    expect(changelog).toBe(
      "Core Services: +Retry queue; −Legacy sync; Orders: intent added 'retries on failure'; +edge Orders → Retry queue; −edge Orders → Payments",
    );
  });

  it("is empty and silent when nothing changed, and ignores layout jitter", () => {
    expect(describeChange(before, before).changelog).toBe("");
    const jittered = snapshotFromRawElements([
      frame,
      ...rect("orders", 42, "Orders"),
      ...rect("payments", 340, "Payments"),
      ...rect("legacy", 640, "Legacy sync"),
      arrow("e1", "orders", "payments", 205),
    ]);
    expect(diffScenes(before, jittered).empty).toBe(true);
  });

  it("is deterministic", () => {
    expect(describeChange(before, after).changelog).toBe(describeChange(before, after).changelog);
  });
});

describe("scene links are meaning too (D95)", () => {
  const linked = (link: unknown, on = "orders") =>
    snapshotFromRawElements([
      frame,
      ...rect("orders", 40, "Orders", on === "orders" ? { customData: { docent: { link } } } : {}),
      ...rect("payments", 340, "Payments"),
      ...rect("legacy", 640, "Legacy sync"),
      arrow("e1", "orders", "payments", 205, on === "e1" ? { customData: { docent: { link } } } : {}),
    ]);

  const plain = linked(null);

  it("says a link added, removed, and retargeted", () => {
    const events = linked({ scene: "payments/events" });
    expect(describeChange(plain, events).changelog).toBe(
      "Core Services: Orders: link → payments/events added",
    );
    expect(describeChange(events, plain).changelog).toBe(
      "Core Services: Orders: link → payments/events removed",
    );
    expect(describeChange(linked({ scene: "a/b" }), linked({ scene: "c/d" })).changelog).toBe(
      "Core Services: Orders: link → a/b → c/d",
    );
  });

  it("names the project and the arrival point, and stays quiet when neither moved", () => {
    const here = linked({ scene: "payments/events" });
    const elsewhere = linked({ scene: "payments/events", project: "Billing", at: "n_hub" });
    expect(describeChange(here, elsewhere).changelog).toBe(
      "Core Services: Orders: link → payments/events → Billing/payments/events#n_hub",
    );
    expect(diffScenes(elsewhere, elsewhere).empty).toBe(true);
  });

  it("reports an edge's link on the edge", () => {
    const before = linked(null, "e1");
    const after = linked({ scene: "payments/settlement" }, "e1");
    expect(describeChange(before, after).changelog).toBe(
      "Core Services: edge Orders → Payments: link → payments/settlement added",
    );
  });
});
