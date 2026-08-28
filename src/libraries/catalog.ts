/**
 * The symbol catalog (D81) and the lookup over it (D82).
 *
 * The bundled icon libraries are a vocabulary, not a drawing: this module
 * reads the generated `public/libraries/catalog.json` into a typed catalog
 * and ranks it against a query. Pure and dependency-free (I7), and the
 * catalog is an argument rather than an import, so every dispatcher runs
 * the same ranking over the same file — the page loads the JSON through
 * Vite, the Node MCP server reads it off disk — and one query answers the
 * same way in both (I3).
 */

/** One library item, as the generator writes it (D81) — never its geometry. */
export interface SymbolEntry {
  /** The id an agent passes to add_node: library slug + name slug. */
  symbol: string;
  name: string;
  library: string;
  /** Where the item sits in its `.excalidrawlib` — how the adapter finds it. */
  index: number;
  itemId: string;
  category: string;
  /** The icon alone, without its caption, and where it sits in the item. */
  icon: { width: number; height: number; x: number; y: number };
  /** Icon plus caption — the component's box for layout and routing (D85). */
  size: { width: number; height: number };
  caption: string | null;
  aliases: string[];
}

export interface SymbolCatalog {
  version: number;
  symbols: SymbolEntry[];
  /** Every library in the catalog, sorted — what a `library` filter takes. */
  libraries: string[];
}

/** What a search answers: enough to choose a symbol, never enough to draw it. */
export interface SymbolHit {
  symbol: string;
  name: string;
  library: string;
  category: string;
  size: { width: number; height: number };
  aliases: string[];
  score: number;
  /** One phrase saying why it matched — "alias: function". */
  why: string;
}

export interface FindSymbolOptions {
  /** A library id ("software-architecture") or a symbol namespace ("aws"). */
  library?: string;
  /** How many hits to answer with; 1–20, default 8. */
  limit?: number;
}

export interface FindSymbolAnswer {
  hits: SymbolHit[];
  libraries: string[];
  next: string;
}

/** Anything that names a symbol — an entry or a hit — reads the same way. */
type Describable = Pick<SymbolEntry, "symbol" | "name" | "library" | "category" | "size">;

/**
 * Parse the checked-in catalog: lenient about fields a later generator may
 * add, strict about the shape a lookup needs.
 */
export function loadCatalog(json: unknown): SymbolCatalog {
  const data = json as { version?: unknown; symbols?: unknown } | null;
  const symbols = Array.isArray(data?.symbols) ? (data.symbols as SymbolEntry[]) : null;
  if (!symbols) {
    throw new Error(
      "Not a symbol catalog — expected { version, symbols: [...] }; regenerate it with `pnpm catalog`",
    );
  }
  return {
    version: typeof data?.version === "number" ? data.version : 1,
    symbols,
    libraries: [...new Set(symbols.map((entry) => entry.library))].sort(),
  };
}

/** One line naming a symbol, for a tool's prose. */
export function describeSymbol(entry: Describable): string {
  return `${entry.symbol} — ${entry.name} (${entry.library}, ${entry.category}), ${entry.size.width}×${entry.size.height}`;
}

// ------------------------------------------------------------- ranking --
// Deterministic tiers, best first (D82): the name the agent already knows,
// then a synonym it reached for, then the phrase somewhere in either, then
// a prefix ("dyn" → DynamoDB), then every word present, then a bounded
// typo. A name outranks an alias within a tier, so the order never depends
// on which entry the loop reached first.
const EXACT_NAME = 100;
const EXACT_ALIAS = 90;
const PHRASE_NAME = 80;
const PHRASE_ALIAS = 78;
const PREFIX_NAME = 70;
const PREFIX_ALIAS = 68;
const ALL_WORDS = 50;
const FUZZY = 30;

/** A typo is at most two edits, and only on a word long enough to have one. */
const FUZZY_MAX_DISTANCE = 2;
const FUZZY_MIN_LENGTH = 4;

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const words = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

/** A phrase match is on word boundaries: "queue" is not inside "queued". */
const phrase = (haystack: string[], needle: string): boolean =>
  ` ${haystack.join(" ")} `.includes(` ${needle} `);

interface Query {
  text: string;
  words: string[];
}

interface Match {
  score: number;
  why: string;
}

/**
 * Damerau–Levenshtein (optimal string alignment), bounded: past `max` edits
 * it answers `max + 1`, so most of the catalog is rejected on a row.
 */
function distance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let older: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = new Array<number>(b.length + 1);
    current[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, older[j - 2] + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    older = previous;
    previous = current;
  }
  return previous[b.length];
}

