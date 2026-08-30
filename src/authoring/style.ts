/**
 * How an agent's drawing comes to look like the author's (S19, D59).
 * Meaning arrives as a `kind`; the look is resolved in two steps — the
 * legend first (the inverse of export: a kind whose rule maps a style gets
 * that style), then the diagram's own conventions, read off what is
 * already drawn. Pure: snapshot + graph in, a style out.
 */
import type { LegendRule, SceneSnapshot, SnapshotElement } from "../adapter/snapshot";
import type { WriteStyle } from "../adapter/excalidraw";
import { applyLegend } from "../export/legend";
import type { GraphNode, SceneGraph } from "../scene/graph";

export type Shape = "rectangle" | "ellipse" | "diamond";

/** Excalidraw's defaults — what a fresh canvas draws with. */
export const DEFAULT_STYLE: WriteStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  // Architect ink (D143): single-pass strokes — a rougher hand draws each
  // stroke twice, and a long arrow wearing two lines reads as two arrows.
  roughness: 0,
  roundness: 3,
  opacity: 100,
  fontFamily: 5,
  fontSize: 20,
};

export interface ArrowLook {
  style: WriteStyle;
  startArrowhead: string | null;
  endArrowhead: string | null;
}

/** The most common value of a field over some elements, or undefined. */
function mode<T extends string | number | null>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | undefined;
  let top = 0;
  for (const [v, n] of counts) {
    if (n > top) {
      top = n;
      best = v;
    }
  }
  return best;
}

const SHAPES = new Set<string>(["rectangle", "ellipse", "diamond"]);

/** The prevailing look of some elements; `base` fills what they do not say. */
function lookOf(elements: SnapshotElement[], base: WriteStyle): WriteStyle {
  if (!elements.length) return base;
  // Sharp corners are `null` on the element; 0 stands in so "most are
  // sharp" can win the vote like any other value.
  const roundness = mode(elements.map((e) => e.look.roundness ?? 0));
  return {
    strokeColor: mode(elements.map((e) => e.strokeColor)) ?? base.strokeColor,
    backgroundColor: mode(elements.map((e) => e.backgroundColor)) ?? base.backgroundColor,
    fillStyle: mode(elements.map((e) => e.fillStyle)) ?? base.fillStyle,
    strokeWidth: mode(elements.map((e) => e.strokeWidth)) ?? base.strokeWidth,
    strokeStyle: mode(elements.map((e) => e.strokeStyle)) ?? base.strokeStyle,
    // The vote learns everything but the hand: architect ink is pinned (D143).
    roughness: 0,
    roundness: roundness === undefined ? base.roundness : roundness === 0 ? null : roundness,
    opacity: mode(elements.map((e) => e.opacity)) ?? base.opacity,
    fontFamily: base.fontFamily,
    fontSize: base.fontSize,
  };
}

/**
 * The diagram's conventions: the look of its shapes, texts, and arrows, and
 * — per legend kind — the shape and look the author uses for that kind.
 */
export interface HouseStyle {
  shape: WriteStyle;
  text: WriteStyle;
  arrow: ArrowLook;
  /** Per kind: what the author draws that kind as. */
  kinds: Map<string, { shape: Shape; style: WriteStyle }>;
  /** The shape most components are drawn as. */
  defaultShape: Shape;
}

/**
 * The groups a placed symbol owns (D83): the icon's brand drawing, the
 * invisible carrier on its bounds, and the label Docent wrote. None of it is
 * the author's hand — the icon keeps its own colours by decision and the
 * rest was dressed by the house already — so none of it votes on what the
 * house style is.
 */
function symbolGroups(elements: readonly SnapshotElement[]): Set<string> {
  const groups = new Set<string>();
  for (const el of elements) {
    if (el.docent.symbol !== null) for (const g of el.groupIds) groups.add(g);
  }
  return groups;
}

