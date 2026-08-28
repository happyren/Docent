/**
 * The command palette's matching (D111). Commands and the portfolio's scene
 * paths are ranked by one pure function, so what the fingers feel — acronyms
 * first, a path fragment finding a nested scene, an order that never wobbles
 * — is read here without a DOM, a store, or a canvas.
 */
import { describe, expect, it } from "vitest";
import {
  fuzzyMatch,
  matchPalette,
  PALETTE_ICON_ROWS,
  PALETTE_LIMIT,
  scenePath,
  type PaletteCommand,
  type PaletteScene,
} from "../src/shell/palette";

const command = (id: string, title: string, shortcut?: string): PaletteCommand => ({
  id,
  title,
  ...(shortcut ? { shortcut } : {}),
  run: () => {},
});

const scene = (project: string, path: string): PaletteScene => ({ project, path });

const COMMANDS = [
  command("open", "Open…", "⌘O"),
  command("save", "Save", "⌘S"),
  command("save-as", "Save as…", "⇧⌘S"),
  command("export-mermaid", "Export Mermaid…"),
  command("export-sidecar", "Export semantic JSON…"),
  command("present", "Present", "⌘P"),
  command("tidy", "Tidy diagram", "⌥⇧F"),
  command("legend", "Legend…"),
  command("portfolio", "Portfolio…"),
];

const SCENES = [
  scene("payments", "refunds/chargeback"),
  scene("payments", "ledger"),
  scene("billing", "invoices/monthly/dunning"),
];

const titles = (query: string, scenes: PaletteScene[] = []) =>
  matchPalette(query, COMMANDS, scenes).map((entry) => entry.label);

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports where it landed", () => {
    const hit = fuzzyMatch("tid", "Tidy diagram");
    expect(hit?.matched).toEqual([0, 1, 2]);
  });

  it("refuses what is not a subsequence", () => {
    expect(fuzzyMatch("zebra", "Tidy diagram")).toBeNull();
    // Order counts: the letters are all there, backwards.
    expect(fuzzyMatch("yad", "Tidy")).toBeNull();
  });

  it("matches an empty query against anything, scoring nothing", () => {
    expect(fuzzyMatch("", "Save as…")).toEqual({ score: 0, matched: [] });
    expect(fuzzyMatch("   ", "Save as…")).toEqual({ score: 0, matched: [] });
  });

  it("prefers the starts of words — the acronym is what people type", () => {
    // "em" is Export Mermaid's initials, not the "e…m" inside "Export".
    expect(fuzzyMatch("em", "Export Mermaid…")?.matched).toEqual([0, 7]);
    expect(fuzzyMatch("td", "Tidy diagram")?.matched).toEqual([0, 5]);
  });

  it("scores a word start above the same letters buried mid-word", () => {
    const start = fuzzyMatch("leg", "Legend…")!;
    const buried = fuzzyMatch("leg", "Toggle green")!;
    expect(start.score).toBeGreaterThan(buried.score);
  });

  it("scores a typed-through run above a scattered one", () => {
    const run = fuzzyMatch("save", "Save as…")!;
    const scattered = fuzzyMatch("save", "Show and vary everything")!;
    expect(run.score).toBeGreaterThan(scattered.score);
  });

  it("reads separators and camelCase as word starts", () => {
    expect(fuzzyMatch("pr", "payments/refunds")?.matched).toEqual([0, 9]);
    expect(fuzzyMatch("dl", "detailLayer")?.matched).toEqual([0, 6]);
  });
});

