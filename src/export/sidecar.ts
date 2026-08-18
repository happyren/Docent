/**
 * Compact JSON sidecar (S4, D5): carries what Mermaid can't — spatial
 * layout, frames, groups, and the intent model — with provenance on every
 * fact (I4). Pure and deterministic (B5, I3): sorted keys, stable entity
 * ordering, no timestamps.
 *
 * Provenance encoding: `provenanceDefault` in the root declares that any
 * fact without an entry in its entity's `provenance` map is `explicit`
 * (read from the drawing). `declared` and `inferred` facts are always
 * listed per entity.
 */
import type { SceneGraph } from "../scene/graph";
import { applyLegend, legendToRecord } from "./legend";
import { orderFrames } from "./mermaid";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** JSON with sorted object keys; entities render on a single line each. */
function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",");
  return `{${body}}`;
}

function xywh(bounds: { x: number; y: number; width: number; height: number }): Json {
  return [bounds.x, bounds.y, bounds.width, bounds.height];
}

export function exportSidecar(graph: SceneGraph): string {
  const legendRecord = legendToRecord(graph.legend);

  const nodes: Json[] = graph.nodes.map((node) => {
    const facts = applyLegend(node.style, node.shape, graph.legend);
    const tags = [...node.tags, ...facts.tags];
    const provenance: { [k: string]: Json } = {};
    const entity: { [k: string]: Json } = {
      id: node.id,
      xywh: xywh(node.bounds),
    };
    if (facts.kind !== null) {
      entity.kind = facts.kind;
      provenance.kind = "declared";
    } else {
      entity.shape = node.shape;
    }
    if (node.label !== null) entity.label = node.label;
    if (node.frameId !== null) entity.frame = node.frameId;
    if (node.groupIds.length) entity.groups = [...node.groupIds];
    if (tags.length) {
      entity.tags = tags.sort();
      provenance.tags = "declared";
    }
    if (node.note !== null) {
      entity.note = node.note;
      provenance.note = "declared";
    }
    if (node.detailFrameId !== null) {
      entity.detail = node.detailFrameId;
      provenance.detail = "declared";
    }
    if (node.composite !== null) {
      // One component drawn from several elements (D22) — say so, and say
      // whether the author declared it or the glyph signature implied it.
      entity.composite = node.composite.members;
      provenance.composite = node.composite.provenance;
    }
    for (const [key, meaning] of Object.entries(facts.props).sort()) {
      entity[key] = meaning;
      provenance[key] = "declared";
    }
    if (Object.keys(provenance).length) entity.provenance = provenance;
    return entity;
  });

  const edges: Json[] = graph.edges.map((edge) => {
    const facts = applyLegend(edge.style, "arrow", graph.legend);
    const provenance: { [k: string]: Json } = {};
    const entity: { [k: string]: Json } = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
    };
    if (edge.label !== null) entity.label = edge.label;
    if (edge.toRefined !== null) {
      entity.toRefined = edge.toRefined;
      provenance.toRefined = "declared";
    }
    if (edge.fromRefined !== null) {
      entity.fromRefined = edge.fromRefined;
      provenance.fromRefined = "declared";
    }
    if (edge.fromProvenance === "inferred" || edge.toProvenance === "inferred") {
      provenance.link = "inferred";
    }
    for (const [key, meaning] of Object.entries(facts.props).sort()) {
      entity[key] = meaning;
      provenance[key] = "declared";
    }
    if (facts.tags.length) {
      entity.tags = [...facts.tags].sort();
      provenance.tags = "declared";
    }
    if (Object.keys(provenance).length) entity.provenance = provenance;
    return entity;
  });

  const frames: Json[] = orderFrames(graph.frames).map((frame) => {
    const provenance: { [k: string]: Json } = {};
    const entity: { [k: string]: Json } = {
      id: frame.id,
      name: frame.name,
      xywh: xywh(frame.bounds),
    };
    if (frame.narrative !== null) {
      entity.narrative = frame.narrative;
      provenance.narrative = "declared";
    }
    if (frame.order !== null) {
      entity.order = frame.order;
      provenance.order = "declared";
    }
    if (Object.keys(provenance).length) entity.provenance = provenance;
    return entity;
  });

  const chunks: string[] = [
    ` "docent": 1`,
    ` "provenanceDefault": "explicit"`,
  ];
  if (Object.keys(legendRecord).length) {
    chunks.push(` "legend": ${stableStringify(legendRecord)}`);
  }
  const section = (name: string, entities: Json[]): void => {
    if (!entities.length && name !== "nodes") return;
    const body = entities.map((e) => `  ${stableStringify(e)}`).join(",\n");
    chunks.push(entities.length ? ` "${name}": [\n${body}\n ]` : ` "${name}": []`);
  };
  section("nodes", nodes);
  section("edges", edges);
  section("frames", frames);
  section(
    "groups",
    graph.groups.map((g) => ({ id: g.id, members: [...g.members] })),
  );
  return `{\n${chunks.join(",\n")}\n}\n`;
}
