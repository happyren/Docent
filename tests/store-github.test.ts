/**
 * Per-project GitHub sync (S14, D27) against the real store process: binding
 * CRUD, the secrets boundary (no token in the data tree, none in any response),
 * and the bound read/write path — listing, load, save-as-commit, SHA conflict,
 * delete, the blob fallback, and the 401 a missing or rejected token gets.
 *
 * GitHub itself is a plain `node:http` server in this file. It is not a
 * simulation of the API, only of the six calls the store makes, but it answers
 * them the way GitHub does — base64 contents, SHA-checked writes, 409 on a
 * stale SHA, ETag revalidation on the listing — so everything under test is the
 * store's real request/response handling. `apiBase` is part of the binding, so
 * pointing the store at the mock needs no environment variable at all: it is
 * the same mechanism a GitHub Enterprise deployment uses.
 *
 * The Rust store's mirror of this suite is `src-tauri/tests/store_github.rs`;
 * the two exist to keep the one contract honest across both implementations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// One port per suite that binds one: 3497–3499 are already claimed by the
// MCP and store suites, which run alongside this one.
const PORT = 3496;
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = JSON.stringify({ type: "excalidraw", version: 2, elements: [] });
const OTHER_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [{ id: "a" }],
});
const TOKEN = "github_pat_11ABCDEF0_docenttest";
const COMMIT_DATE = "2026-08-20T12:00:00Z";
/** Anything larger answers like GitHub does past 1 MB: no inline content. */
const INLINE_LIMIT = 256;

const CONFLICT_MESSAGE =
  "scene changed on GitHub since it was loaded — reload it to get the latest";
const TOKEN_MESSAGE =
  "GitHub token missing or rejected for this project — set it in the binding";

// ---------------------------------------------------------------------------
// the mock GitHub API
// ---------------------------------------------------------------------------

/** A git blob sha, computed the way git computes one, so it looks real. */
const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");

interface SeenRequest {
  method: string;
  url: string;
  body: string;
  ifNoneMatch?: string;
}

