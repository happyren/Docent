/**
 * Print (A26): the in-house PDF writer (D105, I7), the document's page
 * order (D105), and the adapter's frame renderer (D106, B1).
 *
 * The writer is checked against its own bytes — header, xref offsets, page
 * count, the JPEG carried verbatim — because a PDF nothing validates is a
 * PDF nobody can open.
 */
import { describe, expect, it, vi } from "vitest";

// The adapter is the one module that may import Excalidraw (B1), and its
// published bundle will not load in a node test. The stand-in records what
// the renderer asks of `exportToCanvas` — the crop box and the scale are
// the whole of D106, so they are asserted, not assumed.
const upstream = vi.hoisted(() => ({
  calls: [] as Record<string, any>[],
  blobs: [] as { mime?: string; quality?: number }[],
}));

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "immediately", NEVER: "never" },
  Excalidraw: () => null,
  FONT_FAMILY: { Excalifont: 5, Nunito: 6, "Comic Shanns": 7 },
  MainMenu: Object.assign(() => null, { DefaultItems: {} }),
  convertToExcalidrawElements: (skeletons: Record<string, unknown>[]) => skeletons,
  elementsOverlappingBBox: () => [],
  getCommonBounds: (els: { x: number; y: number; width: number; height: number }[]) => {
    const minX = Math.min(...els.map((e) => e.x));
    const minY = Math.min(...els.map((e) => e.y));
    const maxX = Math.max(...els.map((e) => e.x + e.width));
    const maxY = Math.max(...els.map((e) => e.y + e.height));
    return [minX, minY, maxX, maxY];
  },
  hashElementsVersion: () => 0,
  exportToCanvas: async (opts: Record<string, any>) => {
    upstream.calls.push(opts);
    // What upstream would measure: the exporting frame, or the elements'
    // common bounds grown by the export padding.
    const frame = opts.exportingFrame;
    const pad = opts.exportPadding ?? 0;
    const els = opts.elements as { x: number; y: number; width: number; height: number }[];
    const natural = frame
      ? { width: frame.width, height: frame.height }
      : {
          width: Math.max(...els.map((e) => e.x + e.width)) - Math.min(...els.map((e) => e.x)) + pad * 2,
          height: Math.max(...els.map((e) => e.y + e.height)) - Math.min(...els.map((e) => e.y)) + pad * 2,
        };
    const dims = opts.getDimensions(natural.width, natural.height);
    return fakeCanvas(dims.width, dims.height);
  },
  loadFromBlob: async () => ({ elements: [], appState: {} }),
  newElementWith: (el: object, patch: object) => ({ ...el, ...patch }),
  restoreElements: (els: unknown) => els,
  serializeAsJSON: () => "{}",
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}));

import { makeHandle } from "../src/adapter/excalidraw";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { writePdf, wrapText, type PdfPage } from "../src/export/pdf";
import { exportPdf, printOrder, type PrintRenderer } from "../src/export/print";

/** A JPEG the writer will accept, with a distinctive payload to find again. */
function fakeJpeg(mark: number, length = 64) {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03]);
  for (let i = 12; i < length - 2; i++) bytes[i] = (mark * 7 + i) & 0xff;
  bytes.set([0xff, 0xd9], length - 2);
  return bytes;
}

function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    toBlob: (
      done: (blob: Blob | null) => void,
      mime?: string,
      quality?: number,
    ) => {
      upstream.blobs.push({ mime, quality });
      done(new Blob([fakeJpeg(width & 0xff)], { type: mime }));
    },
  } as unknown as HTMLCanvasElement;
}

const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

const page = (over: Partial<PdfPage> = {}): PdfPage => ({
  jpeg: fakeJpeg(1),
  pxWidth: 1600,
  pxHeight: 900,
  title: "Core Services",
  ...over,
});

/** Parse the file's own cross-reference table back out of its bytes. */
function readXref(bytes: Uint8Array) {
  const text = latin1(bytes);
  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  expect(tail, "the file ends with startxref and %%EOF").not.toBeNull();
  const start = Number(tail![1]);
  const header = /^xref\n0 (\d+)\n/.exec(text.slice(start));
  expect(header, "startxref points at the xref table").not.toBeNull();
  const size = Number(header![1]);
  const first = start + header![0].length;
  expect(text.slice(first, first + 20)).toBe("0000000000 65535 f \n");
  const offsets: number[] = [];
  for (let i = 1; i < size; i++) {
    const entry = text.slice(first + i * 20, first + i * 20 + 20);
    expect(entry, `entry ${i} is exactly 20 bytes`).toMatch(/^\d{10} 00000 n \n$/);
    offsets.push(Number(entry.slice(0, 10)));
  }
  return { text, size, offsets };
}

