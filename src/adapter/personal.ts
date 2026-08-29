/**
 * The personal library's catalog entries (D130): the NAMED items of the
 * person's own Excalidraw library, measured the way the generator measures
 * the bundled shelves (D81) so one vocabulary reads one way. Naming an item
 * is the teaching act — an unnamed item stays a drawing and never enters.
 *
 * Pure over raw element records; in the adapter because raw shapes are the
 * adapter's to read (B1), but importing nothing of it.
 */
import type { SymbolEntry } from "../libraries/catalog";

/** The slice of a library item this builder reads. */
export interface PersonalItem {
  id: string;
  name?: string | null;
  elements: readonly {
    type?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    text?: unknown;
  }[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function bounds(els: PersonalItem["elements"]): { x: number; y: number; width: number; height: number } {
  const xs = els.map((e) => num(e.x));
  const ys = els.map((e) => num(e.y));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.round(Math.max(...els.map((e) => num(e.x) + num(e.width))) - x),
    height: Math.round(Math.max(...els.map((e) => num(e.y) + num(e.height))) - y),
  };
}

/**
 * Runtime catalog entries for the person's items — named, not bundled, and
 * with something drawn in them. `index` is the entry's position in the
 * RETURNED list; the adapter keeps the matching elements at the same
 * positions, which is how a `my/` symbol is resolved when it is placed.
 */
export function buildPersonalEntries(
  items: readonly PersonalItem[],
  excludeItemIds: ReadonlySet<string>,
): { entries: SymbolEntry[]; drawings: PersonalItem["elements"][] } {
  const entries: SymbolEntry[] = [];
  const drawings: PersonalItem["elements"][] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    const name = (item.name ?? "").trim();
    if (!name || excludeItemIds.has(item.id) || !item.elements.length) continue;
    // The generator's own split (D81): texts are the caption, the rest is
    // the glyph — so a personal entry measures like a bundled one.
    const glyph = item.elements.filter((e) => e.type !== "text");
    const texts = item.elements.filter((e) => e.type === "text");
    if (!glyph.length) continue;
    const all = bounds(item.elements);
    const icon = bounds(glyph);
    let symbol = `my/${slug(name)}`;
    const taken = seen.get(symbol) ?? 0;
    seen.set(symbol, taken + 1);
    if (taken) symbol = `${symbol}-${taken + 1}`;
    entries.push({
      symbol,
      name,
      library: "personal",
      index: entries.length,
      itemId: item.id,
      category: "personal",
      icon: {
        width: icon.width,
        height: icon.height,
        x: Math.round(icon.x - all.x),
        y: Math.round(icon.y - all.y),
      },
      size: { width: all.width, height: all.height },
      caption: texts.length ? String(texts[0].text ?? "") : null,
      aliases: [],
    });
    drawings.push(item.elements);
  }
  return { entries, drawings };
}
