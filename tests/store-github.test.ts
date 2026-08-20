/**
 * Per-project GitHub sync (S14, D27, D28) against the real store process:
 * binding CRUD, the secrets boundary (no token in the data tree, none in any
 * response), the bound read/write path — listing, load, save-as-commit, SHA
 * conflict, delete, the blob fallback, and the 401 a missing or rejected token
 * gets — and the branch-aware half: branches, drafting on one, and the pull
 * request back onto the base.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const WRITE_MESSAGE =
  "GitHub rejected the write — the token needs Contents: Read and write on acme/diagrams " +
  "(organization repos may also require fine-grained token approval)";
const UNVERIFIED_MESSAGE =
  "could not verify access to acme/diagrams — check the repo name and token";

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
  /** Branch name → head sha, which is all the ref endpoints need (D28). */
  branches = new Map<string, string>([["main", "sha-main"]]);
  /** Pull request numbers, handed out in order like GitHub's. */
  pulls = 0;
  /** What `GET /repos/acme/diagrams` calls the repository's default branch. */
  defaultBranch = "main";
  /** Bumped by every write, so the listing's ETag changes when it should. */
  version = 1;
  port = 0;
  /**
   * A token that may read and not write — what a fine-grained PAT is by
   * default. Contents GETs answer normally; PUT and DELETE answer GitHub's own
   * 403, and the repository probe reports `push: false`.
   */
  readOnly = false;
  /** `GET /repos/acme/diagrams` answers 404 — a wrong name, or a private repo. */
  repoMissing = false;

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
    // The repository itself: what the bind-time capability probe asks for. The
    // permissions object is the shape the REST API answers an authenticated
    // caller with, `push` being the write bit.
    if (rest.length === 0 && req.method === "GET") {
      if (this.repoMissing) return [404, { message: "Not Found" }];
      return [
        200,
        {
          full_name: "acme/diagrams",
          // The same answer names the branch a pull request should target,
          // which is where a binding's base comes from (D28).
          default_branch: this.defaultBranch,
          permissions: {
            admin: false,
            maintain: false,
            push: !this.readOnly,
            triage: false,
            pull: true,
          },
        },
      ];
    }
    if (rest[0] === "branches" && rest.length === 1 && req.method === "GET") {
      // Alphabetical, as GitHub answers it.
      return [
        200,
        [...this.branches.keys()].sort().map((name) => ({
          name,
          commit: { sha: this.branches.get(name) },
        })),
      ];
    }
    // The two Git-Data calls a branch is cut with: read the source's head,
    // then create the new ref at that sha.
    if (rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads" && req.method === "GET") {
      const wanted = rest.slice(3).join("/");
      const sha = this.branches.get(wanted);
      if (sha === undefined) return [404, { message: "Not Found" }];
      return [200, { ref: `refs/heads/${wanted}`, object: { sha, type: "commit" } }];
    }
    if (rest[0] === "git" && rest[1] === "refs" && rest.length === 2 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as { ref: string; sha: string };
      const name = payload.ref.replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) {
        return [422, { message: "Reference already exists" }];
      }
      this.branches.set(name, payload.sha);
      return [201, { ref: payload.ref, object: { sha: payload.sha, type: "commit" } }];
    }
    if (rest[0] === "pulls" && rest.length === 1 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as { head: string; base: string };
      // A branch that has not moved since it was cut has nothing to merge, and
      // GitHub says so inside the Validation-Failed envelope rather than at
      // its top level.
      if (this.branches.get(payload.head) === this.branches.get(payload.base)) {
        return [
          422,
          {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                field: "base",
                code: "invalid",
                message: `No commits between ${payload.base} and ${payload.head}`,
              },
            ],
          },
        ];
      }
      this.pulls += 1;
      return [
        201,
        {
          number: this.pulls,
          html_url: `https://github.com/acme/diagrams/pull/${this.pulls}`,
          head: { ref: payload.head },
          base: { ref: payload.base },
        },
      ];
    }
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

  /** GitHub's own words when the token authenticates but may not write. */
  private refused(): [number, unknown] {
    return [403, { message: "Resource not accessible by personal access token" }];
  }

  private put(repoPath: string, body: string): [number, unknown] {
    if (this.readOnly) return this.refused();
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
    if (this.readOnly) return this.refused();
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
    // The bind-time probe found a token that can write, and says so.
    expect(await put.json()).toEqual({ ok: true, canWrite: true, baseBranch: "main" });

    const get = await fetch(`${BASE}/api/projects/work/binding`);
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(JSON.parse(body)).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "docs/diagrams",
      branch: "main",
      // The repository's default branch, learned by the same bind-time probe
      // that learned the write bit (D28).
      baseBranch: "main",
      apiBase: github.base,
      hasToken: true,
      canWrite: true,
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
      baseBranch: "main",
      apiBase: github.base,
      // The probe's verdict is metadata, not a secret, so it lives here too.
      canWrite: true,
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
    // No token anywhere, so nothing was probed and nothing is claimed — and in
    // particular no request left the machine for the default API base.
    // …and with nothing to ask, the base falls back to the bound branch.
    expect(await put.json()).toEqual({ ok: true, canWrite: null, baseBranch: "main" });
    const binding = await (await fetch(`${BASE}/api/projects/defaults/binding`)).json();
    expect(binding).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "",
      branch: "main",
      baseBranch: "main",
      apiBase: "https://api.github.com",
      hasToken: false,
      canWrite: null,
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
      [{ owner: "acme", repo: "diagrams", baseBranch: "a/../b" }, "invalid branch"],
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
// a token that reads but does not write — the case that used to read as
// "token missing or rejected" while the scenes were plainly listing
// ---------------------------------------------------------------------------

describe("read-only tokens", () => {
  /** Run `body` against a repository this token may read and not write. */
  const readOnly = async (body: () => Promise<void>) => {
    github.readOnly = true;
    try {
      await body();
    } finally {
      github.readOnly = false;
    }
  };

  const bindingsFile = async () =>
    JSON.parse(
      await readFile(path.join(dataDir, ".docent", "bindings.json"), "utf8"),
    ) as Record<string, { canWrite?: boolean }>;

  it("are named at bind time, and remembered", async () => {
    await fetch(`${BASE}/api/projects/readonly`, { method: "PUT" });
    await readOnly(async () => {
      const put = await bind("readonly");
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ ok: true, canWrite: false, baseBranch: "main" });
    });

    // Persisted as metadata (not a secret), echoed by the binding route, and
    // carried by the projects listing so the modal can mark it without asking.
    expect((await bindingsFile()).readonly.canWrite).toBe(false);
    const binding = (await (
      await fetch(`${BASE}/api/projects/readonly/binding`)
    ).json()) as { hasToken: boolean; canWrite: boolean | null };
    expect(binding).toMatchObject({ hasToken: true, canWrite: false });
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as {
      id: string;
      bound?: boolean;
      canWrite?: boolean;
    }[];
    expect(projects.find((p) => p.id === "readonly")).toMatchObject({
      bound: true,
      canWrite: false,
    });
    // An unbound project gains no such field.
    expect(projects.find((p) => p.id === "plain")?.canWrite).toBeUndefined();

    // …and a token that can write clears the mark again, which is the loop the
    // message asks the user to close.
    const again = await bind("readonly");
    expect(await again.json()).toEqual({ ok: true, canWrite: true, baseBranch: "main" });
    expect((await bindingsFile()).readonly.canWrite).toBe(true);
  });

  it("refuse a save with the permission that is missing, not a credential message", async () => {
    await readOnly(async () => {
      // Overwriting an existing scene…
      const update = await fetch(`${BASE}/api/projects/readonly/scenes/checkout`, {
        method: "PUT",
        body: SCENE,
      });
      expect(update.status).toBe(403);
      expect(await update.json()).toEqual({ error: WRITE_MESSAGE });

      // …and creating one, which is what the field report was about.
      const created = await fetch(`${BASE}/api/projects/readonly/scenes/brand new`, {
        method: "PUT",
        body: SCENE,
      });
      expect(created.status).toBe(403);
      expect(await created.json()).toEqual({ error: WRITE_MESSAGE });
      expect(github.files.has("docs/diagrams/brand new.excalidraw")).toBe(false);
    });
  });

  it("refuse a delete the same way, and the scene survives", async () => {
    await readOnly(async () => {
      const res = await fetch(`${BASE}/api/projects/readonly/scenes/checkout`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: WRITE_MESSAGE });
    });
    expect(github.files.has("docs/diagrams/checkout.excalidraw")).toBe(true);
  });

  it("still list and open scenes — reads are untouched", async () => {
    await readOnly(async () => {
      const listed = await fetch(`${BASE}/api/projects/readonly/scenes`);
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { name: string }[]).map((s) => s.name)).toEqual([
        "big",
        "checkout",
      ]);

      const loaded = await fetch(`${BASE}/api/projects/readonly/scenes/checkout`);
      expect(loaded.status).toBe(200);
      expect(await loaded.text()).toBe(OTHER_SCENE);
    });
  });

  it("bind anyway when the repository cannot be reached, and say why", async () => {
    github.repoMissing = true;
    try {
      await fetch(`${BASE}/api/projects/unverified`, { method: "PUT" });
      const put = await bind("unverified");
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({
        ok: true,
        canWrite: null,
        // Unreachable means the default branch could not be read either, so
        // the base falls back to the branch being bound.
        baseBranch: "main",
        warning: UNVERIFIED_MESSAGE,
      });
    } finally {
      github.repoMissing = false;
    }
    // Unknown is stored as an absent field, never as a claim either way.
    expect("canWrite" in (await bindingsFile()).unverified).toBe(false);
    const binding = (await (
      await fetch(`${BASE}/api/projects/unverified/binding`)
    ).json()) as { canWrite: boolean | null };
    expect(binding.canWrite).toBeNull();
    await fetch(`${BASE}/api/projects/unverified`, { method: "DELETE" });
  });

  it("are not probed for at all when there is no token", async () => {
    const probes = () =>
      github.seen.filter((entry) => entry.url === "/repos/acme/diagrams").length;
    const before = probes();
    await fetch(`${BASE}/api/projects/unprobed`, { method: "PUT" });
    const put = await bind("unprobed", { token: undefined });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, canWrite: null, baseBranch: "main" });
    expect(probes(), "nothing to ask with, so nothing was asked").toBe(before);
    await fetch(`${BASE}/api/projects/unprobed`, { method: "DELETE" });
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

