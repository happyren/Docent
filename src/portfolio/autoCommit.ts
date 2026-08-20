/**
 * Auto-checkpointing for bound projects (S14, D33). Saving is already local
 * and instant (D29); this is what routinely turns those local saves into
 * commits on the draft branch, so a closed laptop never costs more than a
 * debounce window of pushable work.
 *
 * Two rules make it safe to leave running:
 *
 *  - **Never the base branch.** The store refuses it outright, and so does
 *    this: on the trunk, a save is offered a draft branch once per session and
 *    otherwise left alone. Through Docent the base only ever changes by a pull
 *    request someone merged.
 *  - **Never a surprise.** It only pushes what the author already saved, never
 *    while a conflict is unanswered, and never over a manual pull or push. A
 *    successful checkpoint says so in the sync line and nowhere else; the one
 *    thing it interrupts for is a branch that moved underneath, and only once.
 *
 * The timer lives here rather than in the portfolio modal because the modal is
 * transient and the work is not: an author draws for an hour with nothing open
 * but the canvas.
 */
import {
  REMOTE_MOVED,
  createBranch,
  getBinding,
  push,
  syncStatus,
  type SceneSyncState,
} from "./client";
import { alertDialog, confirmDialog } from "../shell/dialogs";

/** How long after the last save a checkpoint lands. */
const DEBOUNCE_MS = 45_000;
/** …and how often anything the debounce missed is swept up. */
const SWEEP_MS = 180_000;

/** The states a push would actually carry. */
const PUSHABLE: ReadonlySet<SceneSyncState> = new Set<SceneSyncState>([
  "modified",
  "new",
  "deleted",
]);

/** What a checkpoint (or the branch offer) did, for the UI to reflect. */
export interface AutoCommitEvent {
  project: string;
  kind: "committed" | "branched";
  /** The commit a checkpoint landed, short enough to read at a glance. */
  commit?: string;
  branch?: string;
}

const listeners = new Set<(event: AutoCommitEvent) => void>();

/** Subscribe; the returned function unsubscribes. */
export function onAutoCommit(
  listener: (event: AutoCommitEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const announce = (event: AutoCommitEvent) => {
  for (const listener of listeners) listener(event);
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Projects saved into this session — what the periodic sweep looks at. */
const tracked = new Set<string>();
/** Projects whose author said no to a draft branch; asked once, then dropped. */
const declined = new Set<string>();
/** Projects already told their branch moved; said once, then quiet. */
const warned = new Set<string>();
/** Projects with a verb in flight — manual or automatic. Never two at once. */
const busy = new Set<string>();
let sweep: ReturnType<typeof setInterval> | null = null;

/**
 * What a draft branch is called unless the author renames it later. The date
 * is enough to tell two of them apart, and it reads as a date in the branch
 * list rather than as a hash.
 */
export const suggestedBranch = () =>
  `docent/diagrams-${new Date().toISOString().slice(0, 10)}`;

/** Hold a project while a manual pull, push or resolution is running. */
export function beginSync(project: string): boolean {
  if (busy.has(project)) return false;
  busy.add(project);
  return true;
}

/**
 * Release it. A manual verb is the author acting on the branch, so it also
 * clears the "we already told you it moved" mark: the next problem is news
 * again.
 */
export function endSync(project: string): void {
  busy.delete(project);
  warned.delete(project);
}

/**
 * A scene was just saved into `project`. Everything after this is decided from
 * the binding, which is a local file read — no network on the save path.
 */
export function notePortfolioSave(project: string): void {
  void (async () => {
    const binding = await getBinding(project).catch(() => null);
    // Unbound projects have nothing to check point *to*, and one with no token
    // could not push if it wanted to.
    if (!binding || !binding.hasToken) return;
    tracked.add(project);
    if (binding.branch !== binding.baseBranch) {
      schedule(project);
      return;
    }
    // On the trunk: the save has already happened and is safe on disk. The
    // only question is whether the author wants it reviewable.
    const branch = await offerDraftBranch(project, binding.baseBranch);
    // A branch cut here starts at the same head, so the work that was just
    // saved is pushable immediately.
    if (branch) schedule(project);
  })();
}

/**
 * Offer, once per project per session, to move off the base branch. Answering
 * no is remembered — nobody should be asked the same question every save.
 */
async function offerDraftBranch(
  project: string,
  base: string,
): Promise<string | null> {
  if (declined.has(project) || busy.has(project)) return null;
  if (!beginSync(project)) return null;
  try {
    const wanted = await confirmDialog(
      `You're on ${base} — create a draft branch so your changes can be pushed and reviewed?`,
    );
    if (!wanted) {
      declined.add(project);
      return null;
    }
    const name = suggestedBranch();
    const created = await createBranch(project, name);
    announce({ project, kind: "branched", branch: created.branch });
    return created.branch;
  } catch (err) {
    // A branch that could not be cut is worth saying out loud: the author
    // asked for it, so silence would read as "it worked".
    await alertDialog(err instanceof Error ? err.message : String(err));
    declined.add(project);
    return null;
  } finally {
    endSync(project);
  }
}

function schedule(project: string): void {
  const existing = timers.get(project);
  if (existing) clearTimeout(existing);
  timers.set(
    project,
    setTimeout(() => {
      timers.delete(project);
      void attempt(project);
    }, DEBOUNCE_MS),
  );
  if (sweep === null) {
    // The debounce covers the common case; the sweep covers the rest — a
    // checkpoint skipped because a manual push was running, or one that failed
    // while the machine was offline.
    sweep = setInterval(() => {
      for (const tracked of trackedProjects()) void attempt(tracked);
    }, SWEEP_MS);
  }
}

const trackedProjects = () => [...tracked];

/**
 * One checkpoint. Every reason not to push is a silent skip: the author is
 * drawing, not waiting for this, and a modal in the middle of a session is
 * worse than a commit that lands three minutes later.
 */
async function attempt(project: string): Promise<void> {
  if (!beginSync(project)) return;
  try {
    const status = await syncStatus(project);
    // The trunk is protected (D33) — the store would refuse anyway, and asking
    // it to would only spend a rate limit to be told so.
    if (status.branch === status.baseBranch) return;
    if (status.local.some((scene) => scene.state === "conflicted")) return;
    if (!status.local.some((scene) => PUSHABLE.has(scene.state))) return;
    const result = await push(project);
    announce({ project, kind: "committed", commit: result.commit });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // One refusal is worth interrupting for, because nothing will land until
    // the author pulls — and even that is said once.
    if (message === REMOTE_MOVED && !warned.has(project)) {
      warned.add(project);
      await alertDialog(
        `Docent could not check point "${project}": ${message}. Open the portfolio and pull to bring the branch up to date.`,
      );
    }
    // Everything else — offline, nothing to push, a conflict that appeared
    // between the status and the push — waits for the next cycle.
  } finally {
    busy.delete(project);
  }
}

/** Forget everything: the app is going away, or a test wants a clean slate. */
export function stopAutoCommit(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (sweep !== null) clearInterval(sweep);
  sweep = null;
  tracked.clear();
  declined.clear();
  warned.clear();
  busy.clear();
}
