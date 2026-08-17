#!/usr/bin/env node
/**
 * Q6 round-trip comprehension eval: present a reference model with ONLY the
 * semantic export (golden Mermaid + sidecar) and score its answers to the
 * fixture's question bank. Threshold 95%, ratchets up only.
 *
 * Runners:
 *  - ANTHROPIC_API_KEY set  → direct Messages API call
 *      (model: COMPREHENSION_MODEL, default claude-haiku-4-5-20251001)
 *  - otherwise              → local `claude -p` CLI fallback
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const THRESHOLD = Number(process.env.COMPREHENSION_THRESHOLD ?? "0.95");
const MODEL = process.env.COMPREHENSION_MODEL ?? "claude-haiku-4-5-20251001";

const mermaid = readFileSync(join(FIXTURES, "golden", "demo.mmd"), "utf8");
const sidecar = readFileSync(join(FIXTURES, "golden", "demo.docent.json"), "utf8");
const questions = JSON.parse(
  readFileSync(join(FIXTURES, "demo.questions.json"), "utf8"),
);

const prompt = `You are given the semantic export of an architecture diagram: a Mermaid graph (structure) and a JSON sidecar (spatial layout, frames, author intent, and provenance; provenanceDefault "explicit" means any fact not listed under an entity's "provenance" was read directly from the drawing, while listed facts are author-"declared" or heuristically "inferred").

Answer the questions using ONLY this export. Be concise — a phrase or one short sentence each.

=== MERMAID ===
${mermaid}
=== SIDECAR ===
${sidecar}
=== QUESTIONS ===
${questions.map((q) => `${q.id}: ${q.q}`).join("\n")}

Respond with ONLY a JSON array, no code fences: [{"id":"q01","answer":"..."}, ...]`;

function runAPI() {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  const result = execFileSync(
    "curl",
    [
      "-s",
      "https://api.anthropic.com/v1/messages",
      "-H", `x-api-key: ${process.env.ANTHROPIC_API_KEY}`,
      "-H", "anthropic-version: 2023-06-01",
      "-H", "content-type: application/json",
      "-d", body,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(`API error: ${JSON.stringify(parsed.error)}`);
  return parsed.content.map((c) => c.text ?? "").join("");
}

function runCLI() {
  return execFileSync("claude", ["-p", "--model", "haiku"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

const raw = process.env.ANTHROPIC_API_KEY ? runAPI() : runCLI();
const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
const answers = new Map(JSON.parse(jsonText).map((a) => [a.id, String(a.answer)]));

let passed = 0;
const failures = [];
for (const q of questions) {
  const answer = (answers.get(q.id) ?? "").toLowerCase();
  const ok = q.expectAll
    ? q.expectAll.every((term) => answer.includes(term.toLowerCase()))
    : q.expect.some((alt) => answer.includes(alt.toLowerCase()));
  if (ok) passed += 1;
  else failures.push({ id: q.id, q: q.q, answer: answers.get(q.id) ?? "(none)" });
}

const score = passed / questions.length;
console.log(`comprehension: ${passed}/${questions.length} = ${(score * 100).toFixed(1)}% (threshold ${THRESHOLD * 100}%)`);
for (const f of failures) {
  console.log(`  MISS ${f.id}: ${f.q}\n       answered: ${f.answer}`);
}
process.exit(score >= THRESHOLD ? 0 : 1);