export function houseStyle(snapshot: SceneSnapshot, graph: SceneGraph): HouseStyle {
  // The legend's own drawing is styled by its rules, not by the author's
  // hand: it must not vote. Nor may a placed symbol's parts (D83).
  const drawn = symbolGroups(snapshot.elements);
  const live = snapshot.elements.filter(
    (el) =>
      el.docent.legend === null &&
      !el.docent.legendSample &&
      !el.groupIds.some((g) => drawn.has(g)),
  );
  const shapes = live.filter((el) => SHAPES.has(el.type));
  const arrows = live.filter((el) => el.type === "arrow");
  const arrowIds = new Set(arrows.map((a) => a.id));
  // A label on an arrow is set in the arrow font, not the label font: it
  // votes for the arrow's, never for the shapes'.
  const boundTexts = live.filter((el) => el.type === "text" && el.containerId && !arrowIds.has(el.containerId));
  const arrowTexts = live.filter((el) => el.type === "text" && el.containerId && arrowIds.has(el.containerId));
  const freeTexts = live.filter((el) => el.type === "text" && !el.containerId);

  const shapeStyle = lookOf(shapes, DEFAULT_STYLE);
  const labelFont = {
    fontFamily: mode(boundTexts.map((t) => t.look.fontFamily)) ?? DEFAULT_STYLE.fontFamily,
    fontSize: mode(boundTexts.map((t) => t.look.fontSize)) ?? DEFAULT_STYLE.fontSize,
  };
  const shape = { ...shapeStyle, ...labelFont };
  const text: WriteStyle = {
    ...DEFAULT_STYLE,
    strokeColor: mode(freeTexts.map((t) => t.strokeColor)) ?? DEFAULT_STYLE.strokeColor,
    fontFamily: mode(freeTexts.map((t) => t.look.fontFamily)) ?? labelFont.fontFamily,
    fontSize: mode(freeTexts.map((t) => t.look.fontSize)) ?? labelFont.fontSize,
    opacity: mode(freeTexts.map((t) => t.opacity)) ?? 100,
  };
  const arrowStyle = lookOf(arrows, { ...DEFAULT_STYLE, backgroundColor: "transparent" });
  const arrowType = mode(arrows.map((a) => a.look.arrowType)) ?? "round";
  const arrow: ArrowLook = {
    style: {
      ...arrowStyle,
      roundness: arrowType === "sharp" ? null : 2,
      fontFamily: mode(arrowTexts.map((t) => t.look.fontFamily)) ?? labelFont.fontFamily,
      fontSize: mode(arrowTexts.map((t) => t.look.fontSize)) ?? Math.max(12, labelFont.fontSize - 4),
    },
    startArrowhead: arrows.length ? (mode(arrows.map((a) => a.look.startArrowhead ?? "none")) ?? "none") : "none",
    endArrowhead: arrows.length ? (mode(arrows.map((a) => a.look.endArrowhead ?? "none")) ?? "arrow") : "arrow",
  };
  if (arrow.startArrowhead === "none") arrow.startArrowhead = null;
  if (arrow.endArrowhead === "none") arrow.endArrowhead = null;

  // Per kind: the shapes the author drew that kind as, and their look.
  const kinds = new Map<string, { shape: Shape; style: WriteStyle }>();
  const byKind = new Map<string, SnapshotElement[]>();
  const bySource = new Map(live.map((el) => [el.id, el]));
  for (const node of graph.nodes) {
    const kind = applyLegend(node.style, node.shape, graph.legend, node.symbol).kind;
    const el = bySource.get(node.sourceId);
    if (!kind || !el || !SHAPES.has(el.type)) continue;
    const list = byKind.get(kind) ?? [];
    list.push(el);
    byKind.set(kind, list);
  }
  for (const [kind, els] of byKind) {
    kinds.set(kind, {
      shape: (mode(els.map((e) => e.type)) ?? "rectangle") as Shape,
      style: { ...lookOf(els, shape), ...labelFont },
    });
  }
  return {
    shape,
    text,
    arrow,
    kinds,
    defaultShape: (mode(shapes.map((s) => s.type)) ?? "rectangle") as Shape,
  };
}

/** What the legend says a kind looks like: every rule mapping `kind: K`, applied. */
export function styleForKind(kind: string, legend: readonly LegendRule[], base: WriteStyle, baseShape: Shape): { shape: Shape; style: WriteStyle; declared: boolean; symbol: string | null } {
  let style = { ...base };
  let shape = baseShape;
  let declared = false;
  // A kind may mean a library icon rather than a fill (D84): then the look
  // IS the symbol, and the house dresses only its label.
  let symbol: string | null = null;
  for (const rule of legend) {
    if (rule.key !== "kind" || rule.meaning !== kind) continue;
    declared = true;
    const conditions = [{ attr: rule.attr, value: rule.value }, ...(rule.also ?? [])];
    for (const c of conditions) {
      if (c.attr === "shape") {
        if (SHAPES.has(c.value)) shape = c.value as Shape;
      } else if (c.attr === "symbol") {
        symbol = c.value;
      } else if (c.attr === "strokeWidth") {
        style.strokeWidth = Number(c.value) || style.strokeWidth;
      } else {
        style = { ...style, [c.attr]: c.value };
      }
    }
  }
  return { shape, style, declared, symbol };
}

/**
 * Resolve a component's look from its kind: the legend rule when there is
 * one, else what the author draws that kind as, else the house shape.
 */
export function resolveLook(
  kind: string | null,
  house: HouseStyle,
  legend: readonly LegendRule[],
): { shape: Shape; style: WriteStyle; source: "legend" | "house-kind" | "house"; symbol?: string } {
  if (kind) {
    const fromLegend = styleForKind(kind, legend, house.kinds.get(kind)?.style ?? house.shape, house.kinds.get(kind)?.shape ?? house.defaultShape);
    // A kind the legend maps to a symbol is drawn as that icon (D84).
    if (fromLegend.declared) {
      return { shape: fromLegend.shape, style: fromLegend.style, source: "legend", ...(fromLegend.symbol ? { symbol: fromLegend.symbol } : {}) };
    }
    const seen = house.kinds.get(kind);
    if (seen) return { shape: seen.shape, style: seen.style, source: "house-kind" };
  }
  return { shape: house.defaultShape, style: house.shape, source: "house" };
}

/** Whether two styles read as the same legend match — what `kind` would export as. */
export function kindOf(style: WriteStyle, shape: Shape, legend: readonly LegendRule[]): string | null {
  const node: GraphNode["style"] = {
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    strokeStyle: style.strokeStyle,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
  };
  return applyLegend(node, shape, legend).kind;
}

/**
 * A distinct fill for a kind the legend does not know yet (`define_kind`
 * without a style): the first of a fixed, legible palette not in use.
 */
const PALETTE = ["#a5d8ff", "#b2f2bb", "#ffec99", "#d0bfff", "#ffc9c9", "#99e9f2", "#ffd8a8", "#eebefa", "#c0eb75", "#bac8ff"];

export function freshFill(taken: Iterable<string>): string {
  const used = new Set(taken);
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[0];
}
