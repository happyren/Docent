/**
 * Overlay renderer (S5, B3): a viewport-synced layer above the canvas.
 * The ONLY place effects draw. Reads the scene through the read-only
 * `SceneReader` surface and the overlay store — it cannot write (I2).
 *
 * Neon-over-pencil (D3): highlights and flow pulses render as wide soft
 * glows over the sketchy strokes — never tracing roughjs jitter.
 *
 * Perf (Q4):
 *  - The camera transform is CSS on a composited wrapper div — static glow
 *    blurs rasterize once per content change and pan/zoom is pure GPU
 *    compositing; React renders nothing during camera motion.
 *  - Spotlight is a single even-odd path (outer rect + target holes) — no
 *    SVG mask, no offscreen surface.
 *  - The moving comet carries no filters: a radial-gradient pulse and a
 *    double-stroke trail, with DOM writes capped at ~60Hz for high-refresh
 *    displays.
 */
import { useEffect, useRef, useState } from "react";
import type { SceneBounds, Viewport } from "../adapter";
import type { SceneReader } from "../command/api";
import type { DetailBadge, LinkBadge, LogicMark } from "../scene/detailBadges";
import { edgePath, shapePath } from "./geometry";
import type { OverlayState, OverlayStore } from "./state";
import { TONE_LOOK } from "../authoring/palette";

const FLOW_UNITS_PER_SECOND = 500;
const GLOW_COLOR = "#ffd43b";
const FLOW_COLOR = "#4dabf7";
const OUTLINE_COLOR = "#7048e8";
/** The link marker's chip (D96) — a different errand, a different colour. */
const LINK_COLOR = "#1c7ed6";
const GHOST_COLOR = "#e03131";
const FILTER_MARGIN = 120;
/** Step-badge radius in scene units — a detail badge's chip, rounded (D89). */
const STEP_BADGE_R = 12;
const MIN_WRITE_INTERVAL_MS = 7.5;

interface TargetPath {
  id: string;
  d: string;
  isEdge: boolean;
  bounds: SceneBounds;
  angle: number;
  transform?: string;
}

function targetPath(reader: SceneReader, id: string, pad: number): TargetPath | null {
  const info = reader.getElementInfo(id);
  if (!info) return null;
  const geometry = reader.getEdgeGeometry(id);
  if (geometry) {
    return {
      id,
      d: edgePath(geometry),
      isEdge: true,
      bounds: info.bounds,
      angle: 0,
    };
  }
  const transform =
    info.angle !== 0
      ? `rotate(${(info.angle * 180) / Math.PI} ${info.bounds.x + info.bounds.width / 2} ${info.bounds.y + info.bounds.height / 2})`
      : undefined;
  return {
    id,
    d: shapePath(info.type, info.bounds, pad),
    isEdge: false,
    bounds: info.bounds,
    angle: info.angle,
    transform,
  };
}

/**
 * One effect per target (D39): a target of one member keeps its own shape
 * path; a composite or group — many members — becomes one rounded box over
 * the union of its members. One glow path instead of one per stroke, and a
 * hole the fill rule can reason about.
 */
function compositeTargetPath(
  reader: SceneReader,
  members: string[],
  pad: number,
): TargetPath | null {
  if (members.length === 1) return targetPath(reader, members[0], pad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of members) {
    const info = reader.getElementInfo(id);
    if (!info) continue;
    minX = Math.min(minX, info.bounds.x);
    minY = Math.min(minY, info.bounds.y);
    maxX = Math.max(maxX, info.bounds.x + info.bounds.width);
    maxY = Math.max(maxY, info.bounds.y + info.bounds.height);
  }
  if (!Number.isFinite(minX)) return null;
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return {
    id: members.join("+"),
    d: shapePath("rectangle", bounds, pad),
    isEdge: false,
    bounds,
    angle: 0,
  };
}

/** Axis-aligned boxes that overlap merge into their enclosing box, until none do. */
export function mergeOverlapping(boxes: SceneBounds[]): SceneBounds[] {
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        if (!overlaps) continue;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        out[i] = {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x,
          height: Math.max(a.y + a.height, b.y + b.height) - y,
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}

/** Union of target bounds + margin — the blur filters' working region. */
function filterRegion(targets: TargetPath[]): SceneBounds {
  if (!targets.length) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of targets) {
    minX = Math.min(minX, t.bounds.x);
    minY = Math.min(minY, t.bounds.y);
    maxX = Math.max(maxX, t.bounds.x + t.bounds.width);
    maxY = Math.max(maxY, t.bounds.y + t.bounds.height);
  }
  return {
    x: minX - FILTER_MARGIN,
    y: minY - FILTER_MARGIN,
    width: maxX - minX + FILTER_MARGIN * 2,
    height: maxY - minY + FILTER_MARGIN * 2,
  };
}

