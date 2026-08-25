/**
 * Scene links (A23: D95, D97) — a link is meaning, not a URL: parsed off
 * the element, carried on every part of the graph, authored by an op whose
 * refusal is the store's own, and round-tripped through a simulated write.
 */
import { describe, expect, it } from "vitest";
import { parseSceneLink, snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { idSource, plan, PlanError, simulate } from "../src/authoring/ops";
import { SCENE_PATH_ERROR } from "../src/portfolio/tree";

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
  groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const docent = (data: Record<string, unknown>) => ({ customData: { docent: data } });
const box = (id: string, x: number, label: string, extra: Record<string, unknown> = {}) => [
  { ...base, id, type: "rectangle", x, y: 100, width: 160, height: 80, frameId: "F", boundElements: [{ id: `${id}_t`, type: "text" }], ...extra },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: 120, width: 140, height: 20, text: label, containerId: id, frameId: "F", fontFamily: 5, fontSize: 20 },
];
const arrow = (extra: Record<string, unknown> = {}) => ({
  ...base, id: "e1", type: "arrow", x: 200, y: 140, width: 140, height: 0, frameId: "F", roundness: { type: 2 },
  points: [[0, 0], [140, 0]], startBinding: { elementId: "orders" }, endBinding: { elementId: "ledger" },
  endArrowhead: "arrow", ...extra,
});

/** One frame, two components, one arrow — any of them free to carry a link. */
const sceneOf = (
  over: { orders?: Record<string, unknown>; edge?: Record<string, unknown>; frame?: Record<string, unknown> } = {},
) =>
  snapshotFromRawElements([
    { ...base, id: "F", type: "frame", name: "Payments", x: 0, y: 0, width: 900, height: 400, ...(over.frame ? docent(over.frame) : {}) },
    ...box("orders", 40, "Orders", over.orders ? docent(over.orders) : {}),
    ...box("ledger", 340, "Ledger"),
    arrow(over.edge ? docent(over.edge) : {}),
  ] as never);

const snapshot = sceneOf();

describe("the link on an element (D95)", () => {
  it("parses a whole link, and defaults what the author left out", () => {
    expect(parseSceneLink({ scene: "payments/events", project: "Billing", at: "n_hub" })).toEqual({
      scene: "payments/events",
      project: "Billing",
      at: "n_hub",
    });
    // Only the path is required — the project is the scene's own (D95).
    expect(parseSceneLink({ scene: " payments/events " })).toEqual({ scene: "payments/events" });
    expect(parseSceneLink({ scene: "payments/events", project: "  ", at: "" })).toEqual({
      scene: "payments/events",
    });
  });

  it("reads a malformed link as no link at all (I5)", () => {
    for (const bad of [
      undefined,
      null,
      "payments/events",
      42,
      {},
      { scene: "" },
      { scene: 7 },
      { project: "Billing", at: "n_hub" },
    ]) {
      expect(parseSceneLink(bad)).toBeNull();
    }
  });

  it("comes off the snapshot beside the rest of the meaning", () => {
    const snap = sceneOf({ orders: { note: "owns order state", link: { scene: "payments/events" } } });
    const orders = snap.elements.find((el) => el.id === "orders")!;
    expect(orders.docent.link).toEqual({ scene: "payments/events" });
    expect(orders.docent.note).toBe("owns order state");
    // The element's own Excalidraw URL is a different field entirely.
    expect(orders.link).toBeNull();
    expect(snap.elements.find((el) => el.id === "ledger")!.docent.link).toBeNull();
  });
});

describe("the graph carries it (D95)", () => {
  it("on a component, an edge, and a frame", () => {
    const graph = buildSceneGraph(
      sceneOf({
        orders: { link: { scene: "payments/events", project: "Billing" } },
        edge: { link: { scene: "payments/settlement", at: "n_clearing" } },
        frame: { link: { scene: "payments/overview" } },
      }),
    );
    expect(graph.nodes.find((n) => n.sourceId === "orders")!.link).toEqual({
      scene: "payments/events",
      project: "Billing",
    });
    expect(graph.edges[0].link).toEqual({ scene: "payments/settlement", at: "n_clearing" });
    expect(graph.frames[0].link).toEqual({ scene: "payments/overview" });
    expect(graph.nodes.find((n) => n.sourceId === "ledger")!.link).toBeNull();
  });

  it("off whichever member of a composite holds it (D22, D83)", () => {
    const group = { groupIds: ["g"], frameId: null };
    const graph = buildSceneGraph(
      snapshotFromRawElements([
        // The representative is the rectangle; the link is declared on the
        // drawing part beside it, and the one component still carries it.
        { ...base, ...group, id: "i1", type: "rectangle", x: 0, y: 0, width: 80, height: 80, ...docent({ composite: { g: true } }) },
        { ...base, ...group, id: "i2", type: "line", x: 10, y: 10, width: 60, height: 60, points: [[0, 0], [60, 60]], ...docent({ composite: { g: true }, link: { scene: "aws/lambda notes" } }) },
      ] as never),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].sourceId).toBe("i1");
    expect(graph.nodes[0].composite).toEqual({ members: 2, provenance: "declared" });
    expect(graph.nodes[0].link).toEqual({ scene: "aws/lambda notes" });
  });
});