describe("the PDF writer (D105, I7 — no library carries this)", () => {
  it("writes a 1.4 header and an %%EOF", () => {
    const text = latin1(writePdf([page()]));
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
  });

  it("xref offsets each land on their object header", () => {
    const { text, size, offsets } = readXref(writePdf([page(), page({ title: "Two" })]));
    // 4 fixed objects + 3 per page.
    expect(size).toBe(1 + 4 + 2 * 3);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("makes one page per input", () => {
    for (const count of [1, 2, 5]) {
      const text = latin1(writePdf(Array.from({ length: count }, () => page())));
      expect(text).toContain(`/Count ${count}`);
      expect(text.match(/\/Type \/Page /g)?.length).toBe(count);
    }
  });

  it("embeds the JPEG bytes verbatim (DCTDecode — no re-encoding)", () => {
    const jpeg = fakeJpeg(42, 128);
    const bytes = writePdf([page({ jpeg })]);
    expect(latin1(bytes)).toContain("/Filter /DCTDecode");
    expect(latin1(bytes)).toContain(`/Length ${jpeg.length}`);
    const at = latin1(bytes).indexOf(latin1(jpeg));
    expect(at).toBeGreaterThan(0);
    expect(bytes.slice(at, at + jpeg.length)).toEqual(jpeg);
  });

  it("reads the colour space off the frame header", () => {
    const gray = fakeJpeg(3);
    gray[11] = 1; // one component
    expect(latin1(writePdf([page({ jpeg: gray })]))).toContain("/ColorSpace /DeviceGray");
    expect(latin1(writePdf([page()]))).toContain("/ColorSpace /DeviceRGB");
  });

  it("refuses anything that is not a JPEG", () => {
    expect(() => writePdf([page({ jpeg: new Uint8Array([0x89, 0x50]) })])).toThrow(/not a JPEG/);
    expect(() => writePdf([])).toThrow(/at least one page/);
  });

  it("is byte-identical across runs, with no timestamp (I3)", () => {
    const pages = [page({ caption: "A narrative." }), page({ title: "Deep", pxWidth: 800, pxHeight: 1400 })];
    const a = writePdf(pages, "Payments");
    const b = writePdf(pages, "Payments");
    expect(a).toEqual(b);
    const text = latin1(a);
    expect(text).toContain("/Producer (Docent)");
    expect(text).toContain("/Title (Payments)");
    expect(text).not.toContain("CreationDate");
    expect(text).not.toContain("/ID");
  });

  it("takes the page box from the picture's aspect (D106)", () => {
    const boxOf = (pxWidth: number, pxHeight: number) => {
      const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(
        latin1(writePdf([page({ pxWidth, pxHeight })])),
      );
      return { width: Number(m![1]), height: Number(m![2]) };
    };
    const wide = boxOf(1600, 900);
    expect(wide.width).toBeGreaterThan(wide.height);
    expect(wide.width).toBeLessThanOrEqual(842);
    expect(wide.height).toBeLessThanOrEqual(595);

    const tall = boxOf(900, 1600);
    expect(tall.height).toBeGreaterThan(tall.width);
    expect(tall.width).toBeLessThanOrEqual(595);
    expect(tall.height).toBeLessThanOrEqual(842);
  });

  it("wraps a long caption onto several measured lines", () => {
    const caption =
      "The gateway terminates TLS, checks the token, and hands the request to the router. " +
      "It retries idempotent calls twice with jitter, sheds load above the configured " +
      "concurrency, and reports every decision to the audit stream so an operator can " +
      "reconstruct why a request was refused long after the fact. Nothing downstream " +
      "sees an unauthenticated call, and nothing upstream sees a retry: both are the " +
      "gateway's business alone, which is why the whole of it is drawn one tier down " +
      "rather than sketched here as three boxes and an arrow.";
    const lines = (text: string) => text.match(/\) Tj/g)?.length ?? 0;
    const short = latin1(writePdf([page({ caption: "One line." })]));
    const long = latin1(writePdf([page({ caption })]));
    expect(lines(short)).toBe(2); // title + one caption line
    // A 16:9 picture fills the widest column (842 - two 36pt margins), so
    // that is the column the caption was measured against.
    const wrapped = wrapText(caption, 9, 842 - 72);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(lines(long)).toBe(1 + wrapped.length);
    // Every wrapped line fits the column it was measured for.
    for (const line of wrapText("a ".repeat(400), 9, 300)) {
      expect(line.length).toBeLessThanOrEqual(300 / (9 * 0.278));
    }
  });

  it("escapes what a literal string cannot carry, and folds what it cannot measure", () => {
    const text = latin1(
      writePdf([
        page({
          title: "Core (v2) \\ shared",
          caption: "Narrative — “quoted” · café… 決済 ok",
        }),
      ]),
    );
    expect(text).toContain("(Core \\(v2\\) \\\\ shared) Tj");
    // Typography an author types folds to the ASCII the widths describe;
    // only what nothing in the table can measure becomes '?'.
    expect(text).toContain('Narrative - "quoted" - cafe... ?? ok');
  });

  it("breaks an unbreakable run rather than running off the page", () => {
    const lines = wrapText("x".repeat(400), 9, 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length < 400)).toBe(true);
  });
});

