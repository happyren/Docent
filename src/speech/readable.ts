/**
 * Verbalization (D52, D56): what a voice should say for what the panel
 * shows. The words stay the author's; only what a reader of prose would
 * stumble over is spelled out the way an engineer says it — numbers as
 * words, units and rates named, operators and symbols spoken, identifiers
 * split, abbreviations expanded, arrows as direction. Pure, deterministic,
 * English, and the one place pronunciation is decided — every voice
 * plugin gets the same words.
 *
 * Order matters: structure first (markdown, arrows), then compound tokens
 * (versions, percentiles, multipliers, units, identifiers), then bare
 * numbers, then lone symbols, then whitespace and punctuation.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [
  [1_000_000_000_000, "trillion"],
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

/** A non-negative integer as English words. Beyond safe integers, the digits. */
export function integerWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n > Number.MAX_SAFE_INTEGER) return digitWords(String(n));
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const rest = n % 10;
    return rest ? `${tens}-${ONES[rest]}` : tens;
  }
  if (n < 1000) {
    const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
    const rest = n % 100;
    return rest ? `${hundreds} ${integerWords(rest)}` : hundreds;
  }
  for (const [scale, name] of SCALES) {
    if (n >= scale) {
      const head = `${integerWords(Math.floor(n / scale))} ${name}`;
      const rest = n % scale;
      return rest ? `${head} ${integerWords(rest)}` : head;
    }
  }
  return String(n);
}

function digitWords(digits: string): string {
  return [...digits].map((d) => (d === "." ? "point" : ONES[Number(d)] ?? d)).join(" ");
}

/** `"3.50"` → "three point five zero"; `"8,000"` → "eight thousand"; `"-2"` → "minus two". */
export function numberWords(raw: string): string {
  let text = raw.replace(/[,_\s]/g, "");
  let sign = "";
  if (text.startsWith("-") || text.startsWith("−")) {
    sign = "minus ";
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    sign = "plus ";
    text = text.slice(1);
  }
  const [whole, fraction] = text.split(".");
  const wholeWords = whole === "" ? "zero" : integerWords(Number(whole));
  if (fraction === undefined || fraction === "") return sign + wholeWords;
  return `${sign}${wholeWords} point ${digitWords(fraction)}`;
}

const ORDINAL_WORDS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth",
};

