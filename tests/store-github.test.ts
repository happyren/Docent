/**
 * Per-project GitHub sync (S14, D27, D28, D29, D30) against the real store
 * process: binding CRUD, the secrets boundary (no token in the data tree, none
 * in any response), the **local-first** working copy — scene CRUD that never
 * reaches the network — and the sync verbs that do: status, pull, conflict
 * resolution, and the single-commit push, plus the branch-aware half.
 *
 * GitHub itself is a plain `node:http` server in this file. It is not a
 * simulation of the API, only of the calls the store makes, but it answers them
 * the way GitHub does — base64 contents, ETag revalidation on the listing, real
 * blob shas, Git-Data blobs/trees/commits, and a non-fast-forward ref update
 * refused the way GitHub refuses one. `apiBase` is part of the binding, so
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
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
const THIRD_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [{ id: "b" }],
});
const TOKEN = "github_pat_11ABCDEF0_docenttest";

const TOKEN_MESSAGE =
  "GitHub token missing or rejected for this project — set it in the binding";
const WRITE_MESSAGE =
  "GitHub rejected the write — the token needs Contents: Read and write on acme/diagrams " +
  "(organization repos may also require fine-grained token approval)";
const UNVERIFIED_MESSAGE =
  "could not verify access to acme/diagrams — check the repo name and token";
const MOVED_MESSAGE = "the remote branch moved — pull first";
const BASE_BRANCH_MESSAGE =
  "pushing to the base branch is disabled — create a branch and open a pull request";

/** A git blob sha, computed the way git computes one, so it looks real. */
const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");

/** The store's own content hash, so a test can predict what it recorded. */
const contentHash = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// the mock GitHub API
// ---------------------------------------------------------------------------

interface SeenRequest {
  method: string;
  url: string;
  body: string;
  ifNoneMatch?: string;
}

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

class MockGitHub {
  readonly server: http.Server;
  /**
   * The repository's files, as the active branch sees them. One set rather
   * than one per branch: the store never reads two branches at once, and a
   * push replaces this wholesale with the tree it just committed.
   */
  readonly files = new Map<string, string>();
  /** Blobs created through the Git Data API, by their sha. */
  readonly blobs = new Map<string, string>();
  /** Trees created through the Git Data API: sha → path → content. */
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
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
  objects = 0;
  /**
   * A token that may read and not write — what a fine-grained PAT is by
   * default. Reads answer normally; every write answers GitHub's own 403, and
   * the repository probe reports `push: false`.
   */
  readOnly = false;
  /** `GET /repos/acme/diagrams` answers 404 — a wrong name, or a private repo. */
  repoMissing = false;
  /**
   * Advance the branch the moment its head is read: the race a push is
   * supposed to lose. The commit it then builds names a parent that is no
   * longer the head, so the ref update is not a fast-forward.
   */
  moveHeadOnRefRead = false;

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

  /** Someone else's commit: a file changes and the listing's ETag moves. */
  write(repoPath: string, content: string): void {
    this.files.set(repoPath, content);
    this.version += 1;
  }

  remove(repoPath: string): void {
    this.files.delete(repoPath);
    this.version += 1;
  }

  requestsTo(fragment: string): SeenRequest[] {
    return this.seen.filter((entry) => entry.url.includes(fragment));
  }

  bodyOf(fragment: string, method: string): Record<string, unknown> {
    const sent = this.seen
      .filter((entry) => entry.url.includes(fragment) && entry.method === method)
      .at(-1);
    return JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
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
    if (rest[0] === "git") return this.gitData(rest.slice(1), req, body);
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
    if (rest[0] !== "contents") return [404, { message: "Not Found" }];
    if (req.method !== "GET") return [404, { message: "Not Found" }];
    return this.get(rest.slice(1).join("/"), req);
  }

