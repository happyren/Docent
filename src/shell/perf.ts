/**
 * Q4 measurement harness (dev tooling): records real rAF frame times while
 * the camera tweens, flow pulses run, and spotlight dims — the three motion
 * systems — against the current scene. Requires a visible document (rAF is
 * paused in hidden tabs); waits for visibility before each scenario and
 * discards windows interrupted by hiding.
 *
 * Run from the console:  await __docent.measurePerformance()
 */
import type { DocentCanvasHandle } from "../adapter";
import type { CameraEngine } from "../camera/engine";
import type { CommandAPI } from "../command/api";

export interface PerfResult {
  scenario: string;
  seconds: number;
  frames: number;
  avgFps: number;
  p95FrameMs: number;
  worstFrameMs: number;
}

function waitForVisible(timeoutMs = 15_000): Promise<boolean> {
  if (!document.hidden) return Promise.resolve(true);
  // Poll rather than trusting visibilitychange — embedded webviews don't
  // always dispatch it.
  return new Promise((resolve) => {
    const start = performance.now();
    const poll = setInterval(() => {
      if (!document.hidden) {
        clearInterval(poll);
        resolve(true);
      } else if (performance.now() - start > timeoutMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
}

/** Record rAF deltas for `ms`; null when the window was interrupted. */
function recordFrames(ms: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      if (document.hidden) {
        resolve(null);
        return;
      }
      deltas.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve(deltas);
    };
    requestAnimationFrame(tick);
  });
}

function summarize(scenario: string, deltas: number[]): PerfResult {
  const sorted = [...deltas].sort((a, b) => a - b);
  const total = deltas.reduce((a, b) => a + b, 0);
  return {
    scenario,
    seconds: +(total / 1000).toFixed(2),
    frames: deltas.length,
    avgFps: +(deltas.length / (total / 1000)).toFixed(1),
    p95FrameMs: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
    worstFrameMs: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
  };
}

export async function measurePerformance(
  canvas: DocentCanvasHandle,
  camera: CameraEngine,
  commands: CommandAPI,
  windowMs = 2500,
): Promise<PerfResult[]> {
  const graph = commands.getSceneGraph();
  const bounds = canvas.getSceneBounds();
  if (!bounds) throw new Error("Empty scene");
  const left = { ...bounds, width: bounds.width / 2 };
  const right = { ...bounds, x: bounds.x + bounds.width / 2, width: bounds.width / 2 };
  const edges = graph.edges.filter((e) => e.from && e.to).slice(0, 6).map((e) => e.id);
  const nodes = graph.nodes.slice(0, 8).map((n) => n.id);
  const results: PerfResult[] = [];

  const orbit = (stop: { done: boolean }) => {
    void (async () => {
      let flip = false;
      while (!stop.done) {
        await camera.flyTo(flip ? left : right, { duration: 900, padding: 0.1 });
        flip = !flip;
      }
    })();
  };

  const runScenario = async (
    name: string,
    setup: () => { done: boolean } | void,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const visible = await waitForVisible();
      if (!visible) break;
      const stop = setup() ?? { done: false };
      const deltas = await recordFrames(windowMs);
      stop.done = true;
      camera.stop();
      if (deltas && deltas.length > 30) {
        results.push(summarize(name, deltas));
        return;
      }
    }
    results.push({
      scenario: `${name} (SKIPPED — tab never stayed visible; run in a regular browser tab)`,
      seconds: 0,
      frames: 0,
      avgFps: 0,
      p95FrameMs: 0,
      worstFrameMs: 0,
    });
  };

  await runScenario("camera-tween", () => {
    const stop = { done: false };
    orbit(stop);
    return stop;
  });

  await runScenario("flow-pulse", () => {
    if (edges.length) void commands.flow({ path: edges, speed: 1.5, loop: true });
  });

  await runScenario("combined (tween + spotlight + flow)", () => {
    if (nodes.length) commands.highlight({ ids: nodes, style: "spotlight" });
    if (edges.length) void commands.flow({ path: edges, speed: 1.5, loop: true });
    const stop = { done: false };
    orbit(stop);
    return stop;
  });

  commands.clearEffects();
  return results;
}
