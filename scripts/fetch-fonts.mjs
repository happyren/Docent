#!/usr/bin/env node
/**
 * Vendor the house type faces as static assets (D107, on D23's precedent).
 *
 * Docent's chrome is set in Newsreader (titles) and Spline Sans (body). Both
 * are SIL OFL 1.1, and both are *bundled* rather than linked: a self-hosted
 * install must come up with its own typography and no call out to
 * fonts.googleapis.com — the same reasoning that vendors the shape libraries.
 *
 * Run once, by hand, and commit what lands in public/fonts:
 *
 *     node scripts/fetch-fonts.mjs
 *
 * Google's CSS2 API answers a modern browser UA with one *variable* woff2 per
 * family — a single file spanning the whole weight range — and splits the
 * character set by unicode-range. We take the `latin` cut only (U+0000-00FF
 * plus the usual punctuation), which is what the chrome's own strings need;
 * a person's diagram text is Excalidraw's business and its fonts are its own.
 *
 * Nothing in the app runs this. It is a build-time vendoring step whose output
 * is checked in, so an offline clone builds and runs unchanged.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");

/** A modern UA is what makes Google serve woff2 rather than ttf. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** The `latin` subset's unicode-range always opens with the Basic Latin block. */
const LATIN = "U+0000-00FF";

const FAMILIES = [
  { query: "Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600", file: "newsreader-latin.woff2" },
  { query: "Spline+Sans:wght@400;500;600", file: "spline-sans-latin.woff2" },
];

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`GET ${url} — HTTP ${response.status}`);
  return response.text();
}

/**
 * The URLs of every `latin` face in a CSS2 answer, de-duplicated. A variable
 * family answers all its weights with one file, so the set is usually a
 * singleton; a static family would yield one per weight and both are fine.
 */
function latinSources(css) {
  const urls = new Set();
  for (const block of css.split("@font-face")) {
    if (!block.includes(`unicode-range: ${LATIN}`)) continue;
    const match = /src:\s*url\((https:\/\/[^)]+\.woff2)\)/.exec(block);
    if (match) urls.add(match[1]);
  }
  return [...urls];
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const family of FAMILIES) {
    const css = await fetchText(
      `https://fonts.googleapis.com/css2?family=${family.query}&display=swap`,
    );
    const sources = latinSources(css);
    if (sources.length !== 1) {
      // More than one means the family stopped being variable upstream, and
      // the @font-face block in styles.css would need one rule per weight.
      throw new Error(
        `${family.query}: expected one latin woff2, got ${sources.length} — ` +
          `styles.css assumes a single variable file per family`,
      );
    }
    const response = await fetch(sources[0], { headers: { "User-Agent": UA } });
    if (!response.ok) throw new Error(`GET ${sources[0]} — HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(join(OUT_DIR, family.file), bytes);
    console.log(`${family.file}  ${(bytes.length / 1024).toFixed(1)} KB  ← ${sources[0]}`);
  }
}

await main();
