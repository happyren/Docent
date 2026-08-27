/**
 * The printed document (D105): a tiered diagram is a document already —
 * the outline is its table of contents, so the PDF walks it. Page one is
 * the overview; then one page per frame, tier 1 in the outline's own order
 * and the detail layers depth-first along their parentage.
 *
 * `printOrder` is pure — the order and the words are a function of the
 * snapshot. `exportPdf` is the glue: the adapter's renderer (B1) makes the
 * pictures, the in-house writer (I7) makes the file.
 */
import type { FrameImage, FrameImageOptions } from "../adapter";
import type { SceneSnapshot, SnapshotElement } from "../adapter/snapshot";
import { computeTiers } from "../scene/tiers";
import { writePdf, type PdfPage } from "./pdf";

/** One page of the document, before anything is drawn. */
export interface PrintPage {
  /** The frame this page shows; null on the overview. */
  frameId: string | null;
  title: string;
  /** The frame's narrative, whole — a caption is not an opener. */
  caption: string;
}

const frameName = (frame: SnapshotElement) => (frame.name ?? "").trim();
const narrativeOf = (frame: SnapshotElement) =>
  (frame.docent.narrative ?? "").trim();

/** The outline's own order within a tier: by name, ties broken by id (I3). */
function byName(a: SnapshotElement, b: SnapshotElement): number {
  return frameName(a).localeCompare(frameName(b)) || (a.id < b.id ? -1 : 1);
}

export function printOrder(
  snapshot: SceneSnapshot,
  docTitle: string,
): PrintPage[] {
  const tiers = computeTiers(snapshot);
  const frames = snapshot.elements.filter((el) => el.type === "frame");
  const tier1 = frames
    .filter((f) => (tiers.frameTier.get(f.id) ?? 1) === 1)
    .sort(byName);

  // Detail frames, grouped under the frame their linking element sits in.
  // A detail of an unframed component has no parent frame; it hangs off the
  // null key and is walked after the tier-1 subtrees.
  const children = new Map<string | null, SnapshotElement[]>();
  for (const frame of frames) {
    const parent = tiers.detailParent.get(frame.id);
    if (!parent) continue;
    const siblings = children.get(parent.parentFrameId) ?? [];
    siblings.push(frame);
    children.set(parent.parentFrameId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(byName);

  const narrated = tier1.filter((f) => narrativeOf(f)).length;
  const pages: PrintPage[] = [
    {
      frameId: null,
      title: docTitle,
      caption: tier1.length
        ? `Layer 1: ${tier1.length} ${tier1.length === 1 ? "frame" : "frames"}, ${narrated} narrated.`
        : "",
    },
  ];

  const seen = new Set<string>();
  const add = (frame: SnapshotElement) => {
    seen.add(frame.id);
    pages.push({
      frameId: frame.id,
      title: frameName(frame) || "Untitled frame",
      caption: narrativeOf(frame),
    });
  };
  const walk = (parentId: string | null) => {
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue; // a cycle in the links, not a page
      add(child);
      walk(child.id);
    }
  };

  for (const frame of tier1) add(frame);
  for (const frame of tier1) walk(frame.id);
  walk(null);
  // Anything the parentage never reached (a dangling link, a cycle) still
  // gets its page — a print of the diagram leaves no frame out.
  for (const frame of [...frames].sort(
    (a, b) =>
      (tiers.frameTier.get(a.id) ?? 1) - (tiers.frameTier.get(b.id) ?? 1) ||
      byName(a, b),
  )) {
    if (!seen.has(frame.id)) add(frame);
  }
  return pages;
}

/**
 * What printing needs of the canvas — the adapter's handle satisfies it,
 * and nothing above the adapter needs more than this (B1).
 */
export interface PrintRenderer {
  renderFrameImage(
    frameId: string,
    options?: FrameImageOptions,
  ): Promise<FrameImage | null>;
  renderOverviewImage(options?: FrameImageOptions): Promise<FrameImage | null>;
}

/** JPEG is what the PDF embeds verbatim, so it is what we render (D105). */
const PRINT_OPTIONS: FrameImageOptions = {
  mime: "image/jpeg",
  quality: 0.85,
};

/**
 * The whole diagram as a PDF — what the App's *Export PDF* calls. Pages are
 * rendered one at a time: two rasters of a big diagram at once is a lot of
 * memory for no gain, and the order is the document's.
 */
export async function exportPdf(
  renderer: PrintRenderer,
  snapshot: SceneSnapshot,
  docTitle: string,
): Promise<Uint8Array> {
  const pages: PdfPage[] = [];
  for (const entry of printOrder(snapshot, docTitle)) {
    const image =
      entry.frameId === null
        ? await renderer.renderOverviewImage(PRINT_OPTIONS)
        : await renderer.renderFrameImage(entry.frameId, PRINT_OPTIONS);
    if (!image) continue; // an empty overview, or a frame that went away
    pages.push({
      jpeg: new Uint8Array(await image.blob.arrayBuffer()),
      pxWidth: image.width,
      pxHeight: image.height,
      title: entry.title,
      caption: entry.caption,
    });
  }
  if (!pages.length) throw new Error("There is nothing to print in this scene");
  return writePdf(pages, docTitle);
}
