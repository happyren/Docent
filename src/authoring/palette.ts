/**
 * Colour means something (S20, D77).
 *
 * A kind's colour is not a slot in a list — it is either a *convention* the
 * reader already brings (green is fine, red is trouble, blue is where the
 * data sits) or, when the author names no convention, the fill that stands
 * furthest from every colour the legend already spends. Distance is
 * measured in CIELAB, where equal steps look like equal steps; definition
 * order is not a measure of anything. Past six kinds hue alone stops
 * separating, so a **second channel** — stroke style, then shape — is added
 * automatically (Bertin's answer to a palette that has run out).
 *
 * Pure and deterministic (I3), no dependencies (I7): colours in, a look out.
 */
import type { LegendRule } from "../adapter/snapshot";
import type { Shape } from "./style";

// ---------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------

/** What a kind *means* to a reader, before it means anything to the system. */
export type Tone = "positive" | "neutral" | "caution" | "danger" | "inactive";

/** What a kind *is* — the family of things it belongs to. */
export type Role = "storage" | "compute" | "messaging" | "external" | "people" | "boundary";

export const TONES: readonly Tone[] = ["positive", "neutral", "caution", "danger", "inactive"];
export const ROLES: readonly Role[] = ["storage", "compute", "messaging", "external", "people", "boundary"];

/** A fill and the darker stroke drawn with it, named the way a reader says it. */
export interface Swatch {
  /** An Excalidraw fill, or `"transparent"` for a boundary. */
  fill: string;
  /** The stroke that belongs with that fill — darker, so it reads in mono. */
  stroke: string;
  /** What the colour is called, for the legend's sentence. */
  name: string;
  /** Set only where the look needs it — a boundary and an inactive kind are dashed. */
  strokeStyle?: string;
}

/**
 * The base set: light fills that suit an Excalidraw shape, taken from
 * Excalidraw's own light ramp and kept to hues the Okabe–Ito and Tol-light
 * qualitative sets keep apart under the common dichromacies (blue, green,
 * amber, vermillion, violet, cyan, orange, grey). Every fill carries a
 * darker stroke, so the pair also separates by lightness — the one channel
 * every reader has. Order breaks ties only; the pick is by distance.
 */
export const BASE_SET: readonly Swatch[] = [
  { fill: "#a5d8ff", stroke: "#1971c2", name: "blue" },
  { fill: "#b2f2bb", stroke: "#2f9e44", name: "green" },
  { fill: "#ffec99", stroke: "#e8590c", name: "amber" },
  { fill: "#ffc9c9", stroke: "#e03131", name: "red" },
  { fill: "#d0bfff", stroke: "#6741d9", name: "violet" },
  { fill: "#99e9f2", stroke: "#0c8599", name: "cyan" },
  { fill: "#ffd8a8", stroke: "#d9480f", name: "orange" },
  { fill: "#eebefa", stroke: "#9c36b5", name: "grape" },
  { fill: "#c0eb75", stroke: "#66a80f", name: "lime" },
  { fill: "#bac8ff", stroke: "#4263eb", name: "indigo" },
  { fill: "#e9ecef", stroke: "#495057", name: "grey" },
  { fill: "#96f2d7", stroke: "#0ca678", name: "teal" },
  { fill: "#ffdeeb", stroke: "#c2255c", name: "pink" },
  { fill: "#ced4da", stroke: "#343a40", name: "slate" },
];

/** The conventional hue for each tone — what the reader already believes. */
export const TONE_LOOK: Readonly<Record<Tone, Swatch>> = {
  positive: { fill: "#b2f2bb", stroke: "#2f9e44", name: "green" },
  neutral: { fill: "#e9ecef", stroke: "#495057", name: "blue-grey" },
  caution: { fill: "#ffec99", stroke: "#e8590c", name: "amber" },
  danger: { fill: "#ffc9c9", stroke: "#e03131", name: "red" },
  // Inactive is the one tone hue cannot carry alone — grey is also what a
  // reader sees when nothing is meant — so it dashes as well (D77).
  inactive: { fill: "#f1f3f5", stroke: "#868e96", name: "grey", strokeStyle: "dashed" },
};

