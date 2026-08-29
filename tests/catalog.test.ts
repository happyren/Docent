/**
 * The symbol catalog (D81) and the lookup over it (D82): the catalog cannot
 * drift from the library files it is generated from, and a query answers the
 * symbol a person would have picked — by name, by the synonym a model
 * reaches for, by a prefix, and through a typo — the same way every time.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import catalogJson from "../public/libraries/catalog.json";
import { execute } from "../src/agent/execute";
import {
  answerFindSymbol,
  describeSymbol,
  findSymbols,
  loadCatalog,
  type SymbolCatalog,
} from "../src/libraries/catalog";

const catalog: SymbolCatalog = loadCatalog(catalogJson);
const top = (query: string, options?: { library?: string; limit?: number }) =>
  findSymbols(catalog, query, options).map((hit) => hit.symbol);

describe("the catalog is generated, not hand-kept (D81)", () => {
  it("matches the library files it is generated from", () => {
    const check = spawnSync(
      "node",
      [path.resolve("scripts/catalog-libraries.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(`${check.stdout}${check.stderr}`.trim()).toContain("is current");
    expect(check.status).toBe(0);
  });

  it("names every symbol once, with a box to lay it out in", () => {
    expect(catalog.symbols.length).toBeGreaterThan(200);
    expect(catalog.libraries).toEqual([
      "aws-architecture-icons",
      "docent-house",
      "software-architecture",
    ]);
    const seen = new Set<string>();
    for (const entry of catalog.symbols) {
      expect(entry.symbol, JSON.stringify(entry)).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(entry.name.trim(), entry.symbol).not.toBe("");
      expect(entry.library, entry.symbol).not.toBe("");
      expect(entry.size.width, entry.symbol).toBeGreaterThan(0);
      expect(entry.size.height, entry.symbol).toBeGreaterThan(0);
      expect(entry.icon.width, entry.symbol).toBeGreaterThan(0);
      expect(entry.icon.height, entry.symbol).toBeGreaterThan(0);
      expect(seen.has(entry.symbol), `duplicate ${entry.symbol}`).toBe(false);
      seen.add(entry.symbol);
    }
  });

  it("refuses anything that is not a catalog", () => {
    expect(() => loadCatalog({ version: 1 })).toThrow(/catalog/i);
  });
});

describe("find_symbol finds one (D82)", () => {
  it("takes the name a person would say", () => {
    expect(top("lambda")[0]).toBe("aws/lambda");
    expect(top("Lambda")[0]).toBe("aws/lambda");
    expect(top("dynamodb")[0]).toBe("aws/dynamodb");
  });

  it("takes the synonym a model reaches for", () => {
    // "function" and "queue" are brandless words now the house carries them
    // (D121); the vendor's own vocabulary still answers the vendor.
    expect(top("function")[0]).toBe("docent/function");
    expect(top("queue")[0]).toBe("docent/queue");
    expect(top("postgres")[0]).toBe("aws/rds");
    expect(top("kafka")[0]).toBe("aws/managed-streaming-for-apache-kafka");
    expect(top("cdn")[0]).toBe("aws/cloudfront");
  });

  it("takes a phrase, as a phrase and as words", () => {
    // "message queue" is an alias on both; the tie breaks to the house
    // (D121). The vendor's own qualifier still finds the vendor.
    expect(top("message queue")[0]).toBe("docent/queue");
    expect(top("message queue")).toContain("aws/sqs");
    expect(top("simple queue")[0]).toBe("aws/sqs");
    expect(top("object storage")[0]).toBe("aws/s3");
  });

  it("takes the start of a word", () => {
    expect(top("dynamo")[0]).toBe("aws/dynamodb");
    expect(top("cloudwat")[0]).toBe("aws/cloudwatch");
  });

  it("takes a typo, within two edits of the name", () => {
    expect(top("lambada")[0]).toBe("aws/lambda");
    expect(findSymbols(catalog, "lambada")[0].why).toContain("close to");
    expect(top("qqqqzzzzx")).toEqual([]);
  });

  it("answers a plain word with the database a reader expects", () => {
    const hits = top("database", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.includes("software/database") ||
        hits.some((symbol) => symbol.startsWith("aws/")),
    ).toBe(true);
    expect(hits.slice(0, 3)).toContain("software/database");
  });

  it("says why each hit matched, and how big it is", () => {
    const hits = findSymbols(catalog, "function");
    expect(hits[0].why).toBe("name: Function");
    expect(hits[0].symbol).toBe("docent/function");
    const lambda = hits.find((hit) => hit.symbol === "aws/lambda");
    expect(lambda?.why).toBe("alias: function");
    expect(lambda?.category).toBe("compute");
    expect(lambda?.size.width).toBeGreaterThan(0);
    expect(describeSymbol(lambda!)).toContain("aws/lambda — Lambda");
  });

  it("keeps to one library when asked", () => {
    const hits = findSymbols(catalog, "database", { library: "software-architecture" });
    expect(hits.map((hit) => hit.symbol)).toEqual(["software/database"]);
    for (const hit of findSymbols(catalog, "server", { library: "software-architecture" })) {
      expect(hit.library).toBe("software-architecture");
    }
    expect(top("queue", { library: "software-architecture" })).toEqual([]);
  });

  it("answers at most the limit it is given, eight by default", () => {
    expect(findSymbols(catalog, "data").length).toBeLessThanOrEqual(8);
    expect(findSymbols(catalog, "data", { limit: 3 })).toHaveLength(3);
    expect(findSymbols(catalog, "data", { limit: 500 }).length).toBeLessThanOrEqual(20);
    expect(findSymbols(catalog, "data", { limit: 0 })).toHaveLength(1);
    expect(findSymbols(catalog, "")).toEqual([]);
  });

  it("answers the same query the same way, whatever order the file is in", () => {
    for (const query of ["queue", "database", "data", "lambada", "message queue"]) {
      expect(findSymbols(catalog, query)).toEqual(findSymbols(catalog, query));
      const shuffled: SymbolCatalog = {
        ...catalog,
        symbols: [...catalog.symbols].reverse(),
      };
      expect(findSymbols(shuffled, query)).toEqual(findSymbols(catalog, query));
    }
  });
});

describe("the house glyphs (D119, D121)", () => {
  it("the library file matches its committed generator", () => {
    const check = spawnSync(
      "node",
      [path.resolve("scripts/make-house-library.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(`${check.stdout}${check.stderr}`.trim()).toContain("is current");
    expect(check.status).toBe(0);
  });

  it("keeps each glyph one thing — a shared group per item (D132)", async () => {
    const { readFileSync } = await import("node:fs");
    const lib = JSON.parse(
      readFileSync(path.resolve("public/libraries/docent-house.excalidrawlib"), "utf8"),
    ) as { libraryItems: { name: string; elements: { groupIds: string[] }[] }[] };
    for (const item of lib.libraryItems) {
      const groups = new Set(item.elements.map((el) => el.groupIds.join(",")));
      expect(groups.size, item.name).toBe(1);
      expect(item.elements[0].groupIds.length, item.name).toBeGreaterThan(0);
    }
  });

  it("carries the generic vocabulary as docent/ ids", () => {
    const house = catalog.symbols.filter((entry) => entry.symbol.startsWith("docent/"));
    expect(house.length).toBe(22);
    for (const entry of house) {
      expect(entry.library).toBe("docent-house");
      // Minimal glyphs: the 64-box discipline, no caption to retype.
      expect(entry.size.width, entry.symbol).toBeLessThanOrEqual(64);
      expect(entry.size.height, entry.symbol).toBeLessThanOrEqual(64);
      expect(entry.caption, entry.symbol).toBeNull();
    }
  });

  it("brandless words answer the house first, vendors still on the list", () => {
    expect(top("database")[0]).toBe("docent/database");
    expect(top("gateway")[0]).toBe("docent/gateway");
    expect(top("queue")).toContain("aws/sqs");
  });

  it("a tied tier breaks toward the house", () => {
    // "auth" is an alias on both docent/lock and aws/cognito — same score,
    // and the house sorts first (D121).
    const hits = findSymbols(catalog, "auth");
    expect(hits[0].symbol).toBe("docent/lock");
    expect(hits.map((hit) => hit.symbol)).toContain("aws/cognito");
    expect(hits[0].score).toBe(hits.find((hit) => hit.symbol === "aws/cognito")?.score);
  });

  it("a vendor's own name still wins its word", () => {
    expect(top("lambda")[0]).toBe("aws/lambda");
    expect(top("sqs")[0]).toBe("aws/sqs");
    expect(top("s3")[0]).toBe("aws/s3");
  });

  it("the docent namespace filters like any library", () => {
    const hits = findSymbols(catalog, "database", { library: "docent" });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.symbol.startsWith("docent/")).toBe(true);
  });
});

describe("the find_symbol answer", () => {
  it("carries the hits, the libraries, and what to do next", () => {
    const answer = answerFindSymbol(catalog, { query: "queue", limit: 2 });
    expect(answer.hits[0].symbol).toBe("docent/queue");
    expect(answer.libraries).toEqual([
      "aws-architecture-icons",
      "docent-house",
      "software-architecture",
    ]);
    expect(answer.next).toContain("add_node({symbol:'docent/queue'");
  });

  it("says what to do instead when nothing matches", () => {
    const answer = answerFindSymbol(catalog, { query: "qqqqzzzzx" });
    expect(answer.hits).toEqual([]);
    expect(answer.next).toBe("draw it as a plain component with a kind, or try another word");
  });

  it("refuses an empty query rather than answering the whole catalog", () => {
    expect(() => answerFindSymbol(catalog, { query: "   " })).toThrow(/needs a query/);
    expect(() => answerFindSymbol(catalog, {})).toThrow(/needs a query/);
  });

  it("comes out of the page executor without a canvas", async () => {
    // find_symbol is static data (D82): the executor answers it with no
    // Command API and no shell at all, exactly as the Node server does.
    const answer = (await execute(
      undefined as never,
      undefined as never,
      "find_symbol",
      { query: "kafka" },
    )) as { hits: { symbol: string }[] };
    expect(answer.hits[0].symbol).toBe("aws/managed-streaming-for-apache-kafka");
  });
});