describe("authoring a link (D97)", () => {
  it("draws a new component pointing at another scene", () => {
    const result = plan(
      [{ op: "add_node", label: "Events", frame: "F", link: { scene: "payments/events", project: "Billing", at: "n_hub" } }],
      snapshot,
      idSource(1),
    );
    expect(result.write.shapes![0].meaning).toEqual({
      link: { scene: "payments/events", project: "Billing", at: "n_hub" },
    });
    expect(result.notes).toContain("Events: linked to Billing/payments/events");
  });

  it("sets, retargets, and clears one on what is already drawn", () => {
    const set = plan([{ op: "update", id: "orders", link: { scene: "payments/events" } }], snapshot);
    expect(set.write.patches![0]).toEqual({ id: "orders", meaning: { link: { scene: "payments/events" } } });
    expect(set.notes).toContain("Orders: linked to payments/events");

    const linked = sceneOf({ orders: { link: { scene: "payments/events" } } });
    const retarget = plan([{ op: "update", id: "orders", link: { scene: "payments/settlement" } }], linked);
    expect(retarget.write.patches![0].meaning!.link).toEqual({ scene: "payments/settlement" });

    // Null clears; absent leaves it alone, exactly as logic and narrative do.
    const cleared = plan([{ op: "update", id: "orders", link: null }], linked);
    expect(cleared.write.patches![0].meaning!.link).toBeNull();
    expect(cleared.notes).toContain("Orders: link cleared");
    expect(() => plan([{ op: "update", id: "orders", label: "Orders" }], linked)).not.toThrow();
    expect(plan([{ op: "update", id: "orders", label: "Orders v2" }], linked).write.patches![0].meaning).toBeUndefined();
  });

  it("links an edge and a frame too", () => {
    const result = plan(
      [
        { op: "update", id: "e1", link: { scene: "payments/settlement" } },
        { op: "update", id: "F", link: { scene: "payments/overview" } },
      ],
      snapshot,
    );
    expect(result.write.patches!.map((p) => p.meaning!.link)).toEqual([
      { scene: "payments/settlement" },
      { scene: "payments/overview" },
    ]);
  });

  it("refuses a path no scene could ever have, in the store's own words", () => {
    for (const scene of ["../secrets", "a/b/c/d/e/f/g/h/i", ".docent", "", "no|pipes"]) {
      try {
        plan([{ op: "add_node", label: "Elsewhere", link: { scene } }], snapshot);
        throw new Error(`expected a refusal for ${JSON.stringify(scene)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PlanError);
        expect((err as PlanError).problems).toEqual([`op 1 (add_node): ${SCENE_PATH_ERROR}`]);
      }
    }
  });

  it("refuses a project that is not one name", () => {
    try {
      plan([{ op: "update", id: "orders", link: { scene: "payments/events", project: "Billing/EU" } }], snapshot);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).problems[0]).toMatch(/^op 1 \(update\): invalid project name/);
    }
  });

  it("refuses an arrival point that names nothing", () => {
    try {
      plan([{ op: "update", id: "orders", link: { scene: "payments/events", at: "   " } }], snapshot);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as PlanError).problems[0]).toMatch(/link\.at is empty/);
    }
  });

  it("plans a link to a scene nobody has drawn yet — existence is validate's question (D97)", () => {
    const result = plan([{ op: "update", id: "orders", link: { scene: "not/here/yet" } }], snapshot);
    expect(result.write.patches![0].meaning!.link).toEqual({ scene: "not/here/yet" });
  });
});

describe("a simulated write round-trips the link (D62, D95)", () => {
  it("carries it onto the new component and off the cleared one", () => {
    const added = simulate(
      snapshot,
      plan(
        [{ op: "add_node", label: "Events", frame: "F", link: { scene: "payments/events", at: "n_hub" } }],
        snapshot,
        idSource(2),
      ).write,
    );
    const graph = buildSceneGraph(added);
    expect(graph.nodes.find((n) => n.label === "Events")!.link).toEqual({
      scene: "payments/events",
      at: "n_hub",
    });

    const linked = sceneOf({ orders: { link: { scene: "payments/events" } } });
    const after = simulate(linked, plan([{ op: "update", id: "orders", link: null }], linked).write);
    expect(buildSceneGraph(after).nodes.find((n) => n.sourceId === "orders")!.link).toBeNull();
    // Retargeting leaves the meaning beside it untouched.
    const moved = simulate(
      linked,
      plan([{ op: "update", id: "orders", link: { scene: "payments/settlement", project: "Billing" } }], linked).write,
    );
    expect(buildSceneGraph(moved).nodes.find((n) => n.sourceId === "orders")!.link).toEqual({
      scene: "payments/settlement",
      project: "Billing",
    });
  });
});
