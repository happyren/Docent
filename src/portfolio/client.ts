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
  branch: string;
  apiBase: string;
  hasToken: boolean;
}

/** What the binding form sends. `token` is write-only: omitted keeps the stored one. */
export interface BindingInput {
  owner: string;
  repo: string;
  path?: string;
  branch?: string;
  apiBase?: string;
  token?: string;
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
): Promise<{ ok: boolean }> {
  return request(bindingUrl(project), {
    method: "PUT",
    body: JSON.stringify(binding),
  });
}

export function deleteBinding(project: string): Promise<{ ok: boolean }> {
  return request(bindingUrl(project), { method: "DELETE" });
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
