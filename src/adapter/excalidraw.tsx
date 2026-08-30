/**
 * Excalidraw adapter — per Constitution B1, this is the ONLY module that may
 * import from `@excalidraw/excalidraw` or read raw element shapes (including
 * `customData`). Everything above it consumes the typed surface below.
 *
 * Docent-written element data lives exclusively under `customData.docent.*`
 * (Decision D15); this module is the only reader/writer of that namespace.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  FONT_FAMILY,
  MainMenu,
  convertToExcalidrawElements,
  elementsOverlappingBBox,
  getCommonBounds,
  hashElementsVersion,
  exportToCanvas,
  loadFromBlob,
  newElementWith,
  restoreElements,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  LibraryItems_anyVersion,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type { LegendRule, Proposal, Scenario, SceneLink, SceneSnapshot } from "./snapshot";
import { parseLegendRules, parseSceneLink, snapshotFromRawElements } from "./snapshot";
import { bindingFocus, dropCollinear, outlinePoint } from "../authoring/route";
import {
  bundledItemIds,
  registerRuntimeSymbols,
  runtimeSymbols,
  symbolEntry,
} from "../authoring/symbols";
import type { SymbolEntry } from "../libraries/catalog";
import { houseTreatment } from "./treatment";
import { buildPersonalEntries, type PersonalItem } from "./personal";

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
  /** Declared narrative (customData.docent.narrative), if any. */
  narrative: string | null;
  bounds: SceneBounds;
}

export interface EdgeGeometry {
  /** Anchor-relative points in scene units, as drawn. */
  points: [number, number][];
  /** Anchor (element x/y) in scene coordinates. */
  x: number;
  y: number;
  /** Excalidraw roundness type (null = sharp corners). */
  rounded: boolean;
  elbowed: boolean;
}

export interface ElementInfo {
  id: string;
  type: string;
  label: string | null;
  bounds: SceneBounds;
  angle: number;
  frameId: string | null;
  /** Excalidraw group membership, innermost first — grouped library icons
   * (e.g. cloud-provider shapes) select as many elements sharing these. */
  groupIds: string[];
  /** Declared detail diagram (customData.docent.detail.frameId), if any. */
  detailFrameId: string | null;
  /**
   * Declared scene link (D95): where this element goes, not what it holds.
   * The adapter always states it; optional so a stand-in reader may not.
   */
  link?: SceneLink | null;
  tags: string[];
  note: string | null;
  /** Every declared intent in order (D41); `note` is the first. */
  intents: string[];
  /** Declared pseudocode/rules (D42). */
  logic: string | null;
  narrative: string | null;
  order: number | null;
  style: {
    strokeColor: string;
    backgroundColor: string;
    strokeStyle: string;
    fillStyle: string;
    strokeWidth: number;
  };
}


/** Typed surface the shell drives the canvas through. */
/**
 * The adapter's write vocabulary (S19, D59, B1): what the Command API's
 * semantic layer asks for once meaning has become geometry and style. Ids
 * are the caller's — assigned before the write, so the answer needs no
 * mapping. One `SceneWrite` lands as ONE undo step.
 */
export interface WriteStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  /** Excalidraw roundness type, or null for sharp. */
  roundness: number | null;
  opacity: number;
  fontFamily: number;
  fontSize: number;
}

/**
 * The meaning a write carries, in the author's terms (S10). The adapter
 * stores it the way the intent panel does (D41: `note` is the first
 * intent, the list appears at two or more) — one writer, one format.
 */
export interface WriteMeaning {
  tags?: string[];
  intents?: string[];
  logic?: string | null;
  narrative?: string | null;
  order?: number | null;
  detailFrameId?: string | null;
  /**
   * The scene this element points at (D95): meaning like the rest, so it
   * travels the one writer. Named sets, null clears, absent keeps.
   */
  link?: SceneLink | null;
}

export interface WriteShape {
  id: string;
  type: "rectangle" | "ellipse" | "diamond";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
  frameId: string | null;
  style: WriteStyle;
  meaning: WriteMeaning | null;
}

export interface WriteText {
  id: string;
  type: "text";
  x: number;
  y: number;
  text: string;
  frameId: string | null;
  style: WriteStyle;
  meaning: WriteMeaning | null;
}

/**
 * A library symbol placed as ONE component (S21, D83). The adapter inserts
 * the item's own elements with fresh ids, drops the caption it shipped
 * with, and adds two things of Docent's own: the **carrier** — an invisible
 * rectangle exactly on the icon's bounds, carrying `id`, the meaning, and
 * the composite declaration — and the **label**, a free text under the icon
 * in the house label font. All of it shares one group, so the reader drags
 * a symbol as one thing and the scene graph reads it as one component (D22).
 */
export interface WriteSymbol {
  /** The carrier's id: the component's stable id, what arrows bind to. */
  id: string;
  /** Catalog symbol id, e.g. `aws/lambda`. */
  symbol: string;
  /** The library file it comes from, and the item's index in it. */
  library: string;
  index: number;
  /** Where the whole library item's top-left lands. */
  x: number;
  y: number;
  /** The icon's absolute bounds — the carrier's box (D83). */
  icon: { x: number; y: number; width: number; height: number };
  label: string;
  /** The label hard-wrapped to the icon's width: the lines to draw (D83). */
  labelLines: string[];
  /** Where the label goes — under the icon, at the caption's own offset. */
  labelBox: { x: number; y: number; width: number; height: number };
  frameId: string | null;
  /** The house dresses the label only; the icon keeps its brand drawing. */
  labelStyle: WriteStyle;
  meaning: WriteMeaning | null;
}

export interface WriteArrow {
  id: string;
  from: string;
  to: string;
  label: string | null;
  /** Turning points in scene coordinates, all outside both ends (D72); absent = straight. */
  via?: [number, number][];
  /** Where the edge meets each end's outline (D75); absent = aim at the centres. */
  ends?: { start: [number, number]; end: [number, number] };
  /** The points carry their own arcs (D78): draw them sharp, not curved. */
  sharp?: boolean;
  frameId: string | null;
  style: WriteStyle;
  startArrowhead: string | null;
  endArrowhead: string | null;
  meaning: WriteMeaning | null;
}

export interface WriteFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  meaning: WriteMeaning | null;
}

export interface WritePatch {
  id: string;
  label?: string | null;
  name?: string;
  frameId?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style?: Partial<WriteStyle>;
  /** Fields named are set (null clears); fields absent are kept. */
  meaning?: WriteMeaning;
  /** An arrow's new turning points (D72); `[]` makes it straight between its ends. */
  via?: [number, number][];
  /** Where the re-routed edge meets each end's outline (D75). */
  ends?: { start: [number, number]; end: [number, number] };
  /** The points carry their own arcs (D78): draw them sharp, not curved. */
  sharp?: boolean;
}

export interface SceneWrite {
  shapes?: WriteShape[];
  /** Library icons placed as components (D83). */
  symbols?: WriteSymbol[];
  texts?: WriteText[];
  frames?: WriteFrame[];
  arrows?: WriteArrow[];
  patches?: WritePatch[];
  /** Element ids to delete; bound labels go with their container. */
  remove?: string[];
  /** Replace the legend in the same step (the carrier is rewritten). */
  legend?: LegendRule[];
  /**
   * The scene's genre (D87) — recorded on the legend's carrier, because a
   * category of diagram is a set of conventions and the legend is where
   * conventions live. Absent leaves what the scene already records.
   */
  genre?: string;
  /** The scene's scenarios (D89), whole and in order, on the same carrier. */
  scenarios?: Scenario[];
  /** The proposal's case (D135), on the same carrier; null clears it. */
  proposal?: Proposal | null;
}

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
  /**
   * The one element a whole-group selection stands for (D83): when every
   * selected element shares an outermost group and one of them carries the
   * composite's meaning — a symbol's carrier, or a declared composite
   * member — that member. Null when the selection is not one composite.
   */
  compositeRepresentative(elementIds: readonly string[]): string | null;
  /** Bounding box of all live elements, or null for an empty scene. */
  getSceneBounds(): SceneBounds | null;
  getSelectedIds(): string[];

  /** Toggle Excalidraw's view mode (read-only canvas) for presenting. */
  setViewMode(on: boolean): void;
  /**
   * Set the canvas theme. Upstream's own "Dark mode" item is the other way
   * in; Settings (D115) needs a typed way to ask, the same door setViewMode
   * is (B1). The chrome hears about it through onThemeChange either way.
   */
  setTheme(theme: "light" | "dark"): void;
  /**
   * Copy a catalog symbol's library item onto the paper at the viewport's
   * centre, selected — the palette's Enter (D123). The PERSON'S insertion:
   * the whole item as the sidebar would give it, no carrier, no treatment
   * (D120's person rule). False when the catalog has no such symbol.
   */
  insertLibraryItem(symbol: string): Promise<boolean>;
  /** Wipe the scene (D128). The caller has already asked and been answered. */
  clearScene(): void;
  /** The paper's colour (D129), read and written where it lives: appState. */
  getCanvasBackground(): string;
  setCanvasBackground(color: string): void;
  /** The person's own named library items as runtime entries (D130). */
  getPersonalSymbols(): readonly SymbolEntry[];
  /**
   * Give a library item its name (D131) — the teaching act, performed
   * through upstream's own update API. The change comes back through
   * onLibraryChange, which re-teaches the catalog. False when the item is
   * gone or the name is empty.
   */
  nameLibraryItem(itemId: string, name: string): Promise<boolean>;
  /**
   * Toggle Excalidraw's library sidebar. Upstream's own trigger button is the
   * only other way in, and the desktop shell hides it in favour of a native
   * menu item — so the shell needs a typed way to ask (B1).
   */
  toggleLibrarySidebar(): void;
  /**
   * CSS-scale the canvas elements about the viewport center (1 clears). The
   * camera engine's fake-zoom sink calls this every animation frame during
   * glides — it must stay compositor-only, which is why it targets the
   * canvas elements (each already its own layer) and never a DOM subtree
   * containing UI chrome.
   */
  setCanvasScale(scale: number): void;
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
   * `placement` positions the frame (callers compute tier-band placement);
   * defaults to below the scene bounds.
   */
  createAndLinkDetailFrame(
    elementId: string,
    placement?: { x: number; y: number },
  ): { frameId: string; bounds: SceneBounds };

  /**
   * Translate frames and their member elements by per-frame deltas — one
   * undoable step. Mechanical write; tier semantics live in scene/tiers.
   */
  translateFrames(
    moves: { frameId: string; dx: number; dy: number; memberIds: string[] }[],
  ): void;

  /** Typed snapshot of the live scene — input to the scene graph/exporters. */
  getSceneSnapshot(): SceneSnapshot;
  /**
   * Author an element's tags, intents, and logic (S10, D41, D42). Null or
   * empty clears a field. Intents are stored compatibly: one intent is
   * written as `note` alone — byte-identical to every file before A8 — and
   * the `intents` list is written only for two or more.
   */
  setElementIntent(
    elementId: string,
    patch: { tags?: string[] | null; intents?: string[] | null; logic?: string | null },
  ): void;
  /**
   * Declare whether a group is ONE component (D22): true collapses it in
   * the scene graph and both exports, false keeps its members separate,
   * null returns the decision to the glyph-signature heuristic. Applies to
   * every element sharing the given elements' groups; one undoable step.
   */
  setGroupComposite(elementIds: string[], value: boolean | null): void;
  /**
   * Declare cross-tier edge refinement (D21): which inner component of the
   * bound endpoint's detail diagram this edge lands on (`to`) / departs
   * from (`from`). Null clears a side; an undoable intent-capture step.
   */
  setEdgeRefine(
    edgeId: string,
    patch: { to?: string | null; from?: string | null },
  ): void;
  /**
   * Point an element at another scene (D95, D97): the panel's own writer,
   * beside the ones intents and refinement use. Null clears the link; one
   * undoable intent-capture step, and nothing else on the element moves.
   */
  setElementLink(elementId: string, link: SceneLink | null): void;
  /** Author a frame's narrative/order (S10). Null clears a field. */
  setFrameIntent(
    frameId: string,
    patch: { narrative?: string | null; order?: number | null },
  ): void;
  /** Declared legend rules (from the legend carrier element). */
  getLegend(): LegendRule[];

  /** Drawn geometry of a linear element (for overlay path parity, D4). */
  getEdgeGeometry(elementId: string): EdgeGeometry | null;
  /** Subscribe to viewport moves (scroll/zoom). Returns unsubscribe. */
  onViewportChange(callback: (viewport: Viewport) => void): () => void;
  /**
   * Replace the legend. Rules live on a locked text element on the canvas —
   * human-readable text, machine-readable `customData.docent.legend` — so
   * the legend travels inside the `.excalidraw` file (D9, B6).
   */
  setLegend(rules: LegendRule[]): Promise<void>;

  /**
   * Apply one write to the scene as one undo step (S19, D61). Shapes get
   * bound labels, arrows are bound to the shapes they join, frames own
   * what lies inside them, and patches touch exactly the fields named.
   * Unknown ids throw before anything changes.
   */
  applyWrite(write: SceneWrite): Promise<void>;
  /** The scene as it is, opaque — what `restoreScene` puts back (D61 Undo). */
  captureScene(): unknown;
  /** Put a captured scene back, as one undo step of its own. */
  restoreScene(captured: unknown): void;

  /**
   * One frame as its own picture (D106): the frame's contents cropped to
   * its box plus a small margin, at a scale chosen for legibility and
   * capped so a big frame is not a big file. Null for an unknown frame.
   * Rides the same `exportToCanvas` surface the review's crops do (B1).
   */
  renderFrameImage(
    frameId: string,
    options?: FrameImageOptions,
  ): Promise<FrameImage | null>;
  /**
   * The diagram's first page (D105): the legend, the unframed Layer-1
   * components, and the tier-1 frames whole. Null for an empty scene.
   */
  renderOverviewImage(options?: FrameImageOptions): Promise<FrameImage | null>;
}