class MockGitHub {
  readonly server: http.Server;
  readonly files = new Map<string, string>();
  readonly seen: SeenRequest[] = [];
  /** Bumped by every write, so the listing's ETag changes when it should. */
  version = 1;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          ifNoneMatch: req.headers["if-none-match"] as string | undefined,
        });
        const [status, payload, headers] = this.route(req, body);
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(payload === null ? "" : JSON.stringify(payload));
      });
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  requestsTo(fragment: string): SeenRequest[] {
    return this.seen.filter((entry) => entry.url.includes(fragment));
  }

  private route(
    req: http.IncomingMessage,
    body: string,
  ): [number, unknown, Record<string, string>?] {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return [401, { message: "Bad credentials" }];
    }
    const url = new URL(req.url ?? "/", "http://mock");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // /repos/:owner/:repo/...
    if (segments[0] !== "repos" || segments[1] !== "acme" || segments[2] !== "diagrams") {
      return [404, { message: "Not Found" }];
    }
    const rest = segments.slice(3);
    if (rest[0] === "commits" && req.method === "GET") {
      return [200, [{ sha: "c0ffee", commit: { committer: { date: COMMIT_DATE } } }]];
    }
    if (rest[0] === "git" && rest[1] === "blobs" && req.method === "GET") {
      const wanted = rest[2];
      for (const [, content] of this.files) {
        if (blobSha(content) === wanted) {
          return [
            200,
            {
              sha: wanted,
              encoding: "base64",
              content: Buffer.from(content, "utf8").toString("base64"),
            },
          ];
        }
      }
      return [404, { message: "Not Found" }];
    }
    if (rest[0] !== "contents") return [404, { message: "Not Found" }];
    const repoPath = rest.slice(1).join("/");

    if (req.method === "GET") return this.get(repoPath, req);
    if (req.method === "PUT") return this.put(repoPath, body);
    if (req.method === "DELETE") return this.remove(repoPath, body);
    return [404, { message: "Not Found" }];
  }

  private entry(repoPath: string) {
    const content = this.files.get(repoPath) as string;
    return {
      name: repoPath.split("/").pop(),
      path: repoPath,
      sha: blobSha(content),
      size: Buffer.byteLength(content),
      type: "file",
    };
  }

  private get(
    repoPath: string,
    req: http.IncomingMessage,
  ): [number, unknown, Record<string, string>?] {
    if (this.files.has(repoPath)) {
      const content = this.files.get(repoPath) as string;
      // Past the ceiling GitHub answers with the metadata and no content; the
      // bytes are only reachable through the blob API.
      if (Buffer.byteLength(content) > INLINE_LIMIT) {
        return [200, { ...this.entry(repoPath), encoding: "none", content: "" }];
      }
      return [
        200,
        {
          ...this.entry(repoPath),
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64") + "\n",
        },
      ];
    }
    const prefix = repoPath === "" ? "" : `${repoPath}/`;
    const children = [...this.files.keys()].filter(
      (key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"),
    );
    if (children.length === 0) return [404, { message: "Not Found" }];
    const etag = `W/"listing-${this.version}"`;
    if (req.headers["if-none-match"] === etag) return [304, null, { etag }];
    return [200, children.sort().map((key) => this.entry(key)), { etag }];
  }

  private put(repoPath: string, body: string): [number, unknown] {
    const payload = JSON.parse(body) as { content: string; sha?: string; message: string };
    const existing = this.files.get(repoPath);
    if (existing !== undefined && payload.sha !== blobSha(existing)) {
      return [409, { message: "does not match" }];
    }
    if (existing === undefined && payload.sha) {
      return [422, { message: "sha does not match" }];
    }
    const content = Buffer.from(payload.content, "base64").toString("utf8");
    this.files.set(repoPath, content);
    this.version += 1;
    return [
      existing === undefined ? 201 : 200,
      { content: this.entry(repoPath), commit: { sha: `commit-${this.version}` } },
    ];
  }

  private remove(repoPath: string, body: string): [number, unknown] {
    const payload = JSON.parse(body) as { sha: string };
    const existing = this.files.get(repoPath);
    if (existing === undefined) return [404, { message: "Not Found" }];
    if (payload.sha !== blobSha(existing)) return [409, { message: "does not match" }];
    this.files.delete(repoPath);
    this.version += 1;
    return [200, { commit: { sha: `commit-${this.version}` } }];
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

let server: ChildProcess;
let dataDir: string;
let secretsDir: string;
let secretsFile: string;
let github: MockGitHub;

const bindingBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    owner: "acme",
    repo: "diagrams",
    path: "docs/diagrams",
    branch: "main",
    apiBase: github.base,
    token: TOKEN,
    ...extra,
  });

const bind = (project: string, extra?: Record<string, unknown>) =>
  fetch(`${BASE}/api/projects/${project}/binding`, {
    method: "PUT",
    body: bindingBody(extra),
  });

