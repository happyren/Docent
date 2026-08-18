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
import { edgePath, shapePath } from "./geometry";
import type { OverlayState, OverlayStore } from "./state";

const FLOW_UNITS_PER_SECOND = 500;
const GLOW_COLOR = "#ffd43b";
const FLOW_COLOR = "#4dabf7";
const OUTLINE_COLOR = "#7048e8";
const FILTER_MARGIN = 120;
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
function spotlightHoles(targets: TargetPath[]): string {
  return targets
    .map((t) => {
      if (t.isEdge || t.angle !== 0) {
        const p = 14;
        const { x, y, width, height } = t.bounds;
        return `M${x - p} ${y - p} h${width + 2 * p} v${height + 2 * p} h${-(width + 2 * p)} Z`;
      }
      return t.d;
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
}: {
  reader: SceneReader;
  store: OverlayStore;
  /** Bump when document content changes so target geometry recomputes. */
  revision: number;
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

  // Camera sync: one CSS transform + (when spotlighting) one path rewrite.
  // No React involvement per frame.
  useEffect(() => {
    const apply = (vp: Viewport) => {
      const stage = stageRef.current;
      if (stage) {
        stage.style.transform = `scale(${vp.zoom}) translate(${vp.scrollX}px, ${vp.scrollY}px)`;
      }
      const backdrop = backdropRef.current;
      if (backdrop) {
        const view = viewRect(reader, vp);
        backdrop.setAttribute(
          "d",
          `M${view.x} ${view.y} h${view.width} v${view.height} h${-view.width} Z ${holesRef.current}`,
        );
      }
    };
    apply(reader.getViewport());
    return reader.onViewportChange(apply);
  }, [reader, overlay, revision]);

  const highlightTargets: TargetPath[] = (overlay.highlight?.ids ?? [])
    .map((id) => targetPath(reader, id, overlay.highlight?.style === "outline" ? 6 : 4))
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
        </svg>
      </div>
    </div>
  );
}
