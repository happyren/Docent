/**
 * Verbalization (D56): the voice says what an engineer says. One table,
 * one case per rule; a regression here is a mispronounced diagram.
 */
import { describe, expect, it } from "vitest";
import { integerWords, numberWords, readable } from "../src/speech/readable";

describe("numbers as words", () => {
  it("counts like a person", () => {
    expect(integerWords(0)).toBe("zero");
    expect(integerWords(13)).toBe("thirteen");
    expect(integerWords(21)).toBe("twenty-one");
    expect(integerWords(100)).toBe("one hundred");
    expect(integerWords(8000)).toBe("eight thousand");
    expect(integerWords(3301)).toBe("three thousand three hundred one");
    expect(integerWords(1_500_000)).toBe("one million five hundred thousand");
    expect(integerWords(2_000_000_000)).toBe("two billion");
    expect(numberWords("8,000")).toBe("eight thousand");
    expect(numberWords("3.5")).toBe("three point five");
    expect(numberWords("0.05")).toBe("zero point zero five");
    expect(numberWords("-2")).toBe("minus two");
    expect(numberWords("1,234,567.89")).toBe("one million two hundred thirty-four thousand five hundred sixty-seven point eight nine");
  });
});

const cases: [string, string][] = [
  // the complaint that started this
  ["handles 8,000 requests", "handles eight thousand requests"],
  ["latency >= 200ms triggers retry", "latency greater than or equal to two hundred milliseconds triggers retry"],
  // operators and symbols
  ["retries <= 3", "retries less than or equal to three"],
  ["status != 200", "status not equal to two hundred"],
  ["x == y", "x equals y"],
  ["if count > 10 then shed", "if count greater than ten then shed"],
  ["if load < 50% scale down", "if load less than fifty percent scale down"],
  ["±5%", "plus or minus five percent"],
  ["Orders & Payments", "Orders and Payments"],
  ["~5 seconds", "about five seconds"],
  ["node #3", "node number three"],
  ["a || b && c", "a or b and c"],
  ["2^10 entries", "two to the power of ten entries"],
  // arrows and dashes
  ["Orders → Payments", "Orders to Payments"],
  ["A <- B <-> C", "A from B and C"],
  ["API Gateway — internals", "API Gateway, internals"],
  ["retry - then fail over", "retry, then fail over"],
  // units, rates, scales, multipliers, percentiles
  ["p99 under 250 ms", "p ninety-nine under two hundred fifty milliseconds"],
  ["1 s timeout, 30 min TTL", "one second timeout, thirty minutes TTL"],
  ["500 req/s sustained, 10k msgs/sec peak", "five hundred requests per second sustained, ten thousand messages per second peak"],
  ["3 GB/s of reads", "three gigabytes per second of reads"],
  ["1.5M users, 2B events, 8k nodes", "one point five million users, two billion events, eight thousand nodes"],
  ["200 B header", "two hundred bytes header"],
  ["2x replication, x3 fan-out", "two times replication, three times fan-out"],
  ["10-20 ms jitter", "ten to twenty milliseconds jitter"],
  ["10–20 shards", "ten to twenty shards"],
  ["$5 per 1,000 calls", "five dollars per one thousand calls"],
  ["costs $1", "costs one dollar"],
  ["the 1st hop and the 22nd", "the first hop and the twenty-second"],
  ["v2.1 of the API", "version two point one of the API"],
  ["Catalog v2", "Catalog version two"],
  ["5 + 3 = 8", "five plus three equals eight"],
  ["10 - 4", "ten minus four"],
  ["24/7 on call", "twenty-four seven on call"],
  ["256 MB heap", "two hundred fifty-six megabytes heap"],
  // identifiers and paths
  ["max_retry_count is 3", "max retry count is three"],
  ["the retryQueue worker", "the retry Queue worker"],
  ["writes to api.example.com", "writes to api dot example dot com"],
  ["read/write split", "read or write split"],
  // abbreviations
  ["caches, e.g. Redis, etc.", "caches, for example, Redis, et cetera"],
  ["sync vs. async", "sync versus async"],
  ["w/o a lock", "without a lock"],
  // markdown and lists
  ["## Core\n- first\n- **second**", "Core. first. second"],
  ["`charge` is idempotent", "charge is idempotent"],
  // dates are not ranges
  ["since 2026-08-22", "since two thousand twenty-six, eight, twenty-two"],
  // plain prose is untouched
  ["Requests land at the gateway first; every order is verified before it reaches payments.", "Requests land at the gateway first; every order is verified before it reaches payments."],
];

describe("readable", () => {
  for (const [input, expected] of cases) {
    it(`says "${input}" as "${expected}"`, () => {
      expect(readable(input)).toBe(expected);
    });
  }

  it("is deterministic and idempotent on prose", () => {
    const once = readable("handles 8,000 req/s at p99 <= 200ms");
    expect(readable(once)).toBe(once);
  });
});