/**
 * Spotlight holes: closed subpaths punched out of the dim rect via
 * fill-rule evenodd. Rotated shapes and edges use padded bounds boxes —
 * a hole must be a fill, not a stroke.
 */
export function spotlightHoles(targets: TargetPath[]): string {
  // Under evenodd, holes that overlap cancel each other back to dark (D39).
  // So: every target's hole is tested as a box; boxes that touch merge into
  // one enclosing hole, and only a lone, unrotated, single-shape target
  // keeps its true outline.
  const p = 14;
  const boxOf = (t: TargetPath): SceneBounds => ({
    x: t.bounds.x - p,
    y: t.bounds.y - p,
    width: t.bounds.width + 2 * p,
    height: t.bounds.height + 2 * p,
  });
  const boxes = targets.map(boxOf);
  const clusters = mergeOverlapping(boxes);
  return clusters
    .map((box) => {
      // Which targets landed in this cluster? One plain shape alone keeps
      // its path; anything merged or boxy is the cluster's rectangle.
      const inside = targets.filter((_t, i) => {
        const b = boxes[i];
        return (
          b.x >= box.x &&
          b.y >= box.y &&
          b.x + b.width <= box.x + box.width &&
          b.y + b.height <= box.y + box.height
        );
      });
      const lone = inside.length === 1 ? inside[0] : null;
      if (lone && !lone.isEdge && lone.angle === 0 && !lone.id.includes("+")) {
        return lone.d;
      }
      return `M${box.x} ${box.y} h${box.width} v${box.height} h${-box.width} Z`;
    })
    .join(" ");
}

function viewRect(reader: SceneReader, vp: Viewport): SceneBounds {
  const size = reader.getViewportSize();
  const pad = 60 / vp.zoom;
  return {
    x: -vp.scrollX - pad,
    y: -vp.scrollY - pad,
    width: size.width / vp.zoom + pad * 2,
    height: size.height / vp.zoom + pad * 2,
  };
}

