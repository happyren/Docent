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
import { exportSceneFile, importSceneFile } from "./desktop-files";
import { alertDialog } from "./dialogs";
import { arrangeMoves, computeTiers, trailAt } from "../scene/tiers";
import { loadScene as loadPortfolioScene, saveScene as savePortfolioScene } from "../portfolio/client";
import { IntentPanel } from "./IntentPanel";
import { PortfolioModal, type PortfolioIntent } from "./PortfolioModal";
import { LegendEditor } from "./LegendEditor";
import { Breadcrumbs } from "./Breadcrumbs";
import { SelectionToolbar } from "./SelectionToolbar";
import { OVERVIEW, usePresentation } from "./usePresentation";
import { useDrill } from "./useDrill";

const UNTITLED = "untitled.excalidraw";

/**
 * The desktop shell (S13) announces itself before the page loads, the same way
 * it announces its store. Everywhere else the global is absent and the app is
 * the web app, unchanged: Docent's actions stay in the hamburger menu and the
 * canvas keeps its own library button.
 */
const isDesktop = Boolean(
  (window as { __DOCENT_DESKTOP__?: boolean }).__DOCENT_DESKTOP__,
);

/**
 * Actions the native menu bar can invoke, in menu-bar order. The ids are the
 * contract with the Rust menu (src-tauri/src/lib.rs) — change one side and the
 * other must follow.
 */
type DocentMenuId =
  | "new"
  | "open"
  | "import"
  | "save"
  | "save-as"
  | "export-file"
  | "present"
  | "library"
  | "legend"
  | "arrange"
  | "export-mermaid"
  | "export-sidecar";

type DocentMenuWindow = Window & { __docentMenu?: (id: DocentMenuId) => void };

