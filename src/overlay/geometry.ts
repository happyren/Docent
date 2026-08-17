/**
 * Overlay path math (D4 — path parity). Edge paths replicate Excalidraw's
 * construction from `element.points` + roundness:
 *  - sharp linear/elbow elements: the drawn polyline (elbow routes are
 *    stored in points, so rendering them faithfully IS the visible path)
 *  - rounded linear elements: a Catmull-Rom pass through the same points,
 *    matching the curve rendering within the glow radius (Q1)
 *
 * All outputs are SVG path strings in scene coordinates. Pure module — no
 * DOM, no Excalidraw imports.
 */
import type { EdgeGeometry, SceneBounds } from "../adapter";

export function edgePath(geometry: EdgeGeometry): string {
  const abs = geometry.points.map(
    ([px, py]) => [geometry.x + px, geometry.y + py] as [number, number],
  );
  if (abs.length === 2 || geometry.elbowed || !geometry.rounded) {
    return polylinePath(abs, geometry.elbowed ? 8 : 0);
  }
  return catmullRomPath(abs);
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Polyline, optionally with small rounded corners (elbow aesthetics). */
function polylinePath(points: [number, number][], cornerRadius: number): string {
  if (cornerRadius <= 0 || points.length <= 2) {
    return points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`)
      .join(" ");
  }
  const parts = [`M${fmt(points[0][0])} ${fmt(points[0][1])}`];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(cornerRadius, inLen / 2, outLen / 2);
    const inX = cx - ((cx - px) / inLen) * r;
    const inY = cy - ((cy - py) / inLen) * r;
    const outX = cx + ((nx - cx) / outLen) * r;
    const outY = cy + ((ny - cy) / outLen) * r;
    parts.push(`L${fmt(inX)} ${fmt(inY)}`);
    parts.push(`Q${fmt(cx)} ${fmt(cy)} ${fmt(outX)} ${fmt(outY)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L${fmt(last[0])} ${fmt(last[1])}`);
  return parts.join(" ");
}

/** Catmull-Rom through all points, emitted as cubic Béziers. */
function catmullRomPath(points: [number, number][]): string {
  const parts = [`M${fmt(points[0][0])} ${fmt(points[0][1])}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    parts.push(
      `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`,
    );
  }
  return parts.join(" ");
}

/** Outline path for a node shape, in scene coordinates (highlight targets). */
export function shapePath(
  type: string,
  bounds: SceneBounds,
  pad = 0,
): string {
  const x = bounds.x - pad;
  const y = bounds.y - pad;
  const w = bounds.width + pad * 2;
  const h = bounds.height + pad * 2;
  if (type === "ellipse") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    return `M${fmt(cx - rx)} ${fmt(cy)} a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(rx * 2)} 0 a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-rx * 2)} 0`;
  }
  if (type === "diamond") {
    return `M${fmt(x + w / 2)} ${fmt(y)} L${fmt(x + w)} ${fmt(y + h / 2)} L${fmt(x + w / 2)} ${fmt(y + h)} L${fmt(x)} ${fmt(y + h / 2)} Z`;
  }
  const r = Math.min(12, w / 4, h / 4);
  return `M${fmt(x + r)} ${fmt(y)} h${fmt(w - 2 * r)} a${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(r)} ${fmt(r)} v${fmt(h - 2 * r)} a${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(-r)} ${fmt(r)} h${fmt(-(w - 2 * r))} a${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(-r)} ${fmt(-r)} v${fmt(-(h - 2 * r))} a${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(r)} ${fmt(-r)} Z`;
}
