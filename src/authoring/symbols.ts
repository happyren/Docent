/**
 * The bundled symbol catalog, in the pure layer (S21, D81, D83). A component
 * may BE a library icon: `add_node({symbol})` places the item's own drawing,
 * an invisible carrier on the icon's bounds that arrows bind to and meaning
 * lives on, and the agent's label under it in the house font.
 *
 * The catalog is generated and checked in (D81), so reading it here is a
 * compile-time import and not a runtime parse — pure and deterministic (I3),
 * no new dependency (I7). Only what an agent's write needs is read: the
 * item's address in its library and its measurements; the geometry of the
 * drawing itself stays in the library file, where the adapter reads it.
 */
import catalog from "../../public/libraries/catalog.json";
import { CHAR_EM, wrapLabel, type Box, type Size } from "./layout";

export interface SymbolEntry {
  /** Library slug + name slug, e.g. `aws/lambda` (D81). */
  symbol: string;
  name: string;
  /** The `.excalidrawlib` the item comes from, without its extension. */
  library: string;
  /** The item's index in that file — how the adapter finds its elements. */
  index: number;
  itemId: string;
  category: string;
  /** The glyph's bounds without the caption, relative to the whole item. */
  icon: { width: number; height: number; x: number; y: number };
  /** The whole item, caption included — the component's native size (D85). */
  size: { width: number; height: number };
  caption: string | null;
  aliases: string[];
}

const SYMBOLS: readonly SymbolEntry[] = (catalog as { symbols: SymbolEntry[] }).symbols;
const BY_ID = new Map(SYMBOLS.map((entry) => [entry.symbol, entry]));

/** The catalog entry for a symbol id, or null when the catalog has no such item. */
export function symbolEntry(symbol: string): SymbolEntry | null {
  return BY_ID.get(symbol.trim().toLowerCase()) ?? null;
}

/** Every symbol id the catalog knows, in catalog order. */
export function symbolIds(): string[] {
  return SYMBOLS.map((entry) => entry.symbol);
}

/**
 * The libraries' captions are Virgil at 20px, line height 1.2, and sit at
 * the BOTTOM of the item's box — which is how the caption's own offset is
 * recovered from the catalog's `size` without reading the library file.
 */
const CAPTION_LINE = 24;
/** Excalifont's line height: what the converter draws a label at. */
const LABEL_LINE = 1.25;
/** A label may run a little wider than the icon before it wraps (D83). */
const LABEL_OVERHANG = 24;
/** Where the label goes under an icon whose library gave it no caption. */
const LABEL_GAP = 8;

/**
 * Where the pieces of a symbol component go, relative to the component's own
 * top-left. The component's box is the item's native size (D85) grown to
 * hold the agent's label when that runs longer than the library's caption;
 * the label is wrapped to the icon's width and drawn where the library puts
 * the caption it replaces (D83).
 */
export interface SymbolPlacement {
  entry: SymbolEntry;
  /** The whole component: what placement, routing and frame growth see. */
  size: Size;
  /** Where the library item's own top-left sits inside that box. */
  item: { x: number; y: number };
  /** The icon's bounds — the carrier's box, what arrows bind to (D83). */
  icon: Box;
  /** The label's lines and the box they take. */
  label: Box & { lines: string[] };
}

export function placeSymbol(entry: SymbolEntry, label: string, fontSize: number): SymbolPlacement {
  const wrapAt = Math.max(4, Math.floor((entry.icon.width + LABEL_OVERHANG) / (fontSize * CHAR_EM)));
  const lines = wrapLabel(label, wrapAt);
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 0);
  const labelWidth = Math.ceil(longest * fontSize * CHAR_EM);
  const labelHeight = Math.ceil(Math.max(1, lines.length) * fontSize * LABEL_LINE);
  // The caption is bottom-anchored in the item's box, so its top is the
  // item's height less the lines it takes; an item with no caption gets a
  // band of its own under the glyph.
  const captionLines = entry.caption ? entry.caption.split("\n").length : 0;
  const labelY = captionLines
    ? entry.size.height - captionLines * CAPTION_LINE
    : entry.icon.y + entry.icon.height + LABEL_GAP;
  // Centred on the icon, and the box grown to whatever that reaches past.
  const centre = entry.icon.x + entry.icon.width / 2;
  const left = Math.min(0, Math.round(centre - labelWidth / 2));
  const right = Math.max(entry.size.width, Math.round(centre + labelWidth / 2));
  const bottom = Math.max(entry.size.height, labelY + labelHeight);
  return {
    entry,
    size: { width: right - left, height: bottom },
    item: { x: -left, y: 0 },
    icon: { x: -left + entry.icon.x, y: entry.icon.y, width: entry.icon.width, height: entry.icon.height },
    label: { x: -left + Math.round(centre - labelWidth / 2), y: labelY, width: labelWidth, height: labelHeight, lines },
  };
}
