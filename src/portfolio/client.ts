/**
 * Typed client for the portfolio store (S12). Same-origin `/api/` in every
 * environment — nginx proxies it in deployments, Vite proxies it in dev —
 * so a deployment without the store answers with the SPA fallback or a
 * connection error, which `storeAvailable` turns into a clean false.
 */

export interface ProjectInfo {
  id: string;
  scenes: number;
  updatedAt: string | null;
}

export interface SceneInfo {
  name: string;
  updatedAt: string;
  size: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
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

const sceneUrl = (project: string, scene: string) =>
  `/api/projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(scene)}`;

/** Raw scene JSON text (already validated as .excalidraw by the store). */
export async function loadScene(project: string, scene: string): Promise<string> {
  const res = await fetch(sceneUrl(project, scene));
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = String((JSON.parse(text) as { error: string }).error);
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return text;
}

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