describe("matchPalette", () => {
  it("opens on the whole menu, in the order it was written", () => {
    expect(titles("")).toEqual(COMMANDS.map((c) => c.title));
  });

  it("keeps commands ahead of scenes when nothing is typed", () => {
    const kinds = matchPalette("", COMMANDS, SCENES).map((e) => e.kind);
    expect(kinds.indexOf("scene")).toBeGreaterThan(kinds.lastIndexOf("command"));
  });

  it("never answers with more than a screenful", () => {
    const many = Array.from({ length: 40 }, (_, i) => command(`c${i}`, `Command ${i}`));
    expect(matchPalette("", many, []).length).toBe(PALETTE_LIMIT);
    expect(matchPalette("command", many, []).length).toBe(PALETTE_LIMIT);
  });

  it("puts the acronym match first", () => {
    expect(titles("em")[0]).toBe("Export Mermaid…");
    expect(titles("sas")[0]).toBe("Save as…");
    expect(titles("esj")[0]).toBe("Export semantic JSON…");
  });

  it("prefers the title the query nearly spells over a longer one", () => {
    // Coverage, not just word starts: "sa" is most of "Save".
    expect(titles("sa")[0]).toBe("Save");
  });

  it("finds a nested scene by a fragment of its path", () => {
    const hits = matchPalette("chargeback", COMMANDS, SCENES);
    expect(hits[0]).toMatchObject({
      kind: "scene",
      scene: { project: "payments", path: "refunds/chargeback" },
    });
  });

  it("matches a scene across its project and folders", () => {
    // The address is what is matched, so the project narrows the search.
    expect(titles("payled", SCENES)).toContain("payments/ledger");
    expect(titles("bilmondun", SCENES)).toContain(
      "billing/invoices/monthly/dunning",
    );
  });

  it("drops what the query cannot reach", () => {
    expect(titles("qqq", SCENES)).toEqual([]);
  });

  it("seats the icon band at the foot, capped, and never on an empty query (D123)", () => {
    const icons = Array.from({ length: 9 }, (_, i) => ({
      symbol: `docent/icon-${i}`,
      name: `Icon ${i}`,
      library: "docent-house",
    }));
    // The menu is the menu: no icons before anything is typed.
    expect(matchPalette("", COMMANDS, [], icons).every((e) => e.kind !== "symbol")).toBe(true);
    // Typed: the band arrives at the foot, in the caller's ranked order,
    // at most PALETTE_ICON_ROWS rows, inside the one screenful.
    const hits = matchPalette("save", COMMANDS, [], icons);
    const band = hits.filter((e) => e.kind === "symbol");
    expect(band.length).toBe(PALETTE_ICON_ROWS);
    expect(band.map((e) => (e.kind === "symbol" ? e.symbol.symbol : ""))).toEqual(
      icons.slice(0, PALETTE_ICON_ROWS).map((i) => i.symbol),
    );
    expect(hits.length).toBeLessThanOrEqual(PALETTE_LIMIT);
    expect(hits[hits.length - 1].kind).toBe("symbol");
    // A full list still keeps the band: commands give the rows up.
    const many = Array.from({ length: 40 }, (_, i) => command(`c${i}`, `Command ${i}`));
    const crowded = matchPalette("command", many, [], icons);
    expect(crowded.length).toBe(PALETTE_LIMIT);
    expect(crowded.filter((e) => e.kind === "symbol").length).toBe(PALETTE_ICON_ROWS);
  });

  it("ignores spaces between the words a person half-remembers", () => {
    expect(titles("ex me")[0]).toBe("Export Mermaid…");
  });

  it("orders identically on every run", () => {
    const once = matchPalette("s", COMMANDS, SCENES).map((e) => e.key);
    const twice = matchPalette("s", [...COMMANDS], [...SCENES]).map((e) => e.key);
    expect(twice).toEqual(once);
  });

  it("breaks a tie the same way whichever order the input came in", () => {
    const a = command("a", "Zebra");
    const b = command("b", "Zebra");
    expect(matchPalette("z", [a, b], []).map((e) => e.key)).toEqual([
      "command:a",
      "command:b",
    ]);
    expect(matchPalette("z", [b, a], []).map((e) => e.key)).toEqual([
      "command:a",
      "command:b",
    ]);
  });

  it("addresses a scene the way the store takes it (D92)", () => {
    expect(scenePath(scene("payments", "refunds/chargeback"))).toBe(
      "payments/refunds/chargeback",
    );
  });

  it("carries the command through so the row can run it", () => {
    let ran = 0;
    const entries = matchPalette("tidy", [command("tidy", "Tidy diagram"), ...COMMANDS], []);
    const first = entries[0];
    expect(first.kind).toBe("command");
    if (first.kind === "command") {
      const carried: PaletteCommand = { ...first.command, run: () => (ran += 1) };
      carried.run();
    }
    expect(ran).toBe(1);
  });

  it("shows the chord the menus give a command", () => {
    const entries = matchPalette("tidy", COMMANDS, []);
    expect(entries[0].kind === "command" && entries[0].command.shortcut).toBe("⌥⇧F");
  });
});
