#!/usr/bin/env node
/**
 * The symbol catalog (D81): every item of the bundled libraries, by name,
 * with what an agent needs to choose one — never its geometry. Generated
 * from the `.excalidrawlib` files and checked in; `aliases.json` adds names
 * for items that have none and the synonyms a model reaches for.
 *
 *   node scripts/catalog-libraries.mjs          # writes public/libraries/catalog.json
 *   node scripts/catalog-libraries.mjs --check  # exits 1 if the file would change
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public", "libraries");
const aliases = JSON.parse(readFileSync(join(dir, "aliases.json"), "utf8"));

/** AWS draws each category in one brand colour; the icon's fill names it. */
const AWS_CATEGORIES = {
  "#fd7e1488": "compute",
  "#fd7e14": "compute",
  "#e6498088": "application integration",
  // AWS draws analytics and networking in the same purple.
  "#7950f288": "analytics and networking",
  "#7eddd2": "machine learning",
  "#eebefa": "database",
  "#40c05788": "storage",
  "#fa525288": "front-end and mobile",
  "#4c6ef588": "management",
  "#ced4da": "grouping",
};
const IGNORED_FILLS = new Set(["transparent", "", "#ffffff", "#fff", "#000", "#ff00", "#000000", "black"]);

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function bounds(elements) {
  const xs = elements.map((e) => e.x);
  const ys = elements.map((e) => e.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.round(Math.max(...elements.map((e) => e.x + e.width)) - x),
    height: Math.round(Math.max(...elements.map((e) => e.y + e.height)) - y),
  };
}

function itemsOf(file) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const library = file.replace(/\.excalidrawlib$/, "");
  const raw = data.libraryItems ?? (data.library ?? []).map((elements, i) => ({ id: `${library}-${i}`, elements }));
  return raw.map((item, index) => ({ library, index, id: item.id ?? `${library}-${index}`, name: item.name ?? null, elements: item.elements }));
}

const entries = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".excalidrawlib")).sort()) {
  const library = file.replace(/\.excalidrawlib$/, "");
  const given = aliases.names?.[library] ?? {};
  for (const item of itemsOf(file)) {
    const name = item.name ?? given[String(item.index)] ?? null;
    if (!name) continue;
    const texts = item.elements.filter((e) => e.type === "text");
    const glyph = item.elements.filter((e) => e.type !== "text");
    const all = bounds(item.elements);
    const icon = glyph.length ? bounds(glyph) : all;
    const fills = glyph.map((e) => e.backgroundColor ?? "").filter((f) => !IGNORED_FILLS.has(f));
    const brand = fills.length ? [...new Set(fills)].sort((a, b) => fills.filter((f) => f === b).length - fills.filter((f) => f === a).length)[0] : null;
    const category = library.startsWith("aws") ? (AWS_CATEGORIES[brand] ?? "general") : (aliases.categories?.[library]?.[name] ?? "general");
    const symbol = `${slug(library.replace(/-architecture-icons|-architecture/, ""))}/${slug(name)}`;
    entries.push({
      symbol,
      name,
      library,
      index: item.index,
      itemId: item.id,
      category,
      icon: { width: icon.width, height: icon.height, x: Math.round(icon.x - all.x), y: Math.round(icon.y - all.y) },
      size: { width: all.width, height: all.height },
      caption: texts.length ? texts[0].text : null,
      aliases: (aliases.aliases?.[symbol] ?? []).map((a) => a.toLowerCase()),
    });
  }
}
// Two items whose names differ only in case ("Iot Greengrass", "IoT
// Greengrass") are one symbol to a reader; the second takes its index.
const seen = new Map();
for (const e of entries) {
  const n = seen.get(e.symbol) ?? 0;
  seen.set(e.symbol, n + 1);
  if (n) e.symbol = `${e.symbol}-${n + 1}`;
}
entries.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

const out = JSON.stringify({ version: 1, symbols: entries }, null, 1) + "\n";
const target = join(dir, "catalog.json");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== out) {
    console.error("catalog.json is out of date — run node scripts/catalog-libraries.mjs");
    process.exit(1);
  }
  console.log(`catalog.json is current (${entries.length} symbols)`);
} else {
  writeFileSync(target, out);
  console.log(`wrote ${entries.length} symbols to public/libraries/catalog.json`);
}
