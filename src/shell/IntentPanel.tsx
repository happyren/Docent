/**
 * Intent capture UI (S10): element annotations — tags, intents (one per
 * line, D41), logic (D42), the scene link (D95, D97) — and frame
 * narratives/order. Renders for a single-element selection; writes go
 * through the adapter into `customData.docent.*`.
 *
 * Saving is never invisible (D40): fields commit on blur as before, on the
 * Save button (⌘↩), and when the panel goes away — a new selection remounts
 * it, and the outgoing instance commits whatever was still pending. The
 * header says *Unsaved* while anything differs from the scene and *Saved*
 * once it matches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocentCanvasHandle, ElementInfo } from "../adapter";
import type { SceneLink } from "../adapter/snapshot";
import { buildSceneGraph } from "../scene/graph";
import { listScenes, type SceneInfo } from "../portfolio/client";
import {
  displayPath,
  folderOf,
  isScenePath,
  leafOf,
  normalizeScenePath,
  SCENE_PATH_ERROR,
  segmentsOf,
} from "../portfolio/tree";

/**
 * Refinement targets for one side of a selected edge (D21): the members
 * of the bound endpoint's detail diagram, labeled for a dropdown.
 */
interface RefineSide {
  endpointLabel: string;
  current: string | null;
  options: { id: string; label: string }[];
}