export function App() {
  const canvasRef = useRef<DocentCanvasHandle | null>(null);
  const fsHandleRef = useRef<FileSystemFileHandle | null>(null);
  const savedFingerprintRef = useRef<number | null>(null);
  const [canvas, setCanvas] = useState<DocentCanvasHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioIntent, setPortfolioIntent] = useState<PortfolioIntent>("browse");
  // When the current scene came from the portfolio, Save writes back to it
  // (S12). Any local open/save-as clears this and returns Save to file mode.
  // `sha` rides along for scenes from a GitHub-bound project (S14): it is what
  // the scene looked like when it was read, so a save that would land on top of
  // someone else's commit is refused instead of silently winning.
  const portfolioSourceRef = useRef<{
    project: string;
    scene: string;
    sha?: string;
  } | null>(null);
  // Bumped on document changes so selection-derived UI re-reads element intent.
  const [docVersion, setDocVersion] = useState(0);

  const [narration, setNarration] = useState<string | null>(null);
  // Fake-zoom sink: scales the Excalidraw canvas elements and the overlay
  // stage by the residual between the continuous glide zoom and the few
  // committed zoom steps. Only those — each canvas is already its own
  // compositor layer, so the scale is GPU-only work, and UI chrome (menus,
  // zoom controls, breadcrumbs) must not move during a glide.
  const zoomStageRef = useRef<HTMLDivElement | null>(null);
  const lastFakeZoomRef = useRef(1);
  const camera = useMemo(
    () =>
      canvas
        ? new CameraEngine(canvas, {
            apply: (scale) => {
              // The engine calls this every animation frame; skip identical
              // values so pans (residual pinned at 1) write no style at all.
              if (scale === lastFakeZoomRef.current) return;
              lastFakeZoomRef.current = scale;
              canvas.setCanvasScale(scale);
              const el = zoomStageRef.current;
              if (el) el.style.transform = scale === 1 ? "" : `scale(${scale})`;
            },
            clear: () => {
              lastFakeZoomRef.current = 1;
              canvas.setCanvasScale(1);
              const el = zoomStageRef.current;
              if (el) el.style.transform = "";
            },
          })
        : null,
    [canvas],
  );
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

  // Refresh stays in the current scene: portfolio opens/saves stamp
  // ?project=&scene= into the URL (replaceState — no history spam), and
  // local file flows clear them. Reload then restores via the existing
  // startup parameter handling.
  const syncSceneUrl = useCallback(
    (source: { project: string; scene: string } | null) => {
      const url = new URL(window.location.href);
      if (source) {
        url.searchParams.set("project", source.project);
        url.searchParams.set("scene", source.scene);
      } else {
        url.searchParams.delete("project");
        url.searchParams.delete("scene");
      }
      window.history.replaceState(null, "", url);
    },
    [],
  );

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
      portfolioSourceRef.current = null;
      syncSceneUrl(null);
      markClean(picked.name);
      fitLayerOne();
    } catch (err) {
      console.error(err);
      await alertDialog(`Could not open scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean, fitLayerOne, syncSceneUrl]);

  const saveSceneAs = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const suggested = ensureExtension(fileName ?? UNTITLED);
      const target = await pickSaveTarget(suggested);
      if (target === null) return;
      const json = prepareSceneForSave();
      portfolioSourceRef.current = null;
      syncSceneUrl(null);
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
      await alertDialog(`Could not save scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [fileName, markClean, prepareSceneForSave, syncSceneUrl]);

  const saveScene = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    const source = portfolioSourceRef.current;
    if (source) {
      try {
        const saved = await savePortfolioScene(
          source.project,
          source.scene,
          prepareSceneForSave(),
          source.sha,
        );
        // The scene now looks like what was just committed, so the next save
        // guards against that instead of what was originally loaded.
        portfolioSourceRef.current = { ...source, sha: saved.sha ?? undefined };
        markClean(null);
      } catch (err) {
        // A 409 lands here: the document stays dirty, deliberately, because the
        // work is still only in this tab and the message says to reload.
        console.error(err);
        await alertDialog(
          `Could not save to portfolio: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }
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
      await alertDialog(`Could not save scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean, saveSceneAs, prepareSceneForSave]);

  // Refresh with unsaved changes should warn, not silently discard.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const handleDocumentChange = useCallback((fingerprint: number) => {
    setDirty(fingerprint !== savedFingerprintRef.current);
    setDocVersion((v) => v + 1);
  }, []);

  const exportBaseName = (fileName ?? UNTITLED).replace(/\.excalidraw$/, "");
  // A portfolio scene is named "<project>/<scene>" on screen; a file dialog
  // wants the leaf of that, and nothing that looks like a path.
  const exportLeafName = exportBaseName.replace(/^.*\//, "");

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

  // Portfolio flows (S12). Opening tracks the source so Save writes back.
  const openPortfolio = useCallback((intent: PortfolioIntent) => {
    setPortfolioIntent(intent);
    setPortfolioOpen(true);
  }, []);
  const openPortfolioScene = useCallback(
    async (project: string, scene: string) => {
      const handle = canvasRef.current;
      if (!handle) throw new Error("Canvas not ready");
      const { text, sha } = await loadPortfolioScene(project, scene);
      await handle.loadSceneBlob(new Blob([text], { type: "application/json" }));
      fsHandleRef.current = null;
      portfolioSourceRef.current = { project, scene, sha };
      syncSceneUrl({ project, scene });
      markClean(`${project}/${scene}`);
      fitLayerOne();
    },
    [markClean, fitLayerOne, syncSceneUrl],
  );
  const savePortfolioSceneAs = useCallback(
    async (project: string, scene: string) => {
      // No sha: this is "save into that project under this name", which is a
      // deliberate overwrite of whatever is there, not a write-back of
      // something read. From here on the scene is tracked, sha and all.
      const saved = await savePortfolioScene(project, scene, prepareSceneForSave());
      fsHandleRef.current = null;
      portfolioSourceRef.current = { project, scene, sha: saved.sha ?? undefined };
      syncSceneUrl({ project, scene });
      markClean(`${project}/${scene}`);
    },
    [markClean, prepareSceneForSave, syncSceneUrl],
  );

  // Desktop file flows (S13). The system webview has no File System Access API
  // and ignores anchor downloads, so the browser open/save/download paths are
  // dead ends there: the portfolio is the desktop's file system, and the two
  // directions that must cross to a loose file on disk go through the shell's
  // native dialogs. Only the native menu reaches these — the handler map below
  // is installed in the desktop shell alone.
  const importSceneIntoCanvas = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const picked = await importSceneFile();
      if (!picked) return;
      // The same gate the ?scene= loader applies: a file that isn't a scene
      // must fail loudly rather than blank the canvas.
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(picked.content) as { type?: string };
      } catch {
        throw new Error("not an .excalidraw file");
      }
      if (parsed.type !== "excalidraw") {
        throw new Error("not an .excalidraw file");
      }
      await handle.loadSceneBlob(
        new Blob([picked.content], { type: "application/json" }),
      );
      // An imported file has no portfolio home until the user gives it one.
      fsHandleRef.current = null;
      portfolioSourceRef.current = null;
      syncSceneUrl(null);
      markClean(picked.name);
      fitLayerOne();
    } catch (err) {
      console.error(err);
      await alertDialog(
        `Could not import scene: ${err instanceof Error ? err.message : err}`,
      );
    }
  }, [markClean, fitLayerOne, syncSceneUrl]);

  const exportToFile = useCallback(async (name: string, contents: string) => {
    try {
      await exportSceneFile(name, contents);
    } catch (err) {
      console.error(err);
      await alertDialog(
        `Could not export "${name}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }, []);

  // Startup scene load (?scene=<url>) runs in an effect so it acts only after
  // the canvas is mounted — the excalidrawAPI callback fires mid-mount, and
  // viewport calls made then are silently dropped.
  useEffect(() => {
    if (!canvas) return;
    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get("project");
    const sceneParam = params.get("scene");
    // ?project=<p>&scene=<s> addresses a portfolio scene (S12);
    // ?scene=<url> alone keeps meaning "fetch this URL".
    if (projectParam && sceneParam) {
      void openPortfolioScene(projectParam, sceneParam).catch((err: unknown) => {
        console.error(`Failed to load ?project=${projectParam}&scene=${sceneParam}`, err);
        // Not an async handler, so the box is raised and left to resolve on
        // its own; nothing here waits on the answer.
        void alertDialog(
          `Could not load "${projectParam}/${sceneParam}": ${err instanceof Error ? err.message : err}`,
        );
      });
      return;
    }
    const sceneUrl = sceneParam;
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
          await alertDialog(
            `Could not load scene "${sceneUrl}": ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    })();
    return () => controller.abort();
  }, [canvas, camera, commands, markClean, fitLayerOne, prepareSceneForSave, openPortfolioScene]);

  // File shortcuts (always active).
  useEffect(() => {
    // Except in the desktop shell, where the native accelerators own these
    // chords: a second in-page handler would fire alongside them.
    if (isDesktop) return;
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

  // Native menu bar bridge (S13). The Rust handlers reach the page by
  // evaluating `window.__docentMenu(id)`, which keeps the desktop shell free
  // of any JS SDK (I7) — the same reasoning as the injected store base URL.
  // Held in a ref so the registration survives re-renders: the handlers are
  // rebuilt every render, the global is installed once.
  const menuHandlersRef = useRef<Record<DocentMenuId, () => void>>(
    {} as Record<DocentMenuId, () => void>,
  );
  // Desktop semantics throughout: the portfolio is this app's file system, so
  // New, Open and Save address it, and only Import/Export cross to a loose
  // file. The web app never reaches this map — it keeps the in-canvas menu and
  // the browser file paths, both untouched.
  menuHandlersRef.current = {
    new: () => openPortfolio("save"),
    open: () => openPortfolio("browse"),
    import: () => void importSceneIntoCanvas(),
    save: () => {
      // Nowhere to save to yet: the modal stands in for the save dialog,
      // opened on its name field.
      if (!portfolioSourceRef.current) openPortfolio("save");
      else void saveScene();
    },
    "save-as": () => {
      // A copy under a new name — detach first, so a cancelled Save As cannot
      // silently overwrite the scene it started from.
      portfolioSourceRef.current = null;
      syncSceneUrl(null);
      openPortfolio("save");
    },
    "export-file": () => {
      if (!canvasRef.current) return;
      void exportToFile(ensureExtension(exportLeafName), prepareSceneForSave());
    },
    present: () => presentation.enter(),
    library: () => canvasRef.current?.toggleLibrarySidebar(),
    legend: () => setLegendOpen(true),
    arrange: arrangeTiers,
    "export-mermaid": () => {
      const handle = canvasRef.current;
      if (!handle) return;
      const { mermaid } = exportScene(handle.getSceneSnapshot());
      void exportToFile(`${exportLeafName}.mmd`, mermaid);
    },
    "export-sidecar": () => {
      const handle = canvasRef.current;
      if (!handle) return;
      const { sidecar } = exportScene(handle.getSceneSnapshot());
      void exportToFile(`${exportLeafName}.docent.json`, sidecar);
    },
  };
  useEffect(() => {
    if (!isDesktop) return;
    const target = window as DocentMenuWindow;
    target.__docentMenu = (id) => menuHandlersRef.current[id]?.();
    return () => {
      delete target.__docentMenu;
    };
  }, []);

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
    <div className={isDesktop ? "docent-app docent-desktop" : "docent-app"}>
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
            onOpenPortfolio: () => openPortfolio("browse"),
            onExportMermaid: exportMermaidFile,
            onExportSidecar: exportSidecarFile,
            onArrangeTiers: arrangeTiers,
            onConnectAgent: connectAgent,
          }}
          hideDocentMenuItems={isDesktop}
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
          <div className="docent-zoom-stage" ref={zoomStageRef}>
            <OverlayLayer reader={canvas} store={overlayStore} revision={docVersion} />
          </div>
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
      {portfolioOpen && canvas && (
        <PortfolioModal
          onOpenScene={openPortfolioScene}
          onSaveScene={savePortfolioSceneAs}
          suggestedName={(fileName ?? UNTITLED).replace(/\.excalidraw$/i, "").replace(/^.*\//, "")}
          intent={portfolioIntent}
          onClose={() => setPortfolioOpen(false)}
        />
      )}
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
