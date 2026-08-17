/**
 * Overlay renderer (S5, B3): a viewport-synced SVG layer above the canvas.
 * The ONLY place effects draw. Reads the scene through the read-only
 * `SceneReader` surface and the overlay store — it cannot write (I2).
 *
 * Neon-over-pencil (D3): highlights and flow pulses render as wide soft
 * glows over the sketchy strokes — never tracing roughjs jitter.
 */
import { useEffect, useRef, useState } from "react";
import type { Viewport } from "../adapter";
import type { SceneReader } from "../command/api";
import { edgePath, shapePath } from "./geometry";
import type { OverlayState, OverlayStore } from "./state";

const FLOW_UNITS_PER_SECOND = 500;
const GLOW_COLOR = "#ffd43b";
const FLOW_COLOR = "#4dabf7";
const OUTLINE_COLOR = "#7048e8";

interface TargetPath {
  id: string;
  d: string;
  isEdge: boolean;
  transform?: string;
}

function targetPath(reader: SceneReader, id: string, pad: number): TargetPath | null {
  const info = reader.getElementInfo(id);
  if (!info) return null;
  const geometry = reader.getEdgeGeometry(id);
  if (geometry) {
    return { id, d: edgePath(geometry), isEdge: true };
  }
  const transform =
    info.angle !== 0
      ? `rotate(${(info.angle * 180) / Math.PI} ${info.bounds.x + info.bounds.width / 2} ${info.bounds.y + info.bounds.height / 2})`
      : undefined;
  return { id, d: shapePath(info.type, info.bounds, pad), isEdge: false, transform };
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
  const [viewport, setViewport] = useState<Viewport>(() => reader.getViewport());
  const [overlay, setOverlay] = useState<OverlayState>(() => store.get());
  const flowPathRefs = useRef<(SVGPathElement | null)[]>([]);
  const pulseRef = useRef<SVGCircleElement | null>(null);
  const trailRef = useRef<SVGPathElement | null>(null);

  useEffect(() => reader.onViewportChange(setViewport), [reader]);
  useEffect(() => store.subscribe(setOverlay), [store]);

  const highlightTargets: TargetPath[] = (overlay.highlight?.ids ?? [])
    .map((id) => targetPath(reader, id, overlay.highlight?.style === "outline" ? 6 : 4))
    .filter((t): t is TargetPath => t !== null);

  const flowTargets: TargetPath[] = (overlay.flow?.path ?? [])
    .map((id) => targetPath(reader, id, 0))
    .filter((t): t is TargetPath => t !== null && t.isEdge);

  // Flow pulse animation: a comet driven along the concatenated edge paths.
  useEffect(() => {
    const flow = overlay.flow;
    const pulse = pulseRef.current;
    const trail = trailRef.current;
    if (!flow || !pulse || !trail) return;
    const paths = flowPathRefs.current.filter(
      (p): p is SVGPathElement => p !== null,
    );
    if (!paths.length) return;
    const lengths = paths.map((p) => p.getTotalLength());
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total === 0) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // Degrade to a static lit path (I8) — no motion.
      pulse.style.display = "none";
      trail.style.display = "none";
      return;
    }
    // Stay hidden until the first tick positions the comet (rAF may be
    // paused in hidden tabs — never show an unpositioned pulse).
    pulse.style.display = "none";
    trail.style.display = "none";

    let raf = 0;
    let last = performance.now();
    let distance = 0;
    const tail = Math.min(90, total / 3);
    const tick = (now: number) => {
      pulse.style.display = "";
      trail.style.display = "";
      const dt = (now - last) / 1000;
      last = now;
      distance += dt * FLOW_UNITS_PER_SECOND * flow.speed;
      if (distance > total + tail) {
        if (flow.loop) {
          distance = 0;
        } else {
          pulse.style.display = "none";
          trail.style.display = "none";
          return;
        }
      }
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
      trail.setAttribute("d", active.getAttribute("d") ?? "");
      trail.style.strokeDasharray = `${Math.min(tail, localHead)} ${lengths[segment] + tail}`;
      trail.style.strokeDashoffset = String(
        lengths[segment] - localHead + Math.min(tail, localHead),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.flow?.generation, revision, flowTargets.length]);

  const { scrollX, scrollY, zoom } = viewport;
  const size = reader.getViewportSize();
  const sceneView = {
    x: -scrollX - 40 / zoom,
    y: -scrollY - 40 / zoom,
    width: size.width / zoom + 80 / zoom,
    height: size.height / zoom + 80 / zoom,
  };
  const spotlight = overlay.highlight?.style === "spotlight";

  return (
    <svg className="docent-overlay" width="100%" height="100%">
      <defs>
        {/* userSpaceOnUse regions: percentage regions collapse to nothing on
            perfectly horizontal/vertical paths (zero-area bounding box). */}
        <filter
          id="docent-glow"
          filterUnits="userSpaceOnUse"
          x={sceneView.x}
          y={sceneView.y}
          width={sceneView.width}
          height={sceneView.height}
        >
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter
          id="docent-glow-strong"
          filterUnits="userSpaceOnUse"
          x={sceneView.x}
          y={sceneView.y}
          width={sceneView.width}
          height={sceneView.height}
        >
          <feGaussianBlur stdDeviation="9" />
        </filter>
        {spotlight && (
          <mask id="docent-spotlight-mask">
            <rect
              x={sceneView.x}
              y={sceneView.y}
              width={sceneView.width}
              height={sceneView.height}
              fill="white"
            />
            {highlightTargets.map((t) =>
              t.isEdge ? (
                <path
                  key={t.id}
                  d={t.d}
                  fill="none"
                  stroke="black"
                  strokeWidth={26}
                  strokeLinecap="round"
                />
              ) : (
                <path key={t.id} d={t.d} fill="black" transform={t.transform} />
              ),
            )}
          </mask>
        )}
      </defs>
      <g transform={`scale(${zoom}) translate(${scrollX} ${scrollY})`}>
        {spotlight && (
          <rect
            x={sceneView.x}
            y={sceneView.y}
            width={sceneView.width}
            height={sceneView.height}
            fill="#101014"
            opacity={0.55}
            mask="url(#docent-spotlight-mask)"
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
                stroke={overlay.highlight!.style === "outline" ? OUTLINE_COLOR : GLOW_COLOR}
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
              ref={trailRef}
              d=""
              fill="none"
              stroke={FLOW_COLOR}
              strokeWidth={6}
              strokeLinecap="round"
              opacity={0.9}
              filter="url(#docent-glow)"
            />
            <circle
              ref={pulseRef}
              r={7}
              fill="#e7f5ff"
              stroke={FLOW_COLOR}
              strokeWidth={3}
              filter="url(#docent-glow-strong)"
            />
          </>
        )}
      </g>
    </svg>
  );
}