/** The hue family for each role; the member furthest from the legend wins. */
export const ROLE_FAMILIES: Readonly<Record<Role, readonly Swatch[]>> = {
  storage: [
    { fill: "#a5d8ff", stroke: "#1971c2", name: "blue" },
    { fill: "#bac8ff", stroke: "#4263eb", name: "indigo" },
    { fill: "#99e9f2", stroke: "#0c8599", name: "cyan" },
  ],
  compute: [
    { fill: "#ffec99", stroke: "#e8590c", name: "amber" },
    { fill: "#ffd8a8", stroke: "#d9480f", name: "orange" },
    { fill: "#fff3bf", stroke: "#f08c00", name: "pale yellow" },
  ],
  messaging: [
    { fill: "#d0bfff", stroke: "#6741d9", name: "violet" },
    { fill: "#eebefa", stroke: "#9c36b5", name: "grape" },
    { fill: "#e5dbff", stroke: "#7048e8", name: "pale violet" },
  ],
  external: [
    { fill: "#e9ecef", stroke: "#495057", name: "grey" },
    { fill: "#ced4da", stroke: "#343a40", name: "slate" },
    // Not the palest grey: that one belongs to the inactive tone, and an
    // external thing is not a retired one.
    { fill: "#dee2e6", stroke: "#868e96", name: "light grey" },
  ],
  people: [
    { fill: "#96f2d7", stroke: "#0ca678", name: "teal" },
    { fill: "#b2f2bb", stroke: "#2f9e44", name: "green" },
    { fill: "#c0eb75", stroke: "#66a80f", name: "lime" },
  ],
  // A boundary is not a thing on the canvas, it is a line around things:
  // no fill, and a dashed stroke that says "this edge is drawn, not built".
  boundary: [
    { fill: "transparent", stroke: "#495057", name: "dashed grey", strokeStyle: "dashed" },
    { fill: "transparent", stroke: "#1971c2", name: "dashed blue", strokeStyle: "dashed" },
    { fill: "transparent", stroke: "#9c36b5", name: "dashed grape", strokeStyle: "dashed" },
  ],
};

// ---------------------------------------------------------------------------
// sRGB → CIELAB, and the distance between two colours
// ---------------------------------------------------------------------------

/** D65 white point, the one sRGB is defined against. */
const WHITE: readonly [number, number, number] = [95.047, 100.0, 108.883];

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

/** sRGB's transfer function, undone: a displayed value back to light. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function pivot(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
}

/**
 * A hex colour as CIELAB (L*, a*, b*). Anything unparsable — including
 * `"transparent"` — is read as white, because white is what the canvas
 * shows through it.
 */
