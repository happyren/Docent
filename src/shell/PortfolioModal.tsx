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
 * store makes a bound project look like any other, because a bound project's
 * scenes really are local files (D29).
 *
 * The strip's branch row (D28) is the repository's own review flow: pick a
 * branch to work on, cut a new one to draft in, and open a pull request back
 * onto the base when the drafting is done. Below it the sync row (D29) is the
 * synchronization itself: where this copy stands, pull, push, and the
 * per-scene questions a pull could not answer on its own.
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
  pull,
  push,
  pushReviewImages,
  putBinding,
  resolveConflict,
  saveScene,
  storeAvailable,
  switchBranch,
  syncStatus,
  type Binding,
  type BranchInfo,
  type ProjectInfo,
  type SceneInfo,
  type SceneSyncState,
  type SyncStatus,
} from "../portfolio/client";
import {
  beginSync,
  endSync,
  onAutoCommit,
  suggestedBranch,
} from "../portfolio/autoCommit";
import { base64Of, renderCrop } from "../review/images";
import {
  imagePath,
  labelFor,
  projectChangelog,
  pullRequestBody,
  pushExtrasFor,
  pushesOf,
  rememberPush,
  reviewProject,
  type PushedReview,
} from "../review/session";
import { alertDialog, confirmDialog } from "./dialogs";
import { ReviewPanel, type ReviewJump } from "./ReviewPanel";
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
  // The opt-in review artifacts (D49): off until asked for.
  reviewImages: false,
  reviewSidecars: false,
};

/**
 * The one-line summary of where a bound project stands: what the working copy
 * did, what the branch did, and — on the protected trunk (D33) — why Push is
 * not on offer. Derived entirely from one sync-status answer, so it says the
 * same thing the buttons beside it do.
 */
function summarize(sync: SyncStatus | null): string {
  if (!sync) return "checking…";
  const counts = new Map<SceneSyncState, number>();
  for (const scene of sync.local) {
    if (scene.state === "clean") continue;
    counts.set(scene.state, (counts.get(scene.state) ?? 0) + 1);
  }
  // A fixed order so the line never reshuffles between refreshes, with the
  // state that blocks a push named first.
  const order: SceneSyncState[] = ["conflicted", "modified", "new", "deleted"];
  const changes = order
    .filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)} ${state}`);
  const local = changes.length > 0 ? changes.join(", ") : "clean";
  const remote = !sync.remote.reachable
    ? "remote unreachable"
    : sync.remote.changed.length + sync.remote.removed.length > 0
      ? "remote ahead"
      : "up to date";
  const parts = [local, remote];
  if (sync.branch === sync.baseBranch) {
    parts.push(`on ${sync.baseBranch} — create a branch to push`);
  }
  return parts.join(" · ");
}

/** Everything a push would carry — what makes the button worth pressing. */
const hasPushable = (sync: SyncStatus | null) =>
  sync?.local.some((scene) => scene.state !== "clean") ?? false;

const conflictsOf = (sync: SyncStatus | null) =>
  sync?.local.filter((scene) => scene.state === "conflicted") ?? [];

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
        await alertDialog(err instanceof Error ? err.message : String(err));
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
      // Prefilled with what this session pushed (D46, D49): the changelog
      // per push, and the review pictures when the binding asked for them.
      const body = pullRequestBody(binding, pushesOf(project));
      const pull = await openPullRequest(project, body ? { body } : {});
      // The system webview can quietly ignore window.open — nothing happens,
      // no error — so the alert is what actually guarantees the user leaves
      // with the URL. It is deliberately not one or the other, and on the
      // desktop it is now a native box rather than a window.alert the webview
      // would have swallowed too.
      window.open(pull.url, "_blank");
      await alertDialog(`Pull request #${pull.number} opened:\n\n${pull.url}`);
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
 * The sync row (D29, D33): where this working copy stands against the branch,
 * and the two verbs that move it. Pull fast-forwards and asks about anything
 * it could not decide; Push lands every local change as one commit — never on
 * the base branch, and never over an unanswered question.
 *
 * A conflict is not an error state to clear: it is a question with two
 * answers, one row each, and neither of them is a merge.
 */
