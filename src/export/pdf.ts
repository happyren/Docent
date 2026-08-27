/**
 * A minimal PDF 1.4 writer (D105): one page per image, the JPEG embedded
 * verbatim as a DCTDecode stream, the title and caption set in Helvetica —
 * a base-14 font, so nothing is embedded and nothing is measured but the
 * text. No library carries this (I7), and no dependency could: the whole
 * format we need is objects, a stream, and an xref table.
 *
 * Deterministic (I3): no timestamps, no /ID, no randomness, fixed-precision
 * numbers — the same pages always give byte-identical bytes.
 */

/** One page: a picture, its name, and what the diagram says about it. */
export interface PdfPage {
  jpeg: Uint8Array;
  pxWidth: number;
  pxHeight: number;
  title: string;
  caption?: string;
}

// Page geometry, in points. The bounds are A4 landscape (842×595) turned
// on their side for a taller-than-wide picture; within them the page box
// takes the picture's own aspect (D106 — sized to what it shows).
const MAX_LONG_SIDE = 842;
const MAX_SHORT_SIDE = 595;
const MARGIN = 36;
const GAP = 12;
const TITLE_SIZE = 13;
const TITLE_LEADING = TITLE_SIZE * 1.25;
const CAPTION_SIZE = 9;
const CAPTION_LEADING = CAPTION_SIZE * 1.3;
/** A page never narrows past this, however small its picture. */
const MIN_TEXT_WIDTH = 240;
/** Nor may a caption crowd out the picture it captions. */
const MAX_CAPTION_SHARE = 0.6;

/**
 * Helvetica's advance widths (1/1000 em) for ASCII 32..126 — the base-14
 * metrics every reader already has. Nothing outside this range survives
 * `asciiFold`, so the table measures exactly what gets drawn.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** `?` — what an unencodable character costs, and what it draws as. */
const FALLBACK_WIDTH = HELVETICA_WIDTHS["?".charCodeAt(0) - 32];

/** The punctuation prose actually carries, in ASCII the table can measure. */
const TRANSLITERATED: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
  "‹": "'", "›": "'",
  "‐": "-", "‑": "-", "–": "-", "—": "-", "−": "-",
  "•": "-", "·": "-", "…": "...", " ": " ",
  "×": "x", "→": "->", "←": "<-",
};

/**
 * Fold to the ASCII the base-14 metrics describe: accents drop to their
 * base letter, the punctuation an author types maps to its ASCII cousin,
 * whitespace collapses to spaces, and anything left that the table cannot
 * measure — CJK, emoji — becomes `?` rather than corrupting the stream.
 * Done before measuring, so the widths describe what is actually drawn.
 */
function asciiFold(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")) {
    const mapped = TRANSLITERATED[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\r" || ch === "\t") out += " ";
    else if (code >= 32 && code <= 126) out += ch;
    else out += "?";
  }
  return out;
}

/** Escape what a PDF literal string cannot carry raw. */
function pdfString(text: string): string {
  return `(${asciiFold(text).replace(/([\\()])/g, "\\$1")})`;
}

/** Width of an already-folded string at a font size, in points. */
function textWidth(folded: string, size: number): number {
  let mille = 0;
  for (let i = 0; i < folded.length; i++) {
    const code = folded.charCodeAt(i);
    mille += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : FALLBACK_WIDTH;
  }
  return (mille * size) / 1000;
}

/**
 * Greedy word wrap measured in the font it will be set in. A word longer
 * than the column is broken by characters rather than allowed to run off
 * the page. Exported for the writer's own tests.
 */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const words = asciiFold(text).split(" ").filter(Boolean);
  const column = Math.max(size, maxWidth);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= column) {
      line = candidate;
      continue;
    }
    flush();
    if (textWidth(word, size) <= column) {
      line = word;
      continue;
    }
    // An unbreakable run (a url, a hash): break it where it fills.
    let piece = "";
    for (const ch of word) {
      if (piece && textWidth(piece + ch, size) > column) {
        lines.push(piece);
        piece = "";
      }
      piece += ch;
    }
    line = piece;
  }
  flush();
  return lines;
}