/**
 * Rasterize a serialized `.excalidraw` scene to a PNG data URL (S12
 * portfolio thumbnails). Pure of the live canvas: parses, restores, and
 * exports off-screen. `includeIds` (graph/element ids — the typed surface)
 * limits the render, letting callers scope tiered scenes to Layer 1
 * without ever touching raw shapes; null renders everything.
 */
export async function renderSceneThumbnail(
  sceneJSON: string,
  includeIds: ReadonlySet<string> | null,
  maxDim = 640,
): Promise<string> {
  const parsed = JSON.parse(sceneJSON) as {
    elements?: unknown;
    appState?: { viewBackgroundColor?: unknown };
    files?: unknown;
  };
  const restored = restoreElements(
    (Array.isArray(parsed.elements) ? parsed.elements : []) as never,
    null,
  ).filter((el) => !el.isDeleted && (!includeIds || includeIds.has(el.id)));
  const background =
    typeof parsed.appState?.viewBackgroundColor === "string"
      ? parsed.appState.viewBackgroundColor
      : "#ffffff";
  if (restored.length === 0) {
    const blank = document.createElement("canvas");
    blank.width = 320;
    blank.height = 200;
    const ctx = blank.getContext("2d");
    if (ctx) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, blank.width, blank.height);
    }
    return blank.toDataURL("image/png");
  }
  const canvas = await exportToCanvas({
    elements: restored,
    appState: { viewBackgroundColor: background, exportBackground: true },
    files: (parsed.files ?? null) as never,
    maxWidthOrHeight: maxDim,
  });
  return canvas.toDataURL("image/png");
}

/**
 * Rasterize one catalog symbol's glyph to a small PNG data URL — the icon
 * palette's thumbnails (D124). Off-screen through the same export surface
 * every render uses (B1); transparent ground so the row's own surface shows
 * through. Rendered once, in the drawing's own colours: dark mode applies
 * the SAME invert filter upstream's dark canvas applies (in styles.css), so
 * the thumbnail honestly previews what the paper will show. Cached, because
 * a palette redraws on every keystroke and the drawing never changes. Null
 * when the symbol or its library cannot be had; a thumbnail is decoration,
 * never a gate.
 */
const symbolThumbnails = new Map<string, Promise<string | null>>();

function renderThumbnail(
  key: string,
  drawing: () => Promise<readonly RawLibraryElement[]>,
): Promise<string | null> {
  const cached = symbolThumbnails.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<string | null> => {
    const glyph = glyphOf(await drawing());
    const restored = restoreElements(glyph as never, null);
    const canvas = await exportToCanvas({
      elements: restored,
      appState: { viewBackgroundColor: "transparent", exportBackground: false },
      files: null,
      maxWidthOrHeight: 48,
    });
    return canvas.toDataURL("image/png");
  })().catch(() => null);
  symbolThumbnails.set(key, pending);
  return pending;
}

export function renderSymbolThumbnail(symbol: string): Promise<string | null> {
  return renderThumbnail(symbol, async () => {
    const entry = symbolEntry(symbol);
    if (!entry) throw new Error(`Unknown symbol: ${symbol}`);
    return libraryItem(entry.library, entry.index);
  });
}

/** An unnamed personal item's picture (D131) — what the naming row shows. */
export function renderUnnamedThumbnail(itemId: string): Promise<string | null> {
  return renderThumbnail(`unnamed:${itemId}`, async () => {
    const item = unnamedPersonal.find((it) => it.itemId === itemId);
    if (!item) throw new Error(`Unknown library item: ${itemId}`);
    return item.elements;
  });
}

/** The nameless, for the icon door's naming rows (D131). */
export function unnamedPersonalItems(): readonly { itemId: string }[] {
  return unnamedPersonal.map(({ itemId }) => ({ itemId }));
}

/** A rectangle in scene coordinates — the review's unit of cropping (D48). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle to outline on a crop: added/changed on the after, removed on the before. */
export interface CropMark {
  rect: CropRect;
  kind: "added" | "changed" | "removed";
}

const MARK_COLORS: Record<CropMark["kind"], string> = {
  added: "#2f9e44",
  changed: "#7048e8",
  removed: "#e03131",
};

/**
 * Rasterize one rectangle of a serialized scene (D48): the same `rect`
 * on the before and the after yields two pictures a reviewer can compare
 * at a glance. Goes through Excalidraw's own frame export — a synthetic
 * frame at the rectangle crops exactly there, with every element that
 * overlaps it — so the pictures are the scene at full fidelity, not a
 * re-drawing. `frameId` is the scene frame being reviewed, when there is
 * one: elements inside it are the ones the crop keeps (Excalidraw drops
 * other frames' children from a frame export). Marks are drawn after the
 * export, on the raster, so the scene itself is never touched (I2).
 * Deterministic (I3): same scene, rect, marks and scale → same bytes.
 */
export async function renderSceneCrop(
  sceneJSON: string,
  rect: CropRect,
  frameId: string | null,
  marks: readonly CropMark[],
  options: { scale?: number; ghost?: boolean } = {},
): Promise<string> {
  const parsed = JSON.parse(sceneJSON) as {
    elements?: unknown;
    appState?: { viewBackgroundColor?: unknown };
    files?: unknown;
  };
  const background =
    typeof parsed.appState?.viewBackgroundColor === "string"
      ? parsed.appState.viewBackgroundColor
      : "#ffffff";
  const scale = options.scale ?? Math.min(2, Math.max(0.5, 1200 / Math.max(rect.width, rect.height)));
  const restored = restoreElements(
    (Array.isArray(parsed.elements) ? parsed.elements : []) as never,
    null,
  ).filter((el) => !el.isDeleted);
  // The crop frame: Excalidraw keeps an element in a frame export when it
  // overlaps the frame and is either unframed or that very frame's child,
  // so the synthetic frame borrows the reviewed frame's id.
  const [cropFrame] = restoreElements(
    [
      {
        type: "frame",
        id: frameId ?? "docent-review-crop",
        x: rect.x,
        y: rect.y,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        name: "",
      },
    ] as never,
    null,
  );
  // A Layer-1 crop (no frame) is the space *between* frames — the arrows
  // that cross them and the components they join. Excalidraw would drop
  // every framed element from a frame export, so for that crop the
  // elements are rendered unframed: same drawing, no frame membership.
  const elements = restored
    .filter((el) => el.id !== cropFrame.id)
    .map((el) => (frameId === null && el.frameId ? { ...el, frameId: null } : el));
  const canvas = await exportToCanvas({
    elements,
    appState: { viewBackgroundColor: background, exportBackground: true },
    files: (parsed.files ?? null) as never,
    exportingFrame: cropFrame as never,
    getDimensions: (width: number, height: number) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    }),
  });
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // The renderer leaves its own scale/translate on the context; the
    // marks are placed in canvas pixels, so start from identity.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toCanvas = (r: CropRect) => ({
      x: (r.x - rect.x) * scale,
      y: (r.y - rect.y) * scale,
      width: r.width * scale,
      height: r.height * scale,
    });
    for (const mark of marks) {
      const box = toCanvas(mark.rect);
      const pad = 6 * scale;
      ctx.save();
      ctx.lineWidth = Math.max(2, 2.5 * scale);
      ctx.strokeStyle = MARK_COLORS[mark.kind];
      if (mark.kind === "removed") {
        ctx.setLineDash([8 * scale, 6 * scale]);
        // Ghosting: wash the removed thing out so the eye reads "gone".
        ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
        ctx.fillRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
      }
      ctx.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
      ctx.restore();
    }
    if (options.ghost) {
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }
  return canvas.toDataURL("image/png");
}

/** One rendered raster and the pixels it actually has (D106). */
export interface FrameImage {
  blob: Blob;
  width: number;
  height: number;
}

export interface FrameImageOptions {
  /** Device px per scene px. Omitted, the legibility rule below picks it. */
  scale?: number;
  mime?: "image/jpeg" | "image/png";
  /** JPEG quality, 0..1. Ignored for PNG. */
  quality?: number;
}

/**
 * The raster scale rule (D106 — an image is sized to what it shows):
 * text gets at least MIN_RENDER_SCALE device px per font px, a small
 * frame is lifted until its long side reaches TARGET_RASTER_SIDE so a
 * page is not a postage stamp, and nothing is enlarged past
 * MAX_RENDER_SCALE. MAX_RASTER_SIDE outranks all of it: a huge frame
 * comes back smaller rather than as a huge file.
 */
const MIN_RENDER_SCALE = 2;
const MAX_RENDER_SCALE = 6;
const TARGET_RASTER_SIDE = 2400;
const MAX_RASTER_SIDE = 4000;
/** Scene px of air around a frame's own box on its page. */
const FRAME_RENDER_MARGIN = 24;
/** Same, for the overview — Excalidraw pads it for us there. */
const OVERVIEW_RENDER_PADDING = 40;
/** Print default: JPEG is what the PDF embeds verbatim (D105). */
const RENDER_MIME = "image/jpeg";
const RENDER_QUALITY = 0.85;

function renderScale(width: number, height: number, requested?: number): number {
  const side = Math.max(1, width, height);
  if (requested !== undefined && requested > 0) return requested;
  const legible = Math.max(MIN_RENDER_SCALE, TARGET_RASTER_SIDE / side);
  return Math.max(
    0.05,
    Math.min(legible, MAX_RENDER_SCALE, MAX_RASTER_SIDE / side),
  );
}

/** `getDimensions` that applies a chosen scale — what both renderers pass. */
function scaledDimensions(scale: number) {
  return (width: number, height: number) => ({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  });
}

async function toFrameImage(
  canvas: HTMLCanvasElement,
  options: FrameImageOptions,
): Promise<FrameImage> {
  const mime = options.mime ?? RENDER_MIME;
  const quality = options.quality ?? RENDER_QUALITY;
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mime, quality);
  });
  if (!blob) throw new Error(`Could not rasterize the canvas as ${mime}`);
  return { blob, width: canvas.width, height: canvas.height };
}

/** The texts a render is about to draw, for `loadFontsFor` (see above). */
function textsToRender(
  elements: readonly ExcalidrawElement[],
): { fontFamily: number; text: string }[] {
  const texts: { fontFamily: number; text: string }[] = [];
  for (const el of elements) {
    if (el.type !== "text") continue;
    const text = el as ExcalidrawTextElement;
    if (text.text) texts.push({ fontFamily: text.fontFamily, text: text.text });
  }
  return texts;
}

