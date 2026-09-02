/**
 * Typed client for the portfolio store (S12). Same-origin `/api/` in every
 * environment — nginx proxies it in deployments, Vite proxies it in dev —
 * so a deployment without the store answers with the SPA fallback or a
 * connection error, which `storeAvailable` turns into a clean false.
 */

/**
 * The desktop shell (S13) runs its native store on loopback and announces it
 * before the page loads, because a webview origin is not one an HTTP server
 * can answer on. Everywhere else the global is absent and requests stay
 * same-origin, exactly as before.
 */
export const API_BASE =
  // globalThis, not window: the agent executor imports this module, and its
  // tests run where no window exists. In the browser they are the same object.
  (globalThis as { __DOCENT_API_BASE__?: string }).__DOCENT_API_BASE__ ??"";

export interface ProjectInfo {
  id: string;
  scenes: number;
  updatedAt: string | null;
  /** Present only on projects bound to a GitHub repository (S14). */
  bound?: boolean;
  /** Present only on linked projects (S25): the directory they live at. */
  linked?: string;
  /**
   * What the last bind-time probe learned about writing to the bound
   * repository. Absent means nothing is known — only `false` is worth showing,
   * and it is the difference between "scenes open" and "scenes save".
   */
  canWrite?: boolean;
}

export interface SceneInfo {
  name: string;
  /** The file's mtime — a bound project's scenes are files too (D29). */
  updatedAt: string | null;
  size: number;
}

/** A project's GitHub binding as the store states it — never with the token. */
export interface Binding {
  owner: string;
  repo: string;
  path: string;
  /** Where every scene operation lands — the branch being drafted on. */
  branch: string;
  /**
   * What a pull request would target (S14, D28). Equal to `branch` when the
   * project is sitting on its own base, which is where a binding starts and
   * where a binding written before branch-aware sync stays.
   */
  baseBranch: string;
  apiBase: string;
  /**
   * Whether the base branch is locked (D104): while the project sits on it,
   * the canvas is view-only and the way forward is a branch. False on every
   * binding that never asked for one.
   */
  protected: boolean;
  hasToken: boolean;
  /**
   * Whether the stored token may write to the repository, as the last
   * bind-time probe found it. Null is "not known" — no token to ask with, or
   * GitHub could not be reached — and never a reason to hide the binding.
   */
  canWrite: boolean | null;
  /** Which review artifacts may reach GitHub (D49) — both off by default. */
  review: ReviewOptions;
}

/**
 * The opt-in GitHub artifacts of a review (S16, D49): before/after crops on
 * the quarantined `docent-review` branch, and semantic sidecars committed
 * beside the scenes. Neither touches the diagram directory unless asked.
 */
export interface ReviewOptions {
  images: boolean;
  sidecars: boolean;
}

/**
 * What storing a binding answers: the probe's verdict, and — when it could not
 * be reached — one line saying so. A read-only token is the case worth
 * catching: everything reads, nothing saves.
 */
export interface BindingResult {
  ok: boolean;
  canWrite: boolean | null;
  /** The base the store recorded — the repository's default branch, usually. */
  baseBranch: string;
  warning?: string;
  /**
   * How many scenes the working copy gained or lost, when this PUT moved the
   * project to another branch (D29). Absent on every other binding write.
   */
  pulled?: number;
}

/**
 * What the binding form sends. `token` is write-only: omitted keeps the stored
 * one, and so does an omitted `baseBranch` — which is what makes switching
 * branches a PUT of the same binding on another `branch`.
 */
export interface BindingInput {
  owner: string;
  repo: string;
  path?: string;
  branch?: string;
  baseBranch?: string;
  apiBase?: string;
  token?: string;
  /** Omitted keeps whatever the binding recorded. */
  review?: ReviewOptions;
  /** The trunk lock (D104) — omitted keeps what is stored, like `review`. */
  protected?: boolean;
}

/** One branch of the bound repository (D28). */
export interface BranchInfo {
  name: string;
  /** The branch a pull request would target. */
  isBase: boolean;
  /** The branch the project is on, where every save lands. */
  isActive: boolean;
}

