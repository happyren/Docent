/**
 * Portfolio modal (S12): browse the deployment's projects and scenes,
 * open a scene, save the current scene into a project, create and delete
 * both. Storage is the deployment's file tree of plain `.excalidraw`
 * files (D17) behind the same-origin store (D18); when the store isn't
 * deployed the modal says so and the file workflows stay untouched.
 */
import { useCallback, useEffect, useState } from "react";
import {
  createProject,
  deleteProject,
  deleteScene,
  listProjects,
  listScenes,
  storeAvailable,
  type ProjectInfo,
  type SceneInfo,
} from "../portfolio/client";

export interface PortfolioModalProps {
  /** Load a portfolio scene into the canvas. Resolves when loaded. */
  onOpenScene: (project: string, scene: string) => Promise<void>;
  /** Save the current canvas into a project. Resolves when saved. */
  onSaveScene: (project: string, scene: string) => Promise<void>;
  /** Suggested name for "save current scene" (current file name). */
  suggestedName: string;
  onClose: () => void;
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

export function PortfolioModal({
  onOpenScene,
  onSaveScene,
  suggestedName,
  onClose,
}: PortfolioModalProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [newProject, setNewProject] = useState("");
  const [saveName, setSaveName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);

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
                  <div className="docent-portfolio-list">
                    {scenes.length === 0 && (
                      <p className="docent-modal-hint">
                        No scenes in {selected} yet — save the current one
                        below.
                      </p>
                    )}
                    {scenes.map((s) => (
                      <div key={s.name} className="docent-portfolio-item">
                        <button
                          className="docent-portfolio-open"
                          disabled={busy}
                          onClick={() => openScene(s.name)}
                          title={`Open ${selected}/${s.name}`}
                        >
                          {s.name}
                        </button>
                        <span className="docent-portfolio-meta">
                          {fmtTime(s.updatedAt)}
                        </span>
                        <button
                          className="docent-portfolio-delete"
                          title="Delete scene"
                          disabled={busy}
                          onClick={() => removeScene(s.name)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="docent-portfolio-new">
                    <input
                      placeholder="Scene name…"
                      value={saveName}
                      disabled={busy}
                      onChange={(e) => setSaveName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveHere()}
                    />
                    <button
                      disabled={busy || !saveName.trim()}
                      onClick={saveHere}
                      title={`Save the current scene into ${selected}`}
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
