/**
 * The personal library's funnel (D130): named items enter the vocabulary as
 * `my/<name>`, measured the way the generator measures the bundled shelves,
 * and the person's word outranks everyone's at a tie.
 */
import { describe, expect, it } from "vitest";
import { buildPersonalEntries } from "../src/adapter/personal";
import { findSymbols, loadCatalog, withRuntimeSymbols } from "../src/libraries/catalog";
import catalogJson from "../public/libraries/catalog.json";

const rect = (x: number, y: number, w: number, h: number) => ({
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
});
const text = (x: number, y: number, w: number, h: number, t: string) => ({
  type: "text",
  x,
  y,
  width: w,
  height: h,
  text: t,
});

describe("the personal funnel (D130)", () => {
  it("takes only named, drawn, unbundled items — naming is the teaching act", () => {
    const { entries, drawings } = buildPersonalEntries(
      [
        { id: "a", name: "Payment Core", elements: [rect(0, 0, 64, 48)] },
        { id: "b", name: "", elements: [rect(0, 0, 10, 10)] },
        { id: "c", name: "Ghost", elements: [] },
        { id: "d", name: "Bundled Twin", elements: [rect(0, 0, 10, 10)] },
        { id: "e", name: "Caption only", elements: [text(0, 0, 40, 20, "words")] },
      ],
      new Set(["d"]),
    );
    expect(entries.map((e) => e.symbol)).toEqual(["my/payment-core"]);
    expect(entries[0]).toMatchObject({
      library: "personal",
      index: 0,
      itemId: "a",
      category: "personal",
      size: { width: 64, height: 48 },
      caption: null,
      aliases: [],
    });
    expect(drawings.length).toBe(1);
  });

  it("measures the icon apart from the caption, the generator's own way (D81)", () => {
    const { entries } = buildPersonalEntries(
      [{ id: "a", name: "Ledger", elements: [rect(10, 0, 60, 40), text(10, 48, 60, 20, "Ledger")] }],
      new Set(),
    );
    expect(entries[0].icon).toEqual({ width: 60, height: 40, x: 0, y: 0 });
    expect(entries[0].size).toEqual({ width: 60, height: 68 });
    expect(entries[0].caption).toBe("Ledger");
  });

  it("keeps two same-named items apart", () => {
    const { entries } = buildPersonalEntries(
      [
        { id: "a", name: "Widget", elements: [rect(0, 0, 10, 10)] },
        { id: "b", name: "Widget", elements: [rect(0, 0, 10, 10)] },
      ],
      new Set(),
    );
    expect(entries.map((e) => e.symbol)).toEqual(["my/widget", "my/widget-2"]);
  });

  it("the person's word outranks the house's at a tie (D121, D130)", () => {
    const base = loadCatalog(catalogJson);
    const merged = withRuntimeSymbols(base, [
      {
        symbol: "my/queue",
        name: "Queue",
        library: "personal",
        index: 0,
        itemId: "x",
        category: "personal",
        icon: { width: 10, height: 10, x: 0, y: 0 },
        size: { width: 10, height: 10 },
        caption: null,
        aliases: [],
      },
    ]);
    const hits = findSymbols(merged, "queue");
    expect(hits[0].symbol).toBe("my/queue");
    expect(hits.map((h) => h.symbol)).toContain("docent/queue");
    expect(merged.libraries).toContain("personal");
    // …and an empty shelf costs nothing: the same catalog object comes back.
    expect(withRuntimeSymbols(base, [])).toBe(base);
  });
});
