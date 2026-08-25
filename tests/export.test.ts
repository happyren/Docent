/**
 * Export invariants: determinism (I3), golden outputs (Q2), token
 * reduction (S4), and provenance behavior on the demo fixture.
 *
 * Regenerate goldens after intentional format changes:
 *   UPDATE_GOLDENS=1 pnpm test
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { encode } from "gpt-tokenizer";

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

import { snapshotFromRawElements, snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { makeHandle } from "../src/adapter/excalidraw";
import { plan } from "../src/authoring/ops";
import { buildSceneGraph } from "../src/scene/graph";
import { exportScene, applyLegend, legendToRecord } from "../src/export";
import type { LegendRule } from "../src/adapter/snapshot";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const demoJSON = readFileSync(join(FIXTURES, "demo.excalidraw"), "utf8");

function golden(name: string, actual: string): void {
  const path = join(FIXTURES, "golden", name);
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(path, actual);
    return;
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

describe("export determinism (I3)", () => {
  it("produces byte-identical output across runs", () => {
    const a = exportScene(snapshotFromSceneJSON(demoJSON));
    const b = exportScene(snapshotFromSceneJSON(demoJSON));
    expect(a.mermaid).toBe(b.mermaid);
    expect(a.sidecar).toBe(b.sidecar);
  });

  it("is independent of element array order", () => {
    const parsed = JSON.parse(demoJSON);
    parsed.elements = [...parsed.elements].reverse();
    const shuffled = exportScene(snapshotFromSceneJSON(JSON.stringify(parsed)));
    const original = exportScene(snapshotFromSceneJSON(demoJSON));
    expect(shuffled.mermaid).toBe(original.mermaid);
    expect(shuffled.sidecar).toBe(original.sidecar);
  });
});

describe("golden outputs (Q2)", () => {
  it("matches the committed Mermaid golden", () => {
    golden("demo.mmd", exportScene(snapshotFromSceneJSON(demoJSON)).mermaid);
  });

  it("matches the committed sidecar golden", () => {
    golden(
      "demo.docent.json",
      exportScene(snapshotFromSceneJSON(demoJSON)).sidecar,
    );
  });

  it("sidecar golden is valid JSON", () => {
    const { sidecar } = exportScene(snapshotFromSceneJSON(demoJSON));
    const parsed = JSON.parse(sidecar);
    expect(parsed.docent).toBe(1);
    expect(parsed.provenanceDefault).toBe("explicit");
  });
});

describe("token reduction (S4: ≥60% vs raw scene JSON)", () => {
  it("meets the reduction bar", () => {
    const { mermaid, sidecar } = exportScene(snapshotFromSceneJSON(demoJSON));
    const rawTokens = encode(demoJSON).length;
    const exportTokens = encode(mermaid).length + encode(sidecar).length;
    const reduction = 1 - exportTokens / rawTokens;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
  });
});

describe("provenance (I4) on the demo fixture", () => {
  const graph = buildSceneGraph(snapshotFromSceneJSON(demoJSON));

  it("marks bound arrows explicit", () => {
    const verify = graph.edges.find((e) => e.id === "e_verify");
    expect(verify?.fromProvenance).toBe("explicit");
    expect(verify?.toProvenance).toBe("explicit");
  });

  it("proximity-resolves the unbound session arrow as inferred", () => {
    const session = graph.edges.find((e) => e.id === "e_session");
    expect(session?.from).toBe("n_db");
    expect(session?.to).toBe("n_auth");
    expect(session?.fromProvenance).toBe("inferred");
    expect(session?.toProvenance).toBe("inferred");
  });

  it("carries declared intent into the sidecar with provenance", () => {
    const { sidecar } = exportScene(snapshotFromSceneJSON(demoJSON));
    const parsed = JSON.parse(sidecar);
    const gateway = parsed.nodes.find((n: { id: string }) => n.id === "n_gateway");
    expect(gateway.note).toBe("rate-limited at edge");
    expect(gateway.tags).toContain("hot-path");
    expect(gateway.tags).toContain("edge"); // declared via legend fill match
    expect(gateway.provenance.note).toBe("declared");
    expect(gateway.provenance.tags).toBe("declared");
    const db = parsed.nodes.find((n: { id: string }) => n.id === "n_db");
    expect(db.kind).toBe("datastore");
    expect(db.provenance.kind).toBe("declared");
    expect(db.shape).toBeUndefined();
    const session = parsed.edges.find((e: { id: string }) => e.id === "e_session");
    expect(session.channel).toBe("async");
    expect(session.provenance.channel).toBe("declared");
    expect(session.provenance.link).toBe("inferred");
  });

  it("strips unmapped styling entirely", () => {
    const { sidecar } = exportScene(snapshotFromSceneJSON(demoJSON));
    expect(sidecar).not.toContain("strokeColor");
    expect(sidecar).not.toContain("#1e1e1e");
  });

  it("keeps the legend carrier out of the node list", () => {
    expect(graph.nodes.some((n) => n.sourceId === "legend_carrier")).toBe(false);
    expect(graph.legend).toHaveLength(3);
  });
});


// ---------------------------------------------------------------------------
// the conventions travel with the drawing (A21: D87, D89, I4)
// ---------------------------------------------------------------------------

/** The demo fixture with a genre and a story recorded on its carrier. */
function demoWithStory() {
  const parsed = JSON.parse(demoJSON);
  const carrier = parsed.elements.find((el: { id: string }) => el.id === "legend_carrier");
  carrier.customData = {
    docent: {
      ...carrier.customData.docent,
      genre: "request",
      scenarios: [
        {
          name: "Checkout",
          description: "A customer places an order and the card is charged.",
          path: ["e_req", "e_verify"],
        },
      ],
    },
  };
  return snapshotFromSceneJSON(JSON.stringify(parsed));
}