  /** Everything under `/git/…` — refs, blobs, trees and commits. */
  private gitData(
    rest: string[],
    req: http.IncomingMessage,
    body: string,
  ): [number, unknown, Record<string, string>?] {
    const notFound: [number, unknown] = [404, { message: "Not Found" }];
    // The head of a branch, which is where both a new branch and a push start.
    if (rest[0] === "ref" && rest[1] === "heads" && req.method === "GET") {
      const wanted = rest.slice(2).join("/");
      const sha = this.branches.get(wanted);
      if (sha === undefined) return notFound;
      if (this.moveHeadOnRefRead) {
        const moved = this.nextSha("commit");
        this.commits.set(moved, {
          tree: `tree-of-${moved}`,
          parents: [sha],
          message: "someone else",
        });
        this.branches.set(wanted, moved);
        this.version += 1;
      }
      return [200, { ref: `refs/heads/${wanted}`, object: { sha, type: "commit" } }];
    }
    if (rest[0] === "refs" && rest.length === 1 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as { ref: string; sha: string };
      const name = payload.ref.replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) {
        return [422, { message: "Reference already exists" }];
      }
      this.branches.set(name, payload.sha);
      return [201, { ref: payload.ref, object: { sha: payload.sha, type: "commit" } }];
    }
    // Moving a branch: accepted only when the new commit descends from the
    // head this branch currently has, which is what "non-force" means.
    if (rest[0] === "refs" && rest[1] === "heads" && req.method === "PATCH") {
      if (this.readOnly) return this.refused();
      const name = rest.slice(2).join("/");
      const current = this.branches.get(name);
      if (current === undefined) return notFound;
      const payload = JSON.parse(body) as { sha: string; force?: boolean };
      const commit = this.commits.get(payload.sha);
      if (!payload.force && !(commit?.parents ?? []).includes(current)) {
        return [422, { message: "Update is not a fast forward" }];
      }
      this.branches.set(name, payload.sha);
      // One file map stands for the working branch; the quarantined review
      // branch (D49) keeps its pictures to itself.
      const snapshot =
        commit && name !== "docent-review" ? this.trees.get(commit.tree) : undefined;
      if (snapshot) {
        this.files.clear();
        for (const [key, value] of snapshot) this.files.set(key, value);
      }
      this.version += 1;
      return [200, { ref: `refs/heads/${name}`, object: { sha: payload.sha, type: "commit" } }];
    }
    if (rest[0] === "blobs" && rest.length === 2 && req.method === "GET") {
      const wanted = rest[1];
      const known =
        this.blobs.get(wanted) ??
        [...this.files.values()].find((content) => blobSha(content) === wanted);
      if (known === undefined) return notFound;
      return [
        200,
        {
          sha: wanted,
          encoding: "base64",
          content: Buffer.from(known, "utf8").toString("base64") + "\n",
        },
      ];
    }
    if (rest[0] === "blobs" && rest.length === 1 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as { content: string; encoding?: string };
      const text =
        payload.encoding === "base64"
          ? Buffer.from(payload.content, "base64").toString("utf8")
          : payload.content;
      const sha = blobSha(text);
      this.blobs.set(sha, text);
      return [201, { sha, url: `blob/${sha}` }];
    }
    if (rest[0] === "trees" && rest.length === 1 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as {
        base_tree: string;
        tree: { path: string; sha: string | null }[];
      };
      // The base tree is whatever the branch holds now; the entries are laid
      // over it, and a null sha removes a path exactly as the API documents.
      const snapshot = new Map(this.files);
      for (const entry of payload.tree) {
        if (entry.sha === null) snapshot.delete(entry.path);
        else snapshot.set(entry.path, this.blobs.get(entry.sha) ?? "");
      }
      const sha = this.nextSha("tree");
      this.trees.set(sha, snapshot);
      return [201, { sha }];
    }
    if (rest[0] === "trees" && rest.length === 2 && req.method === "GET") {
      const snapshot = this.trees.get(rest[1].split("?")[0]);
      if (!snapshot) return notFound;
      return [
        200,
        {
          sha: rest[1],
          tree: [...snapshot.keys()].map((path) => ({ path, type: "blob", mode: "100644" })),
        },
      ];
    }
    if (rest[0] === "commits" && rest.length === 1 && req.method === "POST") {
      if (this.readOnly) return this.refused();
      const payload = JSON.parse(body) as {
        message: string;
        tree: string;
        parents?: string[];
      };
      const sha = this.nextSha("commit");
      this.commits.set(sha, {
        tree: payload.tree,
        parents: payload.parents ?? [],
        message: payload.message,
      });
      return [201, { sha, message: payload.message, tree: { sha: payload.tree } }];
    }
    if (rest[0] === "commits" && rest.length === 2 && req.method === "GET") {
      const known = this.commits.get(rest[1]);
      return [
        200,
        {
          sha: rest[1],
          // A commit this mock never created still points at *a* tree: the
          // seeded head is one, and a push has to be able to start there.
          tree: { sha: known?.tree ?? `tree-of-${rest[1]}` },
          parents: (known?.parents ?? []).map((parent) => ({ sha: parent })),
        },
      ];
    }
    return notFound;
  }

  private nextSha(kind: string): string {
    this.objects += 1;
    return `${kind}-${this.objects}`;
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

/**
 * A project of its own, bound to a directory of its own inside the one mock
 * repository, so cases never reconcile each other's scenes.
 */
async function boundProject(project: string, extra: Record<string, unknown> = {}) {
  const created = await fetch(`${BASE}/api/projects/${project}`, { method: "PUT" });
  expect(created.status).toBe(201);
  const bound = await bind(project, { path: `docs/${project}`, ...extra });
  expect(bound.status, bound.statusText).toBe(200);
  return `docs/${project}`;
}

const sceneUrl = (project: string, scene: string) =>
  `${BASE}/api/projects/${project}/scenes/${encodeURIComponent(scene)}`;
const putScene = (project: string, scene: string, body: string) =>
  fetch(sceneUrl(project, scene), { method: "PUT", body });
const getScene = (project: string, scene: string) => fetch(sceneUrl(project, scene));
const deleteScene = (project: string, scene: string) =>
  fetch(sceneUrl(project, scene), { method: "DELETE" });
const listScenes = (project: string) => fetch(`${BASE}/api/projects/${project}/scenes`);

const syncStatus = (project: string) =>
  fetch(`${BASE}/api/projects/${project}/sync-status`);
const pull = (project: string) =>
  fetch(`${BASE}/api/projects/${project}/pull`, { method: "POST" });
const resolve = (project: string, body: unknown) =>
  fetch(`${BASE}/api/projects/${project}/pull/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
const push = (project: string) =>
  fetch(`${BASE}/api/projects/${project}/push`, { method: "POST" });
const pushWith = (project: string, body: unknown) =>
  fetch(`${BASE}/api/projects/${project}/push`, {
    method: "POST",
    body: JSON.stringify(body),
  });
const baseOf = (project: string, scene: string) =>
  fetch(`${BASE}/api/projects/${project}/scenes/${scene}/base`);

type SyncAnswer = {
  branch: string;
  baseBranch: string;
  local: { name: string; state: string }[];
  remote: { reachable: boolean; changed: string[]; removed: string[] };
};

const statusOf = async (project: string): Promise<SyncAnswer> => {
  const res = await syncStatus(project);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as SyncAnswer;
};

const stateOf = (status: SyncAnswer, scene: string) =>
  status.local.find((entry) => entry.name === scene)?.state;

const syncFile = (project: string) =>
  path.join(dataDir, ".docent", "sync", `${project}.json`);
const readSyncFile = async (project: string) =>
  JSON.parse(await readFile(syncFile(project), "utf8")) as {
    scenes: Record<string, { baseSha: string; baseHash: string; conflictSha?: string }>;
  };
const localFile = (project: string, scene: string) =>
  path.join(dataDir, project, `${scene}.excalidraw`);

/**
 * Draft on a branch: the base branch is protected (D30), so every case that
 * pushes has to be somewhere else first.
 */
async function draftOn(project: string, branch: string) {
  const created = await fetch(`${BASE}/api/projects/${project}/branches`, {
    method: "POST",
    body: JSON.stringify({ name: branch }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
}

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
      // Review artifacts (D49) are off until a team asks.
      review: { images: false, sidecars: false },
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
      review: { images: false, sidecars: false },
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
// the working copy (D29): a bound project's scenes are files, and nothing else
// ---------------------------------------------------------------------------

describe("a bound project is a local working copy", () => {
  it("opens, saves and deletes scenes without one request to GitHub", async () => {
    await boundProject("copy");
    const before = github.seen.length;

    expect((await putScene("copy", "checkout", SCENE)).status).toBe(200);
    const saved = await putScene("copy", "checkout", OTHER_SCENE);
    expect(await saved.json()).toEqual({ ok: true });

    const loaded = await getScene("copy", "checkout");
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toBe(OTHER_SCENE);
    // The conflict token S14 used to carry is gone with the network round-trip
    // it guarded.
    expect(loaded.headers.get("x-docent-scene-sha")).toBeNull();

    const listed = (await (await listScenes("copy")).json()) as Record<string, unknown>[];
    expect(listed.map((scene) => scene.name)).toEqual(["checkout"]);
    // A bound scene lists exactly as a local one does — same keys, no sha.
    expect(Object.keys(listed[0])).toEqual(["name", "updatedAt", "size"]);

    expect((await deleteScene("copy", "checkout")).status).toBe(200);
    expect((await getScene("copy", "checkout")).status).toBe(404);

    expect(github.seen.length, "not one call left the machine").toBe(before);
  });

  it("keeps the files that were already there when the binding arrives", async () => {
    await fetch(`${BASE}/api/projects/adopted`, { method: "PUT" });
    expect((await putScene("adopted", "drawn here", SCENE)).status).toBe(200);
    await boundProject("adopted");

    // Binding wipes nothing: the file is still the project's, and still open.
    const loaded = await getScene("adopted", "drawn here");
    expect(await loaded.text()).toBe(SCENE);
    // …and it is local-new until a pull decides what to do with it.
    expect(stateOf(await statusOf("adopted"), "drawn here")).toBe("new");
  });

  it("counts a bound project's scenes without calling GitHub", async () => {
    const before = github.seen.length;
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as {
      id: string;
      scenes: number;
      updatedAt: string | null;
      bound?: boolean;
    }[];
    expect(github.seen.length, "the projects listing never blocks on GitHub").toBe(before);
    const adopted = projects.find((project) => project.id === "adopted");
    expect(adopted?.bound).toBe(true);
    // The count is the working copy's, and it has a timestamp like any other.
    expect(adopted?.scenes).toBe(1);
    expect(adopted?.updatedAt).not.toBeNull();
    // The bindings dotfile is not a project.
    expect(projects.some((project) => project.id.startsWith("."))).toBe(false);
    // An unbound project carries no flag at all.
    expect(projects.find((project) => project.id === "plain")?.bound).toBeUndefined();
  });

  it("still refuses bodies that are not .excalidraw scenes (D17)", async () => {
    const notJson = await putScene("copy", "checkout", "not json");
    expect(notJson.status).toBe(400);
    const wrongType = await putScene("copy", "checkout", JSON.stringify({ type: "other" }));
    expect(wrongType.status).toBe(400);
  });

  it("unbinds without touching the working copy, and forgets the sync state", async () => {
    await boundProject("released");
    github.write("docs/released/remote.excalidraw", SCENE);
    expect((await pull("released")).status).toBe(200);
    expect((await readSyncFile("released")).scenes.remote).toBeDefined();

    const unbind = await fetch(`${BASE}/api/projects/released/binding`, {
      method: "DELETE",
    });
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });

    // The pulled file stays; the sync state and the token go.
    expect(await readFile(localFile("released", "remote"), "utf8")).toBe(SCENE);
    await expect(readFile(syncFile("released"), "utf8")).rejects.toThrow();
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.released).toBeUndefined();
    expect(github.files.has("docs/released/remote.excalidraw")).toBe(true);

    // Unbinding twice is a success, not a 404.
    expect(
      (await fetch(`${BASE}/api/projects/released/binding`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("deleting a bound project removes its sync state and leaves GitHub alone", async () => {
    await boundProject("doomed");
    github.write("docs/doomed/remote.excalidraw", SCENE);
    expect((await pull("doomed")).status).toBe(200);
    const before = github.files.size;

    const res = await fetch(`${BASE}/api/projects/doomed`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await readdir(dataDir)).not.toContain("doomed");
    await expect(readFile(syncFile("doomed"), "utf8")).rejects.toThrow();
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
// sync status
// ---------------------------------------------------------------------------

describe("sync status", () => {
  it("names what every scene did since the last sync", async () => {
    await boundProject("states");
    github.write("docs/states/clean.excalidraw", SCENE);
    github.write("docs/states/edited.excalidraw", SCENE);
    github.write("docs/states/gone.excalidraw", SCENE);
    expect((await pull("states")).status).toBe(200);

    // …then the three things an author can do to a working copy.
    expect((await putScene("states", "edited", OTHER_SCENE)).status).toBe(200);
    expect((await deleteScene("states", "gone")).status).toBe(200);
    expect((await putScene("states", "fresh", SCENE)).status).toBe(200);

    const status = await statusOf("states");
    expect(status.branch).toBe("main");
    expect(status.baseBranch).toBe("main");
    expect(status.local).toEqual([
      { name: "clean", state: "clean" },
      { name: "edited", state: "modified" },
      { name: "fresh", state: "new" },
      { name: "gone", state: "deleted" },
    ]);
    // Nothing moved on the branch, so the remote half is empty and reachable.
    expect(status.remote).toEqual({ reachable: true, changed: [], removed: [] });
  });

  it("names what the branch did, on one listing call", async () => {
    github.write("docs/states/clean.excalidraw", OTHER_SCENE);
    github.write("docs/states/added.excalidraw", SCENE);
    github.remove("docs/states/edited.excalidraw");
    const before = github.requestsTo("/contents/docs/states").length;

    const status = await statusOf("states");
    expect(status.remote.reachable).toBe(true);
    // A blob that moved, and one the branch never had before.
    expect(status.remote.changed).toEqual(["added", "clean"]);
    // A scene the branch dropped, which the working copy still has.
    expect(status.remote.removed).toEqual(["edited"]);
    const listings = github.requestsTo("/contents/docs/states");
    expect(listings.length - before, "one listing call, and nothing else").toBe(1);
    // …and it revalidates rather than refetching blind: the previous listing's
    // ETag rides along, so an unchanged branch costs the rate limit nothing.
    expect(listings.at(-1)?.ifNoneMatch).toMatch(/listing-/);
  });

  it("says plainly when the remote cannot be reached, and still answers locally", async () => {
    await fetch(`${BASE}/api/projects/offline`, { method: "PUT" });
    expect((await putScene("offline", "sketch", SCENE)).status).toBe(200);
    // A binding whose API base answers nothing at all — the bind is stored
    // regardless, which is what makes an offline machine usable.
    const bound = await bind("offline", { apiBase: "http://127.0.0.1:1" });
    expect(bound.status).toBe(200);

    const status = await statusOf("offline");
    expect(status.remote).toEqual({ reachable: false, changed: [], removed: [] });
    expect(status.local).toEqual([{ name: "sketch", state: "new" }]);
  });

  it("404s on an unbound project", async () => {
    const res = await syncStatus("plain");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no GitHub binding for project: plain",
    });
  });
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

describe("pull", () => {
  it("brings a legacy binding's scenes in without losing local work", async () => {
    // Exactly the state a project bound before D29 is in: files on disk, scenes
    // in the repository, and no sync state anywhere.
    await fetch(`${BASE}/api/projects/legacy`, { method: "PUT" });
    expect((await putScene("legacy", "only here", SCENE)).status).toBe(200);
    await boundProject("legacy");
    github.write("docs/legacy/only there.excalidraw", OTHER_SCENE);
    github.write("docs/legacy/README.md", "not a scene");
    github.write("docs/legacy/nested/deep.excalidraw", SCENE);

    const res = await pull("legacy");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      updated: ["only there"],
      removed: [],
      kept: ["only here"],
      conflicts: [],
    });
    // The remote scene arrived, the local one stayed, and nothing outside the
    // bound directory's own .excalidraw files was touched.
    expect(await readFile(localFile("legacy", "only there"), "utf8")).toBe(OTHER_SCENE);
    expect(await readFile(localFile("legacy", "only here"), "utf8")).toBe(SCENE);
    const listed = (await (await listScenes("legacy")).json()) as { name: string }[];
    expect(listed.map((scene) => scene.name)).toEqual(["only here", "only there"]);
  });

  it("adopts a local file that already matches the remote", async () => {
    await fetch(`${BASE}/api/projects/samefile`, { method: "PUT" });
    expect((await putScene("samefile", "shared", SCENE)).status).toBe(200);
    await boundProject("samefile");
    github.write("docs/samefile/shared.excalidraw", SCENE);

    const res = await pull("samefile");
    // Same bytes on both sides is an agreement, not a conflict: the scene
    // simply becomes tracked.
    expect(await res.json()).toEqual({
      ok: true,
      updated: ["shared"],
      removed: [],
      kept: [],
      conflicts: [],
    });
    expect(stateOf(await statusOf("samefile"), "shared")).toBe("clean");
  });

  it("fast-forwards a clean scene and creates one the remote added", async () => {
    await boundProject("forward");
    github.write("docs/forward/checkout.excalidraw", SCENE);
    expect((await pull("forward")).status).toBe(200);

    github.write("docs/forward/checkout.excalidraw", OTHER_SCENE);
    github.write("docs/forward/added.excalidraw", THIRD_SCENE);
    const res = await pull("forward");
    expect(await res.json()).toEqual({
      ok: true,
      updated: ["added", "checkout"],
      removed: [],
      kept: [],
      conflicts: [],
    });
    expect(await readFile(localFile("forward", "checkout"), "utf8")).toBe(OTHER_SCENE);
    expect(await readFile(localFile("forward", "added"), "utf8")).toBe(THIRD_SCENE);
    // Both are now clean against the branch, so a second pull says nothing.
    expect(await (await pull("forward")).json()).toEqual({
      ok: true,
      updated: [],
      removed: [],
      kept: [],
      conflicts: [],
    });
  });

  it("removes a scene the remote deleted", async () => {
    await boundProject("dropped");
    github.write("docs/dropped/leaving.excalidraw", SCENE);
    github.write("docs/dropped/staying.excalidraw", SCENE);
    expect((await pull("dropped")).status).toBe(200);

    github.remove("docs/dropped/leaving.excalidraw");
    const res = await pull("dropped");
    expect(await res.json()).toEqual({
      ok: true,
      updated: [],
      removed: ["leaving"],
      kept: [],
      conflicts: [],
    });
    expect((await getScene("dropped", "leaving")).status).toBe(404);
    expect((await getScene("dropped", "staying")).status).toBe(200);
    // …and it is out of the sync state entirely, not remembered as deleted.
    expect((await readSyncFile("dropped")).scenes.leaving).toBeUndefined();
  });

  it("keeps a scene changed here that the branch did not touch", async () => {
    await boundProject("mine");
    github.write("docs/mine/checkout.excalidraw", SCENE);
    github.write("docs/mine/other.excalidraw", SCENE);
    expect((await pull("mine")).status).toBe(200);
    expect((await putScene("mine", "checkout", OTHER_SCENE)).status).toBe(200);
    expect((await putScene("mine", "brand new", THIRD_SCENE)).status).toBe(200);

    github.write("docs/mine/other.excalidraw", THIRD_SCENE);
    const res = await pull("mine");
    expect(await res.json()).toEqual({
      ok: true,
      updated: ["other"],
      removed: [],
      kept: ["brand new", "checkout"],
      conflicts: [],
    });
    expect(await readFile(localFile("mine", "checkout"), "utf8")).toBe(OTHER_SCENE);
  });

  it("flags a scene both sides changed, and touches nothing", async () => {
    await boundProject("clash");
    github.write("docs/clash/checkout.excalidraw", SCENE);
    expect((await pull("clash")).status).toBe(200);
    expect((await putScene("clash", "checkout", OTHER_SCENE)).status).toBe(200);
    github.write("docs/clash/checkout.excalidraw", THIRD_SCENE);

    const res = await pull("clash");
    expect(await res.json()).toEqual({
      ok: true,
      updated: [],
      removed: [],
      kept: [],
      conflicts: ["checkout"],
    });
    // The author's file is exactly as they left it.
    expect(await readFile(localFile("clash", "checkout"), "utf8")).toBe(OTHER_SCENE);
    // The base still points at what was last synced; the question is recorded
    // beside it.
    const stored = (await readSyncFile("clash")).scenes.checkout;
    expect(stored.baseSha).toBe(blobSha(SCENE));
    expect(stored.baseHash).toBe(contentHash(SCENE));
    expect(stored.conflictSha).toBe(blobSha(THIRD_SCENE));
    expect(stateOf(await statusOf("clash"), "checkout")).toBe("conflicted");
  });

  it("flags a scene the remote deleted while it was being edited here", async () => {
    await boundProject("vanished");
    github.write("docs/vanished/checkout.excalidraw", SCENE);
    github.write("docs/vanished/other.excalidraw", SCENE);
    expect((await pull("vanished")).status).toBe(200);
    expect((await putScene("vanished", "checkout", OTHER_SCENE)).status).toBe(200);
    github.remove("docs/vanished/checkout.excalidraw");

    const res = await pull("vanished");
    expect(await res.json()).toEqual({
      ok: true,
      updated: [],
      removed: [],
      kept: [],
      conflicts: ["checkout"],
    });
    expect(await readFile(localFile("vanished", "checkout"), "utf8")).toBe(OTHER_SCENE);
    // An empty conflict sha is how "the remote deleted it" is written down.
    expect((await readSyncFile("vanished")).scenes.checkout.conflictSha).toBe("");
  });

  it("agrees when both sides deleted the same scene", async () => {
    await boundProject("agreed");
    github.write("docs/agreed/leaving.excalidraw", SCENE);
    github.write("docs/agreed/staying.excalidraw", SCENE);
    expect((await pull("agreed")).status).toBe(200);
    expect((await deleteScene("agreed", "leaving")).status).toBe(200);
    github.remove("docs/agreed/leaving.excalidraw");

    expect(await (await pull("agreed")).json()).toEqual({
      ok: true,
      updated: [],
      removed: ["leaving"],
      kept: [],
      conflicts: [],
    });
    expect((await readSyncFile("agreed")).scenes.leaving).toBeUndefined();
  });

  it("404s on an unbound project and 401s without a token", async () => {
    const unbound = await pull("plain");
    expect(unbound.status).toBe(404);
    expect(await unbound.json()).toEqual({
      error: "no GitHub binding for project: plain",
    });

    await fetch(`${BASE}/api/projects/tokenless`, { method: "PUT" });
    await fetch(`${BASE}/api/projects/tokenless/binding`, {
      method: "PUT",
      body: JSON.stringify({ owner: "acme", repo: "diagrams", apiBase: github.base }),
    });
    const missing = await pull("tokenless");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: TOKEN_MESSAGE });
    // …and its scenes still open, because those never needed a credential.
    expect((await listScenes("tokenless")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// resolving conflicts
// ---------------------------------------------------------------------------

describe("resolving a conflict", () => {
  /** A project sitting on one conflicted scene, on a branch it may push to. */
  async function conflicted(project: string, branch: string) {
    await boundProject(project);
    github.write(`docs/${project}/checkout.excalidraw`, SCENE);
    expect((await pull(project)).status).toBe(200);
    await draftOn(project, branch);
    expect((await putScene(project, "checkout", OTHER_SCENE)).status).toBe(200);
    github.write(`docs/${project}/checkout.excalidraw`, THIRD_SCENE);
    const res = await pull(project);
    expect(((await res.json()) as { conflicts: string[] }).conflicts).toEqual(["checkout"]);
  }

  it("keeps the local copy, and the next push overwrites the remote deliberately", async () => {
    await conflicted("keepmine", "docent/keepmine");
    const res = await resolve("keepmine", { scene: "checkout", resolution: "keep-local" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      scene: "checkout",
      resolution: "keep-local",
    });
    // The file is untouched and the scene reads as a plain local change again:
    // the remote sha has been seen and rejected.
    expect(await readFile(localFile("keepmine", "checkout"), "utf8")).toBe(OTHER_SCENE);
    const stored = (await readSyncFile("keepmine")).scenes.checkout;
    expect(stored.baseSha).toBe(blobSha(THIRD_SCENE));
    expect(stored.conflictSha).toBeUndefined();
    expect(stateOf(await statusOf("keepmine"), "checkout")).toBe("modified");

    const pushed = await push("keepmine");
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(github.files.get("docs/keepmine/checkout.excalidraw")).toBe(OTHER_SCENE);
    expect(stateOf(await statusOf("keepmine"), "checkout")).toBe("clean");
  });

  it("takes the remote copy, overwriting the working copy", async () => {
    await conflicted("takeirs", "docent/takeirs");
    const res = await resolve("takeirs", { scene: "checkout", resolution: "take-remote" });
    expect(res.status).toBe(200);
    expect(await readFile(localFile("takeirs", "checkout"), "utf8")).toBe(THIRD_SCENE);
    const stored = (await readSyncFile("takeirs")).scenes.checkout;
    expect(stored).toEqual({
      baseSha: blobSha(THIRD_SCENE),
      baseHash: contentHash(THIRD_SCENE),
    });
    expect(stateOf(await statusOf("takeirs"), "checkout")).toBe("clean");
  });

  it("takes a remote deletion by removing the scene", async () => {
    await boundProject("accepted");
    github.write("docs/accepted/checkout.excalidraw", SCENE);
    github.write("docs/accepted/other.excalidraw", SCENE);
    expect((await pull("accepted")).status).toBe(200);
    expect((await putScene("accepted", "checkout", OTHER_SCENE)).status).toBe(200);
    github.remove("docs/accepted/checkout.excalidraw");
    expect((await pull("accepted")).status).toBe(200);

    const res = await resolve("accepted", { scene: "checkout", resolution: "take-remote" });
    expect(res.status).toBe(200);
    expect((await getScene("accepted", "checkout")).status).toBe(404);
    expect((await readSyncFile("accepted")).scenes.checkout).toBeUndefined();
  });

  it("refuses a resolution it does not know and a scene that is not conflicted", async () => {
    await conflicted("picky", "docent/picky");
    const unknown = await resolve("picky", { scene: "checkout", resolution: "merge" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: 'invalid resolution — use "keep-local" or "take-remote"',
    });

    const calm = await resolve("picky", { scene: "other", resolution: "keep-local" });
    expect(calm.status).toBe(400);
    expect(await calm.json()).toEqual({
      error: "scene is not conflicted: picky/other",
    });

    const nameless = await resolve("picky", { resolution: "keep-local" });
    expect(nameless.status).toBe(400);
    expect(((await nameless.json()) as { error: string }).error).toContain(
      "body is not a resolution",
    );
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe("push", () => {
  it("lands every local change as one commit", async () => {
    await boundProject("landing");
    github.write("docs/landing/edited.excalidraw", SCENE);
    github.write("docs/landing/removed.excalidraw", SCENE);
    expect((await pull("landing")).status).toBe(200);
    await draftOn("landing", "docent/landing");

    expect((await putScene("landing", "edited", OTHER_SCENE)).status).toBe(200);
    expect((await putScene("landing", "added", THIRD_SCENE)).status).toBe(200);
    expect((await deleteScene("landing", "removed")).status).toBe(200);

    const commitsBefore = github.requestsTo("/git/commits").filter((r) => r.method === "POST");
    const res = await push("landing");
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = (await res.json()) as {
      ok: boolean;
      commit: string;
      pushed: string[];
      removedRemotely: string[];
    };
    expect(answer.ok).toBe(true);
    expect(answer.pushed).toEqual(["added", "edited"]);
    expect(answer.removedRemotely).toEqual(["removed"]);
    expect(answer.commit).toMatch(/^commit-/);

    // Exactly one commit, on top of the branch's head, with one tree carrying
    // every change — the deletion as a null sha, which is how the Git Data API
    // spells "drop this path".
    const commits = github.requestsTo("/git/commits").filter((r) => r.method === "POST");
    expect(commits.length - commitsBefore.length).toBe(1);
    const commit = JSON.parse(commits.at(-1)?.body ?? "{}") as {
      message: string;
      tree: string;
      parents: string[];
    };
    expect(commit.message).toBe("docent: update landing (3 scene(s))");
    expect(commit.parents).toEqual(["sha-main"]);

    const tree = github.bodyOf("/git/trees", "POST") as {
      base_tree: string;
      tree: { path: string; mode: string; type: string; sha: string | null }[];
    };
    expect(tree.base_tree).toBe("tree-of-sha-main");
    expect(tree.tree).toEqual([
      {
        path: "docs/landing/added.excalidraw",
        mode: "100644",
        type: "blob",
        sha: blobSha(THIRD_SCENE),
      },
      {
        path: "docs/landing/edited.excalidraw",
        mode: "100644",
        type: "blob",
        sha: blobSha(OTHER_SCENE),
      },
      {
        path: "docs/landing/removed.excalidraw",
        mode: "100644",
        type: "blob",
        sha: null,
      },
    ]);

    // The branch now holds what the working copy holds…
    expect(github.files.get("docs/landing/edited.excalidraw")).toBe(OTHER_SCENE);
    expect(github.files.get("docs/landing/added.excalidraw")).toBe(THIRD_SCENE);
    expect(github.files.has("docs/landing/removed.excalidraw")).toBe(false);
    expect(github.branches.get("docent/landing")).toBe(answer.commit);
    // …and every base moved with it, so nothing is left looking dirty.
    const status = await statusOf("landing");
    expect(status.local).toEqual([
      { name: "added", state: "clean" },
      { name: "edited", state: "clean" },
    ]);
    expect(status.remote).toEqual({ reachable: true, changed: [], removed: [] });
  });

  it("refuses the base branch outright (D30)", async () => {
    await boundProject("trunk");
    expect((await putScene("trunk", "sketch", SCENE)).status).toBe(200);

    const res = await push("trunk");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BASE_BRANCH_MESSAGE });
    // Nothing was created on the way to the refusal.
    expect(github.files.has("docs/trunk/sketch.excalidraw")).toBe(false);
    // The save itself was never blocked — local-first means the work is safe
    // whether or not it may be published.
    expect(await readFile(localFile("trunk", "sketch"), "utf8")).toBe(SCENE);

    // …and a branch of its own is all it takes.
    await draftOn("trunk", "docent/trunk");
    const pushed = await push("trunk");
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(github.files.get("docs/trunk/sketch.excalidraw")).toBe(SCENE);
  });

  it("refuses while a conflict is unresolved", async () => {
    await boundProject("unresolved");
    github.write("docs/unresolved/checkout.excalidraw", SCENE);
    expect((await pull("unresolved")).status).toBe(200);
    await draftOn("unresolved", "docent/unresolved");
    expect((await putScene("unresolved", "checkout", OTHER_SCENE)).status).toBe(200);
    github.write("docs/unresolved/checkout.excalidraw", THIRD_SCENE);
    expect((await pull("unresolved")).status).toBe(200);

    const res = await push("unresolved");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "resolve the conflicted scenes first: checkout",
    });
  });

  it("refuses when there is nothing to push", async () => {
    await boundProject("quiet");
    github.write("docs/quiet/checkout.excalidraw", SCENE);
    expect((await pull("quiet")).status).toBe(200);
    await draftOn("quiet", "docent/quiet");

    const res = await push("quiet");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "nothing to push" });
  });

  it("refuses when the branch moved under it", async () => {
    await boundProject("raced");
    expect((await putScene("raced", "sketch", SCENE)).status).toBe(200);
    await draftOn("raced", "docent/raced");

    github.moveHeadOnRefRead = true;
    try {
      const res = await push("raced");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: MOVED_MESSAGE });
    } finally {
      github.moveHeadOnRefRead = false;
    }
    // Nothing landed, and the scene is still waiting to be pushed.
    expect(github.files.has("docs/raced/sketch.excalidraw")).toBe(false);
    expect(stateOf(await statusOf("raced"), "sketch")).toBe("new");
  });

  it("refuses when a pushed scene changed remotely since the last pull", async () => {
    await boundProject("stale");
    github.write("docs/stale/plan.excalidraw", SCENE);
    expect((await pull("stale")).status).toBe(200);
    await draftOn("stale", "docent/stale");
    // Someone else lands on the branch after the pull; the local author edits
    // the same scene without knowing.
    github.write("docs/stale/plan.excalidraw", OTHER_SCENE);
    expect((await putScene("stale", "plan", SCENE.replace("[]", '[{"id":"z"}]'))).status).toBe(200);

    const res = await push("stale");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: MOVED_MESSAGE });
    // Their change is still there, ours is still local, and a pull is what
    // reconciles them — never a silent overwrite.
    expect(github.files.get("docs/stale/plan.excalidraw")).toBe(OTHER_SCENE);
    expect(stateOf(await statusOf("stale"), "plan")).toBe("modified");
  });

  it("pushes scenes the remote never touched even while another scene changed there", async () => {
    await boundProject("aside");
    github.write("docs/aside/plan.excalidraw", SCENE);
    github.write("docs/aside/notes.excalidraw", SCENE);
    expect((await pull("aside")).status).toBe(200);
    await draftOn("aside", "docent/aside");
    github.write("docs/aside/plan.excalidraw", OTHER_SCENE);
    const local = SCENE.replace("[]", '[{"id":"n"}]');
    expect((await putScene("aside", "notes", local)).status).toBe(200);

    const res = await push("aside");
    expect(res.status).toBe(200);
    // The pushed scene landed; the scene someone else changed rode through
    // the base tree untouched.
    expect(github.files.get("docs/aside/notes.excalidraw")).toBe(local);
    expect(github.files.get("docs/aside/plan.excalidraw")).toBe(OTHER_SCENE);

    // With the race over, the same push succeeds.
    const again = await push("raced");
    expect(again.status, await again.clone().text()).toBe(200);
    expect(github.files.get("docs/raced/sketch.excalidraw")).toBe(SCENE);
  });

  it("refuses with the permission that is missing, not a credential message", async () => {
    await boundProject("locked");
    expect((await putScene("locked", "sketch", SCENE)).status).toBe(200);
    await draftOn("locked", "docent/locked");

    github.readOnly = true;
    try {
      const res = await push("locked");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: WRITE_MESSAGE });
    } finally {
      github.readOnly = false;
    }
    expect(github.files.has("docs/locked/sketch.excalidraw")).toBe(false);
  });

  it("404s on an unbound project", async () => {
    const res = await push("plain");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "no GitHub binding for project: plain",
    });
  });
});

// ---------------------------------------------------------------------------
// the sync state file (D17's `.docent/` exception, D29)
// ---------------------------------------------------------------------------

describe("the sync state file", () => {
  it("is sorted, two-space JSON with a trailing newline, and carries no secret", async () => {
    await boundProject("bytes");
    github.write("docs/bytes/beta.excalidraw", SCENE);
    github.write("docs/bytes/alpha.excalidraw", OTHER_SCENE);
    expect((await pull("bytes")).status).toBe(200);

    const raw = await readFile(syncFile("bytes"), "utf8");
    expect(raw).toBe(
      JSON.stringify(
        {
          scenes: {
            alpha: { baseSha: blobSha(OTHER_SCENE), baseHash: contentHash(OTHER_SCENE) },
            beta: { baseSha: blobSha(SCENE), baseHash: contentHash(SCENE) },
          },
        },
        null,
        2,
      ) + "\n",
    );
    expect(raw).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// a token that reads but does not write — the case that used to read as
// "token missing or rejected" while the scenes were plainly listing
// ---------------------------------------------------------------------------

describe("read-only tokens", () => {
  const bindingsFile = async () =>
    JSON.parse(
      await readFile(path.join(dataDir, ".docent", "bindings.json"), "utf8"),
    ) as Record<string, { canWrite?: boolean }>;

  it("are named at bind time, and remembered", async () => {
    await fetch(`${BASE}/api/projects/readonly`, { method: "PUT" });
    github.readOnly = true;
    try {
      const put = await bind("readonly", { path: "docs/readonly" });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ ok: true, canWrite: false, baseBranch: "main" });
    } finally {
      github.readOnly = false;
    }

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
    expect(projects.find((project) => project.id === "readonly")).toMatchObject({
      bound: true,
      canWrite: false,
    });
    // An unbound project gains no such field.
    expect(projects.find((project) => project.id === "plain")?.canWrite).toBeUndefined();

    // …and a token that can write clears the mark again, which is the loop the
    // message asks the user to close.
    const again = await bind("readonly", { path: "docs/readonly" });
    expect(await again.json()).toEqual({ ok: true, canWrite: true, baseBranch: "main" });
    expect((await bindingsFile()).readonly.canWrite).toBe(true);
  });

  it("never block a save, because a save is a local file (D29)", async () => {
    github.readOnly = true;
    try {
      const saved = await putScene("readonly", "drawn anyway", SCENE);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true });
    } finally {
      github.readOnly = false;
    }
    expect(await readFile(localFile("readonly", "drawn anyway"), "utf8")).toBe(SCENE);
  });

  it("still list and open scenes — reads are untouched", async () => {
    github.write("docs/readonly/theirs.excalidraw", OTHER_SCENE);
    github.readOnly = true;
    try {
      expect((await pull("readonly")).status).toBe(200);
      const listed = await listScenes("readonly");
      expect(listed.status).toBe(200);
      expect(
        ((await listed.json()) as { name: string }[]).map((scene) => scene.name),
      ).toEqual(["drawn anyway", "theirs"]);
      expect(await (await getScene("readonly", "theirs")).text()).toBe(OTHER_SCENE);
    } finally {
      github.readOnly = false;
    }
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
    const put = await putScene("plain", "local", SCENE);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    expect(await readFile(localFile("plain", "local"), "utf8")).toBe(SCENE);

    const listed = await listScenes("plain");
    const scenes = (await listed.json()) as Record<string, unknown>[];
    expect(scenes).toHaveLength(1);
    expect(Object.keys(scenes[0])).toEqual(["name", "updatedAt", "size"]);

    const loaded = await getScene("plain", "local");
    expect(await loaded.text()).toBe(SCENE);
    expect(loaded.headers.get("x-docent-scene-sha")).toBeNull();

    expect((await deleteScene("plain", "local")).status).toBe(200);
    expect((await putScene("nope", "x", SCENE)).status).toBe(404);
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

  it("creates a branch, switches to it, and keeps the base, the token and the copy", async () => {
    await boundProject("drafts");
    github.write("docs/drafts/checkout.excalidraw", SCENE);
    expect((await pull("drafts")).status).toBe(200);

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
      path: "docs/drafts",
      branch: "docent/diagrams-2026-08-20",
      baseBranch: "main",
      apiBase: github.base,
      canWrite: true,
    });
    const secrets = JSON.parse(await readFile(secretsFile, "utf8")) as Record<string, string>;
    expect(secrets.drafts, "the token is untouched by a branch switch").toBe(TOKEN);

    // A branch cut here starts at the same head, so nothing was pulled and
    // every recorded base is still true: the copy reads clean on the new
    // branch, and the next push lands there.
    expect(stateOf(await statusOf("drafts"), "checkout")).toBe("clean");
    expect((await putScene("drafts", "checkout", OTHER_SCENE)).status).toBe(200);
    const pushed = await push("drafts");
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(github.branches.get("docent/diagrams-2026-08-20")).toBe(
      ((await pushed.json()) as { commit: string }).commit,
    );

    // The listing now says which branch is which.
    expect(await (await branches("drafts")).json()).toEqual([
      { name: "docent/diagrams-2026-08-20", isBase: false, isActive: true },
      { name: "main", isBase: true, isActive: false },
    ]);
  });

  it("switches to another branch by binding PUT, and pulls its content in", async () => {
    await boundProject("switcher");
    github.write("docs/switcher/onmain.excalidraw", SCENE);
    expect((await pull("switcher")).status).toBe(200);

    // Another branch, holding a different set of scenes.
    github.branches.set("docent/existing", "sha-existing");
    github.remove("docs/switcher/onmain.excalidraw");
    github.write("docs/switcher/onbranch.excalidraw", OTHER_SCENE);

    const switched = await fetch(`${BASE}/api/projects/switcher/binding`, {
      method: "PUT",
      // Exactly what the client sends: the binding it already has, on another
      // branch. No base, no token.
      body: JSON.stringify({
        owner: "acme",
        repo: "diagrams",
        path: "docs/switcher",
        branch: "docent/existing",
        apiBase: github.base,
      }),
    });
    expect(switched.status, await switched.clone().text()).toBe(200);
    expect(await switched.json()).toEqual({
      ok: true,
      canWrite: true,
      baseBranch: "main",
      // One scene arrived and one went: the working copy is now that branch's.
      pulled: 2,
    });
    const binding = await bindingOf("switcher");
    expect(binding.branch).toBe("docent/existing");
    expect(binding.baseBranch).toBe("main");
    expect(binding.hasToken).toBe(true);

    const listed = (await (await listScenes("switcher")).json()) as { name: string }[];
    expect(listed.map((scene) => scene.name)).toEqual(["onbranch"]);
  });

  it("refuses to switch branches while the working copy is not clean", async () => {
    await boundProject("dirty");
    github.write("docs/dirty/checkout.excalidraw", SCENE);
    expect((await pull("dirty")).status).toBe(200);
    expect((await putScene("dirty", "checkout", OTHER_SCENE)).status).toBe(200);
    expect((await putScene("dirty", "another", THIRD_SCENE)).status).toBe(200);
    github.branches.set("docent/elsewhere", "sha-elsewhere");

    const res = await fetch(`${BASE}/api/projects/dirty/binding`, {
      method: "PUT",
      body: JSON.stringify({
        owner: "acme",
        repo: "diagrams",
        path: "docs/dirty",
        branch: "docent/elsewhere",
        apiBase: github.base,
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "push or resolve local changes before switching branches: another, checkout",
    });
    // The project did not half-move.
    expect((await bindingOf("dirty")).branch).toBe("main");
    expect(await readFile(localFile("dirty", "checkout"), "utf8")).toBe(OTHER_SCENE);
  });

  it("refuses a branch that already exists", async () => {
    await boundProject("dupes");
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
    await boundProject("review");
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
    await boundProject("nodiff");
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
      const put = await bind("trunky", { branch: "docent/wip", path: "docs/trunky" });
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

  it("binds onto the repository's default branch when no branch is stated", async () => {
    github.defaultBranch = "trunk";
    try {
      await fetch(`${BASE}/api/projects/trunkless`, { method: "PUT" });
      const put = await bind("trunkless", {
        path: "docs/trunkless",
        branch: undefined,
      });
      expect(put.status).toBe(200);
      const binding = await bindingOf("trunkless");
      // The active branch is the repository's own default — never a guessed
      // name the repository may simply not have.
      expect(binding.branch).toBe("trunk");
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
    await boundProject("older");
    // Rewrite the dotfile the way the store wrote it before D28 existed: no
    // baseBranch at all. Nothing migrates it, and nothing has to.
    const stored = JSON.parse(await readFile(bindingsFile(), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    delete stored.older.baseBranch;
    await writeFile(bindingsFile(), JSON.stringify(stored, null, 2) + "\n", "utf8");

    const binding = await bindingOf("older");
    expect(binding.branch).toBe("main");
    expect(binding.baseBranch, "the branch it points at is its own base").toBe("main");
    const listed = (await (await branches("older")).json()) as { isBase: boolean }[];
    expect(listed.find((entry) => entry.isBase)).toBeDefined();
    // So nothing is a draft, no pull request is on offer, and the trunk gate
    // stands (D30).
    const pr = await pullRequest("older");
    expect(pr.status).toBe(400);
    expect(await pr.json()).toEqual({
      error: "the active branch main is the base branch — create a branch first",
    });
    expect((await putScene("older", "sketch", SCENE)).status).toBe(200);
    expect(((await (await push("older")).json()) as { error: string }).error).toBe(
      BASE_BRANCH_MESSAGE,
    );

    // …and the next binding PUT records a base without being asked to.
    await bind("older", { path: "docs/older" });
    expect((await bindingOf("older")).baseBranch).toBe("main");
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

describe("visual review plumbing (D47, D49)", () => {
  const bindingOf = async (project: string) =>
    (await (await fetch(`${BASE}/api/projects/${project}/binding`)).json()) as {
      review: { images: boolean; sidecars: boolean };
    };

  it("keeps a base copy of every synced scene, beside the sync state and never in the project", async () => {
    await boundProject("review");
    github.write("docs/review/plan.excalidraw", SCENE);
    expect((await pull("review")).status).toBe(200);
    // After a pull the base is the remote content…
    expect(await (await baseOf("review", "plan")).text()).toBe(SCENE);
    // …a local edit leaves it alone…
    const edited = SCENE.replace("[]", '[{"id":"z"}]');
    expect((await putScene("review", "plan", edited)).status).toBe(200);
    expect(await (await baseOf("review", "plan")).text()).toBe(SCENE);
    // …a push moves it to what landed…
    await draftOn("review", "docent/review");
    expect((await push("review")).status).toBe(200);
    expect(await (await baseOf("review", "plan")).text()).toBe(edited);
    // …a delete-and-push removes it, and a scene never synced has none.
    expect((await deleteScene("review", "plan")).status).toBe(200);
    expect((await push("review")).status).toBe(200);
    expect((await baseOf("review", "plan")).status).toBe(404);
    expect((await putScene("review", "fresh", SCENE)).status).toBe(200);
    expect((await baseOf("review", "fresh")).status).toBe(404);
    // The project directory holds scenes only; the copies live under .docent.
    const projectFiles = (await walk(path.join(dataDir, "review"))).map((f) => path.basename(f));
    expect(projectFiles.every((f) => f.endsWith(".excalidraw"))).toBe(true);
    expect(projectFiles).not.toContain("plan.excalidraw");
  });

  it("a push carries its changelog into the commit and attachments into the tree", async () => {
    await boundProject("changelog");
    expect((await putScene("changelog", "flow", SCENE)).status).toBe(200);
    await draftOn("changelog", "docent/changelog");
    const res = await pushWith("changelog", {
      message: "Core Services: +Retry queue",
      attachments: [{ path: "flow.docent.json", content: '{"nodes":[]}' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const commits = github.requestsTo("/git/commits").filter((r) => r.method === "POST");
    const last = JSON.parse(commits[commits.length - 1].body) as { message: string };
    expect(last.message).toContain("docent: update changelog");
    expect(last.message).toContain("Core Services: +Retry queue");
    expect(github.files.get("docs/changelog/flow.docent.json")).toBe('{"nodes":[]}');
    // A null attachment removes the file from the same commit.
    expect((await putScene("changelog", "flow", SCENE.replace("[]", '[{"id":"q"}]'))).status).toBe(200);
    expect((await pushWith("changelog", { attachments: [{ path: "flow.docent.json", content: null }] })).status).toBe(200);
    expect(github.files.has("docs/changelog/flow.docent.json")).toBe(false);
    // Traversal and scene impersonation are refused outright.
    expect((await pushWith("changelog", { attachments: [{ path: "../x.json", content: "" }] })).status).toBe(400);
    expect((await pushWith("changelog", { attachments: [{ path: "flow.excalidraw", content: "" }] })).status).toBe(400);
  });

  it("review images land on the quarantined branch, never the working one", async () => {
    await boundProject("pictures");
    expect((await putScene("pictures", "scene", SCENE)).status).toBe(200);
    await draftOn("pictures", "docent/pictures");
    expect((await push("pictures")).status).toBe(200);
    const workingHead = github.branches.get("docent/pictures");
    const first = await fetch(`${BASE}/api/projects/pictures/review-images`, {
      method: "POST",
      body: JSON.stringify({
        label: "2026-08-22-abc1234",
        images: [{ path: "scene/Core-before.png", base64: Buffer.from("png-1").toString("base64") }],
      }),
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(github.branches.has("docent-review")).toBe(true);
    // The working branch did not move; the picture is in the review tree.
    expect(github.branches.get("docent/pictures")).toBe(workingHead);
    const trees = github.requestsTo("/git/trees").filter((r) => r.method === "POST");
    const tree = JSON.parse(trees[trees.length - 1].body) as { tree: { path: string }[] };
    expect(tree.tree.map((t) => t.path)).toEqual(["2026-08-22-abc1234/scene/Core-before.png"]);
    // A second push descends from the first and prunes labels older than 90 days.
    const second = await fetch(`${BASE}/api/projects/pictures/review-images`, {
      method: "POST",
      body: JSON.stringify({
        label: "2026-08-23-def5678",
        images: [{ path: "scene/Core-after.png", base64: Buffer.from("png-2").toString("base64") }],
      }),
    });
    expect(second.status, await second.clone().text()).toBe(200);
    const answer = (await second.json()) as { pruned: number };
    expect(answer.pruned).toBe(0);
    // Malformed labels and paths are refused.
    const bad = await fetch(`${BASE}/api/projects/pictures/review-images`, {
      method: "POST",
      body: JSON.stringify({ label: "nope", images: [{ path: "x.png", base64: "" }] }),
    });
    expect(bad.status).toBe(400);
  });

  it("review artifacts are opt-in per binding and remembered", async () => {
    await boundProject("optin");
    expect((await bindingOf("optin")).review).toEqual({ images: false, sidecars: false });
    const on = await bind("optin", { path: "docs/optin", review: { images: true, sidecars: false } });
    expect(on.status).toBe(200);
    expect((await bindingOf("optin")).review).toEqual({ images: true, sidecars: false });
    // A later PUT that does not mention review keeps it.
    const again = await bind("optin", { path: "docs/optin" });
    expect(again.status).toBe(200);
    expect((await bindingOf("optin")).review).toEqual({ images: true, sidecars: false });
  });
});
