import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExcalidrawCanvas } from "../adapter";
import type { DocentCanvasHandle } from "../adapter";
import { connectAgentBridge, type AgentBridge } from "../agent/bridge";
import { CameraEngine } from "../camera/engine";
import { CommandAPI } from "../command/api";
import { exportScene } from "../export";
import { OverlayLayer } from "../overlay/OverlayLayer";
import { OverlayStore } from "../overlay/state";
import {
  downloadSceneFile,
  ensureExtension,
  pickSaveTarget,
  pickSceneFile,
  writeSceneFile,
} from "./scene-file";
import { arrangeMoves, computeTiers, trailAt } from "../scene/tiers";
import { IntentPanel } from "./IntentPanel";
import { LegendEditor } from "./LegendEditor";
import { Breadcrumbs } from "./Breadcrumbs";
import { SelectionToolbar } from "./SelectionToolbar";
import { OVERVIEW, usePresentation } from "./usePresentation";
import { useDrill } from "./useDrill";

const UNTITLED = "untitled.excalidraw";

export function App() {
  const canvasRef = useRef<DocentCanvasHandle | null>(null);
  const fsHandleRef = useRef<FileSystemFileHandle | null>(null);
  const savedFingerprintRef = useRef<number | null>(null);
  const [canvas, setCanvas] = useState<DocentCanvasHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  // Bumped on document changes so selection-derived UI re-reads element intent.
  const [docVersion, setDocVersion] = useState(0);

  const [narration, setNarration] = useState<string | null>(null);
  const camera = useMemo(() => (canvas ? new CameraEngine(canvas) : null), [canvas]);
  const cameraRef = useRef<CameraEngine | null>(null);
  cameraRef.current = camera;
  const overlayStore = useMemo(() => new OverlayStore(), []);
  const commands = useMemo(
    () =>
      canvas && camera
        ? new CommandAPI(canvas, camera, overlayStore, { narrate: setNarration })
        : null,
    [canvas, camera, overlayStore],
  );

  // Agent bridge (S8): strictly manual — automatic attempts would log
  // connection errors on every launch without an MCP server. Connect via
  // Menu → "Connect agent bridge", or opt in per-URL with ?agent.
  const bridgeRef = useRef<AgentBridge | null>(null);
  const connectAgent = useCallback(() => {
    if (!commands) return;
    if (bridgeRef.current) bridgeRef.current.reconnect();
    else bridgeRef.current = connectAgentBridge(commands);
  }, [commands]);
  useEffect(() => {
    if (commands && new URLSearchParams(window.location.search).has("agent")) {
      connectAgent();
    }
    return () => {
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
    };
  }, [commands, connectAgent]);

  // Esc interrupts an agent tour outside presentation mode.
  const presentationActiveForEscRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || presentationActiveForEscRef.current) return;
      commands?.stopTour();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands]);
  const presentation = usePresentation(canvas, camera);

  /** Scene point at the middle of the current viewport. */
  const viewportCenter = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const vp = c.getViewport();
    const size = c.getViewportSize();
    return {
      x: size.width / (2 * vp.zoom) - vp.scrollX,
      y: size.height / (2 * vp.zoom) - vp.scrollY,
    };
  }, []);

  // Structural "up": from wherever the camera is, fly to the linking shape's
  // parent context and glow that shape briefly — works with no dive stack
  // (e.g. right after opening a file deep in a tier).
  const structuralUp = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !camera) return;
    const snapshot = c.getSceneSnapshot();
    const tiers = computeTiers(snapshot);
    const trail = trailAt(tiers, snapshot, viewportCenter());
    const deepest = trail[trail.length - 1];
    if (!deepest) return;
    const parentBounds = deepest.parentFrameId
      ? (c.getFrameInfo(deepest.parentFrameId)?.bounds ?? tiers.tier1Bounds)
      : tiers.tier1Bounds;
    if (parentBounds) void camera.flyTo(parentBounds, { padding: 0.1 });
    commands?.highlight({ ids: [deepest.linkingElementId], style: "glow" });
    window.setTimeout(() => commands?.highlight({ ids: [] }), 1800);
  }, [camera, commands, viewportCenter]);

  const deepestFrameId = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return null;
    const snapshot = c.getSceneSnapshot();
    const trail = trailAt(computeTiers(snapshot), snapshot, viewportCenter());
    return trail[trail.length - 1]?.frameId ?? null;
  }, [viewportCenter]);

  const drill = useDrill(canvas, camera, structuralUp, deepestFrameId);

  const markClean = useCallback((name: string | null) => {
    savedFingerprintRef.current = canvasRef.current?.getSceneFingerprint() ?? null;
    if (name !== null) setFileName(name);
    setDirty(false);
  }, []);

  // Tiered scenes open on Layer 1 only — lower bands stay out of view.
  const fitLayerOne = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const tiers = computeTiers(c.getSceneSnapshot());
    if (tiers.maxTier > 1 && tiers.tier1Bounds) {
      void cameraRef.current?.flyTo(tiers.tier1Bounds, {
        padding: 0.08,
        duration: 0,
      });
    }
  }, []);

  const arrangeTiers = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const snapshot = c.getSceneSnapshot();
    const moves = arrangeMoves(computeTiers(snapshot), snapshot);
    if (moves.length) c.translateFrames(moves);
  }, []);

  // Saving tidies the tiers first (D16): bands re-space against the current
  // Layer-1 extent, so files always round-trip with clean layering. The
  // arrange is tolerance-based — an already-banded scene is untouched.
  const prepareSceneForSave = useCallback(() => {
    const c = canvasRef.current;
    if (!c) throw new Error("Canvas not ready");
    arrangeTiers();
    return c.serializeScene();
  }, [arrangeTiers]);

  const openScene = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const picked = await pickSceneFile();
      if (!picked) return;
      await handle.loadSceneBlob(picked.blob);
      fsHandleRef.current = picked.handle;
      markClean(picked.name);
      fitLayerOne();
    } catch (err) {
      console.error(err);
      window.alert(`Could not open scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean, fitLayerOne]);

  const saveSceneAs = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const suggested = ensureExtension(fileName ?? UNTITLED);
      const target = await pickSaveTarget(suggested);
      if (target === null) return;
      const json = prepareSceneForSave();
      if (target === "download") {
        downloadSceneFile(suggested, json);
        markClean(suggested);
      } else {
        await writeSceneFile(target, json);
        fsHandleRef.current = target;
        markClean(target.name);
      }
    } catch (err) {
      console.error(err);
      window.alert(`Could not save scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [fileName, markClean, prepareSceneForSave]);

  const saveScene = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    const fsHandle = fsHandleRef.current;
    if (!fsHandle) {
      await saveSceneAs();
      return;
    }
    try {
      await writeSceneFile(fsHandle, prepareSceneForSave());
      markClean(null);
    } catch (err) {
      console.error(err);
      window.alert(`Could not save scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean, saveSceneAs, prepareSceneForSave]);

  const handleDocumentChange = useCallback((fingerprint: number) => {
    setDirty(fingerprint !== savedFingerprintRef.current);
    setDocVersion((v) => v + 1);
  }, []);

  const exportBaseName = (fileName ?? UNTITLED).replace(/\.excalidraw$/, "");

  const exportMermaidFile = useCallback(() => {
    const canvasHandle = canvasRef.current;
    if (!canvasHandle) return;
    const { mermaid } = exportScene(canvasHandle.getSceneSnapshot());
    downloadSceneFile(`${exportBaseName}.mmd`, mermaid);
  }, [exportBaseName]);

  const exportSidecarFile = useCallback(() => {
    const canvasHandle = canvasRef.current;
    if (!canvasHandle) return;
    const { sidecar } = exportScene(canvasHandle.getSceneSnapshot());
    downloadSceneFile(`${exportBaseName}.docent.json`, sidecar);
  }, [exportBaseName]);

  const handleReady = useCallback((handle: DocentCanvasHandle) => {
    canvasRef.current = handle;
    savedFingerprintRef.current = handle.getSceneFingerprint();
    setCanvas(handle);
  }, []);

  // Console hook. The Q4 perf harness ships in every build — it measures
  // the deployed app, per release. Debug internals stay dev-only.
  useEffect(() => {
    if (!canvas) return;
    const hook: Record<string, unknown> = {
      measurePerformance: (windowMs?: number) =>
        camera && commands
          ? import("./perf").then((m) =>
              m.measurePerformance(canvas, camera, commands, windowMs),
            )
          : Promise.reject(new Error("Not ready")),
    };
    if (import.meta.env.DEV) {
      Object.assign(hook, {
        serializeScene: () => canvas.serializeScene(),
        loadSceneJSON: (json: string) =>
          canvas.loadSceneBlob(new Blob([json], { type: "application/json" })),
        getSceneFingerprint: () => canvas.getSceneFingerprint(),
        exportScene: () => exportScene(canvas.getSceneSnapshot()),
        prepareSceneForSave,
        canvas,
        camera,
        commands,
      });
    }
    (window as unknown as Record<string, unknown>).__docent = hook;
  }, [canvas, camera, commands, prepareSceneForSave]);

  // Startup scene load (?scene=<url>) runs in an effect so it acts only after
  // the canvas is mounted — the excalidrawAPI callback fires mid-mount, and
  // viewport calls made then are silently dropped.
  useEffect(() => {
    if (!canvas) return;
    const sceneUrl = new URLSearchParams(window.location.search).get("scene");
    if (!sceneUrl) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(sceneUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (controller.signal.aborted) return;
        // The SPA fallback answers unknown paths with index.html and a 200 —
        // a typo'd scene URL must fail loudly, not blank the canvas.
        let parsed: { type?: string };
        try {
          parsed = JSON.parse(text) as { type?: string };
        } catch {
          throw new Error("not an .excalidraw file — check the URL for typos");
        }
        if (parsed.type !== "excalidraw") {
          throw new Error("not an .excalidraw file — check the URL for typos");
        }
        await canvas.loadSceneBlob(
          new Blob([text], { type: "application/json" }),
        );
        markClean(sceneUrl.split("/").pop() ?? sceneUrl);
        fitLayerOne();
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(`Failed to load ?scene=${sceneUrl}`, err);
          window.alert(
            `Could not load scene "${sceneUrl}": ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    })();
    return () => controller.abort();
  }, [canvas, camera, commands, markClean, fitLayerOne, prepareSceneForSave]);

  // File shortcuts (always active).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        event.stopPropagation();
        void (event.shiftKey ? saveSceneAs() : saveScene());
      } else if (key === "o") {
        event.preventDefault();
        event.stopPropagation();
        void openScene();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [openScene, saveScene, saveSceneAs]);

  // Presentation keyboard controls (S2) + drill back (S11).
  const drillRef = useRef(drill);
  drillRef.current = drill;
  useEffect(() => {
    if (!presentation.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "ArrowRight":
        case " ":
        case "PageDown":
          presentation.next();
          break;
        case "ArrowLeft":
        case "PageUp":
          presentation.prev();
          break;
        case "Home":
          presentation.overview();
          break;
        case "Backspace":
          drillRef.current.up();
          break;
        case "Escape":
          drillRef.current.reset();
          presentation.exit();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [presentation]);

  // Click-to-dive during presentation (S11 navigation). View mode swallows
  // Excalidraw's pointer callbacks, so we listen on Docent's own container
  // and hit-test through the adapter. A small movement threshold separates
  // clicks from view-mode panning.
  const presentationActiveRef = useRef(false);
  presentationActiveRef.current = presentation.active;
  presentationActiveForEscRef.current = presentation.active;
  const canvasHostRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !canvas) return;
    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      downAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = downAt;
      downAt = null;
      if (!start || !presentationActiveRef.current) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const info = canvas.elementAtClient(event.clientX, event.clientY);
      if (info?.detailFrameId) {
        drillRef.current.dive(info.id);
      }
    };
    host.addEventListener("pointerdown", onPointerDown, { capture: true });
    host.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, { capture: true });
      host.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [canvas]);

  useEffect(() => {
    const name = fileName ?? "untitled";
    document.title = `${dirty ? "● " : ""}${name} — Docent`;
  }, [fileName, dirty]);

  // Structural breadcrumb trail for the current view (debounced on viewport
  // settle). Tier computation is O(elements) — cheap even for large scenes.
  const [viewportRev, setViewportRev] = useState(0);
  useEffect(() => {
    if (!canvas) return;
    let timer = 0;
    const unsubscribe = canvas.onViewportChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setViewportRev((v) => v + 1), 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [canvas]);
  const trail = useMemo(() => {
    if (!canvas) return [];
    const snapshot = canvas.getSceneSnapshot();
    return trailAt(computeTiers(snapshot), snapshot, viewportCenter());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, viewportRev, docVersion, viewportCenter]);

  const singleSelected =
    !presentation.active && selectedIds.length === 1 && canvas
      ? canvas.getElementInfo(selectedIds[0])
      : null;

  const currentWaypoint =
    presentation.index === OVERVIEW
      ? null
      : (presentation.waypoints[presentation.index] ?? null);
  const waypointLabel =
    presentation.index === OVERVIEW
      ? "Overview"
      : `${currentWaypoint?.name || "Frame"} — ${presentation.index + 1}/${
          presentation.waypoints.length
        }`;

  return (
    <div className="docent-app">
      <main
        className="docent-canvas"
        ref={(el) => {
          canvasHostRef.current = el;
        }}
      >
        <ExcalidrawCanvas
          onReady={handleReady}
          onDocumentChange={handleDocumentChange}
          onSelectionChange={setSelectedIds}
          menuActions={{
            onOpen: () => void openScene(),
            onSave: () => void saveScene(),
            onSaveAs: () => void saveSceneAs(),
            onPresent: () => presentation.enter(),
            onOpenLegend: () => setLegendOpen(true),
            onExportMermaid: exportMermaidFile,
            onExportSidecar: exportSidecarFile,
            onArrangeTiers: arrangeTiers,
            onConnectAgent: connectAgent,
          }}
        />
        {!presentation.active && (
          <div className="docent-file-chip" title={fileName ?? "untitled"}>
            {fileName ?? "untitled"}
            {dirty && (
              <span className="docent-dirty" title="Unsaved changes">
                ●
              </span>
            )}
          </div>
        )}
        {canvas && (
          <Breadcrumbs
            canvas={canvas}
            camera={camera}
            trail={trail}
            drill={drill}
            revision={docVersion}
          />
        )}
        {canvas && (
          <OverlayLayer reader={canvas} store={overlayStore} revision={docVersion} />
        )}
        {!presentation.active && selectedIds.length > 0 && canvas && commands && (
          <SelectionToolbar
            canvas={canvas}
            selectedIds={selectedIds}
            singleSelected={singleSelected}
            commands={commands}
            drill={drill}
            revision={docVersion}
          />
        )}
        {singleSelected && canvas && (
          <IntentPanel
            key={`${singleSelected.id}:${docVersion}`}
            canvas={canvas}
            selection={singleSelected}
          />
        )}
        {narration && (
          <div className="docent-narration">
            <span className="docent-narration-text">{narration}</span>
            <button
              className="docent-narration-close"
              title="Stop narration"
              onClick={() => commands?.stopTour()}
            >
              ✕
            </button>
          </div>
        )}
        {presentation.active && (
          <div className="docent-hud">
            <span className="docent-hud-title">{waypointLabel}</span>
            {currentWaypoint?.narrative && (
              <span className="docent-hud-narrative">
                {currentWaypoint.narrative}
              </span>
            )}
            <span className="docent-hud-hint">
              → next · ← prev · Home overview · click a component to dive · ⌫ back
              · Esc exit
            </span>
          </div>
        )}
      </main>
      {legendOpen && canvas && (
        <LegendEditor
          canvas={canvas}
          selection={singleSelected}
          onClose={() => setLegendOpen(false)}
        />
      )}
    </div>
  );
}
