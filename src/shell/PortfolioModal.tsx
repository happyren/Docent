/**
 * Portfolio modal (S12): browse the deployment's projects and scenes,
 * open a scene, save the current scene into a project, create and delete
 * both. Storage is the deployment's file tree of plain `.excalidraw`
 * files (D17) behind the same-origin store (D18); when the store isn't
 * deployed the modal says so and the file workflows stay untouched.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProject,
  deleteProject,
  deleteScene,
  listProjects,
  listScenes,
  saveScene,
  storeAvailable,
  type ProjectInfo,
  type SceneInfo,
} from "../portfolio/client";
import { portfolioThumbnail } from "./sceneThumbnails";

/** A brand-new scene is just an empty `.excalidraw` file (D17). */
const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "docent",
  elements: [],
  appState: {},
  files: {},
});

/** Large Layer-1 snapshot of a scene, rendered lazily and cached. */
function SceneThumb({ project, scene }: { project: string; scene: SceneInfo }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    portfolioThumbnail(project, scene.name, scene.updatedAt)
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [project, scene.name, scene.updatedAt]);
  if (src === null) {
    return <div className="docent-scene-thumb is-loading">rendering…</div>;
  }
  if (src === "") {
    return <div className="docent-scene-thumb is-loading">no preview</div>;
  }
  return (
    <img className="docent-scene-thumb" src={src} alt={`${scene.name} preview`} />
  );
}

/**
 * Why the modal was opened. "save" is the desktop's Save with nowhere to save
 * to yet: the portfolio is that app's file system, so the modal stands in for
 * a save dialog and opens on the name field with its text selected.
 */
export type PortfolioIntent = "browse" | "save";

