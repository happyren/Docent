/**
 * Portfolio modal (S12): browse the deployment's projects and scenes,
 * open a scene, save the current scene into a project, create and delete
 * both. Storage is the deployment's file tree of plain `.excalidraw`
 * files (D17) behind the same-origin store (D18); when the store isn't
 * deployed the modal says so and the file workflows stay untouched.
 *
 * A project may instead be bound to a GitHub repository (S14): the GitHub
 * strip below the scene grid is where that is set up, changed, and undone, and
 * a bound project wears a ⛓ in the list — plus a "read-only" tag when the
 * store's bind-time probe found a token that can read the repository but not
 * write to it. Everything else about the modal is the same either way — the
 * store makes a bound project look like any other.
 *
 * The strip's branch row (D28) is the repository's own review flow: pick a
 * branch to work on, cut a new one to draft in, and open a pull request back
 * onto the base when the drafting is done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBranch,
  createProject,
  deleteBinding,
  deleteProject,
  deleteScene,
  getBinding,
  listBranches,
  listProjects,
  listScenes,
  openPullRequest,
  putBinding,
  saveScene,
  storeAvailable,
  switchBranch,
  type Binding,
  type BranchInfo,
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
function SceneThumb({
  project,
  scene,
  revision,
}: {
  project: string;
  scene: SceneInfo;
  revision: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    // The revision the thumbnail cache keys on. A bound project stamps every
    // scene with the branch's last commit, so any change there re-renders all
    // of them — and an unknown stamp simply never invalidates. `revision` is
    // what covers the case a timestamp cannot: two branches whose scenes share
    // a name and a last-commit date are still two different pictures.
    portfolioThumbnail(project, scene.name, `${scene.updatedAt ?? "unknown"}#${revision}`)
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [project, scene.name, scene.updatedAt, revision]);
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

/** The binding form's fields, all of them optional except owner and repo. */
const EMPTY_FORM = {
  owner: "",
  repo: "",
  path: "",
  branch: "",
  apiBase: "",
  token: "",
};

/** What a new branch is called unless the user says otherwise (D28). */
const suggestedBranch = () =>
  `docent/diagrams-${new Date().toISOString().slice(0, 10)}`;

/**
 * The branch row (D28): which branch this project's scenes come from and go
 * to, a way to cut a new one, and — once the project is off its base — the
 * pull request that puts the drafts up for review.
 *
 * Every action here changes what the scene grid should be showing, so each one
 * ends in `onChanged`, which re-reads the binding, the scene listing, and the
 * thumbnails.
 */