export function hexToLab(hex: string): [number, number, number] {
  let h = String(hex ?? "").trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-f]/.test(h)) h = "ffffff";
  const r = toLinear(channel(h, 0));
  const g = toLinear(channel(h, 2));
  const b = toLinear(channel(h, 4));
  // sRGB → XYZ (D65), scaled to 100 like the white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) * 100;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) * 100;
  const fx = pivot(x / WHITE[0]);
  const fy = pivot(y / WHITE[1]);
  const fz = pivot(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * How far apart two colours look — CIE76, the plain Euclidean distance in
 * CIELAB. CIEDE2000 is more faithful for near-identical pairs; the palette
 * only ever asks "are these two obviously different?", where CIE76 gives
 * the same ordering for a great deal less arithmetic (I3, I7).
 * Black to white is 100; a colour to itself is 0.
 */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

// ---------------------------------------------------------------------------
// reading the legend
// ---------------------------------------------------------------------------

/** Every condition a rule states, primary first. */
function conditions(rule: LegendRule): { attr: LegendRule["attr"]; value: string }[] {
  return [{ attr: rule.attr, value: rule.value }, ...(rule.also ?? [])];
}

function conditionValue(rule: LegendRule, attr: LegendRule["attr"]): string | null {
  return conditions(rule).find((c) => c.attr === attr)?.value ?? null;
}

/**
 * The colour a kind shows: its fill, or — when the fill is transparent, as
 * a boundary's is — the stroke that draws it. That is what a reader has to
 * tell apart, so that is what the distance is measured between.
 */
function swatchColour(swatch: Pick<Swatch, "fill" | "stroke">): string {
  return swatch.fill && swatch.fill !== "transparent" ? swatch.fill : swatch.stroke;
}

/** The rules that name a kind — the only ones a new kind must differ from. */
function kindRules(legend: readonly LegendRule[]): LegendRule[] {
  return legend.filter((r) => r.key === "kind");
}

/** The colours the legend's kinds already spend, in legend order. */
export function kindColours(legend: readonly LegendRule[]): string[] {
  const out: string[] = [];
  for (const rule of kindRules(legend)) {
    const fill = conditionValue(rule, "backgroundColor");
    const stroke = conditionValue(rule, "strokeColor");
    const colour = fill && fill !== "transparent" ? fill : (stroke ?? fill);
    if (colour) out.push(colour);
  }
  return out;
}

/**
 * The least distance between any two kinds in the legend — the number D76's
 * craft score reads as "the legend's least colour distance". `Infinity`
 * when there are fewer than two kinds: nothing can collide with nothing.
 */
export function minKindDistance(legend: readonly LegendRule[]): number {
  const colours = kindColours(legend);
  let least = Infinity;
  for (let i = 0; i < colours.length; i += 1) {
    for (let j = i + 1; j < colours.length; j += 1) {
      least = Math.min(least, deltaE(colours[i], colours[j]));
    }
  }
  return least;
}

/** How far the nearest taken colour is; `Infinity` when nothing is taken. */
function leastDistance(colour: string, taken: readonly string[]): number {
  let least = Infinity;
  for (const other of taken) least = Math.min(least, deltaE(colour, other));
  return least;
}

/** The candidate standing furthest from everything taken; ties keep order. */
function furthest(candidates: readonly Swatch[], taken: readonly string[]): Swatch {
  let best = candidates[0];
  let bestAt = -1;
  for (const candidate of candidates) {
    const at = leastDistance(swatchColour(candidate), taken);
    if (at > bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// tags that colour themselves
// ---------------------------------------------------------------------------

const TAG_TONES: Readonly<Record<string, Tone>> = {
  "hot-path": "danger",
  hotpath: "danger",
  critical: "danger",
  urgent: "danger",
  incident: "danger",
  deprecated: "inactive",
  legacy: "inactive",
  retired: "inactive",
  obsolete: "inactive",
  draft: "caution",
  experimental: "caution",
  todo: "caution",
  wip: "caution",
  healthy: "positive",
  ok: "positive",
  done: "positive",
  pass: "positive",
};

/**
 * The tone a conventional tag name already carries. `hot path`, `hot-path`
 * and `HOT_PATH` are one tag to a reader, so they are one tag here.
 * Unknown names get no tone — an invented tag means nothing to a reader
 * either, and a colour would be a lie.
 */
export function toneOfTag(tag: string): Tone | null {
  const key = String(tag ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return TAG_TONES[key] ?? null;
}

/** The look a tag's tone draws with — a stroke, and a dash when inactive. */
export function toneLook(tone: Tone): Swatch {
  return TONE_LOOK[tone];
}

// ---------------------------------------------------------------------------
// picking a kind's look
// ---------------------------------------------------------------------------

export interface PickKindLookArgs {
  /** The kind being defined — what the sentence in the legend is about. */
  kind: string;
  /** What it means to a reader; wins over `role` when both are given. */
  tone?: Tone | null;
  /** What family of thing it is, when no tone applies. */
  role?: Role | null;
  /** The legend as it stands — every rule, kind rules and others alike. */
  taken: readonly LegendRule[];
  /** A shape the caller already chose, so the second channel does not spend it. */
  shape?: Shape | null;
}

export interface KindLook {
  backgroundColor: string;
  strokeColor: string;
  /** Present only when the look needs one — dashed, dotted. */
  strokeStyle?: string;
  /** Present only when the look needs one; Excalidraw's default is solid. */
  fillStyle?: string;
  /** Present only when a shape is what separates this kind from the rest. */
  shape?: Shape;
  /** What actually separates it: hue alone, or hue plus a second channel. */
  channel: "hue" | "hue+stroke" | "hue+shape";
  /** One sentence, for the note and the legend: what was chosen and why. */
  why: string;
}

const SHAPE_ORDER: readonly Shape[] = ["rectangle", "ellipse", "diamond"];
const STROKE_STYLES: readonly string[] = ["dashed", "dotted"];

/** Past six, hue alone no longer separates a new kind from the rest (D77). */
const HUE_ONLY_LIMIT = 6;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * The look a new kind should wear: the conventional hue when the author
 * named a tone or a role, otherwise the base fill furthest from every kind
 * the legend already draws — plus a second channel once hue has run out.
 */
export function pickKindLook(args: PickKindLookArgs): KindLook {
  const { tone, role, taken } = args;
  const rules = kindRules(taken);
  const colours = kindColours(taken);

  let swatch: Swatch;
  let why: string;
  if (tone) {
    swatch = TONE_LOOK[tone];
    why = `${tone} tone → ${swatch.name}`;
  } else if (role) {
    swatch = furthest(ROLE_FAMILIES[role], colours);
    why = `${role} family, ${swatch.name}`;
  } else {
    swatch = furthest(BASE_SET, colours);
    why = `${swatch.name}, the fill furthest from the legend's others`;
  }

  const ownStrokeStyle = swatch.strokeStyle ?? "solid";
  const usedStrokeStyles = new Set(rules.map((r) => conditionValue(r, "strokeStyle") ?? "solid"));
  const usedShapes = new Set(rules.map((r) => conditionValue(r, "shape")).filter((s): s is string => s !== null));
  // A kind that would draw exactly like one already in the legend is a
  // collision whatever the count says, so it gets a second channel too.
  const signature = `${swatch.fill}|${ownStrokeStyle}|${args.shape ?? ""}`;
  const collides = rules.some(
    (r) =>
      `${conditionValue(r, "backgroundColor") ?? ""}|${conditionValue(r, "strokeStyle") ?? "solid"}|${conditionValue(r, "shape") ?? ""}` === signature,
  );
  const nth = rules.length + 1;

  let strokeStyle = swatch.strokeStyle;
  let shape: Shape | undefined;
  const needsSecond = nth > HUE_ONLY_LIMIT || collides;
  // A look that is already dashed and dashes alone carries its own second
  // channel; only reach for another when this one is spoken for.
  if (needsSecond && (ownStrokeStyle === "solid" || usedStrokeStyles.has(ownStrokeStyle))) {
    const free = STROKE_STYLES.find((s) => s !== ownStrokeStyle && !usedStrokeStyles.has(s));
    if (free) {
      strokeStyle = free;
      why += `; ${ordinal(nth)} kind → ${free} stroke added`;
    } else if (!args.shape) {
      const freeShape = SHAPE_ORDER.find((s) => !usedShapes.has(s));
      shape = freeShape ?? SHAPE_ORDER[(nth - 1) % SHAPE_ORDER.length];
      why += `; ${ordinal(nth)} kind → ${shape} shape added`;
    } else {
      why += `; ${ordinal(nth)} kind → hue alone, the palette's channels are spent`;
    }
  }

  const look: KindLook = {
    backgroundColor: swatch.fill,
    strokeColor: swatch.stroke,
    channel: shape ? "hue+shape" : strokeStyle && strokeStyle !== "solid" ? "hue+stroke" : "hue",
    why,
  };
  if (strokeStyle && strokeStyle !== "solid") look.strokeStyle = strokeStyle;
  if (shape) look.shape = shape;
  return look;
}