describe("genre and scenarios in the exports (D87, D89, I4)", () => {
  it("Mermaid says them in the author's words, where no renderer draws them", () => {
    const { mermaid } = exportScene(demoWithStory());
    expect(mermaid.split("\n").slice(0, 5)).toEqual([
      "flowchart LR",
      "  %% genre (declared): Life of a request",
      "  %% scenario (declared): Checkout — A customer places an order and the card is charged.",
      "  %%   1. Client → API Gateway (HTTPS)",
      "  %%   2. API Gateway → Auth Service (verify JWT)",
    ]);
    // The drawing itself is untouched by the declaration.
    const plain = exportScene(snapshotFromSceneJSON(demoJSON)).mermaid;
    expect(plain).not.toContain("%%");
    expect(mermaid.replace(/^ *%%.*\n/gm, "")).toBe(plain);
  });

  it("the sidecar carries both as declared facts, addressable in graph ids", () => {
    const { sidecar } = exportScene(demoWithStory());
    const parsed = JSON.parse(sidecar);
    expect(parsed.genre).toEqual({ id: "request", name: "Life of a request", provenance: "declared" });
    expect(parsed.scenarios).toEqual([
      {
        name: "Checkout",
        description: "A customer places an order and the card is charged.",
        path: ["e_req", "e_verify"],
        steps: ["1. Client → API Gateway (HTTPS)", "2. API Gateway → Auth Service (verify JWT)"],
        provenance: { name: "declared", description: "declared", steps: "declared" },
      },
    ]);
    // A scene that declares neither says neither — the goldens do not move.
    const plain = JSON.parse(exportScene(snapshotFromSceneJSON(demoJSON)).sidecar);
    expect(plain.genre).toBeUndefined();
    expect(plain.scenarios).toBeUndefined();
  });

  it("stays deterministic with them (I3)", () => {
    const a = exportScene(demoWithStory());
    const b = exportScene(demoWithStory());
    expect(a.mermaid).toBe(b.mermaid);
    expect(a.sidecar).toBe(b.sidecar);
  });
});