export interface PortfolioModalProps {
  /** Load a portfolio scene into the canvas. Resolves when loaded. */
  onOpenScene: (project: string, scene: string) => Promise<void>;
  /** Save the current canvas into a project. Resolves when saved. */
  onSaveScene: (project: string, scene: string) => Promise<void>;
  /** Suggested name for "save current scene" (current file name). */
  suggestedName: string;
  intent?: PortfolioIntent;
  onClose: () => void;
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

export function PortfolioModal({
  onOpenScene,
  onSaveScene,
  suggestedName,
  intent = "browse",
  onClose,
}: PortfolioModalProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [newProject, setNewProject] = useState("");
  const [saveName, setSaveName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const saveNameRef = useRef<HTMLInputElement | null>(null);

  const fail = (err: unknown) =>
    window.alert(err instanceof Error ? err.message : String(err));

  const refreshProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    setSelected((cur) =>
      cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await storeAvailable();
      setAvailable(ok);
      if (ok) await refreshProjects().catch(fail);
    })();
  }, [refreshProjects]);

  useEffect(() => {
    if (!selected) {
      setScenes([]);
      return;
    }
    listScenes(selected).then(setScenes).catch(fail);
  }, [selected]);

  // Opened to save: put the caret in the name field with the suggestion
  // selected, so typing replaces it. The field only exists once a project is
  // selected, so this waits for the listing rather than firing only on mount.
  useEffect(() => {
    if (intent !== "save") return;
    const input = saveNameRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [intent, available, selected]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const addProject = () =>
    run(async () => {
      const id = newProject.trim();
      if (!id) return;
      await createProject(id);
      setNewProject("");
      await refreshProjects();
      setSelected(id);
    });

  const removeProject = (id: string, count: number) => {
    const detail = count ? ` and its ${count} scene${count === 1 ? "" : "s"}` : "";
    if (!window.confirm(`Delete project "${id}"${detail}? This cannot be undone.`))
      return;
    void run(async () => {
      await deleteProject(id);
      await refreshProjects();
    });
  };

  const removeScene = (name: string) => {
    if (!selected) return;
    if (!window.confirm(`Delete scene "${selected}/${name}"? This cannot be undone.`))
      return;
    void run(async () => {
      await deleteScene(selected, name);
      setScenes(await listScenes(selected));
      await refreshProjects();
    });
  };

  const openScene = (name: string) => {
    if (!selected) return;
    void run(async () => {
      await onOpenScene(selected, name);
      onClose();
    });
  };

  const newScene = () => {
    if (!selected) return;
    void run(async () => {
      const name = saveName.trim().replace(/\.excalidraw$/i, "");
      if (!name) return;
      if (scenes.some((s) => s.name === name)) {
        window.alert(
          `Scene "${selected}/${name}" already exists — pick another name, or use "Save current scene here" to overwrite it.`,
        );
        return;
      }
      await saveScene(selected, name, EMPTY_SCENE);
      await onOpenScene(selected, name);
      onClose();
    });
  };

  const saveHere = () => {
    if (!selected) return;
    void run(async () => {
      const name = saveName.trim().replace(/\.excalidraw$/i, "");
      if (!name) return;
      const exists = scenes.some((s) => s.name === name);
      if (
        exists &&
        !window.confirm(`Overwrite scene "${selected}/${name}"?`)
      ) {
        return;
      }
      await onSaveScene(selected, name);
      setScenes(await listScenes(selected));
      await refreshProjects();
    });
  };

  return (
    <div className="docent-modal-backdrop" onClick={onClose}>
      <div
        className="docent-modal docent-portfolio"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="docent-modal-header">
          <span>Portfolio — projects &amp; scenes</span>
        </header>
        {available === null && <p className="docent-modal-hint">Connecting…</p>}
        {available === false && (
          <p className="docent-modal-hint">
            The portfolio store is not available on this deployment. Run the
            docker compose stack (which includes it), or start it in dev with
            <code> node server/docent-store.mjs</code>. Local file open/save
            keep working either way.
          </p>
        )}
        {available && (
          <div className="docent-portfolio-body">
            <aside className="docent-portfolio-projects">
              <div className="docent-portfolio-list">
                {projects.length === 0 && (
                  <p className="docent-modal-hint">No projects yet.</p>
                )}
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className={
                      "docent-portfolio-item" +
                      (p.id === selected ? " is-selected" : "")
                    }
                    onClick={() => setSelected(p.id)}
                  >
                    <span className="docent-portfolio-name">{p.id}</span>
                    <span className="docent-portfolio-meta">
                      {p.scenes} scene{p.scenes === 1 ? "" : "s"}
                    </span>
                    <button
                      className="docent-portfolio-delete"
                      title="Delete project"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeProject(p.id, p.scenes);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="docent-portfolio-new">
                <input
                  placeholder="New project…"
                  value={newProject}
                  disabled={busy}
                  onChange={(e) => setNewProject(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addProject()}
                />
                <button disabled={busy || !newProject.trim()} onClick={() => void addProject()}>
                  Add
                </button>
              </div>
            </aside>
            <section className="docent-portfolio-scenes">
              {!selected && (
                <p className="docent-modal-hint">
                  Create a project to hold scenes.
                </p>
              )}
              {selected && (
                <>
                  <div className="docent-portfolio-grid">
                    {scenes.length === 0 && (
                      <p className="docent-modal-hint">
                        No scenes in {selected} yet — create one below, or
                        save the current canvas into it.
                      </p>
                    )}
                    {scenes.map((s) => (
                      <div
                        key={s.name}
                        className="docent-scene-card"
                        onClick={() => !busy && openScene(s.name)}
                        title={`Open ${selected}/${s.name}`}
                      >
                        <SceneThumb project={selected} scene={s} />
                        <div className="docent-scene-caption">
                          <span className="docent-portfolio-name">{s.name}</span>
                          <span className="docent-portfolio-meta">
                            {fmtTime(s.updatedAt)}
                          </span>
                          <button
                            className="docent-portfolio-delete"
                            title="Delete scene"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeScene(s.name);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="docent-portfolio-new">
                    <input
                      ref={saveNameRef}
                      placeholder="Scene name…"
                      value={saveName}
                      disabled={busy}
                      autoFocus={intent === "save"}
                      onChange={(e) => setSaveName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && newScene()}
                    />
                    <button
                      disabled={busy || !saveName.trim()}
                      onClick={newScene}
                      title={`Create a blank scene in ${selected} and open it`}
                    >
                      ＋ New scene
                    </button>
                    <button
                      disabled={busy || !saveName.trim()}
                      onClick={saveHere}
                      title={`Save the current canvas into ${selected}`}
                    >
                      Save current scene here
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
        <div className="docent-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