/** The best reason this entry answers the query, or none. */
function bestMatch(entry: SymbolEntry, query: Query): Match | null {
  const nameWords = words(entry.name);
  const nameText = nameWords.join(" ");
  if (nameText === query.text) return { score: EXACT_NAME, why: `name: ${entry.name}` };

  const aliases = entry.aliases.map((alias) => ({ alias, words: words(alias) }));
  for (const alias of aliases) {
    if (alias.words.join(" ") === query.text) {
      return { score: EXACT_ALIAS, why: `alias: ${alias.alias}` };
    }
  }

  // A multi-word query is a phrase before it is a bag of words: "message
  // queue" should find the queue, not everything that says "message".
  if (phrase(nameWords, query.text)) {
    return { score: PHRASE_NAME, why: `name mentions: ${query.text}` };
  }
  for (const alias of aliases) {
    if (phrase(alias.words, query.text)) {
      return { score: PHRASE_ALIAS, why: `alias mentions: ${alias.alias}` };
    }
  }

  // A prefix is a word the person started typing: every query word must
  // begin one, so "dyn" finds DynamoDB and "dyn table" finds its table.
  const startsAll = (haystack: string[]): boolean =>
    query.words.every(
      (word) => word.length >= 2 && haystack.some((candidate) => candidate.startsWith(word)),
    );
  if (startsAll(nameWords)) return { score: PREFIX_NAME, why: `name starts with: ${query.text}` };
  for (const alias of aliases) {
    if (startsAll(alias.words)) {
      return { score: PREFIX_ALIAS, why: `alias starts with: ${query.text}` };
    }
  }

  // Every word somewhere in the entry's own words — the last honest match
  // before guessing: "queue message" still finds the simple queue service.
  const bag = [nameWords, ...aliases.map((alias) => alias.words)].flat();
  if (query.words.every((word) => bag.some((candidate) => candidate.includes(word)))) {
    return { score: ALL_WORDS, why: `words: ${query.words.join(" ")}` };
  }

  // A typo, on the name only: the aliases are the vocabulary a model
  // reaches for, and fuzzing those would answer for words nobody wrote.
  if (query.text.length >= FUZZY_MIN_LENGTH) {
    let closest = FUZZY_MAX_DISTANCE + 1;
    if (nameText.length >= FUZZY_MIN_LENGTH) {
      closest = distance(query.text, nameText, FUZZY_MAX_DISTANCE);
    }
    if (query.words.length === 1) {
      for (const word of nameWords) {
        if (word.length < FUZZY_MIN_LENGTH) continue;
        closest = Math.min(closest, distance(query.text, word, FUZZY_MAX_DISTANCE));
      }
    }
    if (closest <= FUZZY_MAX_DISTANCE) {
      return { score: FUZZY - (closest - 1) * 5, why: `close to: ${entry.name}` };
    }
  }
  return null;
}

/** Case-insensitive, then codepoint — never a locale (I3). */
const compare = (a: string, b: string): number => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const inLibrary = (entry: SymbolEntry, library: string): boolean =>
  entry.library.toLowerCase() === library || entry.symbol.toLowerCase().startsWith(`${library}/`);

/**
 * Ranked matches for a query, best first (D82). Ties break by name and then
 * by id, so the same query answers the same list every time.
 */
export function findSymbols(
  catalog: SymbolCatalog,
  query: string,
  options: FindSymbolOptions = {},
): SymbolHit[] {
  const text = normalize(query ?? "");
  if (!text) return [];
  const parsed: Query = { text, words: text.split(" ") };
  // A filter names a library ("software-architecture") or the namespace the
  // ids carry ("aws"); a model that saw an id has only ever seen the latter.
  const library = options.library ? normalize(options.library).replace(/ /g, "-") : "";
  const requested = Number(options.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LIMIT;

  const hits: SymbolHit[] = [];
  for (const entry of catalog.symbols) {
    if (library && !inLibrary(entry, library)) continue;
    const match = bestMatch(entry, parsed);
    if (!match) continue;
    hits.push({
      symbol: entry.symbol,
      name: entry.name,
      library: entry.library,
      category: entry.category,
      size: entry.size,
      aliases: entry.aliases,
      score: match.score,
      why: match.why,
    });
  }
  // Within a tier the house glyphs answer first (D121): a brandless word —
  // "queue", "database", "gateway" — is a request for the idea, and the
  // house draws ideas. A vendor's own words still win naturally: they score
  // on names the house does not carry.
  const house = (hit: SymbolHit): number => (hit.symbol.startsWith("docent/") ? 0 : 1);
  hits.sort(
    (a, b) =>
      b.score - a.score || house(a) - house(b) || compare(a.name, b.name) || compare(a.symbol, b.symbol),
  );
  return hits.slice(0, limit);
}

/**
 * The `find_symbol` tool's answer (D82) — shared by every dispatcher, so a
 * Node server with no page attached says exactly what the page says.
 */
export function answerFindSymbol(
  catalog: SymbolCatalog,
  params: Record<string, unknown>,
): FindSymbolAnswer {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    throw new Error("find_symbol needs a query — e.g. find_symbol({query:'queue'})");
  }
  const library =
    typeof params.library === "string" && params.library.trim() ? params.library.trim() : undefined;
  const limit = params.limit === undefined ? undefined : Number(params.limit);
  const hits = findSymbols(catalog, query, { library, limit });
  if (!hits.length) {
    return {
      hits,
      libraries: catalog.libraries,
      next: "draw it as a plain component with a kind, or try another word",
    };
  }
  return {
    hits,
    libraries: catalog.libraries,
    next: `${describeSymbol(hits[0])} — pass its id as add_node({symbol:'${hits[0].symbol}', label:'…'})`,
  };
}
