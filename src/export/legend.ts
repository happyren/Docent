/**
 * Legend application (D9): declared style→meaning mappings convert styling
 * into semantics. Styling a rule matches is exported as meaning with
 * `declared` provenance; styling no rule matches is stripped as noise.
 * Styling is only noise if the legend says so.
 */
import type { LegendRule } from "../adapter/snapshot";
import type { GraphNode } from "../scene/graph";

export interface LegendFacts {
  /** From rules with key "kind" (e.g. datastore). Last match wins. */
  kind: string | null;
  /** From rules with key "tag". */
  tags: string[];
  /** Any other key → meaning (e.g. channel: async). */
  props: Record<string, string>;
}

export function applyLegend(
  style: GraphNode["style"],
  shape: string,
  legend: readonly LegendRule[],
): LegendFacts {
  const facts: LegendFacts = { kind: null, tags: [], props: {} };
  for (const rule of legend) {
    const actual =
      rule.attr === "shape" ? shape : String(style[rule.attr] ?? "");
    if (actual !== rule.value) continue;
    if (rule.key === "kind") {
      facts.kind = rule.meaning;
    } else if (rule.key === "tag") {
      if (!facts.tags.includes(rule.meaning)) facts.tags.push(rule.meaning);
    } else {
      facts.props[rule.key] = rule.meaning;
    }
  }
  return facts;
}

/** Sidecar legend serialization: `stroke.dashed` → `channel: async`. */
const ATTR_PREFIX: Record<LegendRule["attr"], string> = {
  strokeStyle: "stroke",
  strokeColor: "color",
  backgroundColor: "fill",
  fillStyle: "fillStyle",
  strokeWidth: "strokeWidth",
  shape: "shape",
};

export function legendToRecord(
  legend: readonly LegendRule[],
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const rule of legend) {
    record[`${ATTR_PREFIX[rule.attr]}.${rule.value}`] =
      `${rule.key}: ${rule.meaning}`;
  }
  return record;
}
