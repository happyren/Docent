/**
 * The command palette (D111). Cmd+K over the canvas: every command the menus
 * carry, with the chord the menu bar gives it, and the portfolio's scenes by
 * path (D92) — fuzzy-matched by `palette.ts`, which is where the ranking lives
 * and is tested.
 *
 * It runs the same handlers the hamburger and the native bar run (B4, one
 * command path): the rows here carry functions the shell built once, and this
 * file invents none of them. Opening a scene goes through the shell's one
 * loader under the guard `open_scene` keeps (D96) — again, handed in.
 *
 * The scene list is fetched when the palette OPENS and never on boot: a canvas
 * must come up without waiting on a store, and a store that is not there (a
 * file-only session) leaves the commands working and says nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  iconEntries,
  matchPalette,
  PALETTE_LIMIT,
  type PaletteCommand,
  type PaletteEntry,
  type PaletteScene,
  type PaletteSymbol,
} from "./palette";
import { folderOf, leafOf } from "../portfolio/tree";
import catalogJson from "../../public/libraries/catalog.json";
import { findSymbols, loadCatalog, withRuntimeSymbols } from "../libraries/catalog";
import { runtimeSymbols } from "../authoring/symbols";
import { renderSymbolThumbnail, renderUnnamedThumbnail, unnamedPersonalItems } from "../adapter";

/** The checked-in catalog (D81), parsed once — icon mode's bundled half. */
const CATALOG = loadCatalog(catalogJson);

/** The two doors (D124): Cmd+K, and Cmd+Shift+K for icons. */
export type PaletteMode = "commands" | "icons";