interface PageLayout {
  width: number;
  height: number;
  image: { x: number; y: number; width: number; height: number };
  titleBaseline: number;
  captionBaseline: number;
  textX: number;
  title: string;
  captionLines: string[];
}

/**
 * The page box, sized to the picture (D106). The picture's aspect picks
 * the orientation and the bounds; within them the page hugs what it shows
 * — the column is as wide as the picture wants (never below a readable
 * text width), the height is the picture plus its title and caption.
 */
function layoutPage(page: PdfPage): PageLayout {
  const pxWidth = Math.max(1, page.pxWidth);
  const pxHeight = Math.max(1, page.pxHeight);
  const landscape = pxWidth >= pxHeight;
  const maxWidth = landscape ? MAX_LONG_SIDE : MAX_SHORT_SIDE;
  const maxHeight = landscape ? MAX_SHORT_SIDE : MAX_LONG_SIDE;
  const widest = maxWidth - MARGIN * 2;

  // A caption may be a whole narrative; it gets most of the page but never
  // the picture's share of it.
  const maxLines = Math.max(
    1,
    Math.floor(
      (maxHeight * MAX_CAPTION_SHARE - MARGIN * 2 - TITLE_LEADING - GAP * 2) /
        CAPTION_LEADING,
    ),
  );
  const wrap = (column: number): string[] => {
    const caption = page.caption?.trim();
    if (!caption) return [];
    const lines = wrapText(caption, CAPTION_SIZE, column);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}...`;
    return kept;
  };
  const chromeOf = (lines: number) =>
    MARGIN * 2 +
    TITLE_LEADING +
    GAP +
    (lines ? GAP + lines * CAPTION_LEADING : 0);
  const fit = (column: number, available: number) => {
    const scale = Math.min(column / pxWidth, Math.max(1, available) / pxHeight);
    return { width: pxWidth * scale, height: pxHeight * scale };
  };

  // Pass one asks how wide the picture wants to be; pass two re-wraps the
  // caption into that column and re-fits under the taller text block.
  const first = fit(widest, maxHeight - chromeOf(wrap(widest).length));
  const column = Math.min(widest, Math.max(first.width, MIN_TEXT_WIDTH));
  const captionLines = wrap(column);
  const chrome = chromeOf(captionLines.length);
  const image = fit(column, maxHeight - chrome);

  const captionHeight = captionLines.length * CAPTION_LEADING;
  const height = chrome + image.height;
  return {
    width: MARGIN * 2 + column,
    height,
    image: {
      x: MARGIN + (column - image.width) / 2,
      y: MARGIN + captionHeight + (captionLines.length ? GAP : 0),
      width: image.width,
      height: image.height,
    },
    titleBaseline: height - MARGIN - TITLE_SIZE,
    captionBaseline: MARGIN + captionHeight - CAPTION_SIZE,
    textX: MARGIN,
    title: page.title,
    captionLines,
  };
}

/** Fixed precision keeps two runs byte-identical (I3). */
function pt(value: number): string {
  const text = (Math.round(value * 100) / 100).toFixed(2);
  return text === "-0.00" ? "0.00" : text;
}

function contentStream(layout: PageLayout): string {
  const parts: string[] = [];
  const { image } = layout;
  if (image.width > 0 && image.height > 0) {
    parts.push(
      "q",
      `${pt(image.width)} 0 0 ${pt(image.height)} ${pt(image.x)} ${pt(image.y)} cm`,
      "/Im0 Do",
      "Q",
    );
  }
  parts.push(
    "BT",
    `/F1 ${pt(TITLE_SIZE)} Tf`,
    `${pt(layout.textX)} ${pt(layout.titleBaseline)} Td`,
    `${pdfString(layout.title)} Tj`,
    "ET",
  );
  if (layout.captionLines.length) {
    parts.push(
      "BT",
      `/F1 ${pt(CAPTION_SIZE)} Tf`,
      `${pt(layout.textX)} ${pt(layout.captionBaseline)} Td`,
    );
    layout.captionLines.forEach((line, i) => {
      if (i > 0) parts.push(`0 ${pt(-CAPTION_LEADING)} Td`);
      parts.push(`${pdfString(line)} Tj`);
    });
    parts.push("ET");
  }
  return `${parts.join("\n")}\n`;
}

/**
 * The colour space of a JPEG, read off its frame header: canvas gives us
 * three components, but a grayscale or CMYK file would be drawn wrong if
 * we simply assumed.
 */
function jpegColorSpace(jpeg: Uint8Array): string {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // scan data — past every header
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      const components = jpeg[i + 9];
      if (components === 1) return "/DeviceGray";
      if (components === 4) return "/DeviceCMYK";
      return "/DeviceRGB";
    }
    i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
  }
  return "/DeviceRGB";
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

interface PdfObject {
  dict: string;
  stream?: Uint8Array;
}

/**
 * Write the document. `docTitle` names it in /Info; the Producer is the
 * fixed string "Docent" and there is no creation date, because a print of
 * the same diagram must be the same file (I3).
 */
export function writePdf(pages: readonly PdfPage[], docTitle?: string): Uint8Array {
  if (!pages.length) throw new Error("A PDF needs at least one page");
  for (const page of pages) {
    if (page.jpeg[0] !== 0xff || page.jpeg[1] !== 0xd8) {
      throw new Error(`Page "${page.title}" is not a JPEG`);
    }
  }

  // 1 catalog, 2 pages, 3 font, 4 info, then page/contents/image per page.
  const FIRST_PAGE_OBJECT = 5;
  const objectOf = (index: number) => FIRST_PAGE_OBJECT + index * 3;
  const kids = pages.map((_, i) => `${objectOf(i)} 0 R`).join(" ");
  const objects: PdfObject[] = [
    { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { dict: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` },
    { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
    {
      dict: `<< /Producer (Docent)${docTitle ? ` /Title ${pdfString(docTitle)}` : ""} >>`,
    },
  ];

  pages.forEach((page, i) => {
    const layout = layoutPage(page);
    const self = objectOf(i);
    const content = latin1(contentStream(layout));
    objects.push({
      dict:
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${pt(layout.width)} ${pt(layout.height)}] ` +
        `/Resources << /XObject << /Im0 ${self + 2} 0 R >> /Font << /F1 3 0 R >> >> ` +
        `/Contents ${self + 1} 0 R >>`,
    });
    objects.push({
      dict: `<< /Length ${content.length} >>`,
      stream: content,
    });
    objects.push({
      dict:
        `<< /Type /XObject /Subtype /Image ` +
        `/Width ${Math.max(1, Math.round(page.pxWidth))} ` +
        `/Height ${Math.max(1, Math.round(page.pxHeight))} ` +
        `/ColorSpace ${jpegColorSpace(page.jpeg)} /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${page.jpeg.length} >>`,
      stream: page.jpeg,
    });
  });

  const chunks: Uint8Array[] = [];
  let at = 0;
  const put = (part: Uint8Array | string) => {
    const bytes = typeof part === "string" ? latin1(part) : part;
    chunks.push(bytes);
    at += bytes.length;
  };

  // The binary comment tells every tool this file is not text.
  put("%PDF-1.4\n");
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(at);
    put(`${i + 1} 0 obj\n`);
    put(object.dict);
    if (object.stream) {
      put("\nstream\n");
      put(object.stream);
      put("\nendstream");
    }
    put("\nendobj\n");
  });

  const startxref = at;
  put(`xref\n0 ${objects.length + 1}\n`);
  put("0000000000 65535 f \n");
  // Each entry is exactly 20 bytes — readers seek by arithmetic, not parsing.
  for (const offset of offsets) {
    put(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  put(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\n`);
  put(`startxref\n${startxref}\n%%EOF\n`);

  const out = new Uint8Array(at);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
