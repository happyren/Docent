/**
 * Excalidraw adapter — per Constitution B1, this is the ONLY module that may
 * import from `@excalidraw/excalidraw` or read raw element shapes (including
 * `customData`). Everything above it consumes the typed surface below.
 *
 * Docent-written element data lives exclusively under `customData.docent.*`
 * (Decision D15); this module is the only reader/writer of that namespace.
 */
import { useCallback, useRef } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  elementsOverlappingBBox,
  getCommonBounds,
  hashElementsVersion,
  loadFromBlob,
  newElementWith,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";

// Excalidraw's zoom limits (MIN_ZOOM/MAX_ZOOM are not runtime-exported).
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 30;

/** Camera state. scroll offsets are in scene units; zoom is a scale factor. */
export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** Axis-aligned box in scene coordinates. */
export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInfo {
  id: string;
  name: string;
  /** Declared presentation order (customData.docent.order), if any. */
  order: number | null;
  bounds: SceneBounds;
}

export interface ElementInfo {
  id: string;
  type: string;
  label: string | null;
  bounds: SceneBounds;
  frameId: string | null;
  /** Declared detail diagram (customData.docent.detail.frameId), if any. */
  detailFrameId: string | null;
}


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

  getViewport(): Viewport;
  /**
   * Write the viewport. Per Constitution B2 the camera engine is the ONLY
   * caller — everything else routes camera moves through it.
   */
  setViewport(viewport: Viewport): void;
  /** Measured canvas size in CSS px (0×0 until Excalidraw's first measure). */
  getViewportSize(): { width: number; height: number };

  getFrames(): FrameInfo[];
  getFrameInfo(frameId: string): FrameInfo | null;
  getElementInfo(elementId: string): ElementInfo | null;
  /** Bounding box of all live elements, or null for an empty scene. */
  getSceneBounds(): SceneBounds | null;
  getSelectedIds(): string[];

  /** Toggle Excalidraw's view mode (read-only canvas) for presenting. */
  setViewMode(on: boolean): void;
  /**
   * Topmost element at a client (viewport) position, shapes preferred over
   * the frames that spatially contain them. Used for click-to-drill — view
   * mode swallows Excalidraw's own pointer callbacks, so the shell listens
   * on its own container and asks the adapter what was hit.
   */
  elementAtClient(clientX: number, clientY: number): ElementInfo | null;

  /**
   * Create a detail frame for an element and link it via
   * `customData.docent.detail` — one undoable step (drill authoring is intent
   * capture per D14; the overlay-never-writes invariant I2 is untouched).
   */
  createAndLinkDetailFrame(elementId: string): { frameId: string; bounds: SceneBounds };
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
  onSelectionChange?: (selectedIds: string[]) => void;
  menuActions: SceneMenuActions;
}

type DocentData = { detail?: { frameId?: unknown }; order?: unknown };

function docentDataOf(element: ExcalidrawElement): DocentData {
  const data = (element.customData as Record<string, unknown> | undefined)?.docent;
  return typeof data === "object" && data !== null ? (data as DocentData) : {};
}

/**
 * Declared detail link, validated against live frames when `elements` is
 * given: upstream's history deltas don't track customData, so an undone or
 * user-deleted detail frame can leave a dangling link behind — a link whose
 * target frame is gone must read as "no detail".
 */
function detailFrameIdOf(
  element: ExcalidrawElement,
  elements?: readonly ExcalidrawElement[],
): string | null {
  const frameId = docentDataOf(element).detail?.frameId;
  if (typeof frameId !== "string") return null;
  if (
    elements &&
    !elements.some(
      (el) => el.id === frameId && el.type === "frame" && !el.isDeleted,
    )
  ) {
    return null;
  }
  return frameId;
}

function orderOf(element: ExcalidrawElement): number | null {
  const order = docentDataOf(element).order;
  return typeof order === "number" && Number.isFinite(order) ? order : null;
}