function SyncRow({
  project,
  binding,
  sync,
  disabled,
  onChanged,
  onReview,
}: {
  project: string;
  binding: Binding;
  sync: SyncStatus | null;
  disabled: boolean;
  onChanged: () => void;
  /** Open the Review view (D48) for this project. */
  onReview: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the background checkpoint did, said where the manual verbs say their
  // own results — the author should not have to guess whether it is running.
  useEffect(
    () =>
      onAutoCommit((event) => {
        if (event.project !== project) return;
        setNote(
          event.kind === "committed"
            ? `auto-committed ${event.commit?.slice(0, 7) ?? ""}`.trim()
            : `drafting on ${event.branch}`,
        );
        onChanged();
      }),
    [project, onChanged],
  );

  /**
   * Run one verb, holding the project so the background checkpoint cannot
   * overlap it, and saying loudly whatever the store refused with.
   */
  const act = (label: string, action: () => Promise<string | null>) =>
    void (async () => {
      if (!beginSync(project)) return;
      setBusy(true);
      try {
        setNote(await action());
      } catch (err) {
        setNote(null);
        await alertDialog(
          `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        endSync(project);
        setBusy(false);
        onChanged();
      }
    })();

  const doPull = () =>
    act("Pull", async () => {
      const result = await pull(project);
      const said = [
        result.updated.length > 0 && `${result.updated.length} updated`,
        result.removed.length > 0 && `${result.removed.length} removed`,
        result.kept.length > 0 && `${result.kept.length} kept`,
        result.conflicts.length > 0 && `${result.conflicts.length} conflicted`,
      ].filter((part): part is string => typeof part === "string");
      return said.length > 0 ? `pulled: ${said.join(", ")}` : "already up to date";
    });

  const doPush = () =>
    act("Push", async () => {
      // The review first (S16): the semantic diff of every changed scene
      // against its base copy is what the commit message says (D46), and
      // what the opt-in artifacts are made from (D49).
      const reviews = await reviewProject(project);
      const result = await push(project, pushExtrasFor(reviews, binding));
      const pushed: PushedReview = {
        commit: result.commit,
        changelog: projectChangelog(reviews),
        label: null,
        pictures: [],
      };
      let said = `pushed ${result.commit.slice(0, 7)}`;
      if (binding.review.images && reviews.some((r) => r.plan.crops.length)) {
        const label = labelFor(result.commit, new Date());
        const images: { path: string; base64: string }[] = [];
        for (const review of reviews) {
          for (const crop of review.plan.crops) {
            const pictures = await renderCrop(review, crop);
            const entry = { scene: review.scene, frameName: crop.frameName, before: null as string | null, after: null as string | null };
            if (pictures.before) {
              entry.before = imagePath(review.scene, crop, "before");
              images.push({ path: entry.before, base64: base64Of(pictures.before) });
            }
            if (pictures.after) {
              entry.after = imagePath(review.scene, crop, "after");
              images.push({ path: entry.after, base64: base64Of(pictures.after) });
            }
            pushed.pictures.push(entry);
          }
        }
        if (images.length) {
          try {
            await pushReviewImages(project, label, images);
            pushed.label = label;
            said += `, ${images.length} review picture${images.length === 1 ? "" : "s"}`;
          } catch (err) {
            // The scenes landed; the pictures are a courtesy. Say so rather
            // than report the push as failed.
            said += ` (review pictures not pushed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }
      }
      rememberPush(project, pushed);
      // The short sha is what a user checks against the repository, and the
      // Open PR button beside it is where the branch goes next.
      return said;
    });

  const answer = (scene: string, resolution: "keep-local" | "take-remote") =>
    act("Resolve", async () => {
      await resolveConflict(project, scene, resolution);
      return `${scene}: ${resolution === "keep-local" ? "kept yours" : "took theirs"}`;
    });

  const working = busy || disabled;
  const conflicts = conflictsOf(sync);
  const onBase = sync !== null && sync.branch === sync.baseBranch;
  const pushable = hasPushable(sync) && !onBase;

  return (
    <>
      <div className="docent-portfolio-github-branches">
        <span className="docent-portfolio-github-label">Sync</span>
        <span className="docent-portfolio-sync-summary">{summarize(sync)}</span>
        <button
          disabled={working || sync === null}
          title="Bring this copy up to date with the branch"
          onClick={doPull}
        >
          Pull
        </button>
        <button
          disabled={working || !pushable}
          title={
            onBase
              ? `${sync?.baseBranch ?? "The base branch"} is protected — create a branch, then push and open a pull request`
              : "Commit every local change to the branch"
          }
          onClick={doPush}
        >
          Push
        </button>
        <button
          disabled={working || !hasPushable(sync)}
          title="See every changed frame before and after, with what changed in words"
          onClick={onReview}
        >
          Review changes
        </button>
        {note && <span className="docent-portfolio-sync-note">{note}</span>}
      </div>
      {conflicts.map((scene) => (
        <div key={scene.name} className="docent-portfolio-github-branches">
          <span className="docent-portfolio-conflict">conflict</span>
          <span className="docent-portfolio-sync-summary">{scene.name}</span>
          <button
            disabled={working}
            title="Keep this copy; the next push overwrites the branch"
            onClick={() => answer(scene.name, "keep-local")}
          >
            Keep mine
          </button>
          <button
            disabled={working}
            title="Replace this copy with the branch's"
            onClick={() => answer(scene.name, "take-remote")}
          >
            Take remote
          </button>
        </div>
      ))}
    </>
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
  sync,
  onChanged,
  onReview,
}: {
  project: string;
  sync: SyncStatus | null;
  onChanged: () => void;
  onReview: () => void;
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
      reviewImages: binding?.review.images ?? false,
      reviewSidecars: binding?.review.sidecars ?? false,
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
          review: { images: form.reviewImages, sidecars: form.reviewSidecars },
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
          await alertDialog(
            `Connected read-only: scenes will open, but saving will fail. Grant the token "Contents: Read and write" on ${target}, then update the token here.`,
          );
        } else if (result.warning) {
          await alertDialog(result.warning);
        }
      } catch (err) {
        await alertDialog(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const disconnect = () => {
    if (!binding) return;
    // The question is asked first and the work only starts once it is
    // answered, exactly as before — awaiting it is what changed, not the
    // order. `busy` still turns on for the work alone, so the modal is not
    // frozen behind a box the user is reading.
    void (async () => {
      const confirmed = await confirmDialog(
        `Disconnect "${project}" from ${binding.owner}/${binding.repo}?\n\n` +
          "Nothing is deleted on GitHub, and the project's local folder — which " +
          "may still hold older scenes — comes back as its storage.",
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        await deleteBinding(project);
        setBinding(null);
        setOpen(false);
        onChanged();
      } catch (err) {
        await alertDialog(err instanceof Error ? err.message : String(err));
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
      {/* Branches and synchronization both need a token to ask about at all,
          and the line above already says when there isn't one. */}
      {binding && binding.hasToken && (
        <>
          <BranchRow
            project={project}
            binding={binding}
            disabled={busy}
            onChanged={reload}
          />
          <SyncRow
            project={project}
            binding={binding}
            sync={sync}
            disabled={busy}
            onChanged={onChanged}
            onReview={onReview}
          />
        </>
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
              {/* Review artifacts on GitHub (D49): both off by default, and
                  neither ever touches the diagram folder on the base branch
                  except the sidecar a team explicitly asks for. */}
              <label className="docent-check">
                <input
                  type="checkbox"
                  checked={form.reviewImages}
                  disabled={busy}
                  onChange={(e) => edit({ reviewImages: e.target.checked })}
                />
                Push review pictures to a <code>docent-review</code> branch and
                embed them in pull requests (pruned after 90 days, never merged)
              </label>
              <label className="docent-check">
                <input
                  type="checkbox"
                  checked={form.reviewSidecars}
                  disabled={busy}
                  onChange={(e) => edit({ reviewSidecars: e.target.checked })}
                />
                Commit a semantic sidecar (<code>&lt;scene&gt;.docent.json</code>)
                beside each changed scene
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
  /**
   * Show a review change in the canvas (D48): open the scene if it is not
   * the one on screen, fly to the crop, ghost what was removed. Absent when
   * there is no canvas to fly in.
   */
  onShowChange?: (project: string, jump: ReviewJump) => Promise<void>;
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

export function PortfolioModal({
  onOpenScene,
  onSaveScene,
  suggestedName,
  intent = "browse",
  onClose,
  onShowChange,
}: PortfolioModalProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  // The Review view (D48) stands in for the body while it is open.
  const [reviewing, setReviewing] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [newProject, setNewProject] = useState("");
  const [saveName, setSaveName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  // Where the selected project stands against its branch (D29), or null when
  // it is a plain local project — which is what a 404 from the store means.
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Bumped whenever the scenes on screen start coming from somewhere else —
  // a new binding, or another branch of the same repository (D28). Thumbnails
  // are cached per scene revision, and "the same name at the same timestamp on
  // a different branch" is the one case a timestamp cannot tell apart.
  const [thumbRevision, setThumbRevision] = useState(0);
  const saveNameRef = useRef<HTMLInputElement | null>(null);

  // Async now that the box may be a native one the shell raises, but used the
  // same way: as a `.catch` handler and from `run` below. Callers that do not
  // await it simply do not wait for the user to dismiss it.
  const fail = (err: unknown) =>
    alertDialog(err instanceof Error ? err.message : String(err));

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

  /**
   * A project's sync state, or null when it has none. Never fatal: an unbound
   * project answers 404 here, and a store that cannot say is no reason to stop
   * showing the scenes.
   */
  const refreshSync = useCallback(async (project: string) => {
    try {
      setSync(await syncStatus(project));
    } catch {
      setSync(null);
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setScenes([]);
      setSync(null);
      return;
    }
    refreshScenes(selected).catch(fail);
    void refreshSync(selected);
  }, [selected, refreshScenes, refreshSync]);

  /**
   * What every binding, branch and sync action ends with. Binding, unbinding,
   * switching branches and pulling all change where the scenes come from, so
   * both listings — and every thumbnail — are stale the moment one lands. The
   * scene listing goes before the sync state on purpose: it is what puts the
   * project's count back into the sidebar.
   */
  const handleSynced = useCallback(() => {
    if (!selected) return;
    setThumbRevision((revision) => revision + 1);
    void (async () => {
      await refreshProjects();
      await refreshScenes(selected);
      await refreshSync(selected);
    })().catch(fail);
  }, [selected, refreshProjects, refreshScenes, refreshSync]);

  /** The badge a scene wears in the grid, or nothing when it is clean. */
  const badgeOf = (name: string): SceneSyncState | null => {
    const state = sync?.local.find((scene) => scene.name === name)?.state;
    return state === undefined || state === "clean" || state === "deleted"
      ? null
      : state;
  };

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
      await fail(err);
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
    // Ask, then delete — the gate is the same one, only awaited. A dialog the
    // desktop shell could not raise answers no, so the deletion never runs on
    // a question nobody saw.
    void (async () => {
      if (!(await confirmDialog(question))) return;
      await run(async () => {
        await deleteProject(id);
        await refreshProjects();
      });
    })();
  };

  const removeScene = (name: string) => {
    if (!selected) return;
    void (async () => {
      const confirmed = await confirmDialog(
        `Delete scene "${selected}/${name}"? This cannot be undone.`,
      );
      if (!confirmed) return;
      await run(async () => {
        await deleteScene(selected, name);
        setScenes(await listScenes(selected));
        await refreshProjects();
        // Deleting a bound scene is a local deletion the next push carries, so
        // the sync line has just changed.
        await refreshSync(selected);
      });
    })();
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
        await alertDialog(
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
      if (exists && !(await confirmDialog(`Overwrite scene "${selected}/${name}"?`))) {
        return;
      }
      await onSaveScene(selected, name);
      setScenes(await listScenes(selected));
      await refreshProjects();
      await refreshSync(selected);
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
        {available && reviewing && selected && (
          <ReviewPanel
            project={selected}
            onBack={() => setReviewing(false)}
            onJump={
              onShowChange
                ? (jump) => {
                    void onShowChange(selected, jump)
                      .then(onClose)
                      .catch((err: unknown) => alertDialog(err instanceof Error ? err.message : String(err)));
                  }
                : undefined
            }
          />
        )}
        {available && !reviewing && (
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
                          {/* What this scene did since the last sync (D29) —
                              shown only when it did something. */}
                          {badgeOf(s.name) && (
                            <span
                              className={
                                "docent-scene-tag" +
                                (badgeOf(s.name) === "conflicted"
                                  ? " is-conflicted"
                                  : "")
                              }
                              title={
                                badgeOf(s.name) === "conflicted"
                                  ? "Changed here and on the branch — answer it in the sync row below"
                                  : "Not on the branch yet — Push commits it"
                              }
                            >
                              {badgeOf(s.name)}
                            </span>
                          )}
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
                    sync={sync}
                    onChanged={handleSynced}
                    onReview={() => setReviewing(true)}
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
