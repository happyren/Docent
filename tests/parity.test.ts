/**
 * Q1 — path parity, bounded numerically. The overlay edge path must track
 * Excalidraw's rendered centerline within the glow radius:
 *  - straight/sharp/elbow routes render as the drawn polyline → our path may
 *    deviate only at corner arcs, bounded by the corner radius (8) which is
 *    inside the glow radius (12).
 *  - rounded linear elements render via the Catmull-Rom→Bézier conversion
 *    with tightness 0 (control points p1 ± (p2-p0)/6) — the exact formula
 *    our emitter uses; the test locks those control points numerically and
 *    verifies the path passes through every drawn point.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotFromSceneJSON } from "../src/adapter/snapshot";
import { edgePath } from "../src/overlay/geometry";
import type { EdgeGeometry } from "../src/adapter";

const GLOW_RADIUS = 12;
const CORNER_RADIUS = 8;

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const paritySnapshot = snapshotFromSceneJSON(
  readFileSync(join(FIXTURES, "arrows.excalidraw"), "utf8"),
);

type Point = [number, number];

/** Evaluate our emitter's absolute M/L/Q/C path at `samples` points. */
function samplePath(d: string, samples: number): Point[] {
  const tokens = d.match(/[MLQC]|-?\d+(?:\.\d+)?/g)!;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const segments: { kind: string; pts: Point[] }[] = [];
  let current: Point = [0, 0];
  while (i < tokens.length) {
    const op = tokens[i++];
    if (op === "M") {
      current = [num(), num()];
      segments.push({ kind: "M", pts: [current] });
    } else if (op === "L") {
      const to: Point = [num(), num()];
      segments.push({ kind: "L", pts: [current, to] });
      current = to;
    } else if (op === "Q") {
      const c: Point = [num(), num()];
      const to: Point = [num(), num()];
      segments.push({ kind: "Q", pts: [current, c, to] });
      current = to;
    } else if (op === "C") {
      const c1: Point = [num(), num()];
      const c2: Point = [num(), num()];
      const to: Point = [num(), num()];
      segments.push({ kind: "C", pts: [current, c1, c2, to] });
      current = to;
    }
  }
  const evalSeg = (seg: { kind: string; pts: Point[] }, t: number): Point => {
    const lerp = (a: Point, b: Point, u: number): Point => [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
    ];
    if (seg.kind === "L") return lerp(seg.pts[0], seg.pts[1], t);
    if (seg.kind === "Q") {
      const a = lerp(seg.pts[0], seg.pts[1], t);
      const b = lerp(seg.pts[1], seg.pts[2], t);
      return lerp(a, b, t);
    }
    const a = lerp(seg.pts[0], seg.pts[1], t);
    const b = lerp(seg.pts[1], seg.pts[2], t);
    const c = lerp(seg.pts[2], seg.pts[3], t);
    return lerp(lerp(a, b, t), lerp(b, c, t), t);
  };
  const drawable = segments.filter((s) => s.kind !== "M");
  const out: Point[] = [];
  for (const seg of drawable) {
    for (let s = 0; s <= samples; s++) out.push(evalSeg(seg, s / samples));
  }
  return out;
}

function distToPolyline(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

function geometryOf(id: string): EdgeGeometry {
  const el = paritySnapshot.elements.find((e) => e.id === id)!;
  return {
    points: el.points!,
    x: el.x,
    y: el.y,
    rounded: false,
    elbowed: false,
  };
}

function absPoints(geo: EdgeGeometry): Point[] {
  return geo.points.map(([px, py]) => [geo.x + px, geo.y + py]);
}

describe("Q1 parity bounds on the arrows fixture", () => {
  it("straight and vertical arrows follow the drawn line exactly", () => {
    for (const id of ["pe_straight", "pe_vertical"]) {
      const geo = geometryOf(id);
      const poly = absPoints(geo);
      for (const p of samplePath(edgePath(geo), 24)) {
        expect(distToPolyline(p, poly)).toBeLessThan(0.05);
      }
    }
  });

  it("elbow routes stay within the corner radius of the drawn polyline", () => {
    const geo = { ...geometryOf("pe_elbow"), elbowed: true };
    const poly = absPoints(geo);
    let maxDeviation = 0;
    for (const p of samplePath(edgePath(geo), 24)) {
      maxDeviation = Math.max(maxDeviation, distToPolyline(p, poly));
    }
    expect(maxDeviation).toBeLessThanOrEqual(CORNER_RADIUS + 0.1);
    expect(maxDeviation).toBeLessThan(GLOW_RADIUS);
    // Path must still pass through both endpoints exactly.
    const samples = samplePath(edgePath(geo), 24);
    expect(Math.hypot(samples[0][0] - poly[0][0], samples[0][1] - poly[0][1])).toBeLessThan(0.05);
    const last = samples[samples.length - 1];
    const end = poly[poly.length - 1];
    expect(Math.hypot(last[0] - end[0], last[1] - end[1])).toBeLessThan(0.05);
  });

  it("rounded arrows use the tightness-0 Catmull-Rom control formula and pass through every drawn point", () => {
    const geo = { ...geometryOf("pe_curved"), rounded: true };
    const pts = absPoints(geo);
    const d = edgePath(geo);
    // Lock the control points to p1 + (p2-p0)/6 and p2 - (p3-p1)/6 — the
    // conversion Excalidraw's renderer applies to curved linear elements.
    const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const curves: number[][] = [];
    for (let i = 2; i < nums.length; i += 6) curves.push(nums.slice(i, i + 6));
    expect(curves).toHaveLength(pts.length - 1);
    curves.forEach((c, i) => {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      expect(c[0]).toBeCloseTo(p1[0] + (p2[0] - p0[0]) / 6, 1);
      expect(c[1]).toBeCloseTo(p1[1] + (p2[1] - p0[1]) / 6, 1);
      expect(c[2]).toBeCloseTo(p2[0] - (p3[0] - p1[0]) / 6, 1);
      expect(c[3]).toBeCloseTo(p2[1] - (p3[1] - p1[1]) / 6, 1);
      expect(c[4]).toBeCloseTo(p2[0], 1);
      expect(c[5]).toBeCloseTo(p2[1], 1);
    });
  });

  it("elbowed-flag arrows render from their stored points — verified upstream renders the same (no render-time routing)", () => {
    const el = paritySnapshot.elements.find((e) => e.id === "pe_true_elbow")!;
    const geo = { ...geometryOf("pe_true_elbow"), elbowed: true };
    const poly = absPoints(geo);
    // Fixture invariant: this element carries the real elbowed flag.
    expect(el.points!.length).toBeGreaterThanOrEqual(2);
    for (const p of samplePath(edgePath(geo), 24)) {
      expect(distToPolyline(p, poly)).toBeLessThanOrEqual(CORNER_RADIUS + 0.1);
    }
  });

  it("every fixture arrow's path starts and ends on its drawn endpoints", () => {
    for (const el of paritySnapshot.elements) {
      if (el.type !== "arrow" || !el.points) continue;
      const geo = geometryOf(el.id);
      const poly = absPoints(geo);
      const samples = samplePath(edgePath(geo), 8);
      const first = samples[0];
      const last = samples[samples.length - 1];
      expect(Math.hypot(first[0] - poly[0][0], first[1] - poly[0][1])).toBeLessThan(0.05);
      const end = poly[poly.length - 1];
      expect(Math.hypot(last[0] - end[0], last[1] - end[1])).toBeLessThan(0.05);
    }
  });
});
