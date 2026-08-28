import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExcalidrawCanvas } from "../adapter";
import type { DocentCanvasHandle } from "../adapter";
import { connectAgentBridge, type AgentBridge } from "../agent/bridge";
import { connectDesktopAgentBridge } from "../agent/desktopBridge";
import { UNSAVED_CHANGES, type AgentShellHooks } from "../agent/execute";
import { CameraEngine } from "../camera/engine";
import { CommandAPI } from "../command/api";
import { exportFrameSidecar, exportPdf, exportScene, type ExportContext } from "../export";
import { OverlayLayer } from "../overlay/OverlayLayer";
import { OverlayStore } from "../overlay/state";
import {
  downloadBinaryFile,
  downloadSceneFile,
  ensureExtension,
  pickSaveTarget,
  pickSceneFile,
  writeSceneFile,
} from "./scene-file";
import { exportSceneBytes, exportSceneFile, importSceneFile } from "./desktop-files";
import { alertDialog } from "./dialogs";
import { copyText } from "./clipboard";
import { arrangeMoves, computeTiers, trailAt } from "../scene/tiers";
import { tidyOps, type TidyScope } from "../authoring/tidy";
import { detailBadges, linkBadges, logicMarks } from "../scene/detailBadges";
import type { SceneLink } from "../adapter/snapshot";
import {
  createBranch as createPortfolioBranch,
  getBinding as getPortfolioBinding,
  listProjects,
  listScenes,
  loadScene as loadPortfolioScene,
  saveScene as savePortfolioScene,
} from "../portfolio/client";
import { notePortfolioSave, suggestedBranch } from "../portfolio/autoCommit";
import { IntentPanel } from "./IntentPanel";
import { EMPTY_SCENE, PortfolioModal, type PortfolioIntent } from "./PortfolioModal";
import { PluginsModal } from "./PluginsModal";
import { SettingsModal } from "./SettingsModal";
import { hasPlugins, listPlugins, pluginUrl, providerOf, type PluginInfo } from "../plugins/client";
import { SpeechController, WebAudioSink } from "../speech/controller";
import type { ReviewJump } from "./ReviewPanel";
import { LegendEditor } from "./LegendEditor";
import { Breadcrumbs } from "./Breadcrumbs";
import { SelectionToolbar } from "./SelectionToolbar";
import { OVERVIEW, usePresentation } from "./usePresentation";
import { useDrill } from "./useDrill";
import { CommandPalette } from "./CommandPalette";
import type { PaletteCommand, PaletteScene } from "./palette";

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
 * The borderless window (D108) is a macOS-only arrangement: only there does
 * the shell build the window with an overlay title bar, so only there do the
 * traffic lights float over the page and only there does the chrome owe them
 * a safe area. The two sides agree by construction — the Rust builder is
 * `#[cfg(target_os = "macos")]` and a macOS build runs in a macOS webview —
 * so this needs no flag of its own from the shell.
 */
const hasOverlayTitleBar = isDesktop && /Mac/.test(navigator.userAgent);

/**
 * Actions the native menu bar can invoke, in menu-bar order — File, Diagram,
 * Project (D109). The ids are the contract with the Rust menu
 * (src-tauri/src/lib.rs), matched literally by the test at the foot of that
 * file: change one side and the other must follow.
 */
type DocentMenuId =
  | "settings"
  | "new"
  | "open"
  | "import"
  | "save"
  | "save-as"
  | "export-file"
  | "export-mermaid"
  | "export-sidecar"
  | "export-pdf"
  | "present"
  | "library"
  | "tools"
  | "legend"
  | "arrange"
  | "tidy"
  | "detail-markers"
  | "portfolio"
  | "plugins"
  | "agent-edit";

type DocentMenuWindow = Window & { __docentMenu?: (id: DocentMenuId) => void };

/**
 * Everything the command table holds: the menu bar's ids plus the actions no
 * menu carries — the portfolio's sync verbs, and the web bridge's connect,
 * which the desktop menu dropped because the shell's pipe needs no asking
 * (D118).
 */
type DocentActionId =
  | DocentMenuId
  | "branch"
  | "pull"
  | "push"
  | "connect-agent";

/** One command, in the one place it is implemented (B4). */
interface DocentAction {
  /** What every door calls it — menu item, palette row, hamburger entry. */
  title: string;
  /** The chord the menu bar gives it, as this platform writes it. */
  shortcut?: string;
  /** A word of context for the palette's row; the menus have none. */
  hint?: string;
  /** False where this platform cannot do it, and the palette drops the row. */
  available?: boolean;
  run: () => void;
}

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.userAgent);

/** The chords, spelled the way each platform spells them. */
const KEY = isMac
  ? {
      settings: "⌘,",
      newScene: "⌘N",
      open: "⌘O",
      import: "⇧⌘O",
      save: "⌘S",
      saveAs: "⇧⌘S",
      present: "⌘P",
      library: "⌘L",
      tools: "⌘\\",
      tidy: "⌥⇧F",
    }
  : {
      settings: "Ctrl+,",
      newScene: "Ctrl+N",
      open: "Ctrl+O",
      import: "Ctrl+Shift+O",
      save: "Ctrl+S",
      saveAs: "Ctrl+Shift+S",
      present: "Ctrl+P",
      library: "Ctrl+L",
      tools: "Ctrl+\\",
      tidy: "Alt+Shift+F",
    };

/** The palette's own order — the menu bar's, read top to bottom (D111). */
const PALETTE_ORDER: readonly DocentActionId[] = [
  "settings",
  "new",
  "open",
  "import",
  "save",
  "save-as",
  "export-file",
  "export-mermaid",
  "export-sidecar",
  "export-pdf",
  "present",
  "library",
  "tools",
  "legend",
  "arrange",
  "tidy",
  "detail-markers",
  "portfolio",
  "branch",
  "pull",
  "push",
  "connect-agent",
  "plugins",
  "agent-edit",
];

/**
 * Whether the tools are away (D110). Remembered per machine, and read inside a
 * try/catch: a browser with storage denied is a browser with the tools showing,
 * never one that fails to come up.
 */
const TOOLS_COLLAPSED = "docent.toolsCollapsed";

function readToolsCollapsed(): boolean {
  try {
    return localStorage.getItem(TOOLS_COLLAPSED) === "1";
  } catch {
    return false;
  }
}

function rememberToolsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(TOOLS_COLLAPSED, collapsed ? "1" : "0");
  } catch {
    // Remembered where it can be; the session still collapses either way.
  }
}

