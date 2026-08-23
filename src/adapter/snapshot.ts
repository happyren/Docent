/**
 * Pure raw-element → typed snapshot mapping. Inside the adapter boundary
 * (B1): this file is one of the two places allowed to read raw Excalidraw
 * element shapes (including `customData`). It imports nothing from
 * `@excalidraw/excalidraw`, so the scene graph and exporters built on top of
 * it run in Node (golden tests, CI) as well as in the browser.
 *
 * All Docent-written data lives under `customData.docent.*` (D15).
 */

export interface LegendRule {
  /** Style attribute the rule matches. */
  attr:
    | "strokeStyle"
    | "strokeColor"
    | "backgroundColor"
    | "fillStyle"
    | "strokeWidth"
    | "shape"
    /** The library symbol a component is drawn as (D84). */
    | "symbol";
  /** Exact attribute value, e.g. "dashed", "#a5d8ff", "ellipse", "aws/lambda". */
  value: string;
  /**
   * Additional conditions for composite rules — the rule matches only when
   * the primary attr/value AND every entry here match (e.g. rectangle +
   * solid #1e1e1e stroke + width 2 → kind: service). Absent for simple
   * rules, keeping their serialized form (and every existing file) intact.
   */
  also?: { attr: LegendRule["attr"]; value: string }[];
  /** Semantic key the match declares, e.g. "channel", "kind", "tag". */
  key: string;
  /** Semantic value, e.g. "async", "datastore", "hot-path". */
  meaning: string;
}

export interface DocentElementData {
  detailFrameId: string | null;
  tags: string[];
  /**
   * The first declared intent — kept as its own field because a single
   * intent is stored as `note` (D41), which is what every file before A8
   * wrote and what every reader before A8 understands.
   */
  note: string | null;
  /** Every declared intent, in order; `note` is always `intents[0]`. */
  intents: string[];
  /** Free-form pseudocode or rules for what this element does (D42). */
  logic: string | null;
  narrative: string | null;
  order: number | null;
  /** Present only on the legend carrier element. */
  legend: LegendRule[] | null;
  /**
   * A drawn legend sample or its label (D69): part of the legend's picture,
   * never a component or an edge.
   */
  legendSample: boolean;
  /**
   * Declared cross-tier edge refinement (D21): which inner component of a
   * bound endpoint's detail diagram this edge actually lands on (`to`) or
   * departs from (`from`). Validated against the live graph at read time.
   */
  refine: { to: string | null; from: string | null } | null;
  /**
   * Declared grouped-composite overrides (D22), keyed by group id: true =
   * that group is ONE component, false = keep its members separate. A
   * group with no entry falls to the glyph-signature heuristic. Keying by
   * group is what lets an author split an outer grouping of several icons
   * while each icon inside stays whole.
   */
  composite: Record<string, boolean>;
  /**
   * The library symbol this element is the carrier of (D83): an invisible
   * rectangle on a placed icon's bounds IS the component — arrows bind to
   * it, its meaning is the component's, and its id is the stable one.
   */
  symbol: string | null;
}

export interface SnapshotElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: string;
  fillStyle: string;
  strokeWidth: number;
  opacity: number;
  frameId: string | null;
  groupIds: string[];
  locked: boolean;
  text: string | null;
  containerId: string | null;
  boundElements: { id: string; type: string }[];
  points: [number, number][] | null;
  startBindingId: string | null;
  endBindingId: string | null;
  name: string | null;
  link: string | null;
  docent: DocentElementData;
  /**
   * The look beyond what the legend reads (D59): what a new element of the
   * same kind or type inherits so an agent's drawing matches the author's.
   */
  look: ElementLook;
}

export interface ElementLook {
  roughness: number;
  /** Excalidraw's roundness type, or null for sharp corners. */
  roundness: number | null;
  fontFamily: number | null;
  fontSize: number | null;
  textAlign: string | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
  /** Arrow routing: `elbow`, `round` (curved), or `sharp`. */
  arrowType: string | null;
}

export interface SceneSnapshot {
  elements: SnapshotElement[];
}

const LEGEND_ATTRS = new Set([
  "strokeStyle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "shape",
  "symbol",
]);

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function parseLegendRules(v: unknown): LegendRule[] | null {
  if (!Array.isArray(v)) return null;
  const rules: LegendRule[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const attr = asString(r.attr);
    const value = asString(r.value);
    const key = asString(r.key);
    const meaning = asString(r.meaning);
    if (attr && LEGEND_ATTRS.has(attr) && value !== null && key && meaning !== null) {
      const rule: LegendRule = { attr: attr as LegendRule["attr"], value, key, meaning };
      if (Array.isArray(r.also)) {
        const also: NonNullable<LegendRule["also"]> = [];
        for (const rawCond of r.also) {
          if (typeof rawCond !== "object" || rawCond === null) continue;
          const c = rawCond as Record<string, unknown>;
          const cAttr = asString(c.attr);
          const cValue = asString(c.value);
          if (cAttr && LEGEND_ATTRS.has(cAttr) && cValue !== null) {
            also.push({ attr: cAttr as LegendRule["attr"], value: cValue });
          }
        }
        if (also.length) rule.also = also;
      }
      rules.push(rule);
    }
  }
  return rules;
}