export interface SceneMenuActions {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onOpenPortfolio: () => void;
  onPresent: () => void;
  onOpenLegend: () => void;
  onExportMermaid: () => void;
  onExportSidecar: () => void;
  onExportPdf: () => void;
  onArrangeTiers: () => void;
  /** The formatter (S20, D73) — re-lays out what is in scope, meaning untouched. */
  onTidy: () => void;
  onToggleDetailMarkers: () => void;
  onConnectAgent: () => void;
  /** Settings (D115) — the person's switches, one dialog. */
  onOpenSettings: () => void;
  /** Present only where the shell hosts plugins (S17) — the web build never does. */
  onOpenPlugins?: () => void;
  /** The agent-can-edit switch (S19, D61), with its current state for the label. */
  onToggleAgentEdit?: () => void;
  agentCanEdit?: boolean;
}


export interface ExcalidrawCanvasProps {
  onReady?: (handle: DocentCanvasHandle) => void;
  /** Fires when document content changes (viewport-only changes are filtered out). */
  onDocumentChange?: (fingerprint: number) => void;
  onSelectionChange?: (selectedIds: string[]) => void;
  /**
   * The canvas's own light/dark, reported when it is first known and whenever
   * the person changes it from upstream's "Dark mode" item (D107). The theme
   * lives in Excalidraw's `appState`, which only the adapter may read (B1) —
   * and it is pushed rather than polled because a theme change moves no
   * elements, so `onDocumentChange` never fires for it.
   */
  onThemeChange?: (theme: "light" | "dark") => void;
  menuActions: SceneMenuActions;
  /**
   * Drop Docent's own entries from the hamburger menu, leaving only
   * Excalidraw's default items. The desktop shell sets this because those
   * actions live in the native menu bar there; the web build never does.
   */
  hideDocentMenuItems?: boolean;
  /**
   * Whether detail-layer markers are currently drawn (D31) — only the
   * toggle's menu label reads it.
   */
  detailMarkersVisible?: boolean;
  /**
   * Frame-scoped semantic export from the right-click menu (D32). Upstream
   * has no context-menu extension API, so when a right-click resolves to an
   * exportable frame the adapter appends one item to the menu's DOM after it
   * mounts — coupling that is safe only because `@excalidraw/excalidraw` is
   * pinned exact (I7/D12); revalidate on any upgrade.
   */
  contextExport?: {
    /** The frame this right-click would export, or null for none. */
    resolveFrameAt: (
      clientX: number,
      clientY: number,
    ) => { id: string; name: string } | null;
    onCopy: (frameSourceId: string) => void;
  };
}

type DocentData = {
  detail?: { frameId?: unknown };
  /** The declared scene link (D95) — parsed, never trusted as written. */
  link?: unknown;
  order?: unknown;
  tags?: unknown;
  note?: unknown;
  intents?: unknown;
  logic?: unknown;
  narrative?: unknown;
  legend?: unknown;
  /** The conventions that ride with the legend on its carrier (D87, D89). */
  genre?: unknown;
  scenarios?: unknown;
};

function docentDataOf(element: ExcalidrawElement): DocentData {
  const data = (element.customData as Record<string, unknown> | undefined)?.docent;
  return typeof data === "object" && data !== null ? (data as DocentData) : {};
}

function tagsOf(element: ExcalidrawElement): string[] {
  const tags = docentDataOf(element).tags;
  return Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string")
    : [];
}

/** The intents list (D41): the written list, else the lone note. */
function intentsOf(docent: DocentData): string[] {
  const listed = Array.isArray(docent.intents)
    ? docent.intents.filter(
        (t): t is string => typeof t === "string" && t.trim() !== "",
      )
    : [];
  if (listed.length) return listed;
  const note = stringField(docent.note);
  return note ? [note] : [];
}

function stringField(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Merge a patch into an element's `customData.docent`, dropping null keys. */
/**
 * The legend as scene elements (D9, D69): a locked title that carries the
 * rules as data, and beneath it one drawn sample per rule with its meaning
 * beside it — a shape in that fill and outline for a fill or shape rule,
 * a short arrow in that stroke for a stroke-only rule. Samples and labels
 * are locked, grouped with the title, and marked `legendSample`, which is
 * what keeps them out of the graph. Returns the element list with the old
 * legend deleted and the new one appended, ready for one updateScene.
 */
// ---------------------------------------------------------------------------
// fonts — a text is measured in the font it will be drawn in
// ---------------------------------------------------------------------------
//
// Excalidraw registers its font faces with `document.fonts` when a scene
// first loads but fetches each family's subsets only for the characters
// the scene already holds, and when a face arrives later it clears its
// caches without re-measuring any text. A text created while its font was
// not loaded keeps the fallback font's width for good and is clipped once
// the real one draws. So: the font is loaded for what is about to be
// written before it is measured, the Latin subsets are asked for at mount,
// and the legend's labels — the one text Docent measures itself — are
// re-measured whenever a font finishes loading.

const FAMILY_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FONT_FAMILY).map(([name, id]) => [id as number, name]),
);
const LATIN_SAMPLE =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" +
  "àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿÀÉÈÊÖÜß–—…‘’“”€£";

const fontFamilyString = (fontFamily: number) => `${FAMILY_NAMES[fontFamily] ?? "Excalifont"}, Segoe UI Emoji`;