export function App() {
  const canvasRef = useRef<DocentCanvasHandle | null>(null);
  const fsHandleRef = useRef<FileSystemFileHandle | null>(null);
  const savedFingerprintRef = useRef<number | null>(null);
  const [canvas, setCanvas] = useState<DocentCanvasHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  // Settings (D115): the person's switches, on the person's chord.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The palette (D111) and the tools' collapse (D110) — both Docent's own
  // chrome, both keyed off the app root and nothing else.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(readToolsCollapsed);
  const toggleTools = useCallback(() => {
    setToolsCollapsed((collapsed) => {
      rememberToolsCollapsed(!collapsed);
      return !collapsed;
    });
  }, []);
  // Agent authoring (S19, D61): the person's switch, the orange frame, and
  // the last edit's line with its Undo.
  const [agentCanEdit, setAgentCanEdit] = useState(true);
  const agentCanEditRef = useRef(agentCanEdit);
  agentCanEditRef.current = agentCanEdit;
  const [agentWorking, setAgentWorking] = useState(false);
  const [agentReport, setAgentReport] = useState<{ line: string; undo: (() => void) | null } | null>(null);
  // The trunk lock (D104): the open scene's project is bound, its base branch
  // is protected, and it is sitting on it. Null everywhere else — a loose file,
  // an unbound project, a draft branch.
  const [trunkLock, setTrunkLock] = useState<{
    project: string;
    branch: string;
  } | null>(null);
  const trunkLockRef = useRef(trunkLock);
  trunkLockRef.current = trunkLock;
  // Whether the open scene's project is bound to a repository (S14). Learned
  // from the same probe the lock is, and read by the palette: the sync verbs
  // are commands only where there is something to sync with.
  const [projectBound, setProjectBound] = useState(false);
  // Spoken narration (S18, D52): one controller, fed by the narration sink
  // and the presentation's waypoint. Only a shell with plugins can speak.
  const speech = useMemo(() => new SpeechController(new WebAudioSink()), []);
  const [voice, setVoice] = useState<string | null>(
    () => (typeof localStorage === "undefined" ? null : localStorage.getItem("docent.speech.voice")) || null,
  );
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const pluginsRef = useRef<{ list: PluginInfo[]; at: number }>({ list: [], at: 0 });
  // Plugins (S17): the listing the voice resolves its provider from — a
  // capability the shell announces before the page loads.
  useEffect(() => {
    if (!hasPlugins()) return;
    const refresh = () =>
      void listPlugins()
        .then((list) => {
          pluginsRef.current = { list, at: Date.now() };
        })
        .catch(() => {});
    refresh();
    // The provider is resolved per utterance from a listing at most a few
    // seconds old: a plugin switched on mid-session counts, and speaking
    // never waits on a round trip.
    speech.setProvider(() => {
      if (Date.now() - pluginsRef.current.at > 5000) refresh();
      const provider = providerOf(pluginsRef.current.list, "speech/1");
      return provider ? { ttsUrl: pluginUrl(provider.name, "/tts"), voice: voiceRef.current } : null;
    });
  }, [speech]);
  const [speechState, setSpeechState] = useState(() => speech.get());
  useEffect(() => speech.subscribe(setSpeechState), [speech]);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioIntent, setPortfolioIntent] = useState<PortfolioIntent>("browse");
  // When the current scene came from the portfolio, Save writes back to it
  // (S12). Any local open/save-as clears this and returns Save to file mode.
  // A GitHub-bound project is no different here (D29): its directory is a
  // working copy, so the save is a local write and the sync verbs are what
  // reach the network.
  const portfolioSourceRef = useRef<{ project: string; scene: string } | null>(
    null,
  );
  // Bumped on document changes so selection-derived UI re-reads element intent.
  const [docVersion, setDocVersion] = useState(0);
  // Detail-layer markers (D31): session-scoped, default on. Not persisted, so
  // the desktop menu checkbox — which starts checked and toggles itself —
  // always agrees with the page without a page→shell channel.
  const [detailMarkers, setDetailMarkers] = useState(true);

  /**
   * The chrome wears the house, in the theme the canvas is already in (D107).
   * Excalidraw owns the switch — its "Dark mode" item — and the adapter is the
   * one place appState may be read (B1), so the theme arrives here as a
   * callback and is written straight onto the document element, where the
   * token blocks in styles.css key off it. Everything Docent draws, modals
   * included, is inside that element, so one attribute dresses the whole app.
   */
  const [canvasTheme, setCanvasTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    document.documentElement.dataset.docentTheme = canvasTheme;
  }, [canvasTheme]);

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
        ? new CommandAPI(
            canvas,
            camera,
            overlayStore,
            {
              narrate: setNarration,
              spoken: (text) => speech.speak(text),
              speaks: () => speech.active,
              settled: () => speech.settled(),
            },
            {
              applyWrite: (write) => canvas.applyWrite(write),
              captureScene: () => canvas.captureScene(),
              restoreScene: (captured) => canvas.restoreScene(captured),
              canEdit: () => agentCanEditRef.current,
              // The orange frame (D61): view-only while a batch runs, so the
              // two never edit the same element at once. The switch itself is
              // asserted below, where the trunk lock (D104) shares it — a
              // batch ending must not unlock a protected trunk.
              working: setAgentWorking,
              report: (line, undo) => setAgentReport({ line, undo }),
            },
          )
        : null,
    [canvas, camera, overlayStore, speech],
  );
  const commandsRef = useRef<CommandAPI | null>(null);
  commandsRef.current = commands;

  // Agent bridge (S8): strictly manual — automatic attempts would log
  // connection errors on every launch without an MCP server. Connect via
  // Menu → "Connect agent bridge", or opt in per-URL with ?agent.
  const bridgeRef = useRef<AgentBridge | null>(null);
  const connectAgent = useCallback(() => {
    if (!commands) return;
    if (bridgeRef.current) bridgeRef.current.reconnect();
    else bridgeRef.current = connectAgentBridge(commands, agentShell);
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

  // Cmd/Ctrl+P means Present — claimed in the CAPTURE phase, because
  // upstream listens for it too (to suggest its command palette) and the
  // browser would otherwise print. In the desktop app the native menu
  // usually consumes the chord first; this is the fallback for the focus
  // states where the webview sees it instead — whichever side wins, the
  // other never fires.
  const enterPresentationRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopPropagation();
        enterPresentationRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
  enterPresentationRef.current = () => {
    if (!presentation.active) presentation.enter();
  };

  /**
   * The one view-only switch, asserted from every reason there is to hold it
   * down: the agent's turn (D61), a presentation (D54), and the protected
   * trunk (D104) — which is the same mechanism without the orange frame, and
   * outlives both of the others. Re-asserted rather than toggled, because an
   * agent batch ending or a presentation exiting each turn it off on their way
   * out and neither of them knows about the lock.
   */
  useEffect(() => {
    canvas?.setViewMode(agentWorking || presentation.active || trunkLock !== null);
  }, [canvas, agentWorking, presentation.active, trunkLock]);

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

  /**
   * Whether this scene is on a locked trunk (D104): a bound project whose base
   * branch is protected, sitting on that base. Never fatal — a store that
   * cannot answer leaves the canvas exactly as editable as it was.
   */
  const refreshTrunkLock = useCallback(
    async (source: { project: string; scene: string } | null) => {
      if (!source) {
        setTrunkLock(null);
        setProjectBound(false);
        return;
      }
      try {
        const binding = await getPortfolioBinding(source.project);
        setProjectBound(binding !== null);
        setTrunkLock(
          binding && binding.protected && binding.branch === binding.baseBranch
            ? { project: source.project, branch: binding.branch }
            : null,
        );
      } catch {
        setTrunkLock(null);
        setProjectBound(false);
      }
    },
    [],
  );

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
      // Every path that changes where the canvas came from passes through
      // here, which makes it the one place the lock has to be re-asked (D104).
      void refreshTrunkLock(source);
    },
    [refreshTrunkLock],
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

  // Tidy (S20, D73): the formatter, from ⌥⇧F or the menu. What is selected
  // says what to format — the frame the selection sits in, or, when the
  // selection spans more than one region or there is none, the tier the
  // viewport is looking at. The promise that nothing but the picture
  // changed is kept by the Command API, which puts the scene back if a
  // tidy ever changed meaning; here we only report what it said.
  const selectedIdsRef = useRef<string[]>(selectedIds);
  selectedIdsRef.current = selectedIds;
  const tidyDiagram = useCallback(() => {
    const c = canvasRef.current;
    const api = commandsRef.current;
    if (!c || !api) return;
    if (!api.canEdit()) {
      setAgentReport({ line: "Tidy is off while View → Agent Can Edit is unchecked", undo: null });
      return;
    }
    // The formatter is a write like any other (D73), and the trunk is locked
    // against writes (D104) — not against reading the diagram.
    const lock = trunkLockRef.current;
    if (lock) {
      setAgentReport({
        line: `${lock.branch} is protected — create a branch to edit`,
        undo: null,
      });
      return;
    }
    const snapshot = c.getSceneSnapshot();
    const selection = selectedIdsRef.current;
    const scope: TidyScope =
      selection.length && tidyOps(snapshot, { selection }).length === 1
        ? { selection }
        : { tier: trailAt(computeTiers(snapshot), snapshot, viewportCenter()).length + 1 };
    void api.tidy(scope).catch((err: unknown) => {
      setAgentReport({ line: err instanceof Error ? err.message : String(err), undo: null });
    });
  }, [viewportCenter]);

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
        await savePortfolioScene(source.project, source.scene, prepareSceneForSave());
        markClean(null);
        // Landed on disk. If the project is bound, this is also what starts the
        // checkpoint clock — and, on the base branch, what offers a draft
        // branch to check point onto (D33).
        notePortfolioSave(source.project);
      } catch (err) {
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

  /**
   * What the export knows about where it is being made from (D95): a link
   * that names no project means this scene's own, and only the shell knows
   * which that is. A loose file has none, and the export says so.
   */
  const exportContext = useCallback(
    (): ExportContext => ({
      ...(portfolioSourceRef.current
        ? { project: portfolioSourceRef.current.project }
        : {}),
    }),
    [],
  );

  const exportMermaidFile = useCallback(() => {
    const canvasHandle = canvasRef.current;
    if (!canvasHandle) return;
    const { mermaid } = exportScene(canvasHandle.getSceneSnapshot(), exportContext());
    downloadSceneFile(`${exportBaseName}.mmd`, mermaid);
  }, [exportBaseName, exportContext]);

  const exportSidecarFile = useCallback(() => {
    const canvasHandle = canvasRef.current;
    if (!canvasHandle) return;
    const { sidecar } = exportScene(canvasHandle.getSceneSnapshot(), exportContext());
    downloadSceneFile(`${exportBaseName}.docent.json`, sidecar);
  }, [exportBaseName, exportContext]);

  // One page per frame, the outline as the table of contents (D105). On the
  // desktop the bytes cross the shell's file channel base64-encoded (D116);
  // on the web they stay a browser download.
  const exportPdfFile = useCallback(() => {
    const canvasHandle = canvasRef.current;
    if (!canvasHandle) return;
    void exportPdf(canvasHandle, canvasHandle.getSceneSnapshot(), exportBaseName)
      .then((bytes) =>
        isDesktop
          ? exportSceneBytes(`${exportBaseName}.pdf`, bytes).then(() => {})
          : downloadBinaryFile(`${exportBaseName}.pdf`, bytes, "application/pdf"),
      )
      .catch((err) => void alertDialog(String(err instanceof Error ? err.message : err)));
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
        exportScene: () => exportScene(canvas.getSceneSnapshot(), exportContext()),
        prepareSceneForSave,
        canvas,
        camera,
        commands,
      });
    }
    (window as unknown as Record<string, unknown>).__docent = hook;
  }, [canvas, camera, commands, prepareSceneForSave, exportContext]);

  // Portfolio flows (S12). Opening tracks the source so Save writes back.
  const openPortfolio = useCallback((intent: PortfolioIntent) => {
    setPortfolioIntent(intent);
    setPortfolioOpen(true);
  }, []);
  /**
   * The one scene loader (S12). Every way in but a followed link (D96) is
   * the reader changing context themselves, so the cross-scene trail goes
   * with the context: only `keepTrail` — the jump — keeps it.
   */
  const openPortfolioScene = useCallback(
    async (project: string, scene: string, options?: { keepTrail?: boolean }) => {
      const handle = canvasRef.current;
      if (!handle) throw new Error("Canvas not ready");
      const text = await loadPortfolioScene(project, scene);
      await handle.loadSceneBlob(new Blob([text], { type: "application/json" }));
      fsHandleRef.current = null;
      portfolioSourceRef.current = { project, scene };
      syncSceneUrl({ project, scene });
      markClean(`${project}/${scene}`);
      if (!options?.keepTrail) drill.clearJumps();
      fitLayerOne();
    },
    [markClean, fitLayerOne, syncSceneUrl, drill.clearJumps],
  );
  /** A passing line in the narration strip — said, then gone. */
  const flashNote = useCallback((note: string) => {
    setNarration(note);
    window.setTimeout(
      () => setNarration((current) => (current === note ? null : current)),
      3000,
    );
  }, []);

  /**
   * The way out of the lock, in one click (D104): the branch the checkpointer
   * would have suggested anyway, cut through the same store route the
   * portfolio's ＋ Branch uses — which moves the project onto it, which is
   * what lifts the lock.
   */
  const [cutting, setCutting] = useState(false);
  const cutDraftBranch = useCallback(() => {
    const lock = trunkLockRef.current;
    if (!lock || cutting) return;
    setCutting(true);
    void (async () => {
      const name = suggestedBranch();
      try {
        await createPortfolioBranch(lock.project, name);
        flashNote(`drafting on ${name}`);
        await refreshTrunkLock(portfolioSourceRef.current);
      } catch (err) {
        await alertDialog(
          `Could not create ${name}: ${err instanceof Error ? err.message : err}`,
        );
      } finally {
        setCutting(false);
      }
    })();
  }, [cutting, flashNote, refreshTrunkLock]);

  /**
   * The guard `open_scene` keeps (D96), said once and shared: nothing opens
   * over unsaved changes, whether the way in is a link, the way back, or a
   * row in the palette (D111). True means the caller must stop.
   */
  const blockedByUnsaved = useCallback(async () => {
    if (!dirty) return false;
    await alertDialog(UNSAVED_CHANGES);
    return true;
  }, [dirty]);

  /**
   * Follow a scene link (D96): the jump, under the guard `open_scene` keeps,
   * with the way back recorded before the target opens. `at` is where to
   * arrive when the target still holds it — gone or absent, the overview
   * with a note, which is an answer, not a refusal (I5).
   */
  const followLink = useCallback(
    async (elementId: string, link: SceneLink) => {
      const from = portfolioSourceRef.current;
      if (await blockedByUnsaved()) return;
      const project = link.project ?? from?.project ?? null;
      if (!project) {
        await alertDialog(
          `“${link.scene}” names no project, and this scene is a loose file — open it from the portfolio first.`,
        );
        return;
      }
      try {
        await openPortfolioScene(project, link.scene, { keepTrail: true });
      } catch (err) {
        console.error(err);
        await alertDialog(
          `Could not follow the link to ${project}/${link.scene}: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
      // Recorded after the arrival, so a link that could not be followed
      // leaves no way back to a scene nobody left.
      if (from) drill.pushJump({ ...from, elementId });
      if (!link.at) return;
      try {
        await commandsRef.current?.focus({ id: link.at });
      } catch {
        flashNote(`${project} / ${link.scene} no longer holds “${link.at}” — here is the whole diagram`);
      }
    },
    [blockedByUnsaved, openPortfolioScene, drill.pushJump, flashNote],
  );

  /** The way back (D96): reopen where the last jump left, on what jumped. */
  const followBack = useCallback(async () => {
    const back = drill.jumps[drill.jumps.length - 1];
    if (!back) return;
    if (await blockedByUnsaved()) return;
    try {
      await openPortfolioScene(back.project, back.scene, { keepTrail: true });
    } catch (err) {
      console.error(err);
      await alertDialog(
        `Could not reopen ${back.project}/${back.scene}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    drill.popJump();
    try {
      await commandsRef.current?.focus({ id: back.elementId });
    } catch {
      // The element that jumped is gone; the scene is still the way back.
    }
  }, [blockedByUnsaved, openPortfolioScene, drill.jumps, drill.popJump]);

  /**
   * Every scene the portfolio holds, as the addresses the palette matches on
   * (D92, D111). Asked when the palette OPENS and never on boot — the canvas
   * comes up without waiting on a store — and one project the store will not
   * list is not the others' problem. No store at all throws, and the palette
   * is commands only, silently: a file-only session is a session, not a fault.
   */
  const loadPaletteScenes = useCallback(async (): Promise<PaletteScene[]> => {
    const projects = await listProjects();
    const found: PaletteScene[] = [];
    // Serially: the desktop store answers one request at a time (D34), so a
    // fan-out would only queue itself.
    for (const project of projects) {
      try {
        for (const scene of await listScenes(project.id)) {
          found.push({ project: project.id, path: scene.name });
        }
      } catch {
        // Skipped, not surfaced.
      }
    }
    return found;
  }, []);

  /** A palette row's scene, opened through the one loader under D96's guard. */
  const openPaletteScene = useCallback(
    (scene: PaletteScene) => {
      void (async () => {
        if (await blockedByUnsaved()) return;
        try {
          await openPortfolioScene(scene.project, scene.path);
        } catch (err) {
          console.error(err);
          await alertDialog(
            `Could not open ${scene.project}/${scene.path}: ${err instanceof Error ? err.message : err}`,
          );
        }
      })();
    },
    [blockedByUnsaved, openPortfolioScene],
  );

  /**
   * Show a review change in place (D48): the scene comes up if it is not the
   * one on screen, the camera flies to the crop, and what was removed is
   * drawn as ghosts from the base copy — effects only, nothing written (I2).
   */
  const showPortfolioChange = useCallback(
    async (project: string, jump: ReviewJump) => {
      const source = portfolioSourceRef.current;
      if (!source || source.project !== project || source.scene !== jump.scene) {
        await openPortfolioScene(project, jump.scene);
      }
      const api = commandsRef.current;
      if (!api) throw new Error("Canvas not ready");
      await api.showChange({
        rect: jump.crop.rect,
        ghosts: jump.crop.ghosts,
        outline: jump.crop.marks.filter((m) => m.kind !== "removed").map((m) => m.id),
      });
    },
    [openPortfolioScene],
  );
  const savePortfolioSceneAs = useCallback(
    async (project: string, scene: string) => {
      await savePortfolioScene(project, scene, prepareSceneForSave());
      fsHandleRef.current = null;
      portfolioSourceRef.current = { project, scene };
      syncSceneUrl({ project, scene });
      markClean(`${project}/${scene}`);
      notePortfolioSave(project);
    },
    [markClean, prepareSceneForSave, syncSceneUrl],
  );
  /**
   * The portfolio moved a scene (D93). Nothing about the canvas changed —
   * only where it came from — so the source, the URL and the name follow it
   * and the dirty flag is left exactly as it was: Save must land at the new
   * path, and must not resurrect the one just vacated.
   */
  const notePortfolioMove = useCallback(
    (project: string, from: string, to: string) => {
      const source = portfolioSourceRef.current;
      if (!source || source.project !== project || source.scene !== from) return;
      portfolioSourceRef.current = { project, scene: to };
      syncSceneUrl({ project, scene: to });
      setFileName(`${project}/${to}`);
    },
    [syncSceneUrl],
  );

  // What the agent surface may borrow from the shell (S15, D35): navigation,
  // never mutation. Rebuilt every render like the menu handlers; the facade
  // handed to the bridges is stable and reads through the ref, so a bridge
  // connected once never acts on a stale closure.
  const agentShellRef = useRef<AgentShellHooks | null>(null);
  agentShellRef.current = {
    presentation: {
      enter: (mode) => presentation.enter(mode),
      exit: () => presentation.exit(),
      next: () => presentation.next(),
      prev: () => presentation.prev(),
      overview: () => presentation.overview(),
      state: () => ({
        active: presentation.active,
        mode: presentation.active ? presentation.mode : null,
        index: !presentation.active
          ? null
          : presentation.index === OVERVIEW
            ? "overview"
            : presentation.index,
        waypoints: presentation.waypoints.map((w) => ({
          id: w.id,
          name: w.name,
          narrative: w.narrative,
        })),
      }),
    },
    drill: {
      dive: (elementId) => drill.dive(elementId),
      up: () => drill.up(),
      trail: () => {
        const c = canvasRef.current;
        if (!c) return [];
        const snapshot = c.getSceneSnapshot();
        return trailAt(computeTiers(snapshot), snapshot, viewportCenter()).map(
          (crumb) => ({ id: crumb.frameId, name: crumb.name }),
        );
      },
    },
    openScene: (project, scene) => openPortfolioScene(project, scene),
    isDirty: () => dirty,
    currentScene: () =>
      portfolioSourceRef.current
        ? {
            project: portfolioSourceRef.current.project,
            scene: portfolioSourceRef.current.scene,
          }
        : null,
    authoring: {
      saveScene: async () => {
        const source = portfolioSourceRef.current;
        if (!source) throw new Error("This scene is a loose file — the person saves it; create_scene to work in the portfolio");
        await savePortfolioScene(source.project, source.scene, prepareSceneForSave());
        markClean(null);
        notePortfolioSave(source.project);
        return { ...source };
      },
      createScene: async (project, scene) => {
        await savePortfolioScene(project, scene, EMPTY_SCENE);
        await openPortfolioScene(project, scene);
      },
      binding: async (project) => {
        const binding = await getPortfolioBinding(project);
        return binding
          ? {
              branch: binding.branch,
              baseBranch: binding.baseBranch,
              // What makes the refusal a rule rather than advice (D104).
              protected: binding.protected,
            }
          : null;
      },
      createBranch: async (project, name) => {
        await createPortfolioBranch(project, name);
        // The project moved off its base, so the lock has just lifted.
        await refreshTrunkLock(portfolioSourceRef.current);
      },
    },
  };
  const agentShell = useMemo<AgentShellHooks>(() => {
    const current = () => agentShellRef.current!;
    return {
      presentation: {
        enter: (mode) => current().presentation.enter(mode),
        exit: () => current().presentation.exit(),
        next: () => current().presentation.next(),
        prev: () => current().presentation.prev(),
        overview: () => current().presentation.overview(),
        state: () => current().presentation.state(),
      },
      drill: {
        dive: (elementId) => current().drill.dive(elementId),
        up: () => current().drill.up(),
        trail: () => current().drill.trail(),
      },
      openScene: (project, scene) => current().openScene(project, scene),
      isDirty: () => current().isDirty(),
      currentScene: () => current().currentScene(),
      authoring: {
        saveScene: () => current().authoring!.saveScene(),
        createScene: (project, scene) => current().authoring!.createScene(project, scene),
        binding: (project) => current().authoring!.binding(project),
        createBranch: (project, name) => current().authoring!.createBranch(project, name),
      },
    };
  }, []);

  // Desktop agent endpoint (S15): the shell's /mcp pipe is this same
  // process, so the page side connects at launch — nothing to configure.
  useEffect(() => {
    if (!isDesktop || !commands) return;
    const bridge = connectDesktopAgentBridge(commands, agentShell);
    return () => bridge.dispose();
  }, [commands, agentShell]);

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

  // Format Document, for a diagram (D73): ⌥⇧F tidies what is in scope.
  // The desktop shell's native accelerator owns the chord there, as it does
  // for the file chords above. Typing is never interrupted: a text field,
  // or Excalidraw's own editor, keeps the key.
  useEffect(() => {
    if (isDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return;
      // ⌥⇧F types a character on macOS, so the physical key is what counts.
      if (event.code !== "KeyF" && event.key.toLowerCase() !== "f") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      tidyDiagram();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [tidyDiagram]);

  // The rail's chord (D114): Cmd+\, Ctrl+\ elsewhere — the editors' sidebar
  // family. The desktop's native accelerator owns it there, like the file
  // chords above; here as everywhere, a field being typed in keeps its keys.
  useEffect(() => {
    if (isDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key !== "\\") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTools();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [toggleTools]);

  // The settings chord (D115): Cmd+,, Ctrl+, elsewhere. The desktop's native
  // accelerator owns it there; a field being typed in keeps its keys.
  useEffect(() => {
    if (isDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key !== ",") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  /**
   * ── One command, one implementation (B4, D109) ──────────────────────────
   *
   * The in-canvas hamburger, the native menu bar and the palette are three
   * doors onto this table and never onto each other's copies. Where a
   * platform differs the difference lives inside one `run`: the desktop's
   * File verbs address the portfolio — which is that app's file system — and
   * cross to a loose file only through the shell's native dialogs, while the
   * web's address the browser's own pickers and downloads.
   *
   * Rebuilt every render, because every handler closes over state; the ref
   * below is what the shell's `__docentMenu` reads, so the global is
   * installed once and never holds a stale closure.
   */
  const actions: Record<DocentActionId, DocentAction> = {
    new: {
      title: "New scene…",
      shortcut: KEY.newScene,
      available: isDesktop,
      run: () => openPortfolio("save"),
    },
    open: {
      title: "Open…",
      shortcut: KEY.open,
      run: () => {
        if (isDesktop) openPortfolio("browse");
        else void openScene();
      },
    },
    import: {
      title: "Import scene file…",
      shortcut: KEY.import,
      available: isDesktop,
      run: () => void importSceneIntoCanvas(),
    },
    save: {
      title: "Save",
      shortcut: KEY.save,
      run: () => {
        // Nowhere to save to yet, on the desktop: the modal stands in for the
        // save dialog, opened on its name field.
        if (isDesktop && !portfolioSourceRef.current) openPortfolio("save");
        else void saveScene();
      },
    },
    "save-as": {
      title: "Save as…",
      shortcut: KEY.saveAs,
      run: () => {
        if (!isDesktop) {
          void saveSceneAs();
          return;
        }
        // A copy under a new name — detach first, so a cancelled Save As
        // cannot silently overwrite the scene it started from.
        portfolioSourceRef.current = null;
        syncSceneUrl(null);
        openPortfolio("save");
      },
    },
    "export-file": {
      title: "Export scene file…",
      available: isDesktop,
      run: () => {
        if (!canvasRef.current) return;
        void exportToFile(ensureExtension(exportLeafName), prepareSceneForSave());
      },
    },
    "export-mermaid": {
      title: "Export Mermaid…",
      run: () => {
        if (!isDesktop) {
          exportMermaidFile();
          return;
        }
        const handle = canvasRef.current;
        if (!handle) return;
        const { mermaid } = exportScene(handle.getSceneSnapshot(), exportContext());
        void exportToFile(`${exportLeafName}.mmd`, mermaid);
      },
    },
    "export-sidecar": {
      title: "Export semantic JSON…",
      run: () => {
        if (!isDesktop) {
          exportSidecarFile();
          return;
        }
        const handle = canvasRef.current;
        if (!handle) return;
        const { sidecar } = exportScene(handle.getSceneSnapshot(), exportContext());
        void exportToFile(`${exportLeafName}.docent.json`, sidecar);
      },
    },
    // The PDF is bytes (D105) and the file channel carries bytes now (D116):
    // one command, both builds.
    "export-pdf": {
      title: "Export PDF…",
      run: exportPdfFile,
    },
    present: { title: "Present", shortcut: KEY.present, run: () => presentation.enter() },
    library: {
      title: "Shape library",
      shortcut: KEY.library,
      run: () => canvasRef.current?.toggleLibrarySidebar(),
    },
    tools: {
      title: toolsCollapsed ? "Show the tools" : "Hide the tools",
      shortcut: KEY.tools,
      hint: "the left rail",
      run: toggleTools,
    },
    legend: { title: "Legend…", run: () => setLegendOpen(true) },
    arrange: { title: "Arrange detail tiers", run: arrangeTiers },
    tidy: { title: "Tidy diagram", shortcut: KEY.tidy, run: tidyDiagram },
    "detail-markers": {
      title: detailMarkers ? "Hide detail markers" : "Show detail markers",
      run: () => setDetailMarkers((v) => !v),
    },
    portfolio: { title: "Portfolio…", run: () => openPortfolio("browse") },
    // The sync verbs live in the portfolio's own strip, where the branch list,
    // the conflict resolution and the review all are — so these open it
    // rather than growing a second, thinner copy of them here.
    branch: {
      title: "Create a branch…",
      hint: "in the portfolio",
      available: projectBound,
      // On a locked trunk there is already a one-click way out (D104); take it.
      run: () => (trunkLockRef.current ? cutDraftBranch() : openPortfolio("browse")),
    },
    pull: {
      title: "Pull from GitHub",
      hint: "in the portfolio",
      available: projectBound,
      run: () => openPortfolio("browse"),
    },
    push: {
      title: "Push to GitHub",
      hint: "in the portfolio",
      available: projectBound,
      run: () => openPortfolio("browse"),
    },
    // Web only (D118): the desktop shell's own pipe connects itself (D34),
    // so there the verb would ask for what already happened.
    "connect-agent": {
      title: "Connect agent bridge",
      available: !isDesktop,
      run: connectAgent,
    },
    settings: {
      title: "Settings…",
      shortcut: KEY.settings,
      run: () => setSettingsOpen(true),
    },
    plugins: {
      title: "Plugins…",
      available: hasPlugins(),
      run: () => setPluginsOpen(true),
    },
    "agent-edit": {
      title: agentCanEdit ? "Agent can edit ✓" : "Agent can edit",
      run: () => setAgentCanEdit((v) => !v),
    },
  };

  // Native menu bar bridge (S13, D109). The Rust handlers reach the page by
  // evaluating `window.__docentMenu(id)`, which keeps the desktop shell free
  // of any JS SDK (I7) — the same reasoning as the injected store base URL.
  const menuHandlersRef = useRef(actions);
  menuHandlersRef.current = actions;
  useEffect(() => {
    if (!isDesktop) return;
    const target = window as DocentMenuWindow;
    target.__docentMenu = (id) => menuHandlersRef.current[id]?.run();
    return () => {
      delete target.__docentMenu;
    };
  }, []);

  /** The same table, as palette rows (D111) — menu order, minus what this
      platform cannot do. */
  const paletteCommands: PaletteCommand[] = PALETTE_ORDER.filter(
    (id) => actions[id].available !== false,
  ).map((id) => ({
    id,
    title: actions[id].title,
    ...(actions[id].hint ? { hint: actions[id].hint } : {}),
    ...(actions[id].shortcut ? { shortcut: actions[id].shortcut } : {}),
    run: actions[id].run,
  }));

  // The palette's chord (D111): Cmd+K, Ctrl+K elsewhere. It takes that one
  // combination and nothing else — a key it does not own is never
  // preventDefaulted — and it keeps out of text: a field being typed in owns
  // its own keyboard, Excalidraw's editors included.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // Presentation keyboard controls (S2) + drill back (S11).
  const drillRef = useRef(drill);
  drillRef.current = drill;
  // The jump, read through a ref for the same reason the drill is: the
  // pointer listeners below are installed once and must not close over a
  // stale dirty flag or a stale scene (D96).
  const followRef = useRef(followLink);
  followRef.current = followLink;
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
        case "m":
        case "M":
          // Mute the voice (D52) — only meaningful once it is on.
          if (!speech.get().enabled) return;
          speech.setMuted(!speech.get().muted);
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [presentation, speech]);

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
      // A click on a detail badge is the badge's own dive (D31) — handling
      // it here too would dive twice.
      if ((event.target as Element | null)?.closest?.(".docent-detail-badge")) return;
      const info = canvas.elementAtClient(event.clientX, event.clientY);
      // Dive when it is this diagram going deeper, link when it is another
      // diagram's story (D96) — and when a component is both, this
      // diagram's own depth comes first. The panel offers the link either way.
      if (info?.detailFrameId) drillRef.current.dive(info.id);
      else if (info?.link) void followRef.current(info.id, info.link);
    };
    host.addEventListener("pointerdown", onPointerDown, { capture: true });
    host.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, { capture: true });
      host.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [canvas]);

  useEffect(() => {
    // A portfolio scene is "<project>/<path>" and its name is a path (D92),
    // so the title spaces the separators: a trail to read, not a file name.
    const name = (fileName ?? "untitled").split("/").join(" / ");
    document.title = `${dirty ? "● " : ""}${name} — Docent`;
  }, [fileName, dirty]);

  // Detail-layer markers (D31), recomputed with the document. Off costs
  // nothing — the graph build is skipped entirely.
  const badges = useMemo(
    () =>
      canvas && detailMarkers ? detailBadges(canvas.getSceneSnapshot()) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, detailMarkers, docVersion],
  );
  const marks = useMemo(
    () => (canvas && detailMarkers ? logicMarks(canvas.getSceneSnapshot()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, detailMarkers, docVersion],
  );
  // Link markers (D96) ride the same toggle: "goes elsewhere" is shown the
  // way "goes deeper" is, or neither is.
  const links = useMemo(
    () => (canvas && detailMarkers ? linkBadges(canvas.getSceneSnapshot()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, detailMarkers, docVersion],
  );
  const onBadgeClick = useCallback((diveElementId: string) => {
    drillRef.current.dive(diveElementId);
  }, []);
  // The marker is the explicit affordance: it follows even where the same
  // component also goes deeper, which activating it would prefer (D96).
  const onLinkBadgeClick = useCallback(
    (elementId: string) => {
      const link = links.find((b) => b.elementId === elementId)?.link;
      if (link) void followRef.current(elementId, link);
    },
    [links],
  );

  // Right-click semantic export (D32). Eligible targets: a frame, or a shape
  // whose declared detail layer IS a frame — either way the export is a
  // frame, one tier deep, never the layers nested beneath it.
  const resolveFrameAt = useCallback((clientX: number, clientY: number) => {
    const c = canvasRef.current;
    if (!c) return null;
    const info = c.elementAtClient(clientX, clientY);
    if (!info) return null;
    const frameId =
      info.detailFrameId ?? (info.type === "frame" ? info.id : null);
    if (!frameId) return null;
    const frame = c.getFrameInfo(frameId);
    return frame ? { id: frame.id, name: frame.name || "detail" } : null;
  }, []);
  const copyFrameJson = useCallback((frameSourceId: string) => {
    const c = canvasRef.current;
    if (!c) return;
    void (async () => {
      try {
        const { name, sidecar } = exportFrameSidecar(
          c.getSceneSnapshot(),
          frameSourceId,
        );
        if (!(await copyText(sidecar))) {
          throw new Error("the clipboard is unavailable here");
        }
        const note = `Semantic JSON of “${name}” copied`;
        setNarration(note);
        window.setTimeout(
          () => setNarration((current) => (current === note ? null : current)),
          2500,
        );
      } catch (err) {
        console.error(err);
        await alertDialog(
          `Could not copy semantic JSON: ${err instanceof Error ? err.message : err}`,
        );
      }
    })();
  }, []);

  // During a presentation, diveable components advertise themselves with the
  // pointer cursor too — the badge says "there is more", the cursor says
  // "click me". Hit tests are rAF-throttled and only run while presenting.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || !canvas || !presentation.active) return;
    let raf = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (raf) return;
      const { clientX, clientY } = event;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const info = canvas.elementAtClient(clientX, clientY);
        host.style.cursor = info?.detailFrameId || info?.link ? "pointer" : "";
      });
    };
    host.addEventListener("pointermove", onPointerMove);
    return () => {
      host.removeEventListener("pointermove", onPointerMove);
      if (raf) cancelAnimationFrame(raf);
      host.style.cursor = "";
    };
  }, [canvas, presentation.active]);

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

  // One element, or one composite selected whole — a symbol's group opens
  // the panel on its carrier, where the meaning lives (D83).
  const singleSelected = (() => {
    if (presentation.active || !canvas || !selectedIds.length) return null;
    if (selectedIds.length === 1) return canvas.getElementInfo(selectedIds[0]);
    const carrier = canvas.compositeRepresentative(selectedIds);
    return carrier ? canvas.getElementInfo(carrier) : null;
  })();

  const currentWaypoint =
    presentation.index === OVERVIEW
      ? null
      : (presentation.waypoints[presentation.index] ?? null);
  // The author's own narrative, spoken as the presentation reaches its
  // frame (D52); leaving the presentation ends the voice.
  const spokenNarrative = presentation.active ? (currentWaypoint?.narrative ?? null) : null;
  const spokenKey = presentation.active ? `${presentation.index}:${spokenNarrative ?? ""}` : "";
  useEffect(() => {
    if (!presentation.active) {
      speech.cancel();
      return;
    }
    void speech.speak(spokenNarrative);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spokenKey, presentation.active, speech]);
  const waypointLabel =
    presentation.index === OVERVIEW
      ? "Overview"
      : `${currentWaypoint?.name || "Frame"} — ${presentation.index + 1}/${
          presentation.waypoints.length
        }`;

  return (
    <div
      className={[
        "docent-app",
        isDesktop ? "docent-desktop" : "",
        hasOverlayTitleBar ? "docent-overlay-titlebar" : "",
        // The tools are away, and the paper is the whole window (D110).
        toolsCollapsed ? "docent-tools-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Somewhere to move a borderless window by (D108): a strip along the
          very top, above the canvas and clear of every island. */}
      {hasOverlayTitleBar && (
        <div className="docent-titlebar-drag" data-tauri-drag-region />
      )}
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
          onThemeChange={setCanvasTheme}
          menuActions={{
            onOpen: actions.open.run,
            onSave: actions.save.run,
            onSaveAs: actions["save-as"].run,
            onPresent: actions.present.run,
            onOpenLegend: actions.legend.run,
            onOpenPortfolio: actions.portfolio.run,
            onExportMermaid: actions["export-mermaid"].run,
            onExportSidecar: actions["export-sidecar"].run,
            onExportPdf: actions["export-pdf"].run,
            onArrangeTiers: actions.arrange.run,
            onTidy: actions.tidy.run,
            onToggleDetailMarkers: actions["detail-markers"].run,
            onConnectAgent: actions["connect-agent"].run,
            onOpenSettings: actions.settings.run,
            onOpenPlugins: hasPlugins() ? actions.plugins.run : undefined,
            onToggleAgentEdit: actions["agent-edit"].run,
            agentCanEdit,
          }}
          hideDocentMenuItems={isDesktop}
          detailMarkersVisible={detailMarkers}
          contextExport={{ resolveFrameAt, onCopy: copyFrameJson }}
        />
        {/* The way back (D114): while the tools are away, a slim handle on
            the left edge — the one piece of chrome the collapse leaves, gone
            again the moment the rail returns. Not during a presentation,
            which has no tools to speak of. */}
        {!presentation.active && toolsCollapsed && (
          <button
            type="button"
            className="docent-rail-handle"
            title="Show the tools"
            aria-label="Show the tools"
            onClick={toggleTools}
          />
        )}
        {canvas && (
          <Breadcrumbs
            canvas={canvas}
            camera={camera}
            trail={trail}
            drill={drill}
            revision={docVersion}
            onBack={() => void followBack()}
          />
        )}
        {canvas && (
          <div className="docent-zoom-stage" ref={zoomStageRef}>
            <OverlayLayer
              reader={canvas}
              store={overlayStore}
              revision={docVersion}
              badges={badges}
              onBadgeClick={onBadgeClick}
              linkBadges={links}
              onLinkClick={onLinkBadgeClick}
              logicMarks={marks}
            />
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
            project={portfolioSourceRef.current?.project ?? null}
            onFollow={(elementId, link) => void followLink(elementId, link)}
          />
        )}
        {agentWorking && (
          <div className="docent-agent-frame" aria-live="polite">
            <span className="docent-agent-frame-label">Agent is drawing — hold on</span>
          </div>
        )}
        {/* Why the canvas will not take an edit, and the way forward beside it
            (D104). Not during a presentation: that has its own chrome, and a
            presentation is a reading, which the lock has no quarrel with. */}
        {trunkLock && !presentation.active && (
          <div className="docent-trunk-lock" aria-live="polite">
            <span className="docent-trunk-lock-text">
              <code>{trunkLock.branch}</code> is protected — create a branch to
              edit
            </span>
            <button disabled={cutting} onClick={cutDraftBranch}>
              {cutting ? "Creating…" : "Create a branch"}
            </button>
          </div>
        )}
        {agentReport && !agentWorking && (
          <div className="docent-agent-report">
            <span className="docent-agent-report-text">{agentReport.line}</span>
            {agentReport.undo && (
              <button
                onClick={() => {
                  agentReport.undo?.();
                  setAgentReport(null);
                }}
              >
                Undo
              </button>
            )}
            <button className="docent-narration-close" title="Dismiss" onClick={() => setAgentReport(null)}>
              ✕
            </button>
          </div>
        )}
        {narration && (
          <div className="docent-narration">
            <span className="docent-narration-text">{narration}</span>
            {speechState.enabled && (
              <button
                className="docent-narration-close"
                title={speechState.muted ? "Unmute the voice" : "Mute the voice"}
                onClick={() => speech.setMuted(!speechState.muted)}
              >
                {speechState.muted ? "🔇" : "🔊"}
              </button>
            )}
            <button
              className="docent-narration-close"
              title="Stop narration"
              onClick={() => commands?.stopTour()}
            >
              ✕
            </button>
          </div>
        )}
        {presentation.active && presentation.mode === "guided" && (
          <div className="docent-hud">
            <span className="docent-hud-title">Guided tour</span>
            <span className="docent-hud-hint">
              the narrator drives the camera · Home overview · click a marked
              component to dive · ⌫ back{speechState.enabled ? " · M mute" : ""} · Esc exit
            </span>
          </div>
        )}
        {presentation.active && presentation.mode === "frames" && (
          <div className="docent-hud">
            <span className="docent-hud-title">{waypointLabel}</span>
            {currentWaypoint?.narrative && (
              <span className="docent-hud-narrative">
                {currentWaypoint.narrative}
              </span>
            )}
            <span className="docent-hud-hint">
              → next · ← prev · Home overview · click a marked component to dive
              · ⌫ back{speechState.enabled ? " · M mute" : ""} · Esc exit
            </span>
          </div>
        )}
      </main>
      {/* Only the project comes off the front of the suggestion: what is left
          is the scene's own path (D92), which is what the name field takes. */}
      {portfolioOpen && canvas && (
        <PortfolioModal
          onOpenScene={openPortfolioScene}
          onSaveScene={savePortfolioSceneAs}
          suggestedName={(fileName ?? UNTITLED).replace(/\.excalidraw$/i, "").replace(/^[^/]*\//, "")}
          intent={portfolioIntent}
          onClose={() => {
            setPortfolioOpen(false);
            // A branch cut, a branch switched, a binding protected: the strip
            // is where the lock changes, so this is when to re-ask (D104).
            void refreshTrunkLock(portfolioSourceRef.current);
          }}
          onShowChange={showPortfolioChange}
          onSceneMoved={notePortfolioMove}
          onSceneReverted={async (project, scene) => {
            // Only the scene on screen, and only through the one loader (D103):
            // the canvas must not go on editing a copy that was just replaced.
            const source = portfolioSourceRef.current;
            if (source?.project !== project || source.scene !== scene) return;
            await openPortfolioScene(project, scene, { keepTrail: true });
          }}
        />
      )}
      {/* The person's switches, in one place (D115). */}
      {settingsOpen && (
        <SettingsModal
          theme={canvasTheme}
          onTheme={(next) => canvasRef.current?.setTheme(next)}
          detailMarkers={detailMarkers}
          onDetailMarkers={setDetailMarkers}
          agentCanEdit={agentCanEdit}
          onAgentCanEdit={setAgentCanEdit}
          endpoint={
            isDesktop
              ? ((window as { __DOCENT_MCP_BASE__?: string }).__DOCENT_MCP_BASE__ ?? null)
              : null
          }
          onConnectBridge={isDesktop ? null : connectAgent}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {pluginsOpen && hasPlugins() && (
        <PluginsModal
          speech={speech}
          pluginsDir={(window as { __DOCENT_PLUGINS_DIR__?: string }).__DOCENT_PLUGINS_DIR__ ?? null}
          voice={voice}
          onVoice={(next) => {
            setVoice(next);
            if (next) localStorage.setItem("docent.speech.voice", next);
            else localStorage.removeItem("docent.speech.voice");
          }}
          onClose={() => setPluginsOpen(false)}
        />
      )}
      {legendOpen && canvas && (
        <LegendEditor
          canvas={canvas}
          selection={singleSelected}
          onClose={() => setLegendOpen(false)}
        />
      )}
      {/* The keyboard's way to everything (D111): the same table the menus
          carry, and the portfolio's scenes by path. */}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          loadScenes={loadPaletteScenes}
          onOpenScene={openPaletteScene}
          onInsertSymbol={(symbol) => void canvasRef.current?.insertLibraryItem(symbol)}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
