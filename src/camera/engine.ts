/**
 * Camera engine — per Constitution B2 the ONLY writer of viewport state.
 * Presentation mode, drill navigation, and (later) agent focus/tour are all
 * clients of this module; no second tween implementation may exist.
 *
 * Per I8: all motion runs on requestAnimationFrame, every tween is
 * interruptible (a new command retargets from the current viewport), and
 * `prefers-reduced-motion` collapses tweens to instant transitions.
 */
import type { DocentCanvasHandle, SceneBounds, Viewport } from "../adapter";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 30;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export interface FlyOptions {
  padding?: number;
  duration?: number;
}

export class CameraEngine {
  private generation = 0;

  constructor(private readonly canvas: DocentCanvasHandle) {}

  private reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Viewport that centers `bounds` with fractional padding on each side. */
  fitViewport(bounds: SceneBounds, padding = 0.1): Viewport {
    const { width: vw, height: vh } = this.canvas.getViewportSize();
    const safeW = Math.max(bounds.width, 1);
    const safeH = Math.max(bounds.height, 1);
    const zoomRaw = Math.min(vw / safeW, vh / safeH) * (1 - padding);
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomRaw));
    return this.viewportFromCenter(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      zoom,
    );
  }

  private viewportFromCenter(cx: number, cy: number, zoom: number): Viewport {
    const { width: vw, height: vh } = this.canvas.getViewportSize();
    return { scrollX: vw / (2 * zoom) - cx, scrollY: vh / (2 * zoom) - cy, zoom };
  }

  private centerOf(viewport: Viewport): { cx: number; cy: number } {
    const { width: vw, height: vh } = this.canvas.getViewportSize();
    return {
      cx: vw / (2 * viewport.zoom) - viewport.scrollX,
      cy: vh / (2 * viewport.zoom) - viewport.scrollY,
    };
  }

  /**
   * Tween to a target viewport. Interpolates the view center linearly and
   * zoom logarithmically, which reads as a smooth Prezi-style glide.
   * Resolves true when the tween completed, false when interrupted.
   *
   * Per I8 the tween degrades instead of blocking: with reduced motion or a
   * hidden document (rAF paused) it snaps straight to the target, a
   * visibilitychange mid-tween finishes it immediately, and a watchdog timer
   * guarantees the promise settles even if rAF never fires again.
   */
  tweenTo(
    target: Viewport,
    duration: number,
    ease: (t: number) => number = easeInOutCubic,
  ): Promise<boolean> {
    this.generation += 1;
    const generation = this.generation;

    if (this.reducedMotion() || duration <= 0 || document.hidden) {
      this.canvas.setViewport(target);
      return Promise.resolve(true);
    }

    const from = this.canvas.getViewport();
    const fromCenter = this.centerOf(from);
    const toCenter = this.centerOf(target);
    const start = performance.now();

    return new Promise((resolve) => {
      let settled = false;
      // Viewport writes cap at ~60Hz regardless of display refresh — every
      // write forces an Excalidraw canvas repaint, and a 120Hz display would
      // double that cost for motion the eye can't distinguish from 60Hz.
      // Zoom applies on every 2nd write (zoom changes additionally
      // invalidate the per-element canvas cache); the final frame always
      // writes the exact target (Q4; degrades-never-blocks per I8).
      const MIN_WRITE_INTERVAL_MS = 7.5;
      let lastWrite = 0;
      let zoomFrameToggle = true;
      let appliedZoom = from.zoom;
      const finish = (completed: boolean, snap: boolean) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("visibilitychange", onVisibility);
        window.clearTimeout(watchdog);
        if (snap) this.canvas.setViewport(target);
        resolve(completed);
      };
      const onVisibility = () => {
        if (document.hidden && generation === this.generation) {
          finish(true, true);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      const watchdog = window.setTimeout(() => {
        if (generation === this.generation) finish(true, true);
        else finish(false, false);
      }, duration + 500);

      const tick = (now: number) => {
        if (settled) return;
        if (generation !== this.generation) {
          finish(false, false);
          return;
        }
        const t = Math.min(1, (now - start) / duration);
        if (t < 1 && now - lastWrite < MIN_WRITE_INTERVAL_MS) {
          requestAnimationFrame(tick);
          return;
        }
        // Frame-budget governor: a large gap since the last write means the
        // previous repaint overran — back off zoom (the cache-invalidating
        // half of the work) further on struggling machines (I8).
        const starved = lastWrite > 0 && now - lastWrite > 3 * MIN_WRITE_INTERVAL_MS;
        lastWrite = now;
        const e = ease(t);
        const zoom = Math.exp(lerp(Math.log(from.zoom), Math.log(target.zoom), e));
        zoomFrameToggle = !zoomFrameToggle;
        if (t >= 1 || (zoomFrameToggle && !starved)) appliedZoom = zoom;
        const cx = lerp(fromCenter.cx, toCenter.cx, e);
        const cy = lerp(fromCenter.cy, toCenter.cy, e);
        this.canvas.setViewport(this.viewportFromCenter(cx, cy, appliedZoom));
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          finish(true, false);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  flyTo(bounds: SceneBounds, { padding = 0.1, duration = 850 }: FlyOptions = {}) {
    return this.tweenTo(this.fitViewport(bounds, padding), duration);
  }

  flyToViewport(viewport: Viewport, duration = 600) {
    return this.tweenTo(viewport, duration);
  }

  /**
   * Portal dive (S11): push into the source element, then resolve outward
   * onto its detail frame — zoom-in, seam, zoom-out reveal.
   */
  async dive(from: SceneBounds, to: SceneBounds): Promise<boolean> {
    const settle = this.fitViewport(to, 0.08);
    if (this.reducedMotion()) {
      this.canvas.setViewport(settle);
      return true;
    }
    const fitFrom = this.fitViewport(from, 0);
    const inward: Viewport = { ...fitFrom, zoom: Math.min(ZOOM_MAX, fitFrom.zoom * 2.4) };
    const phaseA = await this.tweenTo(inward, 340, easeInQuad);
    if (!phaseA) return false;
    const seamCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    this.canvas.setViewport(
      this.viewportFromCenter(
        seamCenter.x,
        seamCenter.y,
        Math.min(ZOOM_MAX, settle.zoom * 2.4),
      ),
    );
    return this.tweenTo(settle, 480, easeOutCubic);
  }

  /** Interrupt any running tween. */
  stop(): void {
    this.generation += 1;
  }
}
