#!/usr/bin/env node
/**
 * The house glyph library (D119): about twenty minimal, monochrome glyphs —
 * the generic vocabulary of systems drawing — written deterministically to
 * `public/libraries/docent-house.excalidrawlib`. Generated and checked in,
 * like the catalog it then joins (D81): same seeds, same ids, same bytes on
 * every run (I3).
 *
 *   node scripts/make-house-library.mjs          # writes the library
 *   node scripts/make-house-library.mjs --check  # exits 1 if it would change
 *
 * The drawing discipline is the house's (A31): one ink `#1e1e1e`, one stroke
 * weight 2, transparent grounds, roughness 1 so Excalidraw's own hand draws
 * the wobble — the glyphs are clean geometry and the canvas makes them
 * hand-drawn, which is exactly how a person's shapes get their look.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "libraries", "docent-house.excalidrawlib");

const INK = "#1e1e1e";
const WEIGHT = 2;

/** Deterministic 32-bit seed from an element's own id (I3). */
function seedOf(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647 || 1;
}

/** The fields every element shares; the canvas re-derives the rest. */
function base(id, type, group, extra = {}) {
  return {
    id,
    type,
    angle: 0,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: WEIGHT,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    // One group per glyph (D132): a drag moves the drawing, never a stroke.
    groupIds: [group],
    frameId: null,
    roundness: null,
    seed: seedOf(id),
    version: 1,
    versionNonce: seedOf(`${id}#nonce`),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

// Tiny drawing verbs — every glyph is spelled in these five.
const R = (x, y, w, h, opts = {}) => ({
  kind: "rectangle",
  x,
  y,
  w,
  h,
  rounded: opts.rounded ?? true,
  dashed: opts.dashed ?? false,
});
const E = (x, y, w, h) => ({ kind: "ellipse", x, y, w, h });
const D = (x, y, w, h) => ({ kind: "diamond", x, y, w, h });
const L = (...pts) => ({ kind: "line", pts });
const A = (...pts) => ({ kind: "arrow", pts });

/**
 * The vocabulary (D119) — each glyph drawn in a 64×64 box, margin-aware,
 * line work only. Order is the library's order; names become `docent/<slug>`
 * ids through the catalog generator.
 */
const GLYPHS = [
  ["User", [E(24, 8, 16, 16), L([12, 58], [14, 46], [22, 40], [42, 40], [50, 46], [52, 58])]],
  [
    "Service",
    [
      E(18, 18, 28, 28),
      E(28, 28, 8, 8),
      // Eight gear teeth, radiating from the ring.
      ...[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const a = (deg * Math.PI) / 180;
        const at = (r) => [Math.round(32 + r * Math.cos(a)), Math.round(32 + r * Math.sin(a))];
        return L(at(14), at(20));
      }),
    ],
  ],
  [
    "Server",
    [R(12, 8, 40, 48, { rounded: false }), L([12, 24], [52, 24]), L([12, 40], [52, 40]), E(17, 14, 4, 4), E(17, 30, 4, 4), E(17, 46, 4, 4)],
  ],
  ["Function", [R(10, 10, 44, 44), L([23, 20], [41, 48]), L([31, 32], [21, 48])]],
  [
    "Database",
    [
      E(14, 6, 36, 14),
      L([14, 13], [14, 52]),
      L([50, 13], [50, 52]),
      L([14, 52], [17, 57], [26, 60], [38, 60], [47, 57], [50, 52]),
    ],
  ],
  ["Cache", [R(10, 12, 44, 40), L([34, 18], [24, 34], [31, 34], [28, 46], [40, 29], [33, 29], [38, 18])]],
  ["Storage", [E(12, 10, 40, 10), L([12, 15], [16, 54], [48, 54], [52, 15])]],
  [
    "Document",
    [
      L([14, 6], [40, 6], [50, 16], [50, 58], [14, 58], [14, 6]),
      L([40, 6], [40, 16], [50, 16]),
      L([21, 30], [43, 30]),
      L([21, 38], [37, 38]),
    ],
  ],
  ["Queue", [R(6, 22, 52, 20), L([19, 22], [19, 42]), L([32, 22], [32, 42]), L([45, 22], [45, 42])]],
  [
    "Topic",
    [
      E(10, 26, 12, 12),
      L([22, 32], [50, 12]),
      L([22, 32], [50, 32]),
      L([22, 32], [50, 52]),
      E(50, 8, 8, 8),
      E(50, 28, 8, 8),
      E(50, 48, 8, 8),
    ],
  ],
  ["Event", [E(25, 25, 14, 14), L([20, 20], [13, 13]), L([44, 20], [51, 13]), L([20, 44], [13, 51]), L([44, 44], [51, 51])]],
  [
    "Stream",
    [20, 32, 44].map((y) => L([8, y], [16, y - 5], [24, y], [32, y + 5], [40, y], [48, y - 5], [56, y])),
  ],
  ["Gateway", [D(10, 16, 44, 32), L([2, 32], [10, 32]), A([54, 32], [62, 32])]],
  [
    "Load balancer",
    [
      R(6, 24, 16, 16),
      L([22, 32], [44, 13]),
      L([22, 32], [44, 32]),
      L([22, 32], [44, 51]),
      R(44, 8, 14, 10),
      R(44, 27, 14, 10),
      R(44, 46, 14, 10),
    ],
  ],
  ["Scheduler", [E(10, 10, 44, 44), L([32, 32], [32, 19]), L([32, 32], [41, 39]), L([32, 10], [32, 14])]],
  ["Lock", [R(18, 28, 28, 26), L([23, 28], [23, 20], [27, 14], [37, 14], [41, 20], [41, 28])]],
  [
    "Cloud",
    [
      L(
        [18, 46],
        [10, 42],
        [8, 34],
        [13, 27],
        [20, 26],
        [24, 18],
        [33, 14],
        [42, 17],
        [46, 24],
        [53, 27],
        [56, 34],
        [52, 42],
        [44, 46],
        [18, 46],
      ),
    ],
  ],
  ["Terminal", [R(6, 12, 52, 40), L([14, 24], [22, 31], [14, 38]), L([28, 40], [40, 40])]],
  ["Metrics", [L([12, 10], [12, 52]), L([12, 52], [56, 52]), L([17, 45], [27, 32], [35, 38], [50, 19])]],
  ["Browser", [R(6, 10, 52, 44), L([6, 22], [58, 22]), E(11, 14, 4, 4), E(18, 14, 4, 4)]],
  ["Mobile", [R(20, 6, 24, 52), L([28, 12], [36, 12]), L([28, 52], [36, 52])]],
  ["External", [R(10, 16, 40, 36, { dashed: true }), A([38, 24], [54, 8])]],
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function build(name, verbs) {
  const flat = verbs.flat();
  const group = `dh-${slug(name)}-group`;
  return flat.map((verb, i) => {
    const id = `dh-${slug(name)}-${i}`;
    if (verb.kind === "line" || verb.kind === "arrow") {
      // Anchored at the min corner with the points normalized to it, so the
      // element's x/y/width/height ARE its visual bounds — which is what the
      // catalog generator measures.
      const minX = Math.min(...verb.pts.map(([x]) => x));
      const minY = Math.min(...verb.pts.map(([, y]) => y));
      const points = verb.pts.map(([x, y]) => [x - minX, y - minY]);
      return base(id, verb.kind, group, {
        x: minX,
        y: minY,
        width: Math.max(...points.map(([x]) => x)),
        height: Math.max(...points.map(([, y]) => y)),
        points,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: verb.kind === "arrow" ? "arrow" : null,
        roundness: { type: 2 },
      });
    }
    return base(id, verb.kind, group, {
      x: verb.x,
      y: verb.y,
      width: verb.w,
      height: verb.h,
      ...(verb.dashed ? { strokeStyle: "dashed" } : {}),
      ...(verb.kind === "rectangle" && verb.rounded ? { roundness: { type: 3 } } : {}),
    });
  });
}

const libraryItems = GLYPHS.map(([name, verbs]) => ({
  id: `docent-house-${slug(name)}`,
  status: "published",
  name,
  elements: build(name, verbs),
}));

const out =
  JSON.stringify(
    {
      type: "excalidrawlib",
      version: 2,
      source: "https://github.com/happyren/Docent",
      libraryItems,
    },
    null,
    1,
  ) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== out) {
    console.error("docent-house.excalidrawlib is out of date — run node scripts/make-house-library.mjs");
    process.exit(1);
  }
  console.log(`docent-house.excalidrawlib is current (${libraryItems.length} glyphs)`);
} else {
  writeFileSync(target, out);
  console.log(`wrote ${libraryItems.length} glyphs to public/libraries/docent-house.excalidrawlib`);
}
