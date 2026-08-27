/**
 * The command palette's matching (D111). Pure on purpose: the ranking is the
 * part a reader feels and the part a screenshot cannot check, so it is a
 * function of two lists and a string, and the tests read it without a DOM.
 *
 * Two kinds of thing are searched, in one list. Commands match on their title
 * — the same words the menus show (B4: one command path, so one vocabulary).
 * Scenes match on their whole `project/path` address (D92), because a path is
 * what a scene is called and typing a fragment of one is the point.
 */

/** One command, exactly as the menus carry it. */
export interface PaletteCommand {
  id: string;
  title: string;
  /** A word about what it does, set dimmed after the title. */
  hint?: string;
  /** The chord the menu bar gives it, shown at the row's end. */
  shortcut?: string;
  run: () => void;
}

/** One scene in the portfolio, addressed the way every store call takes it. */
export interface PaletteScene {
  project: string;
  /** The scene's path inside its project — folders and all (D92). */
  path: string;
}

/** A matched row: what to draw, where the query landed, and how well. */
export type PaletteEntry =
  | {
      kind: "command";
      /** Unique within a result list — what React keys and the cursor track. */
      key: string;
      /** The string that was matched, which is also the string to draw. */
      label: string;
      score: number;
      /** Indices in `label` the query landed on, ascending. */
      matched: readonly number[];
      command: PaletteCommand;
    }
  | {
      kind: "scene";
      key: string;
      label: string;
      score: number;
      matched: readonly number[];
      scene: PaletteScene;
    };

/** A palette that scrolls is a palette that is being read, not used. */
export const PALETTE_LIMIT = 12;

/** What a matched character is worth, and what a skipped one costs. */
const CHAR_SCORE = 1;
/** A hit at the start of a word — the acronym a person actually types. */
const BOUNDARY_BONUS = 8;
/** A hit that continues the previous one — a typed-through prefix. */
const RUN_BONUS = 6;
const GAP_PENALTY = 0.5;
/** Beyond this, one long skip is no worse than another. */
const GAP_CAP = 4;
/**
 * How much of the label the query actually accounts for. Without it a long
 * title full of word starts outranks the short one the query nearly spells,
 * which is the wrong answer every time.
 */
const COVERAGE_BONUS = 12;

/** Where a word starts: the head of the string, or after a separator. */
function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text[at - 1];
  if (before === undefined) return true;
  if (/[\s/\-_.:]/.test(before)) return true;
  // camelCase and TitleCase read as words too.
  return before === before.toLowerCase() && text[at] !== text[at].toLowerCase();
}

export interface FuzzyMatch {
  score: number;
  matched: readonly number[];
}

/**
 * Subsequence match, left to right, preferring word starts and runs. Greedy
 * rather than optimal — an optimal matcher would be a dynamic program whose
 * answers a reader could not predict, and predictable is what a palette owes
 * the fingers. Returns null when the query is not a subsequence at all.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  // Spaces are how people separate words they are not sure of the order of;
  // the match is over characters, so they are not part of it.
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, matched: [] };
  const lower = text.toLowerCase();
  const matched: number[] = [];
  let score = 0;
  let cursor = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const char = q[qi];
    let at = -1;
    const previous = matched.length ? matched[matched.length - 1] : -1;
    // A run beats everything: the next character continuing the last hit is
    // someone typing the word out.
    if (previous === cursor - 1 && lower[cursor] === char) {
      at = cursor;
    } else {
      // Otherwise the first occurrence that starts a word, and failing that
      // the first occurrence at all.
      let plain = -1;
      for (let i = cursor; i < lower.length; i++) {
        if (lower[i] !== char) continue;
        if (plain < 0) plain = i;
        if (isBoundary(text, i)) {
          at = i;
          break;
        }
      }
      if (at < 0) at = plain;
    }
    if (at < 0) return null;
    score += CHAR_SCORE;
    if (isBoundary(text, at)) score += BOUNDARY_BONUS;
    // `previous < 0` is the first character, which continues nothing.
    if (previous >= 0 && at === previous + 1) score += RUN_BONUS;
    score -= Math.min(at - cursor, GAP_CAP) * GAP_PENALTY;
    matched.push(at);
    cursor = at + 1;
  }
  score += (matched.length / text.length) * COVERAGE_BONUS;
  return { score, matched };
}

/** The address a scene is matched and drawn by (D92). */
export const scenePath = (scene: PaletteScene): string =>
  `${scene.project}/${scene.path}`;

/**
 * Rank commands and scenes against one query. An empty query is the menu
 * itself — every command in the order it was given, then the scenes — so the
 * palette opens on something to read rather than on nothing.
 *
 * Ordering is total: score, then commands before scenes, then the label, then
 * the key. Two runs of the same inputs cannot disagree.
 */
export function matchPalette(
  query: string,
  commands: readonly PaletteCommand[],
  scenes: readonly PaletteScene[],
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const command of commands) {
    const hit = fuzzyMatch(query, command.title);
    if (!hit) continue;
    entries.push({
      kind: "command",
      key: `command:${command.id}`,
      label: command.title,
      score: hit.score,
      matched: hit.matched,
      command,
    });
  }
  for (const scene of scenes) {
    const label = scenePath(scene);
    const hit = fuzzyMatch(query, label);
    if (!hit) continue;
    entries.push({
      kind: "scene",
      key: `scene:${label}`,
      label,
      score: hit.score,
      matched: hit.matched,
      scene,
    });
  }
  // Nothing typed yet: every score is zero and sorting would only shuffle the
  // menu into alphabetical order, which is not the order anyone wrote it in.
  if (!query.trim()) return entries.slice(0, PALETTE_LIMIT);
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
  return entries.slice(0, PALETTE_LIMIT);
}
