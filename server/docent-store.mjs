#!/usr/bin/env node
/**
 * Docent portfolio store (S12, D17, D18) — projects of scenes for one
 * deployment. A project is a directory, a scene is a plain `.excalidraw`
 * file: `<DOCENT_DATA>/<project>/<scene>.excalidraw`. No database, no
 * format of its own (D17) — anything this service can do, a file manager
 * can too. Zero runtime dependencies (I7): Node's built-in http/fs.
 *
 * Served same-origin behind nginx at /api/ (D18); the dev server proxies
 * the same path, so the client never needs CORS.
 *
 * Run:  node server/docent-store.mjs      (port 3400, data dir ./data)
 * Env:  DOCENT_STORE_PORT, DOCENT_DATA
 *
 * API (JSON in/out; errors are { error } with a 4xx/5xx status):
 *   GET    /api/health                          → { ok: true }
 *   GET    /api/projects                        → [{ id, scenes, updatedAt }]
 *   PUT    /api/projects/:project               → { id }            (create)
 *   DELETE /api/projects/:project               → { ok }            (recursive)
 *   GET    /api/projects/:project/scenes        → [{ name, updatedAt, size }]
 *   GET    /api/projects/:project/scenes/:name  → scene JSON
 *   PUT    /api/projects/:project/scenes/:name  → { ok }            (atomic)
 *   DELETE /api/projects/:project/scenes/:name  → { ok }
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.DOCENT_STORE_PORT ?? "3400");
const DATA_DIR = path.resolve(process.env.DOCENT_DATA ?? "data");
const MAX_SCENE_BYTES = 50 * 1024 * 1024;
const EXT = ".excalidraw";

// One flat rule keeps traversal impossible: every project and scene name
// must match this before it ever touches a path. No dots means no ".."
// and no extension games; the store adds .excalidraw itself.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const checkName = (name, what) => {
  if (!NAME_RE.test(name)) {
    throw new HttpError(
      400,
      `invalid ${what} name — use letters, digits, spaces, - or _ (max 64, no leading symbol)`,
    );
  }
  return name;
};

const projectDir = (project) => path.join(DATA_DIR, checkName(project, "project"));
const scenePath = (project, scene) =>
  path.join(projectDir(project), checkName(scene, "scene") + EXT);

async function listProjects() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const files = await fs.readdir(path.join(DATA_DIR, entry.name));
    const scenes = files.filter((f) => f.endsWith(EXT));
    let updatedAt = 0;
    for (const f of scenes) {
      const st = await fs.stat(path.join(DATA_DIR, entry.name, f));
      updatedAt = Math.max(updatedAt, st.mtimeMs);
    }
    projects.push({
      id: entry.name,
      scenes: scenes.length,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    });
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

async function listScenes(project) {
  const dir = projectDir(project);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    throw new HttpError(404, `no such project: ${project}`);
  }
  const scenes = [];
  for (const f of files.filter((f) => f.endsWith(EXT))) {
    const st = await fs.stat(path.join(dir, f));
    scenes.push({
      name: f.slice(0, -EXT.length),
      updatedAt: new Date(st.mtimeMs).toISOString(),
      size: st.size,
    });
  }
  return scenes.sort((a, b) => a.name.localeCompare(b.name));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SCENE_BYTES) throw new HttpError(413, "scene too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // parts: ["api", "projects", :project?, "scenes"?, :scene?]
  if (parts[0] !== "api") throw new HttpError(404, "not found");

  if (parts[1] === "health" && req.method === "GET") {
    return { ok: true };
  }

  if (parts[1] !== "projects") throw new HttpError(404, "not found");

  if (parts.length === 2 && req.method === "GET") return listProjects();

  if (parts.length === 3) {
    const project = parts[2];
    if (req.method === "PUT") {
      await fs.mkdir(projectDir(project), { recursive: true });
      res.statusCode = 201;
      return { id: project };
    }
    if (req.method === "DELETE") {
      await fs.rm(projectDir(project), { recursive: true, force: true });
      return { ok: true };
    }
  }

  if (parts.length === 4 && parts[3] === "scenes" && req.method === "GET") {
    return listScenes(parts[2]);
  }

  if (parts.length === 5 && parts[3] === "scenes") {
    const [, , project, , scene] = parts;
    const file = scenePath(project, scene);
    if (req.method === "GET") {
      try {
        return { raw: await fs.readFile(file, "utf8") };
      } catch {
        throw new HttpError(404, `no such scene: ${project}/${scene}`);
      }
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      // The store persists .excalidraw files and nothing else (D17) —
      // reject anything that isn't one, loudly.
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, "body is not JSON");
      }
      if (parsed?.type !== "excalidraw") {
        throw new HttpError(400, "body is not an .excalidraw scene");
      }
      try {
        await fs.access(projectDir(project));
      } catch {
        throw new HttpError(404, `no such project: ${project}`);
      }
      // Atomic: a crash mid-write must never truncate an existing scene.
      const tmp = file + ".tmp";
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, file);
      return { ok: true };
    }
    if (req.method === "DELETE") {
      try {
        await fs.unlink(file);
      } catch {
        throw new HttpError(404, `no such scene: ${project}/${scene}`);
      }
      return { ok: true };
    }
  }

  throw new HttpError(404, "not found");
}

const server = http.createServer(async (req, res) => {
  try {
    const result = await handle(req, res);
    if (result && typeof result === "object" && "raw" in result) {
      res.setHeader("content-type", "application/json");
      res.end(result.raw);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message ?? "internal error" }));
  }
});

await fs.mkdir(DATA_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`docent-store: ${DATA_DIR} on :${PORT}`);
});