/**
 * What one scene of a bound project did since the last synchronization (D29).
 * `conflicted` outranks the rest: it is the one state the author has to answer
 * before a push can happen at all.
 */
export type SceneSyncState =
  | "clean"
  | "new"
  | "modified"
  | "deleted"
  | "conflicted";

/** Where a bound project stands: what the copy did, and what the branch did. */
export interface SyncStatus {
  branch: string;
  baseBranch: string;
  local: { name: string; state: SceneSyncState }[];
  remote: {
    /** False when GitHub could not be asked at all — offline, or no token. */
    reachable: boolean;
    changed: string[];
    removed: string[];
  };
}

/** What a pull did, per scene, in the store's own words. */
export interface PullResult {
  ok: boolean;
  updated: string[];
  removed: string[];
  kept: string[];
  conflicts: string[];
}

/** What a push landed: one commit, and the scenes that went into it. */
export interface PushResult {
  ok: boolean;
  commit: string;
  pushed: string[];
  removedRemotely: string[];
}

/** How the author answers a conflicted scene. There is no third option. */
export type Resolution = "keep-local" | "take-remote";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // The SPA fallback answers unknown paths with index.html and a 200 —
    // treat non-JSON as "store not deployed", loudly.
    throw new Error("portfolio store is not available on this deployment");
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function storeAvailable(): Promise<boolean> {
  try {
    const health = await request<{ ok?: boolean }>("/api/health");
    return health.ok === true;
  } catch {
    return false;
  }
}

export function listProjects(): Promise<ProjectInfo[]> {
  return request("/api/projects");
}

export function createProject(id: string): Promise<{ id: string }> {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: "PUT" });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listScenes(project: string): Promise<SceneInfo[]> {
  return request(`/api/projects/${encodeURIComponent(project)}/scenes`);
}

const bindingUrl = (project: string) =>
  `/api/projects/${encodeURIComponent(project)}/binding`;

/** The project's binding, or null when it is a plain local project. */
export async function getBinding(project: string): Promise<Binding | null> {
  const res = await fetch(API_BASE + bindingUrl(project));
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(errorFrom(text, res.status));
  return JSON.parse(text) as Binding;
}

export function putBinding(
  project: string,
  binding: BindingInput,
): Promise<BindingResult> {
  return request(bindingUrl(project), {
    method: "PUT",
    body: JSON.stringify(binding),
  });
}

