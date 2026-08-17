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
    | "shape";
  /** Exact attribute value, e.g. "dashed", "#a5d8ff", "ellipse", "4". */
  value: string;
  /** Semantic key the match declares, e.g. "channel", "kind", "tag". */
  key: string;
  /** Semantic value, e.g. "async", "datastore", "hot-path". */
  meaning: string;
}

export interface DocentElementData {
  detailFrameId: string | null;
  tags: string[];
  note: string | null;
  narrative: string | null;
  order: number | null;
  /** Present only on the legend carrier element. */
  legend: LegendRule[] | null;
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
      rules.push({ attr: attr as LegendRule["attr"], value, key, meaning });
    }
  }
  return rules;
}

function parseDocent(customData: unknown): DocentElementData {
  const empty: DocentElementData = {
    detailFrameId: null,
    tags: [],
    note: null,
    narrative: null,
    order: null,
    legend: null,
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
  return {
    detailFrameId: detail ? asString(detail.frameId) : null,
    tags,
    note: asString(d.note),
    narrative: asString(d.narrative),
    order:
      typeof d.order === "number" && Number.isFinite(d.order) ? d.order : null,
    legend: parseLegendRules(d.legend),
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
