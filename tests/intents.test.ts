/**
 * Intents and logic (D41, D42) and the scene link beside them (D95): the
 * meaning an element carries, through the snapshot, the graph, the sidecar
 * — and, for the link, through the real adapter's write path.
 */
import { describe, expect, it, vi } from "vitest";

// The adapter is the one module that may import Excalidraw (B1), and its
// published bundle will not load in a node test. Standing in for the few
// upstream calls the write path makes lets the round trip below run
// against the REAL adapter — what lands in `customData` is a promise the
// canvas keeps, so it is tested, not assumed.
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "immediately", NEVER: "never" },
  Excalidraw: () => null,
  FONT_FAMILY: { Excalifont: 5, Nunito: 6, "Comic Shanns": 7 },
  MainMenu: Object.assign(() => null, { DefaultItems: {} }),
  convertToExcalidrawElements: (skeletons: Record<string, unknown>[]) =>
    skeletons.map((skeleton, i) => ({
      width: 100,
      height: 20,
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
      ...skeleton,
      id: (skeleton.id as string) ?? `made_${i}`,
    })),
  elementsOverlappingBBox: () => [],
  getCommonBounds: () => [0, 0, 0, 0],
  hashElementsVersion: () => 0,
  exportToCanvas: async () => null,
  loadFromBlob: async () => ({ elements: [], appState: {} }),
  newElementWith: (el: object, patch: object) => ({ ...el, ...patch }),
  restoreElements: (els: unknown) => els,
  serializeAsJSON: () => "{}",
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}));

import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { makeHandle } from "../src/adapter/excalidraw";
import { plan } from "../src/authoring/ops";
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

describe("the scene link through the adapter (A23: D95)", () => {
  const raw = () => [
    { ...base, id: "orders", type: "rectangle", x: 0, y: 0, width: 160, height: 80, boundElements: [] },
    { ...base, id: "ledger", type: "rectangle", x: 400, y: 0, width: 160, height: 80, boundElements: [] },
  ];
  /** A canvas that really applies writes, through the real adapter. */
  const canvas = (initial: Record<string, unknown>[]) => {
    let elements = initial;
    return makeHandle({
      getSceneElementsIncludingDeleted: () => elements,
      getSceneElements: () => elements.filter((el) => !el.isDeleted),
      updateScene: ({ elements: next }: { elements: Record<string, unknown>[] }) => {
        elements = next;
      },
    } as never);
  };
  /** The Orders component as the graph sees it (graph ids sort, I6). */
  const orders = (handle: ReturnType<typeof canvas>) =>
    buildSceneGraph(handle.getSceneSnapshot()).nodes.find((n) => n.sourceId === "orders")!;

  it("round-trips a planned link, and an unrelated patch never erases it", async () => {
    const handle = canvas(raw());
    const written = plan(
      [
        {
          op: "update",
          id: "orders",
          link: { scene: "payments/events", project: "Billing", at: "n_hub" },
        },
      ],
      snapshotFromRawElements(raw() as never),
    );
    await handle.applyWrite(written.write);
    const link = { scene: "payments/events", project: "Billing", at: "n_hub" };
    expect(orders(handle).link).toEqual(link);
    // The panel reads it back off the element, where the follow needs it.
    expect(handle.getElementInfo("orders")?.link).toEqual(link);

    // The regression: a later write that says nothing about the link must
    // leave it exactly where it was — absent keeps, only null clears.
    const later = plan(
      [{ op: "update", id: "orders", intents: ["owns the order state"] }],
      handle.getSceneSnapshot(),
    );
    await handle.applyWrite(later.write);
    const after = orders(handle);
    expect(after.link).toEqual(link);
    expect(after.intents).toEqual(["owns the order state"]);

    const cleared = plan([{ op: "update", id: "orders", link: null }], handle.getSceneSnapshot());
    await handle.applyWrite(cleared.write);
    const gone = orders(handle);
    expect(gone.link).toBeNull();
    expect(gone.intents).toEqual(["owns the order state"]);
  });

  it("the panel's own writer sets and clears one, and touches nothing else", () => {
    const handle = canvas(raw().map((el) => (el.id === "orders" ? { ...el, customData: { docent: { note: "owns order state" } } } : el)));
    handle.setElementLink("orders", { scene: "payments/events", at: "n_hub" });
    const node = () => orders(handle);
    expect(node().link).toEqual({ scene: "payments/events", at: "n_hub" });
    expect(node().intents).toEqual(["owns order state"]);
    handle.setElementLink("orders", null);
    expect(node().link).toBeNull();
    expect(node().intents).toEqual(["owns order state"]);
    expect(() => handle.setElementLink("nobody", { scene: "x" })).toThrow(/Unknown element/);
  });
});
