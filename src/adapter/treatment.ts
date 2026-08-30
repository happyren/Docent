/**
 * The house treatment (D120): what an AGENT-placed library drawing is
 * normalized to before it joins the scene. Scribble fills become solid,
 * roughness comes down to the canvas's own hand, a stroke heavier than the
 * house weight comes down to it — and every colour is kept, because the hue
 * is the brand and the brand is meaning.
 *
 * This lives on the agent's write path (B4) and nowhere else: a person's own
 * insertions — sidebar drags, imported libraries — are never touched (D86's
 * rule, restated for style). Pure over raw element records, which is why it
 * sits in the adapter (B1 owns raw shapes) but imports nothing.
 */

/** The fields the treatment reads and writes; everything else passes through. */
interface TreatableElement {
  fillStyle?: unknown;
  roughness?: unknown;
  strokeWidth?: unknown;
}

const SCRIBBLE_FILLS = new Set(["hachure", "cross-hatch", "zigzag"]);

/** Architect ink (D143): the single-pass hand, and only it. */
const HOUSE_ROUGHNESS = 0;
/** The house stroke weight (A31): bold, and no bolder. */
const HOUSE_WEIGHT = 2;

/**
 * One element, dressed. A new record whenever anything changes; the same
 * record when nothing does, so a cache never sees a needless copy.
 */
export function treatElement<T extends TreatableElement>(element: T): T {
  const patch: Partial<TreatableElement> = {};
  if (typeof element.fillStyle === "string" && SCRIBBLE_FILLS.has(element.fillStyle)) {
    patch.fillStyle = "solid";
  }
  if (typeof element.roughness === "number" && element.roughness > HOUSE_ROUGHNESS) {
    patch.roughness = HOUSE_ROUGHNESS;
  }
  if (typeof element.strokeWidth === "number" && element.strokeWidth > HOUSE_WEIGHT) {
    patch.strokeWidth = HOUSE_WEIGHT;
  }
  return Object.keys(patch).length ? { ...element, ...patch } : element;
}

/** A whole drawing, dressed (D120). */
export function houseTreatment<T extends TreatableElement>(elements: readonly T[]): T[] {
  return elements.map(treatElement);
}