function BranchRow({
  project,
  binding,
  disabled,
  onChanged,
}: {
  project: string;
  binding: Binding;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBranches(null);
    listBranches(project)
      // A repository that cannot be listed is not a reason to hide the row:
      // the active branch is still known, and it is still switchable back to.
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches([]));
    return () => {
      live = false;
    };
  }, [project, binding.branch, binding.baseBranch]);

  // The listing is one page (the store says so), and a branch created outside
  // Docent may not be on it — so the branch actually in use is always an
  // option, or the select would render blank.
  const options = useMemo(() => {
    const listed = branches ?? [];
    if (listed.some((entry) => entry.name === binding.branch)) return listed;
    return [
      {
        name: binding.branch,
        isBase: binding.branch === binding.baseBranch,
        isActive: true,
      },
      ...listed,
    ];
  }, [branches, binding.branch, binding.baseBranch]);

  const act = (action: () => Promise<void>) =>
    void (async () => {
      setBusy(true);
      try {
        await action();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();

  const pick = (branch: string) => {
    if (branch === binding.branch) return;
    act(async () => {
      await switchBranch(project, branch);
      await onChanged();
    });
  };

  const cut = () =>
    act(async () => {
      const wanted = name.trim();
      if (!wanted) return;
      // The store switches the binding to the new branch as part of creating
      // it, so there is nothing to do here but re-read everything.
      await createBranch(project, wanted);
      setNaming(false);
      setName("");
      await onChanged();
    });

  const propose = () =>
    act(async () => {
      const pull = await openPullRequest(project);
      // The system webview can quietly ignore window.open — nothing happens,
      // no error — so the alert is what actually guarantees the user leaves
      // with the URL. It is deliberately not one or the other.
      window.open(pull.url, "_blank");
      window.alert(`Pull request #${pull.number} opened:\n\n${pull.url}`);
    });

  const working = busy || disabled;
  const drafting = binding.branch !== binding.baseBranch;

  return (
    <div className="docent-portfolio-github-branches">
      <span className="docent-portfolio-github-label">Branch</span>
      <select
        value={binding.branch}
        disabled={working || branches === null}
        title="Scenes are read from and saved to this branch"
        onChange={(e) => pick(e.target.value)}
      >
        {options.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.isBase ? `${entry.name} (base)` : entry.name}
          </option>
        ))}
      </select>
      {naming ? (
        <>
          <input
            autoFocus
            value={name}
            disabled={working}
            placeholder={suggestedBranch()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") cut();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button disabled={working || !name.trim()} onClick={cut}>
            Create
          </button>
          <button disabled={working} onClick={() => setNaming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          disabled={working}
          title={`Branch off ${binding.branch} and draft there`}
          onClick={() => {
            setName(suggestedBranch());
            setNaming(true);
          }}
        >
          ＋ Branch
        </button>
      )}
      {/* Only once there is something to review: on the base branch a pull
          request would have nowhere to go. */}
      {drafting && !naming && (
        <button
          disabled={working}
          title={`Open a pull request from ${binding.branch} into ${binding.baseBranch}`}
          onClick={propose}
        >
          Open PR
        </button>
      )}
    </div>
  );
}

/**
 * The GitHub strip (S14) for the selected project: connect it to a repository,
 * change where it points, replace its token, or disconnect it. The token field
 * is write-only in both directions — the store never sends one back, so an
 * empty field on an existing binding means "keep the one you have".
 */
function GitHubPanel({
  project,
  onChanged,
}: {
  project: string;
  onChanged: () => void;
}) {
  const [binding, setBinding] = useState<Binding | null | undefined>(undefined);
  const [form, setForm] = useState(EMPTY_FORM);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setBinding(undefined);
    setOpen(false);
    getBinding(project)
      .then((found) => live && setBinding(found))
      // A store that cannot answer at all is the modal's problem, not this
      // strip's: it renders as "not connected" and the buttons still work.
      .catch(() => live && setBinding(null));
    return () => {
      live = false;
    };
  }, [project]);

  const edit = (patch: Partial<typeof EMPTY_FORM>) =>
    setForm((current) => ({ ...current, ...patch }));

  /**
   * What every branch action ends with: the binding moved, so re-read it and
   * tell the modal that its scene listing and thumbnails are about a branch
   * that is no longer the one on screen.
   */
  const reload = async () => {
    setBinding(await getBinding(project));
    onChanged();
  };

  const openForm = () => {
    setForm({
      owner: binding?.owner ?? "",
      repo: binding?.repo ?? "",
      path: binding?.path ?? "",
      branch: binding?.branch ?? "",
      apiBase: binding?.apiBase ?? "",
      token: "",
    });
    setOpen(true);
  };

  const submit = () => {
    void (async () => {
      setBusy(true);
      try {
        // A pasted "owner/repo" is the shape people copy out of GitHub's URL
        // bar, so accept it in either field rather than making them split it.
        let owner = form.owner.trim();
        let repo = form.repo.trim();
        const pasted = (repo.includes("/") ? repo : owner).split("/");
        if (pasted.length === 2 && pasted[0] && pasted[1]) {
          [owner, repo] = pasted;
        }
        const result = await putBinding(project, {
          owner,
          repo,
          path: form.path.trim(),
          branch: form.branch.trim(),
          apiBase: form.apiBase.trim(),
          token: form.token.trim(),
        });
        const stored = await getBinding(project);
        setBinding(stored);
        setOpen(false);
        edit({ token: "" });
        onChanged();
        // The store asked GitHub what this token may do, so say it now rather
        // than let the first save be the messenger. A read-only token is the
        // common accident: fine-grained PATs default to Contents: Read.
        const target = `${stored?.owner ?? owner}/${stored?.repo ?? repo}`;
        if (result.canWrite === false) {
          window.alert(
            `Connected read-only: scenes will open, but saving will fail. Grant the token "Contents: Read and write" on ${target}, then update the token here.`,
          );
        } else if (result.warning) {
          window.alert(result.warning);
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const disconnect = () => {
    if (!binding) return;
    if (
      !window.confirm(
        `Disconnect "${project}" from ${binding.owner}/${binding.repo}?\n\n` +
          "Nothing is deleted on GitHub, and the project's local folder — which " +
          "may still hold older scenes — comes back as its storage.",
      )
    ) {
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        await deleteBinding(project);
        setBinding(null);
        setOpen(false);
        onChanged();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (binding === undefined) {
    return <div className="docent-portfolio-github">GitHub — checking…</div>;
  }

  return (
    <div className="docent-portfolio-github">
      <div className="docent-portfolio-github-head">
        <span className="docent-portfolio-github-label">GitHub</span>
        {binding ? (
          <>
            <code className="docent-portfolio-github-target">
              {binding.owner}/{binding.repo}
              {binding.path ? `/${binding.path}` : ""}@{binding.branch}
            </code>
            {!binding.hasToken && (
              <span className="docent-portfolio-github-warn">
                no token — scenes cannot be read or written
              </span>
            )}
            <button disabled={busy} onClick={openForm}>
              Update token…
            </button>
            <button disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <span className="docent-portfolio-meta">
              Scenes live in this deployment's file tree.
            </span>
            <button disabled={busy} onClick={openForm}>
              Connect to GitHub…
            </button>
          </>
        )}
      </div>
      {/* Branches need a token to ask about at all, and the line above already
          says when there isn't one. */}
      {binding && binding.hasToken && (
        <BranchRow
          project={project}
          binding={binding}
          disabled={busy}
          onChanged={reload}
        />
      )}
      {open && (
        <div className="docent-portfolio-github-form">
          <label className="docent-field">
            Owner
            <input
              autoFocus
              placeholder="acme"
              value={form.owner}
              disabled={busy}
              onChange={(e) => edit({ owner: e.target.value })}
            />
          </label>
          <label className="docent-field">
            Repository
            <input
              placeholder="diagrams"
              value={form.repo}
              disabled={busy}
              onChange={(e) => edit({ repo: e.target.value })}
            />
          </label>
          <label className="docent-field">
            Folder in the repo
            <input
              placeholder="docs/diagrams (blank = repository root)"
              value={form.path}
              disabled={busy}
              onChange={(e) => edit({ path: e.target.value })}
            />
          </label>
          <label className="docent-field">
            Token
            <input
              type="password"
              autoComplete="off"
              placeholder={
                binding?.hasToken
                  ? "leave blank to keep the current token"
                  : "fine-grained PAT with Contents: Read and write"
              }
              value={form.token}
              disabled={busy}
              onChange={(e) => edit({ token: e.target.value })}
            />
          </label>
          <details className="docent-portfolio-github-advanced">
            <summary>Advanced</summary>
            <div className="docent-portfolio-github-form">
              <label className="docent-field">
                Branch
                <input
                  placeholder="main"
                  value={form.branch}
                  disabled={busy}
                  onChange={(e) => edit({ branch: e.target.value })}
                />
              </label>
              <label className="docent-field">
                API base
                <input
                  placeholder="https://api.github.com"
                  value={form.apiBase}
                  disabled={busy}
                  onChange={(e) => edit({ apiBase: e.target.value })}
                />
              </label>
            </div>
          </details>
          <div className="docent-portfolio-new">
            <button
              className="docent-primary"
              disabled={busy || !form.owner.trim() || !form.repo.trim()}
              onClick={submit}
            >
              {binding ? "Save binding" : "Connect"}
            </button>
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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
  // Bumped whenever the scenes on screen start coming from somewhere else —
  // a new binding, or another branch of the same repository (D28). Thumbnails
  // are cached per scene revision, and "the same name at the same timestamp on
  // a different branch" is the one case a timestamp cannot tell apart.
  const [thumbRevision, setThumbRevision] = useState(0);
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

  const refreshScenes = useCallback(async (project: string) => {
    const list = await listScenes(project);
    setScenes(list);
    // The projects listing never waits on GitHub, so a bound project's count
    // there is whatever the store last saw — and right after a binding or
    // branch change, that is nothing at all. This listing *is* that count, so
    // reconcile the sidebar from it rather than asking again.
    setProjects((current) =>
      current.map((p) =>
        p.id === project && p.bound ? { ...p, scenes: list.length } : p,
      ),
    );
  }, []);

  useEffect(() => {
    if (!selected) {
      setScenes([]);
      return;
    }
    refreshScenes(selected).catch(fail);
  }, [selected, refreshScenes]);

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

  const removeProject = (id: string, count: number, bound?: boolean) => {
    // A bound project's scenes are in someone's repository, and deleting a
    // project here must never reach into it — so the confirmation says exactly
    // what goes and what stays.
    const question = bound
      ? `Delete project "${id}"?\n\nIts GitHub connection and its local folder go. ` +
        "Nothing is deleted on GitHub."
      : `Delete project "${id}"${
          count ? ` and its ${count} scene${count === 1 ? "" : "s"}` : ""
        }? This cannot be undone.`;
    if (!window.confirm(question)) return;
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
                    {p.bound && (
                      <span
                        className="docent-portfolio-bound"
                        title="Scenes live in a GitHub repository"
                      >
                        ⛓
                      </span>
                    )}
                    {/* Only ever shown when the store *knows* the token cannot
                        write — an unverified binding says nothing here. */}
                    {p.canWrite === false && (
                      <span
                        className="docent-portfolio-readonly"
                        title={
                          "The stored token can read this repository but not write to it — " +
                          'scenes open, saving fails. Grant it "Contents: Read and write".'
                        }
                      >
                        read-only
                      </span>
                    )}
                    <span className="docent-portfolio-meta">
                      {p.scenes} scene{p.scenes === 1 ? "" : "s"}
                    </span>
                    <button
                      className="docent-portfolio-delete"
                      title="Delete project"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeProject(p.id, p.scenes, p.bound);
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
                        <SceneThumb
                          project={selected}
                          scene={s}
                          revision={thumbRevision}
                        />
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
                  <GitHubPanel
                    project={selected}
                    onChanged={() => {
                      // Binding, unbinding, and switching branches all swap
                      // where the scenes come from, so both listings — and
                      // every thumbnail — are stale the moment it lands. The
                      // scene listing goes second on purpose: it is what puts
                      // the bound project's count back into the sidebar.
                      setThumbRevision((revision) => revision + 1);
                      void (async () => {
                        await refreshProjects();
                        await refreshScenes(selected);
                      })().catch(fail);
                    }}
                  />
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