// A three-tier scene: two Layer-1 frames, a detail under one of them, and
// a detail under that — the shape the outline walks.
const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  strokeStyle: "solid",
  fillStyle: "solid",
  strokeWidth: 2,
  opacity: 100,
  groupIds: [],
  frameId: null,
  isDeleted: false,
  locked: false,
  boundElements: [],
};

const GATEWAY_NARRATIVE =
  "Every request lands here first. The gateway terminates TLS and checks the token. " +
  "Only then does the router see it.";

const tiered = () => [
  {
    ...base, id: "f_core", type: "frame", name: "Core Services",
    x: 0, y: 0, width: 600, height: 400,
    customData: { docent: { narrative: "The services that hold state." } },
  },
  {
    ...base, id: "f_ingress", type: "frame", name: "Ingress",
    x: 800, y: 0, width: 600, height: 400,
  },
  {
    ...base, id: "n_gateway", type: "rectangle", x: 840, y: 60, width: 160, height: 80,
    frameId: "f_ingress",
    customData: { docent: { detail: { frameId: "f_gw" } } },
  },
  {
    ...base, id: "f_gw", type: "frame", name: "Gateway internals",
    x: 0, y: 30000, width: 600, height: 400,
    customData: { docent: { narrative: GATEWAY_NARRATIVE } },
  },
  {
    ...base, id: "n_router", type: "rectangle", x: 40, y: 30060, width: 160, height: 80,
    frameId: "f_gw",
    customData: { docent: { detail: { frameId: "f_router" } } },
  },
  {
    ...base, id: "f_router", type: "frame", name: "Router internals",
    x: 0, y: 60000, width: 600, height: 400,
  },
  // Unframed Layer-1 content: the legend carrier and a loose component.
  { ...base, id: "legend", type: "text", x: -400, y: 0, width: 200, height: 120, text: "Legend" },
  { ...base, id: "n_cdn", type: "rectangle", x: -400, y: 200, width: 160, height: 80 },
];

describe("the document's page order (D105 — the outline is its contents)", () => {
  const order = printOrder(snapshotFromRawElements(tiered()), "Payments");

  it("opens on the overview, named for the document", () => {
    expect(order[0].frameId).toBeNull();
    expect(order[0].title).toBe("Payments");
    expect(order[0].caption).toBe("Layer 1: 2 frames, 1 narrated.");
  });

  it("prints tier 1 in the outline's order, then details depth-first", () => {
    expect(order.map((p) => p.frameId)).toEqual([
      null,
      "f_core",
      "f_ingress",
      "f_gw",
      "f_router",
    ]);
    expect(order.map((p) => p.title)).toEqual([
      "Payments",
      "Core Services",
      "Ingress",
      "Gateway internals",
      "Router internals",
    ]);
  });

  it("carries a narrative whole — a caption is not an opener", () => {
    const gateway = order.find((p) => p.frameId === "f_gw")!;
    expect(gateway.caption).toBe(GATEWAY_NARRATIVE);
    expect(gateway.caption.split(". ").length).toBeGreaterThan(2);
    expect(order.find((p) => p.frameId === "f_router")!.caption).toBe("");
  });

  it("is pure and stable — the same snapshot gives the same document (I3)", () => {
    const again = printOrder(snapshotFromRawElements(tiered()), "Payments");
    expect(again).toEqual(order);
  });

  it("still pages a frame the parentage never reaches", () => {
    const orphaned = tiered().filter((el) => el.id !== "n_router");
    const pages = printOrder(snapshotFromRawElements(orphaned), "Payments");
    expect(pages.map((p) => p.frameId)).toContain("f_router");
  });
});