/** Load the font faces the given texts need; never throws, never waits past a few seconds. */
async function loadFontsFor(texts: { fontFamily: number; text: string }[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const byFamily = new Map<number, Set<string>>();
  for (const { fontFamily, text } of texts) {
    const chars = byFamily.get(fontFamily) ?? new Set<string>();
    for (const ch of text) chars.add(ch);
    byFamily.set(fontFamily, chars);
  }
  const loads = [...byFamily].map(([family, chars]) =>
    document.fonts.load(`16px ${fontFamilyString(family)}`, [...chars].join("")).catch(() => []),
  );
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

/** Excalidraw's measure of a single-line text, in the font it is drawn in. */
function measureLine(text: string, fontSize: number, fontFamily: number): { width: number; height: number } | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = `${fontSize}px ${fontFamilyString(fontFamily)}`;
  const width = context.measureText(text).width;
  // Excalifont's line height; what the converter uses for these labels.
  return { width, height: fontSize * 1.25 };
}

/**
 * Re-measure the legend's title and labels in the font that is now loaded
 * (they are the one text Docent lays out itself); patch those a loaded
 * font has changed. Not an undo step: nothing the person did.
 */
function repairLegendLabels(api: ExcalidrawImperativeAPI): void {
  const all = api.getSceneElementsIncludingDeleted();
  let changed = false;
  const next = all.map((el) => {
    if (el.isDeleted || el.type !== "text") return el;
    const data = docentDataOf(el) as { legendSample?: unknown; legend?: unknown };
    if (data.legendSample !== true && parseLegendRules(data.legend) === null) return el;
    const text = el as ExcalidrawTextElement;
    if (text.text.includes("\n")) return el;
    const measured = measureLine(text.text, text.fontSize, text.fontFamily);
    if (!measured || Math.abs(measured.width - text.width) < 1) return el;
    changed = true;
    return newElementWith(text, { width: measured.width, height: measured.height });
  });
  if (changed) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
}

/** Ask for the Latin subsets once Excalidraw has registered its faces, then keep the legend honest. */
function watchFonts(api: ExcalidrawImperativeAPI): () => void {
  if (typeof document === "undefined" || !("fonts" in document)) return () => {};
  let stopped = false;
  const onLoaded = () => {
    if (!stopped) repairLegendLabels(api);
  };
  document.fonts.addEventListener("loadingdone", onLoaded);
  const registered = () => [...document.fonts].some((face) => face.family.replace(/"/g, "") === "Excalifont");
  const started = Date.now();
  const preload = () => {
    if (stopped) return;
    if (registered()) {
      void loadFontsFor([{ fontFamily: FONT_FAMILY.Excalifont, text: LATIN_SAMPLE }]).then(onLoaded);
    } else if (Date.now() - started < 10000) {
      setTimeout(preload, 200);
    }
  };
  preload();
  return () => {
    stopped = true;
    document.fonts.removeEventListener("loadingdone", onLoaded);
  };
}

/**
 * The bundled libraries' own elements (S21, D83): a symbol write copies the
 * item's drawing into the scene, and the drawn legend shows it as a sample.
 * The same static assets the library sidebar loads (`public/libraries/`),
 * fetched once per session and kept by library — bundled assets, never a
 * runtime dependency (I7). A failed fetch is not remembered, so the next
 * write tries again.
 */
type RawLibraryElement = Record<string, unknown>;
const libraryElementsCache = new Map<string, Promise<RawLibraryElement[][]>>();

function libraryElements(library: string): Promise<RawLibraryElement[][]> {
  const cached = libraryElementsCache.get(library);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(`/libraries/${library}.excalidrawlib`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as { libraryItems?: unknown; library?: unknown };
    // v2 files carry `{ id, name, elements }`; v1 files carry bare element arrays.
    const items = parsed.libraryItems ?? parsed.library;
    if (!Array.isArray(items)) throw new Error("no library items");
    return items.map((item) =>
      (Array.isArray(item) ? item : ((item as { elements?: unknown }).elements ?? [])) as RawLibraryElement[],
    );
  })();
  libraryElementsCache.set(library, pending);
  pending.catch(() => libraryElementsCache.delete(library));
  return pending;
}

/**
 * The personal shelf (D130): the drawings behind the runtime entries, kept
 * at the same positions `buildPersonalEntries` numbered them. Registered by
 * the mounted canvas whenever the library changes; the thumbnails cached
 * for the old shelf are dropped, because the drawing behind `my/<name>` may
 * be a different drawing now.
 */
let personalDrawings: readonly RawLibraryElement[][] = [];

/** The library as last heard, whole — what a rename maps over (D131). */
let latestLibraryItems: readonly PersonalItem[] = [];

/** The nameless (D131): drawn, unbundled, waiting for their word. */
let unnamedPersonal: readonly { itemId: string; elements: RawLibraryElement[] }[] = [];

function registerPersonalLibrary(items: readonly PersonalItem[]): void {
  latestLibraryItems = items;
  const bundled = bundledItemIds();
  const { entries, drawings } = buildPersonalEntries(items, bundled);
  personalDrawings = drawings as unknown as readonly RawLibraryElement[][];
  registerRuntimeSymbols(entries);
  unnamedPersonal = items
    .filter((item) => !(item.name ?? "").trim() && !bundled.has(item.id) && item.elements.length)
    .map((item) => ({ itemId: item.id, elements: item.elements as RawLibraryElement[] }));
  for (const key of [...symbolThumbnails.keys()]) {
    if (key.startsWith("my/") || key.startsWith("unnamed:")) symbolThumbnails.delete(key);
  }
}

/** The elements of one library item, deep-cloned so the cache stays pristine. */
async function libraryItem(library: string, index: number): Promise<RawLibraryElement[]> {
  // The personal shelf lives in memory, not at a URL (D130).
  const item =
    library === "personal" ? personalDrawings[index] : (await libraryElements(library))[index];
  if (!item?.length) throw new Error(`Unknown library item: ${library}#${index}`);
  return JSON.parse(JSON.stringify(item)) as RawLibraryElement[];
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * A caption is a free text that does NOT sit inside one of the glyph's own
 * shapes — the same rule the scene graph uses to tell an icon's lettering
 * from its name (D22). The caption is retyped to the agent's label (D83),
 * so it is dropped; lettering drawn over the artwork stays.
 */
function isItemCaption(el: RawLibraryElement, item: readonly RawLibraryElement[]): boolean {
  if (el.type !== "text" || (el.containerId ?? null) !== null) return false;
  const pad = 8;
  return !item.some(
    (other) =>
      other !== el &&
      other.type !== "text" &&
      num(el.x) >= num(other.x) - pad &&
      num(el.y) >= num(other.y) - pad &&
      num(el.x) + num(el.width) <= num(other.x) + num(other.width) + pad &&
      num(el.y) + num(el.height) <= num(other.y) + num(other.height) + pad,
  );
}

/** The glyph alone: what the catalog measured as the icon (D81). */
function glyphOf(item: readonly RawLibraryElement[]): RawLibraryElement[] {
  return item.filter((el) => !isItemCaption(el, item));
}

/** The bounds of some raw library elements. */
function rawBounds(els: readonly RawLibraryElement[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...els.map((el) => num(el.x)));
  const y = Math.min(...els.map((el) => num(el.y)));
  return {
    x,
    y,
    width: Math.max(...els.map((el) => num(el.x) + num(el.width))) - x,
    height: Math.max(...els.map((el) => num(el.y) + num(el.height))) - y,
  };
}

/**
 * The icon's bounds as the catalog measured them (D81): the item's drawn
 * shapes, without any text — lettering over the artwork included, since the
 * catalog left it out too. This is the box the carrier must land on exactly.
 */
function iconBounds(item: readonly RawLibraryElement[]): { x: number; y: number; width: number; height: number } {
  const drawn = item.filter((el) => el.type !== "text");
  return rawBounds(drawn.length ? drawn : item);
}

/**
 * Copy a library item's elements into the scene: fresh ids, its own inner
 * groups remapped, and `group` added outermost so the icon, the carrier and
 * the label drag as one; scaled and translated into place; and put through
 * upstream's own restore so a v1 file's legacy fields migrate.
 */
function placeItemElements(
  els: readonly RawLibraryElement[],
  options: { group: string; frameId: string | null; scale: number; dx: number; dy: number; sample?: boolean },
): ExcalidrawElement[] {
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  const fresh = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  for (const el of els) {
    if (typeof el.id === "string") ids.set(el.id, fresh());
    for (const g of (el.groupIds as string[] | undefined) ?? []) if (!groups.has(g)) groups.set(g, fresh());
  }
  const { group, frameId, scale, dx, dy } = options;
  const within = (v: unknown) => (typeof v === "string" ? (ids.get(v) ?? null) : null);
  const mapped = els.map((raw) => {
    const el: RawLibraryElement = { ...raw };
    el.id = ids.get(String(raw.id)) ?? fresh();
    el.groupIds = [...(((raw.groupIds as string[] | undefined) ?? []).map((g) => groups.get(g) ?? g)), group];
    el.frameId = frameId;
    el.x = num(raw.x) * scale + dx;
    el.y = num(raw.y) * scale + dy;
    el.width = num(raw.width) * scale;
    el.height = num(raw.height) * scale;
    if (Array.isArray(raw.points)) {
      el.points = (raw.points as number[][]).map((pt) => pt.map((v) => num(v) * scale));
    }
    if (Array.isArray(raw.lastCommittedPoint)) {
      el.lastCommittedPoint = (raw.lastCommittedPoint as number[]).map((v) => num(v) * scale);
    }
    if (typeof raw.fontSize === "number") el.fontSize = raw.fontSize * scale;
    // Bindings and bound labels only make sense within the copy.
    if (raw.containerId !== undefined) el.containerId = within(raw.containerId);
    if (Array.isArray(raw.boundElements)) {
      el.boundElements = (raw.boundElements as { id?: unknown; type?: unknown }[])
        .map((b) => ({ ...b, id: within(b.id) }))
        .filter((b) => b.id !== null);
    }
    // A v1 file's legacy list of the same thing; restore migrates it.
    if (Array.isArray(raw.boundElementIds)) {
      el.boundElementIds = (raw.boundElementIds as unknown[]).map(within).filter((id) => id !== null);
    }
    for (const side of ["startBinding", "endBinding"] as const) {
      const binding = raw[side] as { elementId?: unknown } | null | undefined;
      el[side] = binding && within(binding.elementId) ? { ...binding, elementId: within(binding.elementId) } : null;
    }
    // Fractional indices and versions are the scene's to assign.
    delete el.index;
    delete el.version;
    delete el.versionNonce;
    delete el.updated;
    if (options.sample) {
      el.locked = true;
      el.customData = { ...((raw.customData as object) ?? {}), docent: { legendSample: true } };
    }
    return el;
  });
  const restored = restoreElements(mapped as never, null);
  for (const el of restored) (el as { index?: unknown }).index = undefined;
  return restored as unknown as ExcalidrawElement[];
}

/** The icon elements each `symbol` legend rule draws its sample from (D84). */
async function symbolSamples(
  rules: readonly LegendRule[],
): Promise<Map<string, RawLibraryElement[]>> {
  const out = new Map<string, RawLibraryElement[]>();
  for (const rule of rules) {
    if (rule.attr !== "symbol" || out.has(rule.value)) continue;
    const at = symbolEntry(rule.value);
    if (!at) continue;
    try {
      // The sample wears what the scene will wear (D120): the legend must
      // show the drawing the treatment produces, not the library's raw one.
      out.set(rule.value, houseTreatment(glyphOf(await libraryItem(at.library, at.index))));
    } catch (err) {
      console.warn(`Failed to load the symbol ${rule.value}`, err);
    }
  }
  return out;
}

function legendWrite(
  all: readonly ExcalidrawElement[],
  rules: LegendRule[],
  samples: ReadonlyMap<string, RawLibraryElement[]> = new Map(),
): { elements: ExcalidrawElement[]; carrier: ExcalidrawElement } {
  const isLegendPart = (el: ExcalidrawElement) =>
    parseLegendRules(docentDataOf(el).legend) !== null ||
    (docentDataOf(el) as { legendSample?: unknown }).legendSample === true;
  const carrier = all.find((el) => !el.isDeleted && parseLegendRules(docentDataOf(el).legend) !== null);
  const previous = all.filter((el) => !el.isDeleted && isLegendPart(el));

  const ROW = 44;
  const SAMPLE_W = 72;
  const SAMPLE_H = 30;
  const LABEL_X = SAMPLE_W + 20;
  const titleH = 26;
  const height = titleH + 10 + rules.length * ROW;

  // Keep the legend's column where it was; a legend sits above the drawing,
  // and one that has grown moves up rather than over the first frame.
  const live = all.filter((el) => !el.isDeleted && !isLegendPart(el));
  let x: number;
  let y: number;
  if (live.length) {
    const [minX, minY] = getCommonBounds(live);
    const above = minY - 40 - height;
    x = carrier ? carrier.x : minX;
    y = carrier ? Math.min(carrier.y, above) : above;
  } else if (carrier) {
    x = carrier.x;
    y = carrier.y;
  } else {
    x = 0;
    y = 0;
  }

  const groupId = `legend-${Math.random().toString(36).slice(2, 10)}`;
  const sample = { legendSample: true };
  // A rule about a symbol is shown as the icon itself, scaled to the sample
  // row (D84): the legend says what its pictures mean by drawing them.
  const drawnSamples: ExcalidrawElement[] = [];
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [
    {
      type: "text",
      text: rules.length ? "Legend" : "Legend (empty)",
      x,
      y,
      fontSize: 18,
      fontFamily: FONT_FAMILY.Excalifont,
      locked: true,
      groupIds: [groupId],
    } as never,
  ];
  rules.forEach((rule, i) => {
    const rowY = y + titleH + 10 + i * ROW;
    const conditions = [{ attr: rule.attr, value: rule.value }, ...(rule.also ?? [])];
    const style: Record<string, unknown> = {
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
    };
    let shape: string | null = null;
    let symbol: string | null = null;
    let strokeOnly = true;
    for (const c of conditions) {
      if (c.attr === "shape") {
        shape = c.value;
        strokeOnly = false;
      } else if (c.attr === "symbol") {
        symbol = c.value;
        strokeOnly = false;
      } else if (c.attr === "strokeWidth") {
        style.strokeWidth = Number(c.value) || 2;
      } else {
        style[c.attr] = c.value;
        if (c.attr === "backgroundColor" || c.attr === "fillStyle") strokeOnly = false;
      }
    }
    const glyph = symbol ? samples.get(symbol) : undefined;
    if (glyph?.length) {
      // The icon, scaled uniformly to the row and centred in the column.
      const box = iconBounds(glyph);
      const scale = Math.min(SAMPLE_H / (box.height || 1), SAMPLE_W / (box.width || 1));
      drawnSamples.push(
        ...placeItemElements(glyph, {
          group: groupId,
          frameId: null,
          scale,
          dx: x + (SAMPLE_W - box.width * scale) / 2 - box.x * scale,
          dy: rowY + (SAMPLE_H - box.height * scale) / 2 - box.y * scale,
          sample: true,
        }),
      );
    } else if (symbol) {
      // The library could not be read: the row still says what it means.
      skeletons.push({
        type: "text",
        text: symbol,
        x: x + 4,
        y: rowY + 6,
        fontSize: 14,
        fontFamily: FONT_FAMILY.Excalifont,
        locked: true,
        groupIds: [groupId],
        customData: { docent: sample },
      } as never);
    } else if (strokeOnly) {
      // A stroke rule is what an arrow is made of: draw the arrow.
      skeletons.push({
        type: "arrow",
        x: x + 4,
        y: rowY + SAMPLE_H / 2,
        points: [
          [0, 0],
          [SAMPLE_W - 8, 0],
        ],
        endArrowhead: "arrow",
        locked: true,
        groupIds: [groupId],
        customData: { docent: sample },
        ...style,
      } as never);
    } else {
      const type = shape === "ellipse" || shape === "diamond" ? shape : "rectangle";
      skeletons.push({
        type,
        x: x + (type === "rectangle" ? 4 : 0),
        y: rowY,
        width: type === "rectangle" ? SAMPLE_W - 8 : SAMPLE_W,
        height: SAMPLE_H,
        roundness: type === "rectangle" ? { type: 3 } : null,
        locked: true,
        groupIds: [groupId],
        customData: { docent: sample },
        ...style,
      } as never);
    }
    skeletons.push({
      type: "text",
      text: `${rule.key}: ${rule.meaning}`,
      x: x + LABEL_X,
      y: rowY + 5,
      fontSize: 16,
      fontFamily: FONT_FAMILY.Excalifont,
      locked: true,
      groupIds: [groupId],
      customData: { docent: sample },
    } as never);
  });
  const made = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  for (const el of made) {
    (el as { index?: unknown }).index = undefined;
  }
  const [title, ...rest] = made;
  // The carrier holds more than the rules (D87, D89): the scene's genre and
  // its scenarios live here too. A legend rewrite replaces the rules and
  // carries everything else across — it owns `legend`, nothing else.
  const nextCarrier = newElementWith(title, {
    customData: {
      ...(carrier?.customData ?? {}),
      docent: { ...(carrier ? docentDataOf(carrier) : {}), legend: rules },
    },
  });
  return {
    elements: [
      ...all.map((el) => (previous.includes(el) ? newElementWith(el, { isDeleted: true }) : el)),
      nextCarrier,
      ...rest,
      ...drawnSamples,
    ],
    carrier: nextCarrier,
  };
}

function withDocentPatch(
  element: ExcalidrawElement,
  patch: Record<string, unknown>,
): ExcalidrawElement {
  const next: Record<string, unknown> = { ...docentDataOf(element) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return newElementWith(element, {
    customData: { ...(element.customData ?? {}), docent: next },
  });
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
  const docent = docentDataOf(element);
  return {
    id: element.id,
    type: element.type,
    label: labelOf(element, elements),
    bounds: boundsOf(element),
    angle: element.angle ?? 0,
    frameId: element.frameId ?? null,
    groupIds: [...(element.groupIds ?? [])],
    detailFrameId: detailFrameIdOf(element, elements),
    link: parseSceneLink(docent.link),
    tags: tagsOf(element),
    note: stringField(docent.note),
    intents: intentsOf(docent),
    logic: stringField(docent.logic),
    narrative: stringField(docent.narrative),
    order: orderOf(element),
    style: {
      strokeColor: element.strokeColor,
      backgroundColor: element.backgroundColor,
      strokeStyle: element.strokeStyle,
      fillStyle: element.fillStyle,
      strokeWidth: element.strokeWidth,
    },
  };
}

function toFrameInfo(frame: ExcalidrawElement): FrameInfo {
  return {
    id: frame.id,
    name: (frame as { name?: string | null }).name ?? "",
    order: orderOf(frame),
    narrative: stringField(docentDataOf(frame).narrative),
    bounds: boundsOf(frame),
  };
}

/**
 * The typed surface over one live Excalidraw API (B1). Exported so the
 * write path can be driven against an API stand-in — what lands in
 * `customData` is a promise the canvas keeps, and it is testable.
 */
export function makeHandle(api: ExcalidrawImperativeAPI): DocentCanvasHandle {
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
        // loadFromBlob threads the CURRENT appState's isLoading through the
        // restore — and a scene loaded at page mount (URL params) can catch
        // it still true from Excalidraw's own init, leaving the "Loading
        // scene…" overlay up forever. Our load is done; say so.
        appState: { ...data.appState, isLoading: false },
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

    setCanvasScale: (scale) => {
      // Both the static and the interactive canvas — they must stay aligned.
      const canvases = document.querySelectorAll<HTMLCanvasElement>(
        "canvas.excalidraw__canvas",
      );
      canvases.forEach((c) => {
        // Persistent will-change keeps each canvas its own compositor layer
        // even while the transform is empty — without it, per-frame scale
        // changes trigger paint instead of pure GPU compositing, and the
        // clear-on-settle churns layers.
        c.style.willChange = "transform";
        if (scale === 1) {
          c.style.transform = "";
        } else {
          c.style.transformOrigin = "50% 50%";
          c.style.transform = `scale(${scale})`;
        }
      });
    },

    getFrames: frames,

    getFrameInfo: (frameId) => {
      const frame = liveElements(api).find(
        (el) => el.id === frameId && el.type === "frame",
      );
      return frame ? toFrameInfo(frame) : null;
    },

    compositeRepresentative: (elementIds) => {
      if (elementIds.length < 2) return null;
      const els = elementIds.map((id) => liveElements(api).find((e) => e.id === id));
      if (els.some((e) => !e)) return null;
      const outer = (e: ExcalidrawElement) => e.groupIds[e.groupIds.length - 1];
      const group = outer(els[0]!);
      if (!group || els.some((e) => outer(e!) !== group)) return null;
      const carrier =
        els.find((e) => (docentDataOf(e!) as { symbol?: unknown }).symbol) ??
        els.find((e) => {
          const composite = (docentDataOf(e!) as { composite?: Record<string, unknown> }).composite;
          return composite?.[group] === true;
        });
      return carrier?.id ?? null;
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

    setTheme: (theme) => {
      // The change flows back out through onThemeChange like any other, so
      // the chrome follows this exactly as it follows upstream's own item.
      api.updateScene({
        appState: { theme },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },

    clearScene: () => {
      api.resetScene();
    },

    getCanvasBackground: () => api.getAppState().viewBackgroundColor,

    setCanvasBackground: (color) => {
      // In appState, where it saves, exports and diffs unchanged (D129) —
      // and into history, the way upstream's own picker records it.
      api.updateScene({
        appState: { viewBackgroundColor: color },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    getPersonalSymbols: () => runtimeSymbols(),

    nameLibraryItem: async (itemId, name) => {
      const trimmed = name.trim();
      if (!trimmed || !latestLibraryItems.some((item) => item.id === itemId)) return false;
      await api.updateLibrary({
        libraryItems: latestLibraryItems.map((item) =>
          item.id === itemId ? { ...item, name: trimmed } : item,
        ) as never,
      });
      return true;
    },

    insertLibraryItem: async (symbol) => {
      const entry = symbolEntry(symbol);
      if (!entry) return false;
      // The WHOLE item, caption included — what the sidebar's own click
      // gives — and untreated: this is the person's insertion (D120, D123).
      const item = await libraryItem(entry.library, entry.index);
      const s = api.getAppState();
      const center = viewportCoordsToSceneCoords(
        { clientX: s.offsetLeft + s.width / 2, clientY: s.offsetTop + s.height / 2 },
        { zoom: s.zoom, offsetLeft: s.offsetLeft, offsetTop: s.offsetTop, scrollX: s.scrollX, scrollY: s.scrollY },
      );
      const bounds = rawBounds(item);
      const group =
        Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      const placed = placeItemElements(item, {
        group,
        frameId: null,
        scale: 1,
        dx: center.x - bounds.x - bounds.width / 2,
        dy: center.y - bounds.y - bounds.height / 2,
      });
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...placed],
        // Selected as one, so the very next drag moves the whole drawing.
        appState: {
          selectedElementIds: Object.fromEntries(placed.map((el) => [el.id, true])),
          selectedGroupIds: { [group]: true },
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return true;
    },

    // "default" is upstream's own sidebar; "library" its library tab. The
    // deferred icon set (D23) still loads on first open — the onChange latch
    // watches app state, not the trigger button.
    toggleLibrarySidebar: () => {
      api.toggleSidebar({ name: "default", tab: "library" });
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
      // Grouped composites (library icons) carry the detail link on one
      // member — a click on any sibling should still find it (S11).
      if (hit && detailFrameIdOf(hit, elements) === null && hit.groupIds?.length) {
        const sibling = elements.find(
          (el) =>
            el.id !== hit.id &&
            el.groupIds?.some((g) => hit.groupIds.includes(g)) &&
            detailFrameIdOf(el, elements) !== null,
        );
        if (sibling) return toElementInfo(sibling, elements);
      }
      return hit ? toElementInfo(hit, elements) : null;
    },

    createAndLinkDetailFrame: (elementId, placement) => {
      const all = api.getSceneElementsIncludingDeleted();
      const source = all.find((el) => el.id === elementId && !el.isDeleted);
      if (!source) {
        throw new Error(`Unknown element: ${elementId}`);
      }
      const label = labelOf(source, all) ?? source.type;

      const live = all.filter((el) => !el.isDeleted);
      const FRAME_W = 760;
      const FRAME_H = 460;
      let x: number;
      let y: number;
      if (placement) {
        x = placement.x;
        y = placement.y;
      } else {
        const [minX, , , maxY] = getCommonBounds(live);
        x = minX;
        y = maxY + 140;
      }

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

    captureScene: () => api.getSceneElementsIncludingDeleted().map((el) => el),

    restoreScene: (captured) => {
      if (!Array.isArray(captured)) throw new Error("Nothing to restore");
      api.updateScene({
        elements: captured as ExcalidrawElement[],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    renderFrameImage: async (frameId, options = {}) => {
      const elements = liveElements(api);
      const frame = elements.find(
        (el) => el.id === frameId && el.type === "frame",
      );
      if (!frame) return null;
      const box = {
        x: frame.x - FRAME_RENDER_MARGIN,
        y: frame.y - FRAME_RENDER_MARGIN,
        width: Math.max(1, frame.width + FRAME_RENDER_MARGIN * 2),
        height: Math.max(1, frame.height + FRAME_RENDER_MARGIN * 2),
      };
      // Same trick as the review's crops: a synthetic frame at the padded
      // box, borrowing the real frame's id so Excalidraw keeps that
      // frame's children (and only those) in the export.
      const [cropFrame] = restoreElements(
        [{ type: "frame", id: frame.id, ...box, name: "" }] as never,
        null,
      );
      const scale = renderScale(box.width, box.height, options.scale);
      const drawn = elements.filter((el) => el.id !== frame.id);
      await loadFontsFor(textsToRender(drawn));
      const canvas = await exportToCanvas({
        elements: drawn,
        appState: {
          viewBackgroundColor: api.getAppState().viewBackgroundColor,
          exportBackground: true,
        },
        files: api.getFiles(),
        exportingFrame: cropFrame as never,
        getDimensions: scaledDimensions(scale),
      });
      return toFrameImage(canvas, options);
    },

    renderOverviewImage: async (options = {}) => {
      const elements = liveElements(api);
      // Tier 1 is every frame nobody drills into (scene/tiers' rule, read
      // here from the raw links because B1 keeps that reading in this
      // module) plus everything living outside a frame — the legend and
      // the unframed Layer-1 components among them (D105).
      const detailed = new Set<string>();
      for (const el of elements) {
        const target = detailFrameIdOf(el, elements);
        if (target) detailed.add(target);
      }
      const tier1Frames = new Set(
        elements
          .filter((el) => el.type === "frame" && !detailed.has(el.id))
          .map((el) => el.id),
      );
      const byId = new Map(elements.map((el) => [el.id, el]));
      const drawn = elements.filter((el) => {
        if (el.type === "frame") return tier1Frames.has(el.id);
        // A bound label rides with whatever contains it.
        const containerId = el.type === "text" ? el.containerId : null;
        const container = containerId ? byId.get(containerId) : undefined;
        const frameId = container ? container.frameId : el.frameId;
        return frameId === null || tier1Frames.has(frameId);
      });
      if (!drawn.length) return null;
      const [minX, minY, maxX, maxY] = getCommonBounds(drawn);
      const scale = renderScale(maxX - minX, maxY - minY, options.scale);
      await loadFontsFor(textsToRender(drawn));
      const canvas = await exportToCanvas({
        elements: drawn,
        appState: {
          viewBackgroundColor: api.getAppState().viewBackgroundColor,
          exportBackground: true,
        },
        files: api.getFiles(),
        exportPadding: OVERVIEW_RENDER_PADDING,
        getDimensions: scaledDimensions(scale),
      });
      return toFrameImage(canvas, options);
    },

    applyWrite: async (write) => {
      // Measured in the font it will be drawn in — see `loadFontsFor`.
      await loadFontsFor([
        ...(write.shapes ?? []).filter((sh) => sh.label).map((sh) => ({ fontFamily: sh.style.fontFamily, text: sh.label! })),
        ...(write.texts ?? []).map((t) => ({ fontFamily: t.style.fontFamily, text: t.text })),
        ...(write.arrows ?? []).filter((a) => a.label).map((a) => ({ fontFamily: a.style.fontFamily, text: a.label! })),
        ...(write.patches ?? []).filter((p) => typeof p.label === "string").map((p) => ({ fontFamily: FONT_FAMILY.Excalifont, text: p.label as string })),
        ...(write.symbols ?? []).map((sym) => ({ fontFamily: sym.labelStyle.fontFamily, text: sym.label })),
        ...(write.legend ?? []).map((r) => ({ fontFamily: FONT_FAMILY.Excalifont, text: `${r.key}: ${r.meaning}` })),
      ]);
      // The drawings a symbol write copies in, and the legend's icon samples
      // (D83, D84) — fetched before anything is built, so a library that
      // cannot be read fails the write whole rather than half-drawing it.
      const symbolDrawings = new Map<string, RawLibraryElement[]>();
      for (const sym of write.symbols ?? []) {
        // Dressed in the house treatment (D120): the write path is the
        // agent's (B4), so a person's own sidebar drags never pass here.
        symbolDrawings.set(sym.id, houseTreatment(glyphOf(await libraryItem(sym.library, sym.index))));
      }
      const legendSamples = write.legend ? await symbolSamples(write.legend) : new Map();
      const all = api.getSceneElementsIncludingDeleted();
      const live = new Map(all.filter((el) => !el.isDeleted).map((el) => [el.id, el]));
      const known = new Set<string>(live.keys());
      for (const shape of write.shapes ?? []) known.add(shape.id);
      for (const sym of write.symbols ?? []) known.add(sym.id);
      for (const text of write.texts ?? []) known.add(text.id);
      for (const frame of write.frames ?? []) known.add(frame.id);
      const need = (id: string, what: string) => {
        if (!known.has(id)) throw new Error(`Unknown ${what}: ${id}`);
      };
      for (const arrow of write.arrows ?? []) {
        need(arrow.from, "arrow source");
        need(arrow.to, "arrow target");
      }
      for (const patch of write.patches ?? []) need(patch.id, "element");
      for (const id of write.remove ?? []) need(id, "element");

      const styleProps = (style: WriteStyle) => ({
        strokeColor: style.strokeColor,
        backgroundColor: style.backgroundColor,
        fillStyle: style.fillStyle as "solid" | "hachure" | "cross-hatch" | "zigzag",
        strokeWidth: style.strokeWidth,
        strokeStyle: style.strokeStyle as "solid" | "dashed" | "dotted",
        roughness: style.roughness,
        roundness: style.roundness === null ? null : { type: style.roundness },
        opacity: style.opacity,
      });
      // The stored form of meaning (D41): what setElementIntent writes.
      const storedMeaning = (meaning: WriteMeaning | null | undefined, base: DocentData = {}) => {
        const next: Record<string, unknown> = { ...base };
        const set = (key: string, value: unknown) => {
          if (value === null || value === undefined) delete next[key];
          else next[key] = value;
        };
        if (!meaning) return next;
        if (meaning.tags !== undefined) set("tags", meaning.tags.length ? meaning.tags : null);
        if (meaning.intents !== undefined) {
          set("note", meaning.intents[0] || null);
          set("intents", meaning.intents.length > 1 ? meaning.intents : null);
        }
        if (meaning.logic !== undefined) set("logic", meaning.logic || null);
        if (meaning.narrative !== undefined) set("narrative", meaning.narrative || null);
        if (meaning.order !== undefined) set("order", meaning.order);
        if (meaning.detailFrameId !== undefined) {
          set("detail", meaning.detailFrameId ? { frameId: meaning.detailFrameId } : null);
        }
        // The scene link (D95), stored whole: a patch that names it sets or
        // clears it, and one that says nothing about it leaves it alone.
        if (meaning.link !== undefined) set("link", meaning.link);
        return next;
      };
      const docentData = (meaning: WriteMeaning | null) => {
        const stored = storedMeaning(meaning);
        return Object.keys(stored).length ? { customData: { docent: stored } } : {};
      };

      // New shapes, texts, and frames come from the skeleton converter —
      // the upstream-sanctioned way to make elements with bound labels.
      const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
      for (const shape of write.shapes ?? []) {
        skeletons.push({
          type: shape.type,
          id: shape.id,
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
          frameId: shape.frameId,
          ...styleProps(shape.style),
          ...docentData(shape.meaning),
          ...(shape.label
            ? {
                label: {
                  text: shape.label,
                  fontSize: shape.style.fontSize,
                  fontFamily: shape.style.fontFamily as never,
                  textAlign: "center",
                  verticalAlign: "middle",
                },
              }
            : {}),
        } as never);
      }
      // A symbol is the library's own drawing plus two things of Docent's
      // (D83): the CARRIER — invisible, exactly on the icon's bounds, holding
      // the component's id and meaning and declaring the group composite
      // (D22) — and the LABEL, a free text under the icon in the house font.
      // The icon's own elements come from the library file further down; the
      // skeleton converter only makes these two.
      const symbolGroups = new Map<string, string>();
      for (const symbol of write.symbols ?? []) {
        const group = `symbol-${symbol.id}`;
        symbolGroups.set(symbol.id, group);
        skeletons.push({
          type: "rectangle",
          id: symbol.id,
          x: symbol.icon.x,
          y: symbol.icon.y,
          width: symbol.icon.width,
          height: symbol.icon.height,
          frameId: symbol.frameId,
          groupIds: [group],
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roughness: 0,
          roundness: null,
          opacity: 100,
          customData: {
            docent: {
              ...storedMeaning(symbol.meaning),
              symbol: symbol.symbol,
              composite: { [group]: true },
            },
          },
        } as never);
        skeletons.push({
          type: "text",
          id: `${symbol.id}-label`,
          x: symbol.labelBox.x,
          y: symbol.labelBox.y,
          text: symbol.labelLines.join("\n"),
          fontSize: symbol.labelStyle.fontSize,
          fontFamily: symbol.labelStyle.fontFamily,
          strokeColor: symbol.labelStyle.strokeColor,
          opacity: symbol.labelStyle.opacity,
          textAlign: "center",
          verticalAlign: "top",
          frameId: symbol.frameId,
          groupIds: [group],
        } as never);
      }
      for (const text of write.texts ?? []) {
        skeletons.push({
          type: "text",
          id: text.id,
          x: text.x,
          y: text.y,
          text: text.text,
          fontSize: text.style.fontSize,
          fontFamily: text.style.fontFamily,
          strokeColor: text.style.strokeColor,
          opacity: text.style.opacity,
          frameId: text.frameId,
          ...docentData(text.meaning),
        } as never);
      }
      for (const frame of write.frames ?? []) {
        // The converter sizes a frame to its children and dereferences the
        // list unconditionally; the bounds are overridden below either way.
        const children = [
          ...(write.shapes ?? []).filter((sh) => sh.frameId === frame.id).map((sh) => sh.id),
          ...(write.symbols ?? []).filter((sy) => sy.frameId === frame.id).flatMap((sy) => [sy.id, `${sy.id}-label`]),
          ...(write.texts ?? []).filter((t) => t.frameId === frame.id).map((t) => t.id),
        ];
        skeletons.push({
          type: "frame",
          id: frame.id,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          children,
          ...docentData(frame.meaning),
        } as never);
      }
      const created = skeletons.length
        ? convertToExcalidrawElements(skeletons, { regenerateIds: false })
        : [];
      // A frame skeleton without children keeps the bounds it was given.
      for (const frame of write.frames ?? []) {
        const el = created.find((c) => c.id === frame.id);
        if (el) Object.assign(el, { x: frame.x, y: frame.y, width: frame.width, height: frame.height });
      }
      // Converter-assigned fractional indices would collide with the scene's.
      for (const el of created) {
        (el as { index?: unknown }).index = undefined;
      }
      // The converter measures the label; centre what it measured under the
      // icon, where the library put the caption it replaces (D83). The
      // library's own drawing is copied in at the icon's bounds — `x`/`y`
      // say where the whole item lands, `icon` is what the carrier holds.
      const symbolElements: ExcalidrawElement[] = [];
      for (const symbol of write.symbols ?? []) {
        const label = created.find((el) => el.id === `${symbol.id}-label`);
        if (label) {
          Object.assign(label, { x: symbol.icon.x + symbol.icon.width / 2 - label.width / 2 });
        }
        const glyph = symbolDrawings.get(symbol.id)!;
        const box = iconBounds(glyph);
        symbolElements.push(
          ...placeItemElements(glyph, {
            group: symbolGroups.get(symbol.id)!,
            frameId: symbol.frameId,
            scale: 1,
            dx: symbol.icon.x - box.x,
            dy: symbol.icon.y - box.y,
          }),
        );
      }
      // Bound labels inherit their container's frame.
      const createdById = new Map(created.map((el) => [el.id, el]));
      for (const el of created) {
        if (el.type === "text" && el.containerId) {
          const container = createdById.get(el.containerId);
          if (container && container.frameId !== el.frameId) {
            Object.assign(el, { frameId: container.frameId });
          }
        }
      }

      // Arrows: straight, from border to border of what they join, and
      // BOUND on both ends so the graph reads them as edges and they follow
      // their shapes when the author moves them.
      const patchOf = new Map((write.patches ?? []).map((p) => [p.id, p]));
      // A box where it will be once the write lands: a patch that moves it counts.
      const boxOf = (id: string): SceneBounds & { type: string } => {
        const el = createdById.get(id) ?? live.get(id);
        if (!el) throw new Error(`Unknown element: ${id}`);
        const moved = patchOf.get(id);
        return { x: moved?.x ?? el.x, y: moved?.y ?? el.y, width: moved?.width ?? el.width, height: moved?.height ?? el.height, type: el.type };
      };
      // Where the centre line leaves the shape's own outline — a rectangle's
      // side, an ellipse's curve, a diamond's edge — so the arrow meets the
      // drawing, not its bounding box. One rule, shared with the authoring
      // layer, so the ports it picks (D75) land exactly where this draws.
      const edgePoint = (box: SceneBounds & { type: string }, towards: { x: number; y: number }) => {
        const [x, y] = outlinePoint(box, box.type, [towards.x, towards.y]);
        return { x, y };
      };
      const GAP = 6;
      // The line of an arrow: from one outline to the other, through its
      // turning points (D72), each end backed off by the binding gap. With
      // `ends` the outline points are given — the ports D75 spread along
      // each side — instead of being found towards the other centre.
      const lineOf = (
        a: SceneBounds & { type: string },
        b: SceneBounds & { type: string },
        via: readonly [number, number][],
        ends?: { start: [number, number]; end: [number, number] },
      ) => {
        const centerB = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        const centerA = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
        const first = via.length ? { x: via[0][0], y: via[0][1] } : centerB;
        const last = via.length ? { x: via[via.length - 1][0], y: via[via.length - 1][1] } : centerA;
        const start = ends ? { x: ends.start[0], y: ends.start[1] } : edgePoint(a, first);
        const end = ends ? { x: ends.end[0], y: ends.end[1] } : edgePoint(b, last);
        const towards = via.length ? first : end;
        const from = via.length ? last : start;
        const l1 = Math.hypot(towards.x - start.x, towards.y - start.y) || 1;
        const l2 = Math.hypot(end.x - from.x, end.y - from.y) || 1;
        const pts: [number, number][] = [
          [start.x + ((towards.x - start.x) / l1) * GAP, start.y + ((towards.y - start.y) / l1) * GAP],
          ...via,
          [end.x - ((end.x - from.x) / l2) * GAP, end.y - ((end.y - from.y) / l2) * GAP],
        ];
        // A turning point that does not turn is dropped — but the two points
        // a softened corner leaves either side of a bend do turn (D75), so
        // the tolerance is the authoring layer's, not a bare epsilon.
        const kept = dropCollinear(pts);
        // Where the arrow meets each shape decides its binding focus, so
        // Excalidraw keeps it at its port when the author moves the shape.
        const startFocus = kept.length > 1 ? bindingFocus(a, a.type, kept[0], kept[1]) : 0;
        const endFocus = kept.length > 1 ? bindingFocus(b, b.type, kept[kept.length - 1], kept[kept.length - 2]) : 0;
        // The binding gap is how far the drawn end sits beyond the shape's
        // outline — the constant for an ordinary port, more where the route
        // starts past a symbol's caption (D83): Excalidraw re-derives the
        // endpoint from outline + gap when the shape is dragged, and the
        // words must stay clear then too.
        const gapAt = (box: SceneBounds & { type: string }, at: [number, number]) => {
          const [hx, hy] = outlinePoint(box, box.type, at);
          return Math.max(GAP, Math.hypot(at[0] - hx, at[1] - hy));
        };
        const startGap = kept.length > 1 ? gapAt(a, kept[0]) : GAP;
        const endGap = kept.length > 1 ? gapAt(b, kept[kept.length - 1]) : GAP;
        const [ox, oy] = kept[0];
        const points = kept.map(([px, py]): [number, number] => [px - ox, py - oy]);
        const xs = points.map((pt) => pt[0]);
        const ys = points.map((pt) => pt[1]);
        return { x: ox, y: oy, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), startFocus, endFocus, startGap, endGap };
      };
      const arrowElements: ExcalidrawElement[] = [];
      const boundTo = new Map<string, { id: string; type: "arrow" }[]>();
      for (const arrow of write.arrows ?? []) {
        const line = lineOf(boxOf(arrow.from), boxOf(arrow.to), arrow.via ?? [], arrow.ends);
        const [made] = convertToExcalidrawElements(
          [
            {
              type: "arrow",
              id: arrow.id,
              x: line.x,
              y: line.y,
              points: line.points,
              frameId: arrow.frameId,
              ...styleProps(arrow.style),
              // A routed edge carries an explicit arc at every turn (D78):
              // it is a sharp polyline, so what is drawn is exactly the
              // route. An edge with no turning points keeps the house curve.
              ...(arrow.sharp ? { roundness: null } : {}),
              startArrowhead: arrow.startArrowhead,
              endArrowhead: arrow.endArrowhead,
              ...docentData(arrow.meaning),
              ...(arrow.label
                ? { label: { text: arrow.label, fontSize: Math.max(12, arrow.style.fontSize - 2), fontFamily: arrow.style.fontFamily } }
                : {}),
            } as never,
          ],
          { regenerateIds: false },
        ).reduce<ExcalidrawElement[][]>((acc, el) => {
          acc[0].push(el);
          return acc;
        }, [[]]);
        for (const el of made) {
          (el as { index?: unknown }).index = undefined;
          if (el.type === "text") Object.assign(el, { frameId: arrow.frameId });
        }
        const drawn = made.find((el) => el.id === arrow.id);
        if (!drawn) throw new Error("Failed to construct arrow");
        Object.assign(drawn, {
          startBinding: { elementId: arrow.from, focus: line.startFocus, gap: line.startGap },
          endBinding: { elementId: arrow.to, focus: line.endFocus, gap: line.endGap },
        });
        arrowElements.push(...made);
        for (const endId of [arrow.from, arrow.to]) {
          const list = boundTo.get(endId) ?? [];
          list.push({ id: arrow.id, type: "arrow" });
          boundTo.set(endId, list);
        }
      }

      // A label follows its container's centre (a bound text keeps its own
      // coordinates; Excalidraw does not re-centre it on updateScene), so a
      // container that was resized carries its label along too (D74).
      const shifted = new Map<string, { dx: number; dy: number }>();
      for (const p of write.patches ?? []) {
        const el = live.get(p.id);
        if (!el || el.type === "arrow") continue;
        const dx = (p.x ?? el.x) + (p.width ?? el.width) / 2 - (el.x + el.width / 2);
        const dy = (p.y ?? el.y) + (p.height ?? el.height) / 2 - (el.y + el.height / 2);
        if (!dx && !dy) continue;
        for (const b of el.boundElements ?? []) if (b.type === "text") shifted.set(b.id, { dx, dy });
      }
      // A symbol component moves as one (D83): a patch on its carrier — the
      // invisible rectangle on the icon's bounds — carries the icon's own
      // elements and the label with it, by the same delta.
      const groupShift = new Map<string, { dx: number; dy: number }>();
      for (const p of write.patches ?? []) {
        if (p.x === undefined && p.y === undefined) continue;
        const el = live.get(p.id);
        if (!el || !(docentDataOf(el) as { symbol?: unknown }).symbol) continue;
        const group = el.groupIds[el.groupIds.length - 1];
        if (group) groupShift.set(group, { dx: (p.x ?? el.x) - el.x, dy: (p.y ?? el.y) - el.y });
      }
      // Removals take bound labels along; patches touch what they name.
      const removing = new Set(write.remove ?? []);
      for (const el of all) {
        if (el.type === "text" && el.containerId && removing.has(el.containerId)) removing.add(el.id);
      }
      const patches = new Map((write.patches ?? []).map((p) => [p.id, p]));

      const next: ExcalidrawElement[] = [];
      for (const el of all) {
        if (removing.has(el.id)) {
          next.push(newElementWith(el, { isDeleted: true }));
          continue;
        }
        let out = el;
        const bound = boundTo.get(el.id);
        if (bound) {
          out = newElementWith(out, {
            boundElements: [...(out.boundElements ?? []), ...bound],
          });
        }
        // An arrow losing an end is unbound from it rather than left
        // pointing at a ghost.
        if (out.type === "arrow") {
          const sb = out.startBinding?.elementId;
          const eb = out.endBinding?.elementId;
          if ((sb && removing.has(sb)) || (eb && removing.has(eb))) {
            out = newElementWith(out, {
              startBinding: sb && removing.has(sb) ? null : out.startBinding,
              endBinding: eb && removing.has(eb) ? null : out.endBinding,
            });
          }
        }
        if (out.boundElements?.some((b) => removing.has(b.id))) {
          out = newElementWith(out, {
            boundElements: out.boundElements.filter((b) => !removing.has(b.id)),
          });
        }
        const shift = shifted.get(el.id);
        if (shift) out = newElementWith(out, { x: out.x + shift.dx, y: out.y + shift.dy });
        // The rest of a moved symbol's group; the carrier itself is patched.
        const group = el.groupIds[el.groupIds.length - 1];
        const carried = group && !patches.has(el.id) ? groupShift.get(group) : undefined;
        if (carried) out = newElementWith(out, { x: out.x + carried.dx, y: out.y + carried.dy });
        const patch = patches.get(el.id);
        if (patch) {
          const fields: Record<string, unknown> = {};
          if (patch.frameId !== undefined) fields.frameId = patch.frameId;
          if (patch.x !== undefined) fields.x = patch.x;
          if (patch.y !== undefined) fields.y = patch.y;
          if (patch.width !== undefined) fields.width = patch.width;
          if (patch.height !== undefined) fields.height = patch.height;
          if (patch.name !== undefined && out.type === "frame") fields.name = patch.name;
          // A re-routed arrow is redrawn between its ends' final places.
          if (patch.via !== undefined && out.type === "arrow" && out.startBinding && out.endBinding) {
            const a = createdById.get(out.startBinding.elementId) ?? live.get(out.startBinding.elementId);
            const b = createdById.get(out.endBinding.elementId) ?? live.get(out.endBinding.elementId);
            if (a && b) {
              const line = lineOf(boxOf(a.id), boxOf(b.id), patch.via, patch.ends);
              fields.x = line.x;
              fields.y = line.y;
              fields.points = line.points;
              fields.width = line.width;
              fields.height = line.height;
              // Turning points mean the edge carries its own arcs (D78) and
              // is drawn sharp; a re-routed edge that came out straight gets
              // the house curvature back.
              fields.roundness = (patch.sharp ?? patch.via.length > 0) ? null : (out.roundness ?? { type: 2 });
              // The re-routed edge keeps its new ports when its shapes move.
              fields.startBinding = { ...out.startBinding, focus: line.startFocus };
              fields.endBinding = { ...out.endBinding, focus: line.endFocus };
            }
          }
          if (patch.style) {
            const st = patch.style;
            if (st.strokeColor !== undefined) fields.strokeColor = st.strokeColor;
            if (st.backgroundColor !== undefined) fields.backgroundColor = st.backgroundColor;
            if (st.fillStyle !== undefined) fields.fillStyle = st.fillStyle;
            if (st.strokeWidth !== undefined) fields.strokeWidth = st.strokeWidth;
            if (st.strokeStyle !== undefined) fields.strokeStyle = st.strokeStyle;
            if (st.roughness !== undefined) fields.roughness = st.roughness;
            if (st.roundness !== undefined) fields.roundness = st.roundness === null ? null : { type: st.roundness };
            if (st.opacity !== undefined) fields.opacity = st.opacity;
          }
          if (patch.meaning !== undefined) {
            fields.customData = {
              ...(out.customData ?? {}),
              docent: storedMeaning(patch.meaning, docentDataOf(out)),
            };
          }
          if (Object.keys(fields).length) out = newElementWith(out, fields as never);
          // A bound label follows its container's frame.
          if (patch.frameId !== undefined) {
            for (const b of out.boundElements ?? []) {
              if (b.type === "text") patches.set(b.id, { id: b.id, frameId: patch.frameId });
            }
          }
        }
        next.push(out);
      }
      // Label patches: the bound text's content changes in place (and a
      // container without one gains nothing here — a label needs the
      // converter, so the semantic layer recreates such a shape).
      for (let i = 0; i < next.length; i++) {
        const el = next[i];
        if (el.type !== "text" || !el.containerId) continue;
        const patch = patches.get(el.containerId);
        if (patch && typeof patch.label === "string") {
          next[i] = newElementWith(el, { text: patch.label, originalText: patch.label } as never);
        }
      }
      // Patches that arrived through the container loop above (label frame).
      for (let i = 0; i < next.length; i++) {
        const el = next[i];
        const late = patches.get(el.id);
        if (late && late.frameId !== undefined && el.frameId !== late.frameId && el.type === "text") {
          next[i] = newElementWith(el, { frameId: late.frameId });
        }
      }

      // A shape made in this write learns of the arrows bound to it, as an
      // existing one did above — it is from the shape's side that Excalidraw
      // carries an arrow along when the shape is moved.
      const createdBound = created.map((el) => {
        const bound = boundTo.get(el.id);
        return bound ? newElementWith(el, { boundElements: [...(el.boundElements ?? []), ...bound] }) : el;
      });
      let elements: ExcalidrawElement[] = [...next, ...createdBound, ...symbolElements, ...arrowElements];
      if (write.legend) elements = legendWrite(elements, write.legend, legendSamples).elements;
      // The genre and the scenarios ride to the same carrier the rules do
      // (D87, D89), merged into what it already holds. A write may record
      // them without touching the legend — and a scene that has no legend
      // yet gets the empty one, which is what marks an element as carrier.
      if (write.genre !== undefined || write.scenarios !== undefined || write.proposal !== undefined) {
        let carrier = elements.find(
          (el) => !el.isDeleted && parseLegendRules(docentDataOf(el).legend) !== null,
        );
        if (!carrier) {
          const made = legendWrite(elements, [], legendSamples);
          elements = made.elements;
          carrier = made.carrier;
        }
        const recorded = carrier;
        elements = elements.map((el) =>
          el === recorded
            ? withDocentPatch(el, {
                ...(write.genre !== undefined ? { genre: write.genre } : {}),
                ...(write.scenarios !== undefined ? { scenarios: write.scenarios } : {}),
                ...(write.proposal !== undefined ? { proposal: write.proposal } : {}),
              })
            : el,
        );
      }
      api.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    getSceneSnapshot: () =>
      snapshotFromRawElements(api.getSceneElementsIncludingDeleted()),

    setElementIntent: (elementId, patch) => {
      const all = api.getSceneElementsIncludingDeleted();
      if (!all.some((el) => el.id === elementId && !el.isDeleted)) {
        throw new Error(`Unknown element: ${elementId}`);
      }
      api.updateScene({
        elements: all.map((el) =>
          el.id === elementId
            ? withDocentPatch(el, {
                tags: patch.tags && patch.tags.length ? patch.tags : null,
                // D41: `note` is always the first intent; the list only
                // appears at two or more, so single-intent files stay as
                // they have always been written.
                note: patch.intents?.[0] || null,
                intents:
                  patch.intents && patch.intents.length > 1 ? patch.intents : null,
                logic: patch.logic || null,
              })
            : el,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    setGroupComposite: (elementIds, value) => {
      const all = api.getSceneElementsIncludingDeleted();
      const selected = all.filter(
        (el) => elementIds.includes(el.id) && !el.isDeleted,
      );
      // The group the author acted on: the outermost one every selected
      // element shares (groupIds run innermost-first).
      const target = [...(selected[0]?.groupIds ?? [])]
        .reverse()
        .find((g) => selected.every((el) => el.groupIds?.includes(g)));
      if (!target) throw new Error("Selection is not one group");
      api.updateScene({
        elements: all.map((el) => {
          if (el.isDeleted || !el.groupIds?.includes(target)) return el;
          const flags = {
            ...((docentDataOf(el) as { composite?: Record<string, boolean> })
              .composite ?? {}),
          };
          if (value === null) delete flags[target];
          else flags[target] = value;
          return withDocentPatch(el, {
            composite: Object.keys(flags).length ? flags : null,
          });
        }),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    setEdgeRefine: (edgeId, patch) => {
      const all = api.getSceneElementsIncludingDeleted();
      const edge = all.find((el) => el.id === edgeId && !el.isDeleted);
      if (!edge || (edge.type !== "arrow" && edge.type !== "line")) {
        throw new Error(`Unknown edge: ${edgeId}`);
      }
      const current =
        (docentDataOf(edge) as { refine?: { to?: string; from?: string } })
          .refine ?? {};
      const to = patch.to === undefined ? current.to : patch.to;
      const from = patch.from === undefined ? current.from : patch.from;
      const next: Record<string, string> = {};
      if (to) next.to = to;
      if (from) next.from = from;
      api.updateScene({
        elements: all.map((el) =>
          el.id === edgeId
            ? withDocentPatch(el, {
                refine: Object.keys(next).length ? next : null,
              })
            : el,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    setElementLink: (elementId, link) => {
      const all = api.getSceneElementsIncludingDeleted();
      if (!all.some((el) => el.id === elementId && !el.isDeleted)) {
        throw new Error(`Unknown element: ${elementId}`);
      }
      // Parsed on the way in, so a half-target never lands in the file (I5).
      const stored = link === null ? null : parseSceneLink(link);
      api.updateScene({
        elements: all.map((el) =>
          el.id === elementId ? withDocentPatch(el, { link: stored }) : el,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    setFrameIntent: (frameId, patch) => {
      const all = api.getSceneElementsIncludingDeleted();
      if (
        !all.some((el) => el.id === frameId && el.type === "frame" && !el.isDeleted)
      ) {
        throw new Error(`Unknown frame: ${frameId}`);
      }
      api.updateScene({
        elements: all.map((el) =>
          el.id === frameId
            ? withDocentPatch(el, {
                narrative: patch.narrative || null,
                order: patch.order ?? null,
              })
            : el,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    getLegend: () => {
      const carrier = liveElements(api).find(
        (el) => parseLegendRules(docentDataOf(el).legend) !== null,
      );
      return carrier
        ? (parseLegendRules(docentDataOf(carrier).legend) ?? [])
        : [];
    },

    setLegend: async (rules) => {
      await loadFontsFor(rules.map((r) => ({ fontFamily: FONT_FAMILY.Excalifont, text: `${r.key}: ${r.meaning}` })));
      const all = api.getSceneElementsIncludingDeleted();
      const { elements } = legendWrite(all, rules, await symbolSamples(rules));
      api.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    translateFrames: (moves) => {
      if (!moves.length) return;
      const byFrame = new Map(moves.map((m) => [m.frameId, m]));
      const byMember = new Map<string, { dx: number; dy: number }>();
      for (const move of moves) {
        for (const id of move.memberIds) byMember.set(id, move);
      }
      const all = api.getSceneElementsIncludingDeleted();
      api.updateScene({
        elements: all.map((el) => {
          const move = byFrame.get(el.id) ?? byMember.get(el.id);
          return move
            ? newElementWith(el, { x: el.x + move.dx, y: el.y + move.dy })
            : el;
        }),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },

    getEdgeGeometry: (elementId) => {
      const el = liveElements(api).find((e) => e.id === elementId);
      if (!el || (el.type !== "arrow" && el.type !== "line")) return null;
      const linear = el as ExcalidrawElement & {
        points?: readonly (readonly number[])[];
        elbowed?: boolean;
      };
      const points = (linear.points ?? []).map(
        (p) => [p[0], p[1]] as [number, number],
      );
      if (points.length < 2) return null;
      return {
        points,
        x: el.x,
        y: el.y,
        rounded: el.roundness !== null && el.roundness !== undefined,
        elbowed: linear.elbowed === true,
      };
    },

    onViewportChange: (callback) =>
      api.onScrollChange((scrollX, scrollY, zoom) =>
        callback({ scrollX, scrollY, zoom: zoom.value }),
      ),
  };
}

/**
 * Right after mount Excalidraw hasn't measured its container yet
 * (appState.width/height are 0), and a fit-to-content computed against a
 * zero-sized viewport collapses zoom to the minimum. Wait, bounded, until
 * the canvas reports a real size. The bound is a clock, not a frame
 * count: on a hidden tab rAF never fires — an agent driving a
 * backgrounded canvas must get its answer, not a wedge — so each wait
 * races a timer and the whole loop gives up after a second.
 */
async function waitForCanvasSize(api: ExcalidrawImperativeAPI): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < 1000) {
    const { width, height } = api.getAppState();
    if (width > 0 && height > 0) return;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 50);
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }
}

interface BundledLibrary {
  url: string;
  /**
   * Eager libraries are fetched at canvas mount; the rest wait until the user
   * first opens the library sidebar. Startup must not pay for shapes nobody
   * has asked to see — the AWS set is ~3.9 MB, ~90× the architecture set.
   */
  eager: boolean;
}

/**
 * Shape libraries shipped as static assets under `public/`, fetched from the
 * app's own origin — bundled assets, never runtime dependencies (I7), and
 * never a call out to libraries.excalidraw.com. Attribution and licenses are
 * recorded in the README (D23).
 */
const BUNDLED_LIBRARIES: readonly BundledLibrary[] = [
  // The house glyphs lead (D119): the shelf a brandless word reaches first.
  { url: "/libraries/docent-house.excalidrawlib", eager: true },
  { url: "/libraries/software-architecture.excalidrawlib", eager: true },
  { url: "/libraries/aws-architecture-icons.excalidrawlib", eager: false },
];

/**
 * Merge one bundled shape library into Excalidraw's library sidebar.
 * Best-effort by construction: a missing, unserved, or malformed asset must
 * never keep the canvas from coming up, so every failure ends at a warning.
 * Repeat calls are idempotent — upstream's merge drops items whose elements
 * are already present, so a re-mount cannot duplicate the shapes.
 */
async function loadBundledLibrary(
  api: ExcalidrawImperativeAPI,
  url: string,
): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as {
      type?: unknown;
      libraryItems?: unknown;
      library?: unknown;
    };
    if (parsed.type !== "excalidrawlib") {
      throw new Error("not an excalidrawlib payload");
    }
    // v2 files carry `libraryItems`; v1 files carry `library` (an array of
    // element arrays). Upstream's restore path accepts either shape.
    const items = parsed.libraryItems ?? parsed.library;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("no library items");
    }
    await api.updateLibrary({
      libraryItems: items as LibraryItems_anyVersion,
      merge: true,
      openLibraryMenu: false,
    });
  } catch (err) {
    console.warn(`Failed to load bundled library ${url}`, err);
  }
}

/** Merge every bundled library matching `select`, in manifest order. */
async function loadBundledLibraries(
  api: ExcalidrawImperativeAPI,
  select: (library: BundledLibrary) => boolean,
): Promise<void> {
  for (const library of BUNDLED_LIBRARIES) {
    if (select(library)) {
      await loadBundledLibrary(api, library.url);
    }
  }
}

/**
 * Upstream opens the shape library as the `library` tab of its default
 * sidebar (`{ name: "default", tab: "library" }`). The constants naming both
 * (`DEFAULT_SIDEBAR`, `LIBRARY_SIDEBAR_TAB`) are internal — not runtime
 * exports — so match on either field rather than pinning one spelling.
 */
function isLibrarySidebarOpen(openSidebar: AppState["openSidebar"]): boolean {
  if (!openSidebar) return false;
  return openSidebar.tab === "library" || openSidebar.name === "library";
}

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
const MOD = isMac ? "Cmd" : "Ctrl";

export function ExcalidrawCanvas({
  onReady,
  onDocumentChange,
  onSelectionChange,
  onThemeChange,
  menuActions,
  hideDocentMenuItems = false,
  detailMarkersVisible = true,
  contextExport,
}: ExcalidrawCanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const fontWatchRef = useRef<(() => void) | null>(null);
  useEffect(() => () => fontWatchRef.current?.(), []);
  const lastFingerprintRef = useRef(0);
  const lastSelectionRef = useRef("");
  const lastThemeRef = useRef<string | null>(null);
  const lazyLibrariesRef = useRef(false);

  // Right-click export (D32): let upstream open its own menu, then append
  // one item — built by cloning an existing entry so it inherits whatever
  // the pinned version's classes render. React removes the whole menu on
  // close, our node with it.
  const contextExportRef = useRef(contextExport);
  contextExportRef.current = contextExport;
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const ctx = contextExportRef.current;
      if (!ctx) return;
      const target = ctx.resolveFrameAt(event.clientX, event.clientY);
      if (!target) return;
      let tries = 0;
      const inject = () => {
        const menu = document.querySelector(".context-menu");
        if (!menu) {
          // The menu mounts through React state — give it a moment. Timeouts,
          // not rAF: rAF is throttled to nothing in hidden/background tabs.
          if (++tries < 12) window.setTimeout(inject, 16);
          return;
        }
        if (menu.querySelector(".docent-copy-frame-json")) return;
        const sampleItem = menu.querySelector("li:has(button)");
        const sampleButton = menu.querySelector("button");
        if (!sampleItem || !sampleButton) return;
        const li = sampleItem.cloneNode(false) as HTMLElement;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `${sampleButton.className} docent-copy-frame-json`;
        const sampleLabel = sampleButton.querySelector("div");
        const label = document.createElement("div");
        if (sampleLabel) label.className = sampleLabel.className;
        const shortName =
          target.name.length > 28 ? `${target.name.slice(0, 27)}…` : target.name;
        label.textContent = `Copy semantic JSON — ${shortName}`;
        button.appendChild(label);
        button.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          contextExportRef.current?.onCopy(target.id);
          // Close the menu the way an outside click does: upstream's popover
          // watches its own full-viewport container for pointerdown (a
          // window-level Escape or body click never reaches it — measured).
          document
            .querySelector(".excalidraw-contextMenuContainer")
            ?.dispatchEvent(
              new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }),
            );
        };
        li.appendChild(button);
        // First entry, right under the cursor: upstream's menu runs long
        // (20+ items) and an appended entry can land below the fold.
        const separator = menu.querySelector("li:has(hr)");
        menu.insertBefore(li, menu.firstChild);
        if (separator) menu.insertBefore(separator.cloneNode(true), li.nextSibling);
      };
      window.setTimeout(inject, 0);
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const handleApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      lastFingerprintRef.current = hashElementsVersion(
        api.getSceneElementsIncludingDeleted(),
      );
      fontWatchRef.current?.();
      fontWatchRef.current = watchFonts(api);
      // What the canvas came up in, before the first change (D107) — the
      // chrome should never be dressed in the other theme for a frame.
      const theme = api.getAppState().theme;
      lastThemeRef.current = theme;
      onThemeChange?.(theme === "dark" ? "dark" : "light");
      // Architect ink (D143): the person's tool draws single-pass strokes.
      // Asserted at every launch — the sloppiness options are off the
      // panel, so a persisted rougher default would have no way back.
      if (api.getAppState().currentItemRoughness !== 0) {
        api.updateScene({
          appState: { currentItemRoughness: 0 },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      onReady?.(makeHandle(api));
      void loadBundledLibraries(api, (library) => library.eager);
    },
    [onReady, onThemeChange],
  );

  const handleChange = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const fingerprint = hashElementsVersion(api.getSceneElementsIncludingDeleted());
    if (fingerprint !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fingerprint;
      onDocumentChange?.(fingerprint);
    }
    const appState = api.getAppState();
    if (!lazyLibrariesRef.current && isLibrarySidebarOpen(appState.openSidebar)) {
      // Latch before awaiting: onChange fires continuously while the sidebar
      // is open, and the deferred libraries must be fetched exactly once.
      lazyLibrariesRef.current = true;
      void loadBundledLibraries(api, (library) => !library.eager);
    }
    // The chrome follows the canvas (D107). The theme lives in appState and
    // nowhere else, and changing it moves no elements — so onDocumentChange
    // never fires for it and this is the only place it can be observed.
    if (appState.theme !== lastThemeRef.current) {
      lastThemeRef.current = appState.theme;
      onThemeChange?.(appState.theme === "dark" ? "dark" : "light");
    }
    const selected = appState.selectedElementIds;
    const ids = Object.keys(selected).filter((id) => selected[id]);
    const key = ids.slice().sort().join(" ");
    if (key !== lastSelectionRef.current) {
      lastSelectionRef.current = key;
      onSelectionChange?.(ids);
    }
  }, [onDocumentChange, onSelectionChange, onThemeChange]);

  return (
    <Excalidraw
      excalidrawAPI={handleApi}
      onChange={handleChange}
      onLibraryChange={(items) => {
        // The runtime vocabulary (D130): named items of the person's own
        // library, taught to the catalog every time the shelf changes.
        registerPersonalLibrary(
          (items as readonly { id?: unknown; name?: unknown; elements?: unknown }[]).map((item) => ({
            id: String(item.id ?? ""),
            name: typeof item.name === "string" ? item.name : null,
            elements: Array.isArray(item.elements) ? (item.elements as PersonalItem["elements"]) : [],
          })),
        );
      }}
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
        {!hideDocentMenuItems && (
          <>
            <MainMenu.Item onSelect={menuActions.onPresent}>▶ Present</MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onOpenLegend}>Legend…</MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onOpenPortfolio}>
              Portfolio…
            </MainMenu.Item>
            <MainMenu.Separator />
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
            <MainMenu.Item onSelect={menuActions.onExportMermaid}>
              Export Mermaid…
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onExportSidecar}>
              Export semantic JSON…
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onExportPdf}>
              Export PDF…
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onArrangeTiers}>
              Arrange detail tiers
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onTidy} shortcut={isMac ? "⌥⇧F" : "Alt+Shift+F"}>
              Tidy diagram
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onToggleDetailMarkers}>
              {detailMarkersVisible ? "Hide detail markers" : "Show detail markers"}
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onConnectAgent}>
              Connect agent bridge
            </MainMenu.Item>
            <MainMenu.Item onSelect={menuActions.onOpenSettings}>Settings…</MainMenu.Item>
            {menuActions.onOpenPlugins && (
              <MainMenu.Item onSelect={menuActions.onOpenPlugins}>Plugins…</MainMenu.Item>
            )}
            {menuActions.onToggleAgentEdit && (
              <MainMenu.Item onSelect={menuActions.onToggleAgentEdit}>
                {menuActions.agentCanEdit ? "Agent can edit ✓" : "Agent can edit"}
              </MainMenu.Item>
            )}
            <MainMenu.Separator />
          </>
        )}
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