function ordinalWords(n: number): string {
  const words = integerWords(n);
  const parts = words.split(/(\s|-)/);
  const last = parts[parts.length - 1];
  let ordinal = ORDINAL_WORDS[last];
  if (!ordinal) ordinal = last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`;
  parts[parts.length - 1] = ordinal;
  return parts.join("");
}

/** Unit symbols that follow a number, to the names a reader says. */
const UNITS: Record<string, [singular: string, plural: string]> = {
  ns: ["nanosecond", "nanoseconds"],
  us: ["microsecond", "microseconds"],
  "µs": ["microsecond", "microseconds"],
  "μs": ["microsecond", "microseconds"],
  ms: ["millisecond", "milliseconds"],
  s: ["second", "seconds"],
  sec: ["second", "seconds"],
  secs: ["seconds", "seconds"],
  min: ["minute", "minutes"],
  mins: ["minutes", "minutes"],
  h: ["hour", "hours"],
  hr: ["hour", "hours"],
  hrs: ["hours", "hours"],
  d: ["day", "days"],
  B: ["byte", "bytes"],
  KB: ["kilobyte", "kilobytes"],
  kB: ["kilobyte", "kilobytes"],
  MB: ["megabyte", "megabytes"],
  GB: ["gigabyte", "gigabytes"],
  TB: ["terabyte", "terabytes"],
  PB: ["petabyte", "petabytes"],
  KiB: ["kibibyte", "kibibytes"],
  MiB: ["mebibyte", "mebibytes"],
  GiB: ["gibibyte", "gibibytes"],
  TiB: ["tebibyte", "tebibytes"],
  Kbps: ["kilobit per second", "kilobits per second"],
  Mbps: ["megabit per second", "megabits per second"],
  Gbps: ["gigabit per second", "gigabits per second"],
  Hz: ["hertz", "hertz"],
  kHz: ["kilohertz", "kilohertz"],
  MHz: ["megahertz", "megahertz"],
  GHz: ["gigahertz", "gigahertz"],
  rps: ["request per second", "requests per second"],
  qps: ["query per second", "queries per second"],
  tps: ["transaction per second", "transactions per second"],
  ops: ["operation per second", "operations per second"],
  fps: ["frame per second", "frames per second"],
  px: ["pixel", "pixels"],
  "%": ["percent", "percent"],
};

/** Rate denominators: `req/s` → "requests per second". */
const PER: Record<string, string> = {
  s: "second", sec: "second", ms: "millisecond", min: "minute", m: "minute",
  h: "hour", hr: "hour", d: "day", day: "day", wk: "week", mo: "month", yr: "year",
  req: "request", op: "operation", user: "user", node: "node", core: "core",
};

/** `req`, `ops`, `msgs` before `/s`: the countable thing. */
const COUNTED: Record<string, string> = {
  req: "requests", reqs: "requests", requests: "requests", msg: "messages", msgs: "messages",
  ops: "operations", op: "operations", tx: "transactions", txn: "transactions",
  events: "events", evt: "events", calls: "calls", jobs: "jobs", items: "items", rows: "rows",
  writes: "writes", reads: "reads", queries: "queries", users: "users", connections: "connections",
  conn: "connections", conns: "connections", packets: "packets", bytes: "bytes", records: "records",
  tokens: "tokens",
};

const SUFFIX_SCALES: Record<string, string> = { k: "thousand", K: "thousand", M: "million", B: "billion", G: "billion", T: "trillion" };

const ABBREVIATIONS: [RegExp, string][] = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\.?(?=\W|$)/gi, "et cetera"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bw\/o\b/gi, "without"],
  [/\bw\/(?=\s)/gi, "with"],
  [/\bapprox\.?(?=\s)/gi, "approximately"],
  [/\bcf\.(?=\s)/gi, "compare"],
  [/\bn\/a\b/gi, "not applicable"],
  [/\b24\/7\b/g, "twenty-four seven"],
];

/** A number with an optional sign — never a sign that follows a digit or a word (dates, ids, ranges). */
const NUMBER = String.raw`(?:(?<![\d\w])[-−+])?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

function unitName(unit: string, value: string): string | null {
  const names = UNITS[unit];
  if (!names) return null;
  const one = /^[-−+]?0*1(?:\.0+)?$/.test(value.replace(/,/g, ""));
  return one ? names[0] : names[1];
}

function splitIdentifier(word: string): string {
  return word
    .replace(/_/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function readable(text: string): string {
  let out = text;

  // --- structure: markdown, arrows, dashes ---------------------------------
  out = out
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-•*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Emphasis and code ticks — underscores stay, they belong to identifiers.
    .replace(/[`*]{1,3}([^`*\n]+)[`*]{1,3}/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s*(↔|<->|<=>)\s*/g, " and ")
    .replace(/\s*(→|->|⇒|=>|⟶)\s*/g, " to ")
    .replace(/\s*(←|<-|⇐)\s*/g, " from ")
    // Dashes as asides read as a pause; an en dash between numbers is a
    // range and is kept for the rule below.
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ");

  // --- abbreviations ------------------------------------------------------
  for (const [pattern, replacement] of ABBREVIATIONS) {
    out = out.replace(pattern, replacement as string);
  }

  // --- compound tokens ----------------------------------------------------
  out = out
    // v1.2.3 → version one point two point three
    .replace(/\bv(\d+(?:\.\d+)*)\b/g, (_, v: string) => `version ${v.split(".").map((n) => integerWords(Number(n))).join(" point ")}`)
    // p99 / p50 → p ninety-nine
    .replace(/\bp(\d{2,3})\b/g, (_, n: string) => `p ${numberWords(n)}`)
    // 1.5M / 8k / 2B / 10K attached to the number → one point five million
    .replace(new RegExp(String.raw`(${NUMBER})([kKMBGT])\b(?![a-zA-Z])`, "g"), (_, n: string, s: string) => `${numberWords(n)} ${SUFFIX_SCALES[s]}`)
    // 2x / x2 / 3× → two times
    .replace(new RegExp(String.raw`\b(${NUMBER})\s?[x×]\b`, "g"), (_, n: string) => `${numberWords(n)} times`)
    .replace(new RegExp(String.raw`\bx\s?(${NUMBER})\b`, "g"), (_, n: string) => `${numberWords(n)} times`)
    // arithmetic between numbers, spaced
    .replace(new RegExp(String.raw`(${NUMBER})\s\+\s(${NUMBER})`, "g"), "$1 plus $2")
    .replace(new RegExp(String.raw`(${NUMBER})\s[-−]\s(${NUMBER})`, "g"), "$1 minus $2")
    .replace(new RegExp(String.raw`(${NUMBER})\s[*]\s(${NUMBER})`, "g"), "$1 times $2")
    .replace(new RegExp(String.raw`(${NUMBER})\s\/\s(${NUMBER})`, "g"), "$1 divided by $2")
    // a tight hyphen between two numbers is a range (10-20, 10–20) — unless
    // a third number follows, which is a date
    .replace(new RegExp(String.raw`(?<![\d-])(${NUMBER})[-–](${NUMBER})(?!\d|-\d)`, "g"), "$1 to $2")
    // currency: $5, $1,200.50, €3 → five dollars
    .replace(new RegExp(String.raw`([$€£¥])\s?(${NUMBER})(?:([kKMB])\b)?`, "g"), (_, c: string, n: string, s?: string) => {
      const unit = { $: "dollar", "€": "euro", "£": "pound", "¥": "yen" }[c] ?? "";
      const amount = s ? `${numberWords(n)} ${SUFFIX_SCALES[s]}` : numberWords(n);
      const plural = n.replace(/,/g, "") === "1" && !s ? unit : unit === "yen" ? "yen" : `${unit}s`;
      return `${amount} ${plural}`;
    })
    // rates: 500 req/s, 10k msgs/sec, 3 GB/s → five hundred requests per second
    .replace(new RegExp(String.raw`\b(${NUMBER})\s?([A-Za-z%µμ]+)\/([A-Za-z]+)\b`, "g"), (m, n: string, top: string, per: string) => {
      const denominator = PER[per];
      if (!denominator) return m;
      const thing = COUNTED[top] ?? unitName(top, n) ?? top;
      return `${numberWords(n)} ${thing} per ${denominator}`;
    })
    .replace(/\b([A-Za-z]+)\/([A-Za-z]+)\b/g, (m, top: string, per: string) => {
      if (PER[per] && (COUNTED[top] || UNITS[top])) {
        return `${COUNTED[top] ?? UNITS[top][1]} per ${PER[per]}`;
      }
      return m;
    })
    // numbers with units: 200ms, 3.5 GB, 15%, 1 h → two hundred milliseconds
    .replace(new RegExp(String.raw`\b(${NUMBER})\s?(${Object.keys(UNITS).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z])`, "g"), (m, n: string, u: string) => {
      const name = unitName(u, n);
      return name ? `${numberWords(n)} ${name}` : m;
    })
    // ordinals: 1st, 2nd, 23rd
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, n: string) => ordinalWords(Number(n)))
    // ~5 → about five; #3 → number three
    .replace(new RegExp(String.raw`~\s?(?=${NUMBER})`, "g"), "about ")
    .replace(new RegExp(String.raw`#\s?(?=\d)`, "g"), "number ");

  // Whatever en dash is left was not a range.
  out = out.replace(/\s*–\s*/g, ", ");

  // --- identifiers: snake_case, camelCase, dotted paths, slashes between words
  out = out
    .replace(/\b[A-Za-z][A-Za-z\d]*(?:_[A-Za-z\d]+)+\b/g, (id) => splitIdentifier(id))
    .replace(/\b[a-z]+(?:[A-Z][a-z\d]+)+\b/g, (id) => splitIdentifier(id))
    .replace(/\b([a-z][a-z\d-]*)(\.[a-z][a-z\d-]*)+\b/gi, (path) =>
      path.split(".").join(" dot "),
    )
    .replace(/\b([A-Za-z]+)\/([A-Za-z]+)\b/g, "$1 or $2");

  // --- bare numbers -------------------------------------------------------
  // A hyphen still sitting between digits is a date or an id, not a range:
  // read it as a pause.
  out = out.replace(/(?<=\d)-(?=\d)/g, ", ");
  out = out.replace(new RegExp(NUMBER, "g"), (n) => numberWords(n));

  // --- operators and symbols ----------------------------------------------
  out = out
    .replace(/\s*>=\s*|\s*≥\s*/g, " greater than or equal to ")
    .replace(/\s*<=\s*|\s*≤\s*/g, " less than or equal to ")
    .replace(/\s*(!=|≠|<>)\s*/g, " not equal to ")
    .replace(/\s*===?\s*/g, " equals ")
    .replace(/\s=\s/g, " equals ")
    .replace(/(^|\s)>\s*(?=\S)/g, "$1greater than ")
    .replace(/(^|\s)<\s*(?=\S)/g, "$1less than ")
    .replace(/\s*±\s*/g, " plus or minus ")
    .replace(/\s*×\s*/g, " times ")
    .replace(/\s*÷\s*/g, " divided by ")
    .replace(/\s*\^\s*/g, " to the power of ")
    .replace(/\s&\s/g, " and ")
    .replace(/\s\+\s/g, " plus ")
    // A spaced hyphen in prose is an aside, not a subtraction (those were
    // handled while the numbers were still digits).
    .replace(/\s(?:-|−)\s/g, ", ")
    .replace(/\s\*\s/g, " times ")
    .replace(/\s@\s?/g, " at ")
    .replace(/∞/g, "infinity")
    .replace(/\s*\|\|\s*/g, " or ")
    .replace(/\s*&&\s*/g, " and ")
    .replace(/\s\|\s/g, ", ");

  // --- whitespace and punctuation -----------------------------------------
  return out
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}
