/**
 * What a voice should say for what the panel shows (D52). The words are the
 * same; only notation that a reader would stumble over is spoken plainly —
 * arrows become "to", code ticks and emphasis marks drop, an em-dash aside
 * becomes a pause. Pure and deterministic.
 */
export function readable(text: string): string {
  return (
    text
      // Arrows read as direction — the two-headed one first, so "<->" is
      // never read as "<" and "->".
      .replace(/\s*(↔|<->)\s*/g, " and ")
      .replace(/\s*(→|->|⇒|=>)\s*/g, " to ")
      .replace(/\s*(←|<-)\s*/g, " from ")
      // Markdown emphasis and code ticks are typography, not words.
      .replace(/[`*_]{1,3}([^`*_]+)[`*_]{1,3}/g, "$1")
      .replace(/[`*]/g, "")
      // Headings and bullets.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-•]\s+/gm, "")
      // Dashes as asides read as a pause.
      .replace(/\s*[—–]\s*/g, ", ")
      // Version-like tokens: "v2" reads as "version 2".
      .replace(/\bv(\d+(?:\.\d+)*)\b/g, "version $1")
      // Whitespace: one space, sentences separated by a pause.
      .replace(/\s*\n+\s*/g, ". ")
      .replace(/\.\s*\./g, ".")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/,\s*,/g, ",")
      .trim()
  );
}
