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
import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { exportScene } from "../src/export";

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