function boundsOf(element: ExcalidrawElement): SceneBounds {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

function labelOf(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): string | null {
  if (element.type === "frame") {
    return (element as { name?: string | null }).name ?? null;
  }
  if (element.type === "text") {
    return (element as { text?: string }).text ?? null;
  }
  const boundTextId = element.boundElements?.find((b) => b.type === "text")?.id;
  if (!boundTextId) return null;
  const text = elements.find((el) => el.id === boundTextId && !el.isDeleted);
  return text ? ((text as { text?: string }).text ?? null) : null;
}

function liveElements(api: ExcalidrawImperativeAPI): readonly ExcalidrawElement[] {
  return api.getSceneElements();
}

function toElementInfo(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): ElementInfo {
  return {
    id: element.id,
    type: element.type,
    label: labelOf(element, elements),
    bounds: boundsOf(element),
    frameId: element.frameId ?? null,
    detailFrameId: detailFrameIdOf(element, elements),
  };
}

function toFrameInfo(frame: ExcalidrawElement): FrameInfo {
  return {
    id: frame.id,
    name: (frame as { name?: string | null }).name ?? "",
    order: orderOf(frame),
    bounds: boundsOf(frame),
  };
}

function makeHandle(api: ExcalidrawImperativeAPI): DocentCanvasHandle {
  const frames = () =>
    liveElements(api).filter((el) => el.type === "frame").map(toFrameInfo);

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

    getViewport: () => {
      const s = api.getAppState();
      return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
    },

    setViewport: (viewport) => {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewport.zoom));
      api.updateScene({
        appState: {
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
          zoom: { value: zoom as AppState["zoom"]["value"] },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },

    getViewportSize: () => {
      const s = api.getAppState();
      return { width: s.width, height: s.height };
    },

    getFrames: frames,

    getFrameInfo: (frameId) => {
      const frame = liveElements(api).find(
        (el) => el.id === frameId && el.type === "frame",
      );
      return frame ? toFrameInfo(frame) : null;
    },

    getElementInfo: (elementId) => {
      const elements = liveElements(api);
      const element = elements.find((el) => el.id === elementId);
      return element ? toElementInfo(element, elements) : null;
    },

    getSceneBounds: () => {
      const elements = liveElements(api);
      if (!elements.length) return null;
      const [minX, minY, maxX, maxY] = getCommonBounds(elements);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    getSelectedIds: () => {
      const selected = api.getAppState().selectedElementIds;
      return Object.keys(selected).filter((id) => selected[id]);
    },

    setViewMode: (on) => {
      api.updateScene({
        appState: { viewModeEnabled: on },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },

    elementAtClient: (clientX, clientY) => {
      const s = api.getAppState();
      const { x, y } = viewportCoordsToSceneCoords(
        { clientX, clientY },
        {
          zoom: s.zoom,
          offsetLeft: s.offsetLeft,
          offsetTop: s.offsetTop,
          scrollX: s.scrollX,
          scrollY: s.scrollY,
        },
      );
      const candidates = elementsOverlappingBBox({
        elements: api.getSceneElements(),
        bounds: [x - 1, y - 1, x + 1, y + 1],
        type: "overlap",
      });
      const elements = liveElements(api);
      // Bound label text sits on top of its container — resolve it to the
      // container so a click on "API Gateway" hits the gateway shape.
      const resolveContainer = (el: ExcalidrawElement): ExcalidrawElement => {
        const containerId =
          el.type === "text"
            ? ((el as { containerId?: string | null }).containerId ?? null)
            : null;
        return containerId
          ? (elements.find((e) => e.id === containerId) ?? el)
          : el;
      };
      // Topmost first; dedupe after container resolution.
      const seen = new Set<string>();
      const ranked = [...candidates]
        .reverse()
        .map(resolveContainer)
        .filter((el) => (seen.has(el.id) ? false : (seen.add(el.id), true)));
      const nonFrames = ranked.filter((el) => el.type !== "frame");
      // Detail-bearing elements win over plain ones at the same point (S11).
      const hit =
        nonFrames.find((el) => detailFrameIdOf(el, elements) !== null) ??
        ranked.find((el) => detailFrameIdOf(el, elements) !== null) ??
        nonFrames[0] ??
        ranked[0] ??
        null;
      return hit ? toElementInfo(hit, elements) : null;
    },

    createAndLinkDetailFrame: (elementId) => {
      const all = api.getSceneElementsIncludingDeleted();
      const source = all.find((el) => el.id === elementId && !el.isDeleted);
      if (!source) {
        throw new Error(`Unknown element: ${elementId}`);
      }
      const label = labelOf(source, all) ?? source.type;

      const live = all.filter((el) => !el.isDeleted);
      const [minX, , , maxY] = getCommonBounds(live);
      const FRAME_W = 760;
      const FRAME_H = 460;
      const x = minX;
      const y = maxY + 140;

      const created = convertToExcalidrawElements(
        [
          {
            type: "text",
            id: "starter-note",
            text: `${label} — inner mechanism`,
            x: x + 24,
            y: y + 20,
            fontSize: 16,
            opacity: 60,
          },
          {
            type: "frame",
            children: ["starter-note"],
            name: `${label} — detail`,
          },
        ],
        { regenerateIds: true },
      );
      const frame = created.find((el) => el.type === "frame");
      if (!frame) {
        throw new Error("Failed to construct detail frame");
      }
      const bounds: SceneBounds = { x, y, width: FRAME_W, height: FRAME_H };
      Object.assign(frame, bounds);
      // Drop converter-assigned fractional indices — they'd collide with the
      // existing scene's; Excalidraw reassigns valid ones on insertion.
      for (const el of created) {
        (el as { index?: unknown }).index = undefined;
      }

      const nextElements = [
        ...all.map((el) =>
          el.id === elementId
            ? newElementWith(el, {
                customData: {
                  ...(el.customData ?? {}),
                  docent: { ...docentDataOf(el), detail: { frameId: frame.id } },
                },
              })
            : el,
        ),
        ...created,
      ];
      api.updateScene({
        elements: nextElements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return { frameId: frame.id, bounds };
    },
  };
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

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
const MOD = isMac ? "Cmd" : "Ctrl";

export function ExcalidrawCanvas({
  onReady,
  onDocumentChange,
  onSelectionChange,
  menuActions,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastFingerprintRef = useRef(0);
  const lastSelectionRef = useRef("");

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
    const selected = api.getAppState().selectedElementIds;
    const ids = Object.keys(selected).filter((id) => selected[id]);
    const key = ids.slice().sort().join(" ");
    if (key !== lastSelectionRef.current) {
      lastSelectionRef.current = key;
      onSelectionChange?.(ids);
    }
  }, [onDocumentChange, onSelectionChange]);

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
