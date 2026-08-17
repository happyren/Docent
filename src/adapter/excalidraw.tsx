/**
 * Excalidraw adapter — per Constitution B1, this is the ONLY module that may
 * import from `@excalidraw/excalidraw` or read raw element shapes. Everything
 * above it consumes `DocentCanvasHandle` and the component props below.
 */
import { useCallback, useRef } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  hashElementsVersion,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

/** Typed surface the shell drives the canvas through. */
export interface DocentCanvasHandle {
  /** Canonical `.excalidraw` JSON for the current scene. */
  serializeScene(): string;
  /** Replace the current scene with the contents of a `.excalidraw` file. Clears undo history. */
  loadSceneBlob(blob: Blob): Promise<void>;
  /** Fingerprint of document content — changes on edits, not on viewport moves. */
  getSceneFingerprint(): number;
  /** Fit the whole scene into the viewport. */
  zoomToScene(): void;
}

export interface SceneMenuActions {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
}

export interface ExcalidrawCanvasProps {
  onReady?: (handle: DocentCanvasHandle) => void;
  /** Fires when document content changes (viewport-only changes are filtered out). */
  onDocumentChange?: (fingerprint: number) => void;
  menuActions: SceneMenuActions;
}

/**
 * Right after mount Excalidraw hasn't measured its container yet
 * (appState.width/height are 0), and a fit-to-content computed against a
 * zero-sized viewport collapses zoom to the minimum. Wait, bounded, until
 * the canvas reports a real size.
 */
async function waitForCanvasSize(api: ExcalidrawImperativeAPI): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { width, height } = api.getAppState();
    if (width > 0 && height > 0) return;
    await new Promise(requestAnimationFrame);
  }
}

function makeHandle(api: ExcalidrawImperativeAPI): DocentCanvasHandle {
  return {
    serializeScene: () =>
      serializeAsJSON(
        api.getSceneElementsIncludingDeleted(),
        api.getAppState(),
        api.getFiles(),
        "local",
      ),

    loadSceneBlob: async (blob) => {
      const data = await loadFromBlob(blob, api.getAppState(), null);
      api.updateScene({
        elements: data.elements,
        appState: data.appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (data.files) {
        api.addFiles(Object.values(data.files));
      }
      api.history.clear();
      await waitForCanvasSize(api);
      // Pass the restored elements explicitly — the scene store may not have
      // committed them yet, and an empty target collapses zoom to the minimum.
      api.scrollToContent(data.elements, { fitToContent: true });
    },

    getSceneFingerprint: () =>
      hashElementsVersion(api.getSceneElementsIncludingDeleted()),

    zoomToScene: () => api.scrollToContent(undefined, { fitToContent: true }),
  };
}

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
const MOD = isMac ? "Cmd" : "Ctrl";

export function ExcalidrawCanvas({
  onReady,
  onDocumentChange,
  menuActions,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastFingerprintRef = useRef(0);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      lastFingerprintRef.current = hashElementsVersion(
        api.getSceneElementsIncludingDeleted(),
      );
      onReady?.(makeHandle(api));
    },
    [onReady],
  );

  const handleChange = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const fingerprint = hashElementsVersion(api.getSceneElementsIncludingDeleted());
    if (fingerprint !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fingerprint;
      onDocumentChange?.(fingerprint);
    }
  }, [onDocumentChange]);

  return (
    <Excalidraw
      excalidrawAPI={handleApi}
      onChange={handleChange}
      UIOptions={{
        // Docent owns the file lifecycle; disable Excalidraw's built-in
        // open/save pathways so there is exactly one.
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
        },
      }}
    >
      <MainMenu>
        <MainMenu.Item onSelect={menuActions.onOpen} shortcut={`${MOD}+O`}>
          Open…
        </MainMenu.Item>
        <MainMenu.Item onSelect={menuActions.onSave} shortcut={`${MOD}+S`}>
          Save
        </MainMenu.Item>
        <MainMenu.Item onSelect={menuActions.onSaveAs} shortcut={`${MOD}+Shift+S`}>
          Save as…
        </MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
}