/** Split the one-per-line intents field, dropping blank lines. */
export function parseIntents(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A link as the panel says it: `project / path # at`. */
function linkLabel(link: SceneLink, here: string | null): string {
  const project = link.project ?? here;
  return `${project ? `${project} / ` : ""}${displayPath(link.scene)}${link.at ? ` # ${link.at}` : ""}`;
}

export function IntentPanel({
  canvas,
  selection,
  project,
  onFollow,
}: {
  canvas: DocentCanvasHandle;
  selection: ElementInfo;
  /** The open scene's project (D95): what a link that names none means. */
  project: string | null;
  /** Follow this element's link — the shell owns the jump (D96). */
  onFollow?: (elementId: string, link: SceneLink) => void;
}) {
  const isFrame = selection.type === "frame";
  const isEdge = selection.type === "arrow" || selection.type === "line";

  // For a selected edge whose endpoints declare detail diagrams, offer
  // "lands on / departs from" pickers over those diagrams' components.
  const refineSides = useMemo(() => {
    if (!isEdge) return null;
    const snapshot = canvas.getSceneSnapshot();
    const graph = buildSceneGraph(snapshot);
    const edge = graph.edges.find((e) => e.sourceId === selection.id);
    if (!edge) return null;
    const declared =
      snapshot.elements.find((el) => el.id === selection.id)?.docent.refine ??
      null;
    const side = (
      endpointId: string | null,
      declaredId: string | null,
    ): RefineSide | null => {
      if (!endpointId) return null;
      const endpoint = graph.nodes.find((n) => n.id === endpointId);
      if (!endpoint?.detailFrameId) return null;
      const options = graph.nodes
        .filter((n) => n.frameId === endpoint.detailFrameId)
        .map((n) => ({ id: n.sourceId, label: n.label ?? n.id }));
      if (!options.length) return null;
      return {
        endpointLabel: endpoint.label ?? endpoint.id,
        current: declaredId,
        options,
      };
    };
    const to = side(edge.to, declared?.to ?? null);
    const from = side(edge.from, declared?.from ?? null);
    return to || from ? { to, from } : null;
  }, [canvas, selection.id, isEdge]);

  // What the scene says right now — the baseline "saved" reads against.
  const saved = useMemo(
    () => ({
      tags: selection.tags.join(", "),
      intents: selection.intents.join("\n"),
      logic: selection.logic ?? "",
      narrative: selection.narrative ?? "",
      order: selection.order !== null ? String(selection.order) : "",
    }),
    [selection],
  );
  const [tags, setTags] = useState(saved.tags);
  const [intents, setIntents] = useState(saved.intents);
  const [logic, setLogic] = useState(saved.logic);
  const [narrative, setNarrative] = useState(saved.narrative);
  const [order, setOrder] = useState(saved.order);
  const [justSaved, setJustSaved] = useState(false);

  // The scene link (D95, D97). It writes on its own the moment a target is
  // named — like the edge refinement beside it, and unlike the text fields,
  // it is a choice, not a sentence being typed.
  const link = selection.link ?? null;
  const [at, setAt] = useState(link?.at ?? "");
  const [typed, setTyped] = useState("");
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  useEffect(() => {
    if (!project) return;
    let live = true;
    // No store, no picker: the typed form still names a scene (I5).
    void listScenes(project)
      .then((list) => live && setScenes(list))
      .catch(() => live && setScenes([]));
    return () => {
      live = false;
    };
  }, [project]);
  /** The project's scenes grouped by the folder they sit in (D92, D93). */
  const byFolder = useMemo(() => {
    const groups = new Map<string, SceneInfo[]>();
    for (const info of scenes) {
      const folder = folderOf(info.name);
      groups.set(folder, [...(groups.get(folder) ?? []), info]);
    }
    return [...groups.entries()];
  }, [scenes]);

  const writeLink = (next: SceneLink | null) => {
    setLinkProblem(null);
    canvas.setElementLink(selection.id, next);
  };
  /** Retarget the link, keeping the arrival point the author typed. */
  const linkTo = (scene: string, toProject?: string) => {
    const point = at.trim();
    writeLink({
      scene,
      ...(toProject ? { project: toProject } : {}),
      ...(point ? { at: point } : {}),
    });
  };
  /** The typed cross-project form: `project/path`, the project one segment. */
  const commitTyped = () => {
    const path = normalizeScenePath(typed);
    if (!path) return;
    const [toProject, ...rest] = segmentsOf(path);
    const scene = rest.join("/");
    if (!scene || !isScenePath(scene) || !isScenePath(toProject)) {
      setLinkProblem(`project / path — ${SCENE_PATH_ERROR}`);
      return;
    }
    setTyped("");
    linkTo(scene, toProject);
  };

  useEffect(() => {
    setTags(saved.tags);
    setIntents(saved.intents);
    setLogic(saved.logic);
    setNarrative(saved.narrative);
    setOrder(saved.order);
  }, [selection.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = isFrame
    ? narrative.trim() !== saved.narrative.trim() || order.trim() !== saved.order
    : parseIntents(intents).join("\n") !== parseIntents(saved.intents).join("\n") ||
      logic.trim() !== saved.logic.trim() ||
      tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .join(",") !==
        saved.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .join(",");

  const commitElement = () => {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const intentList = parseIntents(intents);
    canvas.setElementIntent(selection.id, {
      tags: tagList.length ? tagList : null,
      intents: intentList.length ? intentList : null,
      logic: logic.trim() || null,
    });
  };

  const commitFrame = () => {
    const parsed = Number.parseFloat(order);
    canvas.setFrameIntent(selection.id, {
      narrative: narrative.trim() || null,
      order: Number.isFinite(parsed) ? parsed : null,
    });
  };

  const commit = () => {
    if (isFrame) commitFrame();
    else commitElement();
    setJustSaved(true);
  };

  // The outgoing instance commits what was still pending (D40): a new
  // selection remounts this panel, and a click elsewhere must not cost the
  // author the sentence they were typing. Refs, so the cleanup sees the
  // latest values rather than the ones from the render that scheduled it.
  const latest = useRef({ dirty, commit });
  latest.current = { dirty, commit };
  useEffect(
    () => () => {
      if (latest.current.dirty) latest.current.commit();
    },
    [],
  );

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  const status = dirty ? "Unsaved" : justSaved ? "Saved ✓" : "Saved";

  return (
    <aside className="docent-intent" onKeyDown={onKeyDown}>
      <header className="docent-intent-header">
        <span className="docent-intent-title">
          {isFrame ? "Frame intent" : "Element intent"}
        </span>
        <span className="docent-intent-target">
          {selection.label ?? (isFrame ? "frame" : selection.type)}
        </span>
      </header>
      {isFrame ? (
        <>
          <label className="docent-field">
            <span>Narrative — what this section means</span>
            <textarea
              value={narrative}
              rows={3}
              placeholder="One or two sentences; narrates tours and rides the export."
              onChange={(e) => setNarrative(e.target.value)}
              onBlur={commitFrame}
            />
          </label>
          <label className="docent-field">
            <span>Presentation order (overrides name order)</span>
            <input
              type="number"
              value={order}
              placeholder="e.g. 1"
              onChange={(e) => setOrder(e.target.value)}
              onBlur={commitFrame}
            />
          </label>
        </>
      ) : (
        <>
          <label className="docent-field">
            <span>Tags (comma-separated)</span>
            <input
              value={tags}
              placeholder="hot-path, legacy"
              onChange={(e) => setTags(e.target.value)}
              onBlur={commitElement}
            />
          </label>
          <label className="docent-field">
            <span>Intents — one per line</span>
            <textarea
              value={intents}
              rows={3}
              placeholder={"carries order events\nretries on failure"}
              onChange={(e) => setIntents(e.target.value)}
              onBlur={commitElement}
            />
          </label>
          <label className="docent-field">
            <span>Logic — pseudocode or rules (a snippet here; a mechanism is a detail layer)</span>
            <textarea
              className="docent-logic"
              value={logic}
              rows={4}
              spellCheck={false}
              placeholder={"if retries > 3:\n  park in dead-letter"}
              onChange={(e) => setLogic(e.target.value)}
              onBlur={commitElement}
            />
          </label>
          {refineSides?.to && (
            <label className="docent-field">
              <span>Lands on — inside {refineSides.to.endpointLabel}'s detail</span>
              <select
                value={refineSides.to.current ?? ""}
                onChange={(e) =>
                  canvas.setEdgeRefine(selection.id, {
                    to: e.target.value || null,
                  })
                }
              >
                <option value="">(whole {refineSides.to.endpointLabel})</option>
                {refineSides.to.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {refineSides?.from && (
            <label className="docent-field">
              <span>
                Departs from — inside {refineSides.from.endpointLabel}'s detail
              </span>
              <select
                value={refineSides.from.current ?? ""}
                onChange={(e) =>
                  canvas.setEdgeRefine(selection.id, {
                    from: e.target.value || null,
                  })
                }
              >
                <option value="">(whole {refineSides.from.endpointLabel})</option>
                {refineSides.from.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {/* Dive when it is this diagram going deeper; link when it is another
          diagram's story (D95). The target is picked, never typed twice. */}
      <div className="docent-field docent-link">
        <span>Links to — another diagram's story</span>
        {link ? (
          <div className="docent-link-current">
            <span className="docent-link-target" title={linkLabel(link, project)}>
              {linkLabel(link, project)}
            </span>
            <button type="button" onClick={() => onFollow?.(selection.id, link)}>
              Follow ↗
            </button>
            <button type="button" onClick={() => writeLink(null)}>
              Clear
            </button>
          </div>
        ) : null}
        <select
          value={link && !link.project ? link.scene : ""}
          onChange={(e) => e.target.value && linkTo(e.target.value)}
        >
          <option value="">
            {project ? `${project} — pick a scene…` : "(a loose file — type a project / path)"}
          </option>
          {byFolder.map(([folder, list]) =>
            folder ? (
              <optgroup key={folder} label={displayPath(folder)}>
                {list.map((info) => (
                  <option key={info.name} value={info.name}>
                    {leafOf(info.name)}
                  </option>
                ))}
              </optgroup>
            ) : (
              list.map((info) => (
                <option key={info.name} value={info.name}>
                  {info.name}
                </option>
              ))
            ),
          )}
        </select>
        <input
          value={typed}
          placeholder="another project — project / path"
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commitTyped}
        />
        <input
          value={at}
          placeholder="arrive at (component id) — optional"
          onChange={(e) => setAt(e.target.value)}
          onBlur={() => {
            if (!link) return;
            const point = at.trim();
            if ((link.at ?? "") === point) return;
            writeLink({ ...link, at: point || undefined });
          }}
        />
        {linkProblem && <span className="docent-link-problem">{linkProblem}</span>}
      </div>
      <div className="docent-intent-actions">
        <span className={dirty ? "docent-intent-status docent-intent-unsaved" : "docent-intent-status"}>
          {status}
        </span>
        <button type="button" className="docent-intent-save" onClick={commit} disabled={!dirty}>
          Save ⌘↩
        </button>
      </div>
    </aside>
  );
}