describe("the frame renderer (D106, B1 — the adapter's one export surface)", () => {
  const canvas = (elements: Record<string, unknown>[]) => {
    upstream.calls.length = 0;
    upstream.blobs.length = 0;
    return makeHandle({
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({ viewBackgroundColor: "#fdfdfd" }),
      getFiles: () => ({}),
    } as never);
  };
  const lastCall = () => upstream.calls[upstream.calls.length - 1];

  it("answers null for a frame that is not there", async () => {
    expect(await canvas(tiered()).renderFrameImage("nope")).toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });

  it("crops to the frame's box plus a margin", async () => {
    const image = await canvas(tiered()).renderFrameImage("f_core");
    const frame = lastCall().exportingFrame;
    expect(frame.id).toBe("f_core"); // borrows the id, so its children stay
    expect({ x: frame.x, y: frame.y, width: frame.width, height: frame.height }).toEqual({
      x: -24,
      y: -24,
      width: 648,
      height: 448,
    });
    // The frame's own box is not in the drawing — the synthetic one crops it.
    expect(lastCall().elements.some((el: { id: string }) => el.id === "f_core")).toBe(false);
    expect(lastCall().appState).toEqual({
      viewBackgroundColor: "#fdfdfd",
      exportBackground: true,
    });
    expect(image).not.toBeNull();
  });

  it("scales for legibility: at least 2 device px per scene px", async () => {
    await canvas(tiered()).renderFrameImage("f_core");
    // 648×448 box: lifted toward the 2400px target, well under the cap.
    const dims = lastCall().getDimensions(648, 448);
    expect(dims.scale).toBeCloseTo(2400 / 648, 6);
    expect(dims.scale).toBeGreaterThanOrEqual(2);
    expect(dims.width).toBe(2400);
  });

  it("caps the raster so a huge frame is not a huge file", async () => {
    const huge = tiered().map((el) =>
      el.id === "f_core" ? { ...el, width: 12000, height: 6000 } : el,
    );
    await canvas(huge).renderFrameImage("f_core");
    const dims = lastCall().getDimensions(12048, 6048);
    expect(dims.scale).toBeCloseTo(4000 / 12048, 6);
    expect(dims.scale).toBeLessThan(2); // the cap outranks the legibility floor
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(4000);
  });

  it("takes an explicit scale when one is asked for", async () => {
    await canvas(tiered()).renderFrameImage("f_core", { scale: 1.5 });
    expect(lastCall().getDimensions(648, 448)).toEqual({ width: 972, height: 672, scale: 1.5 });
  });

  it("rasterizes as JPEG at the quality asked for", async () => {
    const image = await canvas(tiered()).renderFrameImage("f_core", {
      mime: "image/jpeg",
      quality: 0.85,
    });
    expect(upstream.blobs).toEqual([{ mime: "image/jpeg", quality: 0.85 }]);
    expect(image!.blob.type).toBe("image/jpeg");
    expect(image!.width).toBe(2400);
  });

  it("draws the overview from Layer 1 alone: the legend, loose components, tier-1 frames", async () => {
    const image = await canvas(tiered()).renderOverviewImage();
    const drawn = new Set(lastCall().elements.map((el: { id: string }) => el.id));
    expect(drawn).toEqual(new Set(["f_core", "f_ingress", "n_gateway", "legend", "n_cdn"]));
    expect(lastCall().exportingFrame).toBeUndefined();
    expect(lastCall().exportPadding).toBe(40);
    expect(image).not.toBeNull();
  });

  it("has no overview to draw for an empty scene", async () => {
    expect(await canvas([]).renderOverviewImage()).toBeNull();
  });
});

describe("exportPdf (D105 — renderer to pages to file)", () => {
  const renderer = (): PrintRenderer => ({
    renderFrameImage: async () => ({
      blob: new Blob([fakeJpeg(2)], { type: "image/jpeg" }),
      width: 1200,
      height: 800,
    }),
    renderOverviewImage: async () => ({
      blob: new Blob([fakeJpeg(3)], { type: "image/jpeg" }),
      width: 1600,
      height: 900,
    }),
  });

  it("writes one page per outline entry, titled and captioned", async () => {
    const snapshot = snapshotFromRawElements(tiered());
    const text = latin1(await exportPdf(renderer(), snapshot, "Payments"));
    expect(text).toContain("/Count 5");
    expect(text).toContain("(Payments) Tj");
    expect(text).toContain("(Gateway internals) Tj");
    expect(text).toContain("/Title (Payments)");
  });

  it("skips a page the canvas cannot draw, and refuses an empty document", async () => {
    const nothing: PrintRenderer = {
      renderFrameImage: async () => null,
      renderOverviewImage: async () => null,
    };
    await expect(
      exportPdf(nothing, snapshotFromRawElements(tiered()), "Payments"),
    ).rejects.toThrow(/nothing to print/);
  });

  it("is byte-identical across runs (I3)", async () => {
    const snapshot = snapshotFromRawElements(tiered());
    const a = await exportPdf(renderer(), snapshot, "Payments");
    const b = await exportPdf(renderer(), snapshot, "Payments");
    expect(a).toEqual(b);
  });
});
