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
  (window as { __DOCENT_API_BASE__?: string }).__DOCENT_API_BASE__ ?? "";

export interface ProjectInfo {
  id: string;
  scenes: number;
  updatedAt: string | null;
  /** Present only on projects bound to a GitHub repository (S14). */
  bound?: boolean;
  /**
   * What the last bind-time probe learned about writing to the bound
   * repository. Absent means nothing is known — only `false` is worth showing,
   * and it is the difference between "scenes open" and "scenes save".
   */
  canWrite?: boolean;
}

export interface SceneInfo {
  name: string;
  /**
   * Null only on a bound project whose branch has no readable commit date —
   * a local scene always has its mtime.
   */
  updatedAt: string | null;
  size: number;
  /** The blob sha, on bound projects only — the conflict token for a save. */
  sha?: string;
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
  hasToken: boolean;
  /**
   * Whether the stored token may write to the repository, as the last
   * bind-time probe found it. Null is "not known" — no token to ask with, or
   * GitHub could not be reached — and never a reason to hide the binding.
   */
  canWrite: boolean | null;
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
 * The header the store answers a bound scene with, and the one a save sends
 * back to prove it is writing over what it read (S14).
 */
const SCENE_SHA_HEADER = "X-Docent-Scene-Sha";

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
 * Raw scene JSON text (already validated as .excalidraw by the store), plus the
 * conflict token when the project is bound to GitHub. Keep the sha with the
 * scene: the next save sends it back, and that is what turns a remote change
 * into a loud 409 instead of a silent overwrite.
 */
export async function loadScene(
  project: string,
  scene: string,
): Promise<{ text: string; sha?: string }> {
  const res = await fetch(API_BASE + sceneUrl(project, scene));
  const text = await res.text();
  if (!res.ok) throw new Error(errorFrom(text, res.status));
  return { text, sha: res.headers.get(SCENE_SHA_HEADER) ?? undefined };
}

/**
 * Write the scene back. `sha` is the token `loadScene` returned; without one a
 * bound save is last-write-wins, with one a remote change answers 409 and the
 * message says to reload. The answer carries the scene's new sha, so the caller
 * can keep saving without reloading.
 */
export function saveScene(
  project: string,
  scene: string,
  json: string,
  sha?: string,
): Promise<{ ok: boolean; sha?: string | null }> {
  return request(sceneUrl(project, scene), {
    method: "PUT",
    body: json,
    headers: sha ? { [SCENE_SHA_HEADER]: sha } : undefined,
  });
}

export function deleteScene(
  project: string,
  scene: string,
): Promise<{ ok: boolean }> {
  return request(sceneUrl(project, scene), { method: "DELETE" });
}