function parseCompositeFlags(v: unknown): Record<string, boolean> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, boolean> = {};
  for (const [group, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === "boolean") out[group] = value;
  }
  return out;
}

function parseDocent(customData: unknown): DocentElementData {
  const empty: DocentElementData = {
    detailFrameId: null,
    tags: [],
    note: null,
    intents: [],
    logic: null,
    narrative: null,
    order: null,
    legend: null,
    legendSample: false,
    refine: null,
    composite: {},
    symbol: null,
  };
  if (typeof customData !== "object" || customData === null) return empty;
  const docent = (customData as Record<string, unknown>).docent;
  if (typeof docent !== "object" || docent === null) return empty;
  const d = docent as Record<string, unknown>;
  const detail =
    typeof d.detail === "object" && d.detail !== null
      ? (d.detail as Record<string, unknown>)
      : null;
  const tags = Array.isArray(d.tags)
    ? d.tags.filter((t): t is string => typeof t === "string")
    : [];
  const refineRaw =
    typeof d.refine === "object" && d.refine !== null
      ? (d.refine as Record<string, unknown>)
      : null;
  const refine = refineRaw
    ? { to: asString(refineRaw.to), from: asString(refineRaw.from) }
    : null;
  // Intents (D41): the `intents` list when written, else the lone `note`
  // as a one-item list. `note` stays the first intent either way.
  const listed = Array.isArray(d.intents)
    ? d.intents.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const note = asString(d.note);
  const intents = listed.length ? listed : note ? [note] : [];
  return {
    detailFrameId: detail ? asString(detail.frameId) : null,
    refine: refine && (refine.to || refine.from) ? refine : null,
    composite: parseCompositeFlags(d.composite),
    symbol: asString(d.symbol),
    tags,
    note: intents[0] ?? null,
    intents,
    logic: asString(d.logic),
    narrative: asString(d.narrative),
    order:
      typeof d.order === "number" && Number.isFinite(d.order) ? d.order : null,
    legend: parseLegendRules(d.legend),
    legendSample: d.legendSample === true,
  };
}

/** Map raw (already non-deleted-filtered or not) elements to the snapshot. */
export function snapshotFromRawElements(raw: readonly unknown[]): SceneSnapshot {
  const elements: SnapshotElement[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const el = item as Record<string, unknown>;
    if (el.isDeleted === true) continue;
    const id = asString(el.id);
    const type = asString(el.type);
    if (!id || !type) continue;
    const boundElements = Array.isArray(el.boundElements)
      ? el.boundElements
          .map((b) => {
            if (typeof b !== "object" || b === null) return null;
            const bb = b as Record<string, unknown>;
            const bid = asString(bb.id);
            const btype = asString(bb.type);
            return bid && btype ? { id: bid, type: btype } : null;
          })
          .filter((b): b is { id: string; type: string } => b !== null)
      : [];
    const points = Array.isArray(el.points)
      ? el.points
          .map((p) =>
            Array.isArray(p) && p.length >= 2
              ? ([asNumber(p[0]), asNumber(p[1])] as [number, number])
              : null,
          )
          .filter((p): p is [number, number] => p !== null)
      : null;
    const binding = (v: unknown): string | null => {
      if (typeof v !== "object" || v === null) return null;
      return asString((v as Record<string, unknown>).elementId);
    };
    elements.push({
      id,
      type,
      x: asNumber(el.x),
      y: asNumber(el.y),
      width: asNumber(el.width),
      height: asNumber(el.height),
      angle: asNumber(el.angle),
      strokeColor: asString(el.strokeColor) ?? "",
      backgroundColor: asString(el.backgroundColor) ?? "",
      strokeStyle: asString(el.strokeStyle) ?? "solid",
      fillStyle: asString(el.fillStyle) ?? "solid",
      strokeWidth: asNumber(el.strokeWidth, 1),
      opacity: asNumber(el.opacity, 100),
      frameId: asString(el.frameId),
      groupIds: Array.isArray(el.groupIds)
        ? el.groupIds.filter((g): g is string => typeof g === "string")
        : [],
      locked: el.locked === true,
      text: asString(el.text),
      containerId: asString(el.containerId),
      boundElements,
      points,
      startBindingId: binding(el.startBinding),
      endBindingId: binding(el.endBinding),
      name: asString(el.name),
      link: asString(el.link),
      look: {
        roughness: asNumber(el.roughness, 1),
        roundness:
          typeof el.roundness === "object" && el.roundness !== null
            ? asNumber((el.roundness as Record<string, unknown>).type, 3)
            : null,
        fontFamily: typeof el.fontFamily === "number" ? el.fontFamily : null,
        fontSize: typeof el.fontSize === "number" ? el.fontSize : null,
        textAlign: asString(el.textAlign),
        startArrowhead: asString(el.startArrowhead),
        endArrowhead: asString(el.endArrowhead),
        arrowType:
          type === "arrow"
            ? el.elbowed === true
              ? "elbow"
              : typeof el.roundness === "object" && el.roundness !== null
                ? "round"
                : "sharp"
            : null,
      },
      docent: parseDocent(el.customData),
    });
  }
  return { elements };
}

/** Parse a canonical `.excalidraw` file's JSON text into a snapshot. */
export function snapshotFromSceneJSON(json: string): SceneSnapshot {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
  return snapshotFromRawElements(elements);
}