/** Every file under `dir`, as absolute paths. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

beforeAll(async () => {
  github = new MockGitHub();
  await github.start();
  dataDir = await mkdtemp(path.join(tmpdir(), "docent-gh-data-"));
  secretsDir = await mkdtemp(path.join(tmpdir(), "docent-gh-secrets-"));
  secretsFile = path.join(secretsDir, "docent-secrets.json");
  server = spawn("node", [path.resolve("server/docent-store.mjs")], {
    env: {
      ...process.env,
      DOCENT_STORE_PORT: String(PORT),
      DOCENT_DATA: dataDir,
      DOCENT_SECRETS: secretsFile,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("store did not start")), 5000);
    server.stdout?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    server.on("exit", () => reject(new Error("store exited early")));
  });
});

afterAll(async () => {
  server.kill();
  await github.stop();
  await rm(dataDir, { recursive: true, force: true });
  await rm(secretsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// binding metadata and the secrets boundary
// ---------------------------------------------------------------------------

describe("GitHub binding", () => {
  it("binds a project, and the token never comes back out", async () => {
    const created = await fetch(`${BASE}/api/projects/work`, { method: "PUT" });
    expect(created.status).toBe(201);

    const put = await bind("work");
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await fetch(`${BASE}/api/projects/work/binding`);
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(JSON.parse(body)).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "docs/diagrams",
      branch: "main",
      apiBase: github.base,
      hasToken: true,
    });
    // Not merely absent from the typed shape — absent from the bytes.
    expect(body).not.toContain(TOKEN);
  });

  it("keeps metadata in .docent/bindings.json and the token out of the data tree (D27)", async () => {
    const bindings = JSON.parse(
      await readFile(path.join(dataDir, ".docent", "bindings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(bindings.work).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "docs/diagrams",
      branch: "main",
      apiBase: github.base,
    });

    // Walk the whole data tree: nothing in it may carry the credential.
    for (const file of await walk(dataDir)) {
      expect(await readFile(file, "utf8"), file).not.toContain(TOKEN);
    }

    // The token lives in the configured secrets file instead, readable by its
    // owner alone.
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.work).toBe(TOKEN);
    expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
  });

  it("keeps the stored token when an update omits it", async () => {
    const update = await bind("work", { token: undefined, path: "docs" });
    expect(update.status).toBe(200);
    const binding = (await (
      await fetch(`${BASE}/api/projects/work/binding`)
    ).json()) as { path: string; hasToken: boolean };
    expect(binding.path).toBe("docs");
    expect(binding.hasToken).toBe(true);
    // Put it back for the rest of the suite.
    expect((await bind("work")).status).toBe(200);
  });

  it("defaults the branch and the API base", async () => {
    await fetch(`${BASE}/api/projects/defaults`, { method: "PUT" });
    const put = await fetch(`${BASE}/api/projects/defaults/binding`, {
      method: "PUT",
      body: JSON.stringify({ owner: "acme", repo: "diagrams" }),
    });
    expect(put.status).toBe(200);
    const binding = await (await fetch(`${BASE}/api/projects/defaults/binding`)).json();
    expect(binding).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "",
      branch: "main",
      apiBase: "https://api.github.com",
      hasToken: false,
    });
    expect((await fetch(`${BASE}/api/projects/defaults/binding`, { method: "DELETE" })).status)
      .toBe(200);
    await fetch(`${BASE}/api/projects/defaults`, { method: "DELETE" });
  });

  it("refuses bindings it cannot trust", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ owner: "-bad", repo: "diagrams" }, "invalid owner"],
      [{ owner: "acme", repo: "" }, "invalid repo"],
      [{ owner: "acme", repo: "diagrams", path: "../etc" }, "invalid path"],
      [{ owner: "acme", repo: "diagrams", path: "a/../b" }, "invalid path"],
      [{ owner: "acme", repo: "diagrams", branch: "no spaces" }, "invalid branch"],
      [{ owner: "acme", repo: "diagrams", branch: "a/../b" }, "invalid branch"],
      [{ owner: "acme", repo: "diagrams", apiBase: "ftp://example.com" }, "invalid apiBase"],
      [{ owner: "acme", repo: "diagrams", apiBase: "not a url" }, "invalid apiBase"],
      [{ owner: "acme", repo: "diagrams", token: "has space" }, "invalid token"],
    ];
    for (const [input, expected] of cases) {
      const res = await fetch(`${BASE}/api/projects/work/binding`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      expect(res.status, expected).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(expected);
    }
    const notJson = await fetch(`${BASE}/api/projects/work/binding`, {
      method: "PUT",
      body: "not json",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "body is not JSON" });
  });

  it("404s the binding of an unbound project", async () => {
    await fetch(`${BASE}/api/projects/plain`, { method: "PUT" });
    const res = await fetch(`${BASE}/api/projects/plain/binding`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no GitHub binding for project: plain",
    });
  });
});

// ---------------------------------------------------------------------------
// bound scenes
// ---------------------------------------------------------------------------

describe("bound project scenes", () => {
  it("lists the repository's scenes, with shas and the branch's timestamp", async () => {
    github.files.set("docs/diagrams/checkout.excalidraw", SCENE);
    github.files.set("docs/diagrams/README.md", "not a scene");
    github.files.set("docs/diagrams/other/nested.excalidraw", SCENE);

    const res = await fetch(`${BASE}/api/projects/work/scenes`);
    expect(res.status).toBe(200);
    const scenes = (await res.json()) as {
      name: string;
      updatedAt: string;
      size: number;
      sha: string;
    }[];
    // Only .excalidraw files, only at the bound path.
    expect(scenes.map((s) => s.name)).toEqual(["checkout"]);
    expect(scenes[0].sha).toBe(blobSha(SCENE));
    expect(scenes[0].size).toBe(Buffer.byteLength(SCENE));
    expect(scenes[0].updatedAt).toBe(COMMIT_DATE);
  });

  it("revalidates the listing with If-None-Match rather than refetching it", async () => {
    const before = github.requestsTo("/contents/docs/diagrams?").length;
    const again = (await (await fetch(`${BASE}/api/projects/work/scenes`)).json()) as {
      name: string;
    }[];
    expect(again.map((s) => s.name)).toEqual(["checkout"]);
    const requests = github.requestsTo("/contents/docs/diagrams?");
    expect(requests.length).toBe(before + 1);
    expect(requests[requests.length - 1].ifNoneMatch).toMatch(/listing-/);
  });

  it("flags bound projects in the projects listing without calling GitHub", async () => {
    const before = github.seen.length;
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as {
      id: string;
      scenes: number;
      bound?: boolean;
    }[];
    expect(github.seen.length, "the projects listing never blocks on GitHub").toBe(before);
    const work = projects.find((p) => p.id === "work");
    expect(work?.bound).toBe(true);
    // The count is whatever the last listing saw — one scene, from above.
    expect(work?.scenes).toBe(1);
    // The bindings dotfile is not a project.
    expect(projects.some((p) => p.id.startsWith("."))).toBe(false);
    // An unbound project carries no flag at all.
    expect(projects.find((p) => p.id === "plain")?.bound).toBeUndefined();
  });

  it("loads a scene with its conflict token", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/checkout`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SCENE);
    expect(res.headers.get("x-docent-scene-sha")).toBe(blobSha(SCENE));
  });

  it("404s a scene the repository does not have", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such scene: work/missing" });
  });

  it("saves a scene as a commit and answers with the new sha", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "PUT",
      headers: { "x-docent-scene-sha": blobSha(SCENE) },
      body: OTHER_SCENE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: blobSha(OTHER_SCENE) });
    expect(github.files.get("docs/diagrams/checkout.excalidraw")).toBe(OTHER_SCENE);

    const write = github.requestsTo("/contents/docs/diagrams/checkout.excalidraw").at(-1);
    const payload = JSON.parse(write?.body ?? "{}") as {
      message: string;
      branch: string;
      sha: string;
    };
    expect(payload.message).toBe("docent: update work/checkout");
    expect(payload.branch).toBe("main");
    expect(payload.sha).toBe(blobSha(SCENE));
  });

  it("creates a scene the repository does not have yet", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/fresh`, {
      method: "PUT",
      body: SCENE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: blobSha(SCENE) });
    const write = github.requestsTo("/contents/docs/diagrams/fresh.excalidraw").at(-1);
    expect((JSON.parse(write?.body ?? "{}") as { message: string }).message).toBe(
      "docent: create work/fresh",
    );
  });

  it("refuses a stale write with a 409 that says what to do", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "PUT",
      // The sha the scene had before the save above — someone else moved first.
      headers: { "x-docent-scene-sha": blobSha(SCENE) },
      body: SCENE,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CONFLICT_MESSAGE });
    // Nothing was overwritten.
    expect(github.files.get("docs/diagrams/checkout.excalidraw")).toBe(OTHER_SCENE);
  });

  it("still refuses bodies that are not .excalidraw scenes (D17)", async () => {
    const notJson = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "PUT",
      body: "not json",
    });
    expect(notJson.status).toBe(400);
    const wrongType = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "PUT",
      body: JSON.stringify({ type: "other" }),
    });
    expect(wrongType.status).toBe(400);
  });

  it("reads a scene too large for the contents API through the blob API", async () => {
    const big = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "x".repeat(INLINE_LIMIT) }],
    });
    github.files.set("docs/diagrams/big.excalidraw", big);
    const res = await fetch(`${BASE}/api/projects/work/scenes/big`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(big);
    expect(res.headers.get("x-docent-scene-sha")).toBe(blobSha(big));
    expect(github.requestsTo("/git/blobs/").length).toBeGreaterThan(0);
  });

  it("deletes a scene as a commit", async () => {
    const res = await fetch(`${BASE}/api/projects/work/scenes/fresh`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(github.files.has("docs/diagrams/fresh.excalidraw")).toBe(false);
    const remove = github
      .requestsTo("/contents/docs/diagrams/fresh.excalidraw")
      .filter((entry) => entry.method === "DELETE")
      .at(-1);
    expect((JSON.parse(remove?.body ?? "{}") as { message: string }).message).toBe(
      "docent: delete work/fresh",
    );
    const gone = await fetch(`${BASE}/api/projects/work/scenes/fresh`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(404);
  });

  it("401s when the token is missing or rejected", async () => {
    await fetch(`${BASE}/api/projects/tokenless`, { method: "PUT" });
    await fetch(`${BASE}/api/projects/tokenless/binding`, {
      method: "PUT",
      body: JSON.stringify({ owner: "acme", repo: "diagrams", apiBase: github.base }),
    });
    const missing = await fetch(`${BASE}/api/projects/tokenless/scenes`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: TOKEN_MESSAGE });

    // A token GitHub itself refuses reads the same way to the user.
    await fetch(`${BASE}/api/projects/tokenless/binding`, {
      method: "PUT",
      body: JSON.stringify({
        owner: "acme",
        repo: "diagrams",
        apiBase: github.base,
        token: "wrong-token",
      }),
    });
    const rejected = await fetch(`${BASE}/api/projects/tokenless/scenes/checkout`);
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: TOKEN_MESSAGE });
    await fetch(`${BASE}/api/projects/tokenless`, { method: "DELETE" });
  });

  it("unbinds without touching the local directory or the repository", async () => {
    // A stale local scene from before the binding: it survives, unread.
    await fetch(`${BASE}/api/projects/stale`, { method: "PUT" });
    await fetch(`${BASE}/api/projects/stale/scenes/local`, {
      method: "PUT",
      body: SCENE,
    });
    await bind("stale");
    // Bound: the local scene is invisible, the repository's scenes are not.
    const bound = (await (await fetch(`${BASE}/api/projects/stale/scenes`)).json()) as {
      name: string;
    }[];
    expect(bound.map((s) => s.name)).toEqual(["big", "checkout"]);

    const unbind = await fetch(`${BASE}/api/projects/stale/binding`, {
      method: "DELETE",
    });
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });

    // The local directory is back in charge, with its file untouched.
    const local = (await (await fetch(`${BASE}/api/projects/stale/scenes`)).json()) as {
      name: string;
    }[];
    expect(local.map((s) => s.name)).toEqual(["local"]);
    expect(
      await readFile(path.join(dataDir, "stale", "local.excalidraw"), "utf8"),
    ).toBe(SCENE);
    // And the token is gone with the binding.
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.stale).toBeUndefined();
    expect(github.files.has("docs/diagrams/checkout.excalidraw")).toBe(true);

    // Unbinding twice is a success, not a 404.
    expect(
      (await fetch(`${BASE}/api/projects/stale/binding`, { method: "DELETE" })).status,
    ).toBe(200);
    await fetch(`${BASE}/api/projects/stale`, { method: "DELETE" });
  });

  it("deleting a bound project unbinds it and leaves GitHub alone", async () => {
    await fetch(`${BASE}/api/projects/doomed`, { method: "PUT" });
    await bind("doomed");
    const before = github.files.size;

    const res = await fetch(`${BASE}/api/projects/doomed`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await readdir(dataDir)).not.toContain("doomed");
    expect(
      (await fetch(`${BASE}/api/projects/doomed/binding`)).status,
      "the binding went with it",
    ).toBe(404);
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.doomed).toBeUndefined();
    expect(github.files.size, "the repository is untouched").toBe(before);
  });
});

// ---------------------------------------------------------------------------
// regression: an unbound project is exactly what it was before S14
// ---------------------------------------------------------------------------

describe("unbound projects", () => {
  it("stay a plain file tree, with no sha and no flag (D17)", async () => {
    const put = await fetch(`${BASE}/api/projects/plain/scenes/local`, {
      method: "PUT",
      body: SCENE,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    expect(
      await readFile(path.join(dataDir, "plain", "local.excalidraw"), "utf8"),
    ).toBe(SCENE);

    const listed = await fetch(`${BASE}/api/projects/plain/scenes`);
    const scenes = (await listed.json()) as Record<string, unknown>[];
    expect(scenes).toHaveLength(1);
    expect(Object.keys(scenes[0])).toEqual(["name", "updatedAt", "size"]);

    const loaded = await fetch(`${BASE}/api/projects/plain/scenes/local`);
    expect(await loaded.text()).toBe(SCENE);
    expect(loaded.headers.get("x-docent-scene-sha")).toBeNull();

    expect(
      (await fetch(`${BASE}/api/projects/plain/scenes/local`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${BASE}/api/projects/nope/scenes/x`, { method: "PUT", body: SCENE }))
        .status,
    ).toBe(404);
  });
});