describe("the carrier keeps the conventions across a write (D87, D89)", () => {
  const base = {
    angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
    fillStyle: "solid", strokeWidth: 2, opacity: 100, groupIds: [], frameId: null,
    isDeleted: false, locked: false, boundElements: [],
  };
  const raw = () => [
    { ...base, id: "a", type: "rectangle", x: 0, y: 0, width: 160, height: 80 },
    { ...base, id: "b", type: "rectangle", x: 400, y: 0, width: 160, height: 80 },
    {
      ...base, id: "e1", type: "arrow", x: 160, y: 40, width: 240, height: 0,
      points: [[0, 0], [240, 0]],
      startBinding: { elementId: "a" }, endBinding: { elementId: "b" },
    },
  ];
  /** A canvas that really applies writes, through the real adapter. */
  const canvas = (initial: Record<string, unknown>[]) => {
    let elements = initial;
    return makeHandle({
      getSceneElementsIncludingDeleted: () => elements,
      updateScene: ({ elements: next }: { elements: Record<string, unknown>[] }) => {
        elements = next;
      },
    } as never);
  };

  it("round-trips a genre and a scenario through applyWrite", async () => {
    const handle = canvas(raw());
    const written = plan(
      [
        { op: "use_genre", genre: "request" },
        { op: "define_scenario", name: "Checkout", path: ["e1"], description: "A customer places an order." },
      ],
      snapshotFromRawElements(raw()),
    );
    await handle.applyWrite(written.write);
    const graph = buildSceneGraph(handle.getSceneSnapshot());
    expect(graph.genre).toBe("request");
    expect(graph.scenarios).toEqual([
      { name: "Checkout", description: "A customer places an order.", path: ["e1"] },
    ]);
    expect(graph.legend.some((r) => r.meaning === "service")).toBe(true);

    // The regression: a later legend write rewrites the carrier, and the
    // rules are the only thing it owns.
    const later = plan([{ op: "define_kind", kind: "gateway" }], handle.getSceneSnapshot());
    await handle.applyWrite(later.write);
    const after = buildSceneGraph(handle.getSceneSnapshot());
    expect(after.genre).toBe("request");
    expect(after.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(after.legend.some((r) => r.meaning === "gateway")).toBe(true);
  });

  it("makes the carrier for a scene that has no legend at all", async () => {
    const handle = canvas(raw());
    const written = plan(
      [{ op: "define_scenario", name: "Checkout", path: ["e1"] }],
      snapshotFromRawElements(raw()),
    );
    // Nothing about the legend is in this write — the carrier still has to exist.
    expect(written.write.legend).toBeUndefined();
    await handle.applyWrite(written.write);
    const graph = buildSceneGraph(handle.getSceneSnapshot());
    expect(graph.scenarios).toEqual([{ name: "Checkout", path: ["e1"] }]);
    expect(graph.genre).toBeNull();
  });
});

describe("composite legend rules (D9 extension)", () => {
  const style = {
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    strokeStyle: "solid",
    fillStyle: "solid",
    strokeWidth: 2,
  };
  const serviceRule: LegendRule = {
    attr: "shape",
    value: "rectangle",
    also: [
      { attr: "strokeColor", value: "#1e1e1e" },
      { attr: "strokeWidth", value: "2" },
    ],
    key: "kind",
    meaning: "service",
  };

  it("matches only when every condition holds", () => {
    expect(applyLegend(style, "rectangle", [serviceRule]).kind).toBe("service");
    // wrong shape
    expect(applyLegend(style, "ellipse", [serviceRule]).kind).toBeNull();
    // wrong stroke width
    expect(
      applyLegend({ ...style, strokeWidth: 4 }, "rectangle", [serviceRule]).kind,
    ).toBeNull();
  });

  it("more specific rules override generic ones for the same key", () => {
    const generic: LegendRule = {
      attr: "shape",
      value: "rectangle",
      key: "kind",
      meaning: "node",
    };
    // Order in the legend must not matter — specificity decides.
    expect(applyLegend(style, "rectangle", [serviceRule, generic]).kind).toBe(
      "service",
    );
    expect(applyLegend(style, "rectangle", [generic, serviceRule]).kind).toBe(
      "service",
    );
  });

  it("serializes composite conditions joined with + in the sidecar record", () => {
    expect(legendToRecord([serviceRule])).toEqual({
      "shape.rectangle+color.#1e1e1e+strokeWidth.2": "kind: service",
    });
  });
});