export function OverlayLayer({
  reader,
  store,
  revision,
  badges = [],
  onBadgeClick,
  linkBadges = [],
  onLinkClick,
  logicMarks = [],
}: {
  reader: SceneReader;
  store: OverlayStore;
  /** Bump when document content changes so target geometry recomputes. */
  revision: number;
  /**
   * Detail-layer markers (D31): static corner chips, no filters, no
   * animation — they ride the composited stage like everything else.
   */
  badges?: DetailBadge[];
  onBadgeClick?: (diveElementId: string) => void;
  /**
   * Link markers (D96): the same chip on the other top corner, so a
   * component that both goes deeper and goes elsewhere wears both.
   */
  linkBadges?: LinkBadge[];
  onLinkClick?: (elementId: string) => void;
  /** `{ }` marks on components that carry logic (D42) — passive chips. */
  logicMarks?: LogicMark[];
}) {
  const [overlay, setOverlay] = useState<OverlayState>(() => store.get());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<SVGPathElement | null>(null);
  const holesRef = useRef("");
  const flowPathRefs = useRef<(SVGPathElement | null)[]>([]);
  const pulseRef = useRef<SVGCircleElement | null>(null);
  const trailGlowRef = useRef<SVGPathElement | null>(null);
  const trailCoreRef = useRef<SVGPathElement | null>(null);

  useEffect(() => store.subscribe(setOverlay), [store]);

  // Camera sync: one CSS transform per frame. The spotlight backdrop
  // pre-covers ~2.5× the viewport and rewrites only when the camera leaves
  // that region — a per-frame path rewrite would invalidate the composited
  // layer every frame (a full-viewport CPU repaint under software
  // rendering).
  const coverageRef = useRef<SceneBounds | null>(null);
  useEffect(() => {
    coverageRef.current = null; // re-cover when targets/effects change
    const contains = (outer: SceneBounds, inner: SceneBounds) =>
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height;
    const apply = (vp: Viewport) => {
      const stage = stageRef.current;
      if (stage) {
        stage.style.transform = `scale(${vp.zoom}) translate(${vp.scrollX}px, ${vp.scrollY}px)`;
      }
      const backdrop = backdropRef.current;
      if (backdrop) {
        const view = viewRect(reader, vp);
        if (!coverageRef.current || !contains(coverageRef.current, view)) {
          const grow = 0.75; // 2.5× linear coverage
          coverageRef.current = {
            x: view.x - view.width * grow,
            y: view.y - view.height * grow,
            width: view.width * (1 + 2 * grow),
            height: view.height * (1 + 2 * grow),
          };
          const c = coverageRef.current;
          backdrop.setAttribute(
            "d",
            `M${c.x} ${c.y} h${c.width} v${c.height} h${-c.width} Z ${holesRef.current}`,
          );
        }
      }
    };
    apply(reader.getViewport());
    return reader.onViewportChange(apply);
  }, [reader, overlay, revision]);

  const highlightPad = overlay.highlight?.style === "outline" ? 6 : 4;
  const highlightTargets: TargetPath[] = (overlay.highlight?.targets ?? [])
    .map((members) => compositeTargetPath(reader, members, highlightPad))
    .filter((t): t is TargetPath => t !== null);

  const flowTargets: TargetPath[] = (overlay.flow?.path ?? [])
    .map((id) => targetPath(reader, id, 0))
    .filter((t): t is TargetPath => t !== null && t.isEdge);

  const region = filterRegion([...highlightTargets, ...flowTargets]);
  const spotlight = overlay.highlight?.style === "spotlight";
  holesRef.current = spotlight ? spotlightHoles(highlightTargets) : "";
  const initialView = viewRect(reader, reader.getViewport());
  const initialViewport = reader.getViewport();

  // Flow pulse: a comet driven along the concatenated edge paths, DOM
  // writes capped at ~60Hz.
  useEffect(() => {
    const flow = overlay.flow;
    const pulse = pulseRef.current;
    const trailGlow = trailGlowRef.current;
    const trailCore = trailCoreRef.current;
    if (!flow || !pulse || !trailGlow || !trailCore) return;
    const paths = flowPathRefs.current.filter(
      (p): p is SVGPathElement => p !== null,
    );
    if (!paths.length) return;
    const lengths = paths.map((p) => p.getTotalLength());
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total === 0) return;

    const parts = [pulse, trailGlow, trailCore];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Stay hidden until the first tick positions the comet (rAF may be
    // paused in hidden tabs — never show an unpositioned pulse).
    for (const el of parts) el.style.display = "none";
    if (reduced) return; // degrade to the static lit path (I8)

    let raf = 0;
    let last = performance.now();
    let lastWrite = 0;
    let distance = 0;
    const tail = Math.min(90, total / 3);
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      distance += dt * FLOW_UNITS_PER_SECOND * flow.speed;
      if (distance > total + tail) {
        if (flow.loop) {
          distance = 0;
        } else {
          for (const el of parts) el.style.display = "none";
          return;
        }
      }
      if (now - lastWrite < MIN_WRITE_INTERVAL_MS) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastWrite = now;
      for (const el of parts) el.style.display = "";
      const head = Math.min(distance, total);
      let acc = 0;
      let segment = 0;
      while (segment < lengths.length - 1 && acc + lengths[segment] < head) {
        acc += lengths[segment];
        segment += 1;
      }
      const point = paths[segment].getPointAtLength(
        Math.max(0, Math.min(head - acc, lengths[segment])),
      );
      pulse.setAttribute("cx", String(point.x));
      pulse.setAttribute("cy", String(point.y));
      const active = paths[segment];
      const localHead = Math.max(0, Math.min(head - acc, lengths[segment]));
      const d = active.getAttribute("d") ?? "";
      const dash = `${Math.min(tail, localHead)} ${lengths[segment] + tail}`;
      const offset = String(
        lengths[segment] - localHead + Math.min(tail, localHead),
      );
      for (const el of [trailGlow, trailCore]) {
        el.setAttribute("d", d);
        el.style.strokeDasharray = dash;
        el.style.strokeDashoffset = offset;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.flow?.generation, revision, flowTargets.length]);

  return (
    <div className="docent-overlay">
      <div
        ref={stageRef}
        className="docent-overlay-stage"
        style={{
          transform: `scale(${initialViewport.zoom}) translate(${initialViewport.scrollX}px, ${initialViewport.scrollY}px)`,
        }}
      >
        <svg className="docent-overlay-svg" width="1" height="1">
          <defs>
            {/* userSpaceOnUse regions sized to the targets: percentage
                regions collapse on axis-aligned paths (zero-area bbox). */}
            <filter
              id="docent-glow"
              filterUnits="userSpaceOnUse"
              x={region.x}
              y={region.y}
              width={region.width}
              height={region.height}
            >
              <feGaussianBlur stdDeviation="6" />
            </filter>
            <radialGradient id="docent-pulse-halo">
              <stop offset="0%" stopColor="#e7f5ff" />
              <stop offset="35%" stopColor={FLOW_COLOR} stopOpacity="0.9" />
              <stop offset="100%" stopColor={FLOW_COLOR} stopOpacity="0" />
            </radialGradient>
          </defs>
          {spotlight && (
            <path
              ref={backdropRef}
              d={`M${initialView.x} ${initialView.y} h${initialView.width} v${initialView.height} h${-initialView.width} Z ${holesRef.current}`}
              fill="#101014"
              opacity={0.55}
              fillRule="evenodd"
            />
          )}
          {overlay.highlight &&
            overlay.highlight.style !== "spotlight" &&
            highlightTargets.map((t) => (
              <g key={t.id} transform={t.transform}>
                {overlay.highlight!.style === "glow" && (
                  <path
                    d={t.d}
                    fill="none"
                    stroke={GLOW_COLOR}
                    strokeWidth={t.isEdge ? 12 : 14}
                    strokeLinecap="round"
                    opacity={0.65}
                    filter="url(#docent-glow)"
                  />
                )}
                <path
                  d={t.d}
                  fill="none"
                  stroke={
                    overlay.highlight!.style === "outline" ? OUTLINE_COLOR : GLOW_COLOR
                  }
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  opacity={0.95}
                />
              </g>
            ))}
          {overlay.flow &&
            flowTargets.map((t, i) => (
              <path
                key={t.id}
                ref={(el) => {
                  flowPathRefs.current[i] = el;
                }}
                d={t.d}
                fill="none"
                stroke={FLOW_COLOR}
                strokeWidth={10}
                strokeLinecap="round"
                opacity={0.3}
                filter="url(#docent-glow)"
              />
            ))}
          {overlay.flow && (
            <>
              <path
                ref={trailGlowRef}
                d=""
                fill="none"
                stroke={FLOW_COLOR}
                strokeWidth={11}
                strokeLinecap="round"
                opacity={0.35}
              />
              <path
                ref={trailCoreRef}
                d=""
                fill="none"
                stroke={FLOW_COLOR}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.95}
              />
              <circle ref={pulseRef} r={16} fill="url(#docent-pulse-halo)" />
            </>
          )}
          {overlay.steps.map((s) => (
            // A scenario's step number, on the stroke it travels (D89).
            // Neon over pencil like the pulse it belongs to (D3), and sized
            // in scene units like the detail badges, so the digit keeps its
            // proportions at every zoom.
            <g key={`step:${s.n}`} className="docent-step-badge">
              <title>{`step ${s.n}`}</title>
              <circle cx={s.x} cy={s.y} r={STEP_BADGE_R + 3} fill={FLOW_COLOR} opacity={0.3} filter="url(#docent-glow)" />
              <circle cx={s.x} cy={s.y} r={STEP_BADGE_R} fill="#1c3d5a" stroke={FLOW_COLOR} strokeWidth={2} opacity={0.95} />
              <text
                x={s.x}
                y={s.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={STEP_BADGE_R * 1.2}
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fontWeight="700"
                fill="#e7f5ff"
              >
                {s.n}
              </text>
            </g>
          ))}
          {/* The compare lens's tints (D134): green for what the proposal
              adds, amber for what it changes — quiet washes with a solid
              hairline, beside the ghosts of what it removes. */}
          {overlay.compareMarks.map((m) => (
            <rect
              key={`mark:${m.id}`}
              className={`docent-compare-${m.tone}`}
              x={m.bounds.x - 4}
              y={m.bounds.y - 4}
              width={Math.max(m.bounds.width, 8) + 8}
              height={Math.max(m.bounds.height, 8) + 8}
              rx={8}
              fill={m.tone === "added" ? "#2f9e44" : "#e8590c"}
              fillOpacity={0.09}
              stroke={m.tone === "added" ? "#2f9e44" : "#e8590c"}
              strokeWidth={2}
              opacity={0.9}
            />
          ))}
          {overlay.ghosts.map((g) => (
            <g key={`ghost:${g.id}`} className="docent-ghost">
              <title>{`${g.label} — removed`}</title>
              <rect
                x={g.bounds.x}
                y={g.bounds.y}
                width={Math.max(g.bounds.width, 8)}
                height={Math.max(g.bounds.height, 8)}
                rx={6}
                fill={GHOST_COLOR}
                fillOpacity={0.08}
                stroke={GHOST_COLOR}
                strokeWidth={2}
                strokeDasharray="8 6"
                opacity={0.9}
              />
              <text
                x={g.bounds.x + Math.max(g.bounds.width, 8) / 2}
                y={g.bounds.y + Math.max(g.bounds.height, 8) / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={14}
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fill={GHOST_COLOR}
                opacity={0.8}
              >
                {g.label}
              </text>
            </g>
          ))}
          {/* Status marks (D150): an author's verdict as a glyph chip at a
              corner — the palette's tones, the note as the tooltip. */}
          {overlay.statusMarks.map((m) => {
            const s = 20;
            const tone =
              m.state === "ok" ? TONE_LOOK.positive : m.state === "fail" ? TONE_LOOK.danger : m.state === "warn" ? TONE_LOOK.caution : TONE_LOOK.neutral;
            const glyph = m.state === "ok" ? "✓" : m.state === "fail" ? "✕" : m.state === "warn" ? "!" : "•";
            const x = m.corner.endsWith("right") ? m.bounds.x + m.bounds.width - s / 2 : m.bounds.x - s / 2;
            const y = m.corner.startsWith("bottom") ? m.bounds.y + m.bounds.height - s / 2 : m.bounds.y - s / 2;
            return (
              <g key={`status:${m.by}:${m.id}`} className={`docent-status-mark docent-status-${m.state}`} transform={`translate(${x} ${y})`}>
                <title>{`${m.by}: ${m.state}${m.note ? ` — ${m.note}` : ""}`}</title>
                <circle cx={s / 2} cy={s / 2} r={s / 2} fill={tone.stroke} stroke="#ffffff" strokeWidth={2} />
                <text
                  x={s / 2}
                  y={s / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={13}
                  fontWeight={700}
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                  fill="#ffffff"
                >
                  {glyph}
                </text>
              </g>
            );
          })}
          {badges.map((b) => {
            const s = b.size;
            return (
              <g
                key={b.id}
                className="docent-detail-badge"
                transform={`translate(${b.bounds.x + b.bounds.width - s / 2} ${b.bounds.y - s / 2})`}
                onClick={() => onBadgeClick?.(b.diveElementId)}
              >
                <title>
                  {b.label ? `${b.label} — has a detail layer` : "Has a detail layer"}
                </title>
                <g className="docent-detail-badge-chip">
                  <rect
                    width={s}
                    height={s}
                    rx={s * 0.27}
                    fill={OUTLINE_COLOR}
                    opacity={0.92}
                  />
                  <rect
                    x={s * 0.38}
                    y={s * 0.2}
                    width={s * 0.42}
                    height={s * 0.3}
                    rx={s * 0.07}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={s * 0.08}
                  />
                  <rect
                    x={s * 0.2}
                    y={s * 0.42}
                    width={s * 0.42}
                    height={s * 0.3}
                    rx={s * 0.07}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={s * 0.08}
                  />
                </g>
              </g>
            );
          })}
          {linkBadges.map((b) => {
            const s = b.size;
            const target = `${b.link.project ? `${b.link.project}/` : ""}${b.link.scene}${b.link.at ? ` #${b.link.at}` : ""}`;
            return (
              <g
                key={`link:${b.id}`}
                className="docent-detail-badge"
                transform={`translate(${b.bounds.x - s / 2} ${b.bounds.y - s / 2})`}
                onClick={() => onLinkClick?.(b.elementId)}
              >
                <title>{`${b.label ? `${b.label} — links` : "Links"} to ${target}`}</title>
                <g className="docent-detail-badge-chip">
                  <rect width={s} height={s} rx={s * 0.27} fill={LINK_COLOR} opacity={0.92} />
                  <text
                    x={s / 2}
                    y={s * 0.7}
                    textAnchor="middle"
                    fontSize={s * 0.66}
                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                    fontWeight="700"
                    fill="#ffffff"
                  >
                    ↗
                  </text>
                </g>
              </g>
            );
          })}
          {logicMarks.map((m) => {
            const s = m.size;
            return (
              <g
                key={`logic:${m.id}`}
                className="docent-logic-mark"
                transform={`translate(${m.bounds.x + m.bounds.width - s / 2} ${m.bounds.y + m.bounds.height - s / 2})`}
              >
                <title>{`logic: ${m.preview}`}</title>
                <rect width={s} height={s} rx={s * 0.27} fill="#1d9e75" opacity={0.9} />
                <text
                  x={s / 2}
                  y={s * 0.72}
                  textAnchor="middle"
                  fontSize={s * 0.62}
                  fontFamily="ui-monospace, Menlo, monospace"
                  fontWeight="700"
                  fill="#ffffff"
                >
                  {"{}"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
