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

const matchesCondition = (
  style: GraphNode["style"],
  shape: string,
  attr: LegendRule["attr"],
  value: string,
): boolean =>
  (attr === "shape" ? shape : String(style[attr] ?? "")) === value;

export function applyLegend(
  style: GraphNode["style"],
  shape: string,
  legend: readonly LegendRule[],
): LegendFacts {
  const facts: LegendFacts = { kind: null, tags: [], props: {} };
  // Composite rules (primary + `also` conditions) match only when every
  // condition holds. Evaluation runs in ascending specificity (condition
  // count, then legend order), so a more specific rule overwrites a
  // generic one for the same key — "rectangle + solid + width 2 →
  // kind: service" beats "rectangle → kind: node". Deterministic (I3).
  const ordered = legend
    .map((rule, index) => ({ rule, index, arity: 1 + (rule.also?.length ?? 0) }))
    .sort((a, b) => a.arity - b.arity || a.index - b.index);
  for (const { rule } of ordered) {
    if (!matchesCondition(style, shape, rule.attr, rule.value)) continue;
    if (rule.also?.some((c) => !matchesCondition(style, shape, c.attr, c.value)))
      continue;
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
    // Composite rules join their conditions with "+" in author order.
    const conditions = [
      `${ATTR_PREFIX[rule.attr]}.${rule.value}`,
      ...(rule.also ?? []).map((c) => `${ATTR_PREFIX[c.attr]}.${c.value}`),
    ].join("+");
    record[conditions] = `${rule.key}: ${rule.meaning}`;
  }
  return record;
}