// ---------------------------------------------------------------------------
// branch-aware sync (D28): drafting on a branch, and the pull request back
// ---------------------------------------------------------------------------

describe("branches and pull requests", () => {
  const BRANCH_NAME_MESSAGE =
    'invalid branch name — letters, digits, ., _, - or / (max 200, no "..", no "//", ' +
    'no leading or trailing "/")';

  // `dataDir` only exists once the fixture has run, so this is a call.
  const bindingsFile = () => path.join(dataDir, ".docent", "bindings.json");

  const branches = (project: string) =>
    fetch(`${BASE}/api/projects/${project}/branches`);

  const createBranch = (project: string, body: unknown) =>
    fetch(`${BASE}/api/projects/${project}/branches`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  const pullRequest = (project: string, body: unknown = {}) =>
    fetch(`${BASE}/api/projects/${project}/pull-request`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  const bindingOf = async (project: string) =>
    (await (await fetch(`${BASE}/api/projects/${project}/binding`)).json()) as {
      branch: string;
      baseBranch: string;
      hasToken: boolean;
      canWrite: boolean | null;
    };

  // Every case starts from a repository with one branch and no pull requests,
  // so what it asserts about is only ever what it did itself.
  beforeEach(() => {
    github.branches = new Map([["main", "sha-main"]]);
    github.pulls = 0;
  });

  it("lists the repository's branches, marking the base and the active one", async () => {
    github.branches.set("docent/older", "sha-older");
    const res = await branches("work");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "docent/older", isBase: false, isActive: false },
      { name: "main", isBase: true, isActive: true },
    ]);
    // One page, and the store says so rather than walking the repository's
    // release history to fill a select.
    expect(github.requestsTo("/branches?per_page=100").length).toBeGreaterThan(0);
  });

  it("creates a branch, switches to it, and keeps the base and the token", async () => {
    await fetch(`${BASE}/api/projects/drafts`, { method: "PUT" });
    await bind("drafts");

    const created = await createBranch("drafts", { name: "docent/diagrams-2026-08-20" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      ok: true,
      branch: "docent/diagrams-2026-08-20",
    });
    // Cut from the branch the project was on, at that branch's head.
    const ref = github
      .requestsTo("/git/refs")
      .filter((entry) => entry.method === "POST")
      .at(-1);
    expect(JSON.parse(ref?.body ?? "{}")).toEqual({
      ref: "refs/heads/docent/diagrams-2026-08-20",
      sha: "sha-main",
    });

    // The binding moved, and nothing else about it did.
    const binding = await bindingOf("drafts");
    expect(binding.branch).toBe("docent/diagrams-2026-08-20");
    expect(binding.baseBranch).toBe("main");
    expect(binding.hasToken).toBe(true);
    expect(binding.canWrite).toBe(true);
    const stored = JSON.parse(await readFile(bindingsFile(), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(stored.drafts).toEqual({
      owner: "acme",
      repo: "diagrams",
      path: "docs/diagrams",
      branch: "docent/diagrams-2026-08-20",
      baseBranch: "main",
      apiBase: github.base,
      canWrite: true,
    });
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.drafts, "the token is untouched by a branch switch").toBe(TOKEN);

    // …and the next save commits to the branch that was just created.
    const saved = await fetch(`${BASE}/api/projects/drafts/scenes/draft`, {
      method: "PUT",
      body: SCENE,
    });
    expect(saved.status).toBe(200);
    const write = github.requestsTo("/contents/docs/diagrams/draft.excalidraw").at(-1);
    expect((JSON.parse(write?.body ?? "{}") as { branch: string }).branch).toBe(
      "docent/diagrams-2026-08-20",
    );
    // The listing now says which branch is which.
    expect(await (await branches("drafts")).json()).toEqual([
      { name: "docent/diagrams-2026-08-20", isBase: false, isActive: true },
      { name: "main", isBase: true, isActive: false },
    ]);
  });

  it("switches branches with a binding PUT that keeps the base and the token", async () => {
    github.branches.set("docent/existing", "sha-existing");
    const switched = await fetch(`${BASE}/api/projects/drafts/binding`, {
      method: "PUT",
      // Exactly what the client sends: the binding it already has, on another
      // branch. No base, no token.
      body: JSON.stringify({
        owner: "acme",
        repo: "diagrams",
        path: "docs/diagrams",
        branch: "docent/existing",
        apiBase: github.base,
      }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      ok: true,
      canWrite: true,
      baseBranch: "main",
    });
    const binding = await bindingOf("drafts");
    expect(binding.branch).toBe("docent/existing");
    expect(binding.baseBranch).toBe("main");
    expect(binding.hasToken).toBe(true);
  });

  it("refuses a branch that already exists", async () => {
    await fetch(`${BASE}/api/projects/dupes`, { method: "PUT" });
    await bind("dupes");
    expect((await createBranch("dupes", { name: "docent/taken" })).status).toBe(201);

    const again = await createBranch("dupes", { name: "docent/taken" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "branch docent/taken already exists on acme/diagrams",
    });
    // The project stays where it was rather than half-moving.
    expect((await bindingOf("dupes")).branch).toBe("docent/taken");
  });

  it("refuses branch names it cannot address", async () => {
    const refs = () => github.requestsTo("/git/refs").length;
    const before = refs();
    for (const name of [
      "",
      "-nope",
      "docent/a..b",
      "docent//b",
      "docent/trailing/",
      "x".repeat(201),
      42,
      null,
      undefined,
    ]) {
      const res = await createBranch("work", { name });
      expect(res.status, String(name)).toBe(400);
      expect(await res.json()).toEqual({ error: BRANCH_NAME_MESSAGE });
    }
    // A source branch is held to the gate every branch is held to.
    const badFrom = await createBranch("work", { name: "docent/ok", from: "a/../b" });
    expect(badFrom.status).toBe(400);
    expect(((await badFrom.json()) as { error: string }).error).toContain("invalid branch");
    expect(refs(), "nothing reached the repository").toBe(before);
  });

  it("names a source branch the repository does not have", async () => {
    const res = await createBranch("work", { name: "docent/orphan", from: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no branch named nope on acme/diagrams",
    });
  });

  it("opens a pull request from the active branch onto the base", async () => {
    await fetch(`${BASE}/api/projects/review`, { method: "PUT" });
    await bind("review");
    expect((await createBranch("review", { name: "docent/review-me" })).status).toBe(201);
    // The branch has moved since it was cut, so there is something to review.
    github.branches.set("docent/review-me", "sha-review");

    const res = await pullRequest("review", { title: "Diagrams: the checkout flow" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      url: "https://github.com/acme/diagrams/pull/1",
      number: 1,
    });
    const sent = github.requestsTo("/pulls").at(-1);
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      title: "Diagrams: the checkout flow",
      head: "docent/review-me",
      base: "main",
      body: "",
    });

    // Without a title it says what it is, which is all a diagram commit needs.
    github.branches.set("docent/review-me", "sha-review-2");
    expect((await pullRequest("review")).status).toBe(201);
    expect(
      (JSON.parse(github.requestsTo("/pulls").at(-1)?.body ?? "{}") as { title: string })
        .title,
    ).toBe("docent: update diagrams");
  });

  it("refuses a pull request from the base branch itself", async () => {
    const before = github.requestsTo("/pulls").length;
    const res = await pullRequest("work");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "the active branch main is the base branch — create a branch first",
    });
    expect(github.requestsTo("/pulls").length, "nothing was asked of GitHub").toBe(
      before,
    );
  });

  it("passes GitHub's refusal through when there is nothing to merge", async () => {
    await fetch(`${BASE}/api/projects/nodiff`, { method: "PUT" });
    await bind("nodiff");
    expect((await createBranch("nodiff", { name: "docent/untouched" })).status).toBe(201);

    const res = await pullRequest("nodiff");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub: No commits between main and docent/untouched",
    });
  });

  it("404s branch routes on an unbound project", async () => {
    const expected = { error: "no GitHub binding for project: plain" };
    const listed = await branches("plain");
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual(expected);

    const created = await createBranch("plain", { name: "docent/nowhere" });
    expect(created.status).toBe(404);
    expect(await created.json()).toEqual(expected);

    const pr = await pullRequest("plain");
    expect(pr.status).toBe(404);
    expect(await pr.json()).toEqual(expected);
  });

  it("records the repository's default branch as the base at bind time", async () => {
    github.defaultBranch = "trunk";
    try {
      await fetch(`${BASE}/api/projects/trunky`, { method: "PUT" });
      const put = await bind("trunky", { branch: "docent/wip" });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({
        ok: true,
        canWrite: true,
        baseBranch: "trunk",
      });
      const binding = await bindingOf("trunky");
      expect(binding.branch).toBe("docent/wip");
      expect(binding.baseBranch).toBe("trunk");
    } finally {
      github.defaultBranch = "main";
    }
  });

  it("falls back to the bound branch when the default cannot be read", async () => {
    github.repoMissing = true;
    try {
      await fetch(`${BASE}/api/projects/nobase`, { method: "PUT" });
      const put = await bind("nobase", { branch: "release/1" });
      expect(await put.json()).toEqual({
        ok: true,
        canWrite: null,
        baseBranch: "release/1",
        warning: UNVERIFIED_MESSAGE,
      });
    } finally {
      github.repoMissing = false;
    }
    expect((await bindingOf("nobase")).baseBranch).toBe("release/1");
  });

  it("treats a binding written before branch-aware sync as its own base", async () => {
    await fetch(`${BASE}/api/projects/legacy`, { method: "PUT" });
    await bind("legacy");
    // Rewrite the dotfile the way the store wrote it before D28 existed: no
    // baseBranch at all. Nothing migrates it, and nothing has to.
    const stored = JSON.parse(await readFile(bindingsFile(), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    delete stored.legacy.baseBranch;
    await writeFile(bindingsFile(), JSON.stringify(stored, null, 2) + "\n", "utf8");

    const binding = await bindingOf("legacy");
    expect(binding.branch).toBe("main");
    expect(binding.baseBranch, "the branch it points at is its own base").toBe("main");
    const listed = (await (await branches("legacy")).json()) as { isBase: boolean }[];
    expect(listed.find((entry) => entry.isBase)).toBeDefined();
    // So nothing is a draft, and no pull request is on offer.
    const pr = await pullRequest("legacy");
    expect(pr.status).toBe(400);
    expect(await pr.json()).toEqual({
      error: "the active branch main is the base branch — create a branch first",
    });

    // …and the next binding PUT records a base without being asked to.
    await bind("legacy");
    expect((await bindingOf("legacy")).baseBranch).toBe("main");
  });

  it("refuses branch work with the permission that is missing", async () => {
    github.readOnly = true;
    try {
      const created = await createBranch("work", { name: "docent/read-only" });
      expect(created.status).toBe(403);
      expect(await created.json()).toEqual({ error: WRITE_MESSAGE });
    } finally {
      github.readOnly = false;
    }
    expect(github.branches.has("docent/read-only")).toBe(false);
  });
});
