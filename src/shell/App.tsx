import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExcalidrawCanvas } from "../adapter";
import type { DocentCanvasHandle } from "../adapter";
import { CameraEngine } from "../camera/engine";
import {
  downloadSceneFile,
  ensureExtension,
  pickSaveTarget,
  pickSceneFile,
  writeSceneFile,
} from "./scene-file";
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

  const camera = useMemo(() => (canvas ? new CameraEngine(canvas) : null), [canvas]);
  const presentation = usePresentation(canvas, camera);
  const drill = useDrill(canvas, camera);

  const markClean = useCallback((name: string | null) => {
    savedFingerprintRef.current = canvasRef.current?.getSceneFingerprint() ?? null;
    if (name !== null) setFileName(name);
    setDirty(false);
  }, []);

  const openScene = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const picked = await pickSceneFile();
      if (!picked) return;
      await handle.loadSceneBlob(picked.blob);
      fsHandleRef.current = picked.handle;
      markClean(picked.name);
    } catch (err) {
      console.error(err);
      window.alert(`Could not open scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean]);

  const saveSceneAs = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    try {
      const suggested = ensureExtension(fileName ?? UNTITLED);
      const target = await pickSaveTarget(suggested);
      if (target === null) return;
      const json = handle.serializeScene();
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
  }, [fileName, markClean]);

  const saveScene = useCallback(async () => {
    const handle = canvasRef.current;
    if (!handle) return;
    const fsHandle = fsHandleRef.current;
    if (!fsHandle) {
      await saveSceneAs();
      return;
    }
    try {
      await writeSceneFile(fsHandle, handle.serializeScene());
      markClean(null);
    } catch (err) {
      console.error(err);
      window.alert(`Could not save scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean, saveSceneAs]);

  const handleDocumentChange = useCallback((fingerprint: number) => {
    setDirty(fingerprint !== savedFingerprintRef.current);
  }, []);

  const handleReady = useCallback((handle: DocentCanvasHandle) => {
    canvasRef.current = handle;
    savedFingerprintRef.current = handle.getSceneFingerprint();
    setCanvas(handle);
  }, []);

  // Startup scene load (?scene=<url>) runs in an effect so it acts only after
  // the canvas is mounted — the excalidrawAPI callback fires mid-mount, and
  // viewport calls made then are silently dropped.
  useEffect(() => {
    if (!canvas) return;
    const sceneUrl = new URLSearchParams(window.location.search).get("scene");

    if (import.meta.env.DEV) {
      // Dev-only hook for scripted verification; not part of the app surface.
      (window as unknown as Record<string, unknown>).__docent = {
        serializeScene: () => canvas.serializeScene(),
        loadSceneJSON: (json: string) =>
          canvas.loadSceneBlob(new Blob([json], { type: "application/json" })),
        getSceneFingerprint: () => canvas.getSceneFingerprint(),
        canvas,
        camera,
      };
    }

    if (!sceneUrl) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(sceneUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        await canvas.loadSceneBlob(blob);
        markClean(sceneUrl.split("/").pop() ?? sceneUrl);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(`Failed to load ?scene=${sceneUrl}`, err);
        }
      }
    })();
    return () => controller.abort();
  }, [canvas, camera, markClean]);

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

  const singleSelected =
    !presentation.active && selectedIds.length === 1 && canvas
      ? canvas.getElementInfo(selectedIds[0])
      : null;

  const waypointLabel =
    presentation.index === OVERVIEW
      ? "Overview"
      : `${presentation.waypoints[presentation.index]?.name || "Frame"} — ${
          presentation.index + 1
        }/${presentation.waypoints.length}`;

  return (
    <div className="docent-app">
      <header className="docent-topbar">
        <span className="docent-brand">Docent</span>
        <span className="docent-file">
          {fileName ?? "untitled"}
          {dirty && (
            <span className="docent-dirty" title="Unsaved changes">
              ●
            </span>
          )}
        </span>
        {drill.stack.length > 0 && (
          <nav className="docent-breadcrumbs">
            <button className="docent-chip" onClick={() => drill.up()}>
              ◂ Up
            </button>
            {drill.stack.map((tier, i) => (
              <span className="docent-crumb" key={`${tier.frameId}-${i}`}>
                {tier.name}
              </span>
            ))}
          </nav>
        )}
        <div className="docent-actions">
          {singleSelected &&
            (singleSelected.detailFrameId ? (
              <button onClick={() => drill.dive(singleSelected.id)}>
                Dive into detail
              </button>
            ) : (
              <button onClick={() => drill.createAndDive(singleSelected.id)}>
                Create detail diagram
              </button>
            ))}
          {!presentation.active && (
            <>
              <button onClick={() => void openScene()}>Open</button>
              <button onClick={() => void saveScene()}>Save</button>
              <button onClick={() => void saveSceneAs()}>Save as…</button>
              <button
                className="docent-present"
                onClick={() => presentation.enter()}
                disabled={!canvas}
              >
                ▶ Present
              </button>
            </>
          )}
          {presentation.active && (
            <button
              onClick={() => {
                drill.reset();
                presentation.exit();
              }}
            >
              Exit
            </button>
          )}
        </div>
      </header>
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
          }}
        />
        {presentation.active && (
          <div className="docent-hud">
            <span className="docent-hud-title">{waypointLabel}</span>
            <span className="docent-hud-hint">
              → next · ← prev · Home overview · click a component to dive · ⌫ back
              · Esc exit
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