export interface CommandPaletteProps {
  mode: PaletteMode;
  /**
   * The sibling chord pressed while the palette is open (D124): its input
   * owns the keyboard then, so the window's chord handler never hears it —
   * the palette itself asks the shell to switch.
   */
  onMode: (mode: PaletteMode) => void;
  commands: readonly PaletteCommand[];
  /** Asked once, on open. Rejections are the store's absence, and are silent. */
  loadScenes: () => Promise<PaletteScene[]>;
  onOpenScene: (scene: PaletteScene) => void;
  /** Enter on an icon row (D124): the person's own insertion, at the centre. */
  onInsertSymbol: (symbol: string) => void;
  /** The pen (D131): write a name onto an unnamed library item. */
  onNameItem: (itemId: string, name: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * One icon row's picture (D124): asked from the adapter's cache, shown when
 * it arrives. Decoration, never a gate — a row without its picture yet is
 * still a row.
 */
function IconThumb({ symbol, itemId }: { symbol?: string; itemId?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const render = itemId ? renderUnnamedThumbnail(itemId) : renderSymbolThumbnail(symbol ?? "");
    void render.then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [symbol, itemId]);
  return (
    <span className="docent-palette-thumb" aria-hidden>
      {src && <img src={src} alt="" />}
    </span>
  );
}

/** The matched characters drawn bold, the rest as written. */
function Marked({ text, matched }: { text: string; matched: readonly number[] }) {
  if (!matched.length) return <>{text}</>;
  const hit = new Set(matched);
  const parts: { text: string; on: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i);
    const last = parts[parts.length - 1];
    if (last && last.on === on) last.text += text[i];
    else parts.push({ text: text[i], on });
  }
  return (
    <>
      {parts.map((part, i) =>
        part.on ? (
          <mark key={i} className="docent-palette-hit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** A scene row: the folder said quietly, the scene said plainly. */
function SceneLabel({ entry }: { entry: Extract<PaletteEntry, { kind: "scene" }> }) {
  const label = entry.label;
  const folder = folderOf(label);
  const leaf = leafOf(label);
  const split = folder ? folder.length + 1 : 0;
  return (
    <>
      {split > 0 && (
        <span className="docent-palette-folder">
          <Marked
            text={`${folder}/`}
            matched={entry.matched.filter((i) => i < split)}
          />
        </span>
      )}
      <Marked
        text={leaf}
        matched={entry.matched.filter((i) => i >= split).map((i) => i - split)}
      />
    </>
  );
}

export function CommandPalette({
  mode,
  onMode,
  commands,
  loadScenes,
  onOpenScene,
  onInsertSymbol,
  onNameItem,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [scenes, setScenes] = useState<PaletteScene[]>([]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Open is when the portfolio is asked, and the answer lives as long as the
  // palette does — a session's worth of typing costs one round trip.
  useEffect(() => {
    let alive = true;
    void loadScenes()
      .then((found) => {
        if (alive) setScenes(found);
      })
      // No store, or a store that will not answer: the commands still work,
      // and a palette is not the place to argue about it.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [loadScenes]);

  // The pen (D131): which unnamed item the input is naming, or none.
  const [naming, setNaming] = useState<string | null>(null);
  // Icon mode (D124): the catalog's own ranking over the bundled shelves
  // plus the person's own (D130) — re-read after a naming, which is the one
  // way the shelf changes while the palette is open. A word answers the
  // same way at the keyboard as over MCP (D82, D121); nothing typed opens
  // on the person's shelf, then the house vocabulary, then the nameless
  // waiting for their word. Command mode never sees an icon — that mix is
  // what D124 undid.
  const [shelfNonce, setShelfNonce] = useState(0);
  const catalog = useMemo(
    () => withRuntimeSymbols(CATALOG, runtimeSymbols()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shelfNonce],
  );
  const unnamed = useMemo(
    () => unnamedPersonalItems(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shelfNonce],
  );
  const starter = useMemo<PaletteSymbol[]>(
    () =>
      catalog.symbols
        .filter((entry) => entry.symbol.startsWith("my/") || entry.symbol.startsWith("docent/"))
        .slice(0, PALETTE_LIMIT)
        .map((entry) => ({ symbol: entry.symbol, name: entry.name, library: entry.library })),
    [catalog],
  );
  const entries = useMemo<PaletteEntry[]>(() => {
    if (mode === "icons") {
      if (naming) return []; // the input is a pen now, not a search
      const symbols = query.trim()
        ? findSymbols(catalog, query, { limit: PALETTE_LIMIT }).map((hit) => ({
            symbol: hit.symbol,
            name: hit.name,
            library: hit.library,
          }))
        : starter;
      // The nameless (D131), on the empty query only — a search answers
      // words, and these have none yet. They hold reserved seats at the
      // foot: a full shelf must not hide the very items waiting to join it.
      if (!query.trim()) {
        const waiting = unnamed.slice(0, 3).map((item) => ({
          kind: "unnamed" as const,
          key: `unnamed:${item.itemId}`,
          label: "Unnamed icon",
          score: 0,
          matched: [],
          itemId: item.itemId,
        }));
        return [...iconEntries(symbols).slice(0, PALETTE_LIMIT - waiting.length), ...waiting];
      }
      return iconEntries(symbols);
    }
    return matchPalette(query, commands, scenes);
  }, [mode, query, commands, scenes, catalog, starter, unnamed, naming]);

  // A shrinking list must never leave the cursor pointing past its end.
  const active = Math.min(cursor, Math.max(entries.length - 1, 0));
  useEffect(() => {
    const el = listRef.current?.children[active];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active, entries.length]);

  const run = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      // Closed first: every command opens a modal, a dialog or a menu of its
      // own, and none of them should come up behind this.
      // Naming stays inside (D131): the palette becomes the pen, everything
      // else closes first so its own surface can come up in front.
      if (entry.kind === "unnamed") {
        setNaming(entry.itemId);
        setQuery("");
        setCursor(0);
        return;
      }
      onClose();
      if (entry.kind === "command") entry.command.run();
      else if (entry.kind === "symbol") onInsertSymbol(entry.symbol.symbol);
      else onOpenScene(entry.scene);
    },
    [onClose, onOpenScene, onInsertSymbol],
  );

  // The pen writes (D131): Enter commits the typed name, Escape puts the
  // pen down and the door is a search again.
  const commitName = useCallback(() => {
    if (!naming || !query.trim()) return;
    void onNameItem(naming, query.trim()).then(() => {
      setNaming(null);
      setQuery("");
      setCursor(0);
      setShelfNonce((n) => n + 1);
    });
  }, [naming, query, onNameItem]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // The palette's own chords switch the open palette between its two
    // doors (D124) — the input has focus, so nobody else can hear them.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      onMode(event.shiftKey ? "icons" : "commands");
      setCursor(0);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // While the pen is out (D131), Enter writes and Escape puts it down.
    if (naming) {
      if (event.key === "Enter") commitName();
      else if (event.key === "Escape") {
        setNaming(null);
        setQuery("");
      } else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Only the four keys this owns are taken; everything else — typing,
    // selection, the platform's own editing chords — is the input's.
    switch (event.key) {
      case "ArrowDown":
        setCursor(entries.length ? (active + 1) % entries.length : 0);
        break;
      case "ArrowUp":
        setCursor(entries.length ? (active + entries.length - 1) % entries.length : 0);
        break;
      case "Enter":
        run(entries[active]);
        break;
      case "Escape":
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="docent-palette-backdrop"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="docent-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "icons" ? "Insert an icon" : "Commands and scenes"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="docent-palette-input"
          autoFocus
          spellCheck={false}
          placeholder={
            naming ? "Name this icon…" : mode === "icons" ? "Insert an icon…" : "Commands and scenes…"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          aria-label={mode === "icons" ? "Insert an icon" : "Commands and scenes"}
        />
        {naming ? (
          <div className="docent-palette-naming">
            <IconThumb itemId={naming} />
            <span>Type the name agents will know it by, then press Enter. Esc cancels.</span>
          </div>
        ) : entries.length === 0 ? (
          <p className="docent-palette-empty">
            {mode === "icons" ? "No icon by that name." : "Nothing by that name."}
          </p>
        ) : (
          <ul className="docent-palette-list" ref={listRef} role="listbox">
            {entries.map((entry, index) => (
              <li
                key={entry.key}
                role="option"
                aria-selected={index === active}
                className={[
                  "docent-palette-row",
                  index === active ? "is-active" : "",
                  entry.kind === "scene" ? "is-scene" : "",
                  entry.kind === "symbol" ? "is-symbol" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseMove={() => setCursor(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(entry);
                }}
              >
                {entry.kind === "symbol" && <IconThumb symbol={entry.symbol.symbol} />}
                {entry.kind === "unnamed" && <IconThumb itemId={entry.itemId} />}
                <span className="docent-palette-label">
                  {entry.kind === "scene" ? (
                    <SceneLabel entry={entry} />
                  ) : (
                    <Marked text={entry.label} matched={entry.matched} />
                  )}
                </span>
                {entry.kind === "command" && entry.command.hint && (
                  <span className="docent-palette-hint">{entry.command.hint}</span>
                )}
                {entry.kind === "command" && entry.command.shortcut && (
                  <kbd className="docent-palette-shortcut">
                    {entry.command.shortcut}
                  </kbd>
                )}
                {entry.kind === "scene" && (
                  <span className="docent-palette-hint">scene</span>
                )}
                {entry.kind === "symbol" && (
                  <span className="docent-palette-hint">{entry.symbol.symbol}</span>
                )}
                {entry.kind === "unnamed" && (
                  <span className="docent-palette-hint">Enter names it</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
