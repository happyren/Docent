import { useCallback, useEffect, useRef, useState } from "react";
import { ExcalidrawCanvas } from "../adapter";
import type { DocentCanvasHandle } from "../adapter";
import {
  downloadSceneFile,
  ensureExtension,
  pickSaveTarget,
  pickSceneFile,
  writeSceneFile,
} from "./scene-file";

const UNTITLED = "untitled.excalidraw";

export function App() {
  const canvasRef = useRef<DocentCanvasHandle | null>(null);
  const fsHandleRef = useRef<FileSystemFileHandle | null>(null);
  const savedFingerprintRef = useRef<number | null>(null);
  const [canvas, setCanvas] = useState<DocentCanvasHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const markClean = useCallback((name: string | null) => {
    savedFingerprintRef.current = canvasRef.current?.getSceneFingerprint() ?? null;
    if (name !== null) setFileName(name);
    setDirty(false);
  }, []);

  const openScene = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const picked = await pickSceneFile();
      if (!picked) return;
      await canvas.loadSceneBlob(picked.blob);
      fsHandleRef.current = picked.handle;
      markClean(picked.name);
    } catch (err) {
      console.error(err);
      window.alert(`Could not open scene: ${err instanceof Error ? err.message : err}`);
    }
  }, [markClean]);

  const saveSceneAs = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const suggested = ensureExtension(fileName ?? UNTITLED);
      const target = await pickSaveTarget(suggested);
      if (target === null) return;
      const json = canvas.serializeScene();
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = fsHandleRef.current;
    if (!handle) {
      await saveSceneAs();
      return;
    }
    try {
      await writeSceneFile(handle, canvas.serializeScene());
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
  }, [canvas, markClean]);

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

  useEffect(() => {
    const name = fileName ?? "untitled";
    document.title = `${dirty ? "● " : ""}${name} — Docent`;
  }, [fileName, dirty]);

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
        <div className="docent-actions">
          <button onClick={() => void openScene()}>Open</button>
          <button onClick={() => void saveScene()}>Save</button>
          <button onClick={() => void saveSceneAs()}>Save as…</button>
        </div>
      </header>
      <main className="docent-canvas">
        <ExcalidrawCanvas
          onReady={handleReady}
          onDocumentChange={handleDocumentChange}
          menuActions={{
            onOpen: () => void openScene(),
            onSave: () => void saveScene(),
            onSaveAs: () => void saveSceneAs(),
          }}
        />
      </main>
    </div>
  );
}