export function deleteBinding(project: string): Promise<{ ok: boolean }> {
  return request(bindingUrl(project), { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// branches and pull requests (S14, D28)
// ---------------------------------------------------------------------------

const branchesUrl = (project: string) =>
  `/api/projects/${encodeURIComponent(project)}/branches`;

/** The bound repository's branches, with the base and the active one marked. */
export function listBranches(project: string): Promise<BranchInfo[]> {
  return request(branchesUrl(project));
}

/**
 * Cut a branch off `from` (the active branch by default) and start drafting on
 * it: the store switches the binding as part of the same call, so the next
 * save commits there.
 */
export function createBranch(
  project: string,
  name: string,
  from?: string,
): Promise<{ ok: boolean; branch: string }> {
  return request(branchesUrl(project), {
    method: "POST",
    body: JSON.stringify(from ? { name, from } : { name }),
  });
}

/** Open a pull request from the active branch onto the recorded base. */
export function openPullRequest(
  project: string,
  input: { title?: string; body?: string } = {},
): Promise<{ ok: boolean; url: string; number: number }> {
  return request(`/api/projects/${encodeURIComponent(project)}/pull-request`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Move the project to an existing branch. It is the binding PUT and nothing
 * else — the store keeps every field this does not state, so the base, the
 * token and the probe's verdict all survive the switch.
 */
export async function switchBranch(
  project: string,
  branch: string,
): Promise<BindingResult> {
  const binding = await getBinding(project);
  if (!binding) throw new Error(`no GitHub binding for project: ${project}`);
  return putBinding(project, {
    owner: binding.owner,
    repo: binding.repo,
    path: binding.path,
    branch,
    apiBase: binding.apiBase,
  });
}

const sceneUrl = (project: string, scene: string) =>
  `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`;

/** The store's `{ error }` body, or the bare status when it sent something else. */
function errorFrom(text: string, status: number): string {
  try {
    return String((JSON.parse(text) as { error: string }).error);
  } catch {
    return `HTTP ${status}`;
  }
}

/**
 * Raw scene JSON text (already validated as .excalidraw by the store). A bound
 * project's scenes are files in its working copy, so this is a disk read there
 * too — offline included, and never a rate-limited round-trip (D29).
 */
export async function loadScene(
  project: string,
  scene: string,
): Promise<string> {
  const res = await fetch(API_BASE + sceneUrl(project, scene));
  const text = await res.text();
  if (!res.ok) throw new Error(errorFrom(text, res.status));
  return text;
}

/** Write the scene back — a local write, bound or not. */
export function saveScene(
  project: string,
  scene: string,
  json: string,
): Promise<{ ok: boolean }> {
  return request(sceneUrl(project, scene), { method: "PUT", body: json });
}

export function deleteScene(
  project: string,
  scene: string,
): Promise<{ ok: boolean }> {
  return request(sceneUrl(project, scene), { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// the sync verbs (S14, D29, D33) — the only calls that reach GitHub
// ---------------------------------------------------------------------------

const syncUrl = (project: string, verb: string) =>
  `/api/projects/${encodeURIComponent(project)}/${verb}`;

/**
 * Where the project stands. Cheap and safe to call after every verb: the local
 * half is file hashes, and the remote half is one listing the store
 * revalidates with an ETag.
 */
export function syncStatus(project: string): Promise<SyncStatus> {
  return request(syncUrl(project, "sync-status"));
}

/** Fast-forward the working copy from the branch, flagging what clashed. */
export function pull(project: string): Promise<PullResult> {
  return request(syncUrl(project, "pull"), { method: "POST" });
}

/** Answer one conflicted scene: keep what is here, or take what is there. */
export function resolveConflict(
  project: string,
  scene: string,
  resolution: Resolution,
): Promise<{ ok: boolean; scene: string; resolution: Resolution }> {
  return request(syncUrl(project, "pull/resolve"), {
    method: "POST",
    body: JSON.stringify({ scene, resolution }),
  });
}

/**
 * What a push may carry beside the scenes (D46, D49): the changelog for the
 * commit message, and attachments written into the same commit at flat file
 * names relative to the bound path — `content: null` removes one.
 */
export interface PushExtras {
  message?: string;
  attachments?: { path: string; content: string | null }[];
}

/**
 * Land every local change as one commit on the active branch. Refused on the
 * base branch (D33), while a conflict is unresolved, and when the remote
 * branch has moved — each with a message that says what to do about it.
 */
export function push(project: string, extras: PushExtras = {}): Promise<PushResult> {
  return request(syncUrl(project, "push"), {
    method: "POST",
    body: JSON.stringify(extras),
  });
}

/**
 * The "before" copy of a scene (D47): what the recorded base sha points at,
 * kept by the store beside its sync state. Null when the scene has never
 * been synced — a new scene has no before.
 */
export async function loadBase(project: string, scene: string): Promise<string | null> {
  const res = await fetch(
    API_BASE +
      `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}/base`,
  );
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(errorFrom(text, res.status));
  return text;
}

/** One review picture for the quarantined branch (D49). */
export interface ReviewImage {
  /** Relative `.png` path under the label, e.g. `plan/Core-before.png`. */
  path: string;
  base64: string;
}

/**
 * Commit review pictures to the orphan `docent-review` branch under
 * `<label>/…`, pruning labels older than 90 days. The working branch is
 * never touched.
 */
export function pushReviewImages(
  project: string,
  label: string,
  images: ReviewImage[],
): Promise<{ ok: boolean; branch: string; label: string; commit: string; pruned: number }> {
  return request(`/api/projects/${encodeURIComponent(project)}/review-images`, {
    method: "POST",
    body: JSON.stringify({ label, images }),
  });
}

/** The store's word for "someone else committed first", matched exactly. */
export const REMOTE_MOVED = "the remote branch moved — pull first";
