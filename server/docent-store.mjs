#!/usr/bin/env node
/**
 * Docent portfolio store (S12, D17, D18) — projects of scenes for one
 * deployment. A project is a directory, a scene is a plain `.excalidraw`
 * file: `<DOCENT_DATA>/<project>/<scene>.excalidraw`. No database, no
 * format of its own (D17) — anything this service can do, a file manager
 * can too. Zero runtime dependencies (I7): Node's built-in http/fs/fetch.
 *
 * Served same-origin behind nginx at /api/ (D18); the dev server proxies
 * the same path, so the client never needs CORS.
 *
 * A project may instead be **bound to a GitHub repository** (S14, D27): its
 * scenes then live in that repo and every route below reads and writes them
 * over GitHub's HTTP API — no `git` binary anywhere. The local directory of a
 * bound project stays on disk untouched and is ignored while the binding
 * lasts. Binding metadata lives in one dotfile at the data root; the token
 * never does (see BINDINGS_FILE / SECRETS_FILE below).
 *
 * Run:  node server/docent-store.mjs      (port 3400, data dir ./data)
 * Env:  DOCENT_STORE_PORT, DOCENT_DATA, DOCENT_SECRETS
 *
 * A bound project also gets the repository's own review flow (D28): the
 * binding records a `baseBranch`, the active `branch` is where every scene
 * operation lands, and the two branch routes below are how a user drafts on a
 * branch and opens a pull request back onto the base.
 *
 * API (JSON in/out; errors are { error } with a 4xx/5xx status):
 *   GET    /api/health                          → { ok: true }
 *   GET    /api/projects                        → [{ id, scenes, updatedAt, bound?, canWrite? }]
 *   PUT    /api/projects/:project               → { id }            (create)
 *   DELETE /api/projects/:project               → { ok }            (recursive)
 *   GET    /api/projects/:project/binding       → { owner, repo, path, branch, baseBranch, apiBase, hasToken, canWrite }
 *   PUT    /api/projects/:project/binding       → { ok, canWrite, baseBranch, warning? }  (token write-only)
 *   DELETE /api/projects/:project/binding       → { ok }            (local dir stays)
 *   GET    /api/projects/:project/branches      → [{ name, isBase, isActive }]
 *   POST   /api/projects/:project/branches      → { ok, branch }    (creates it and switches to it)
 *   POST   /api/projects/:project/pull-request  → { ok, url, number }
 *   GET    /api/projects/:project/scenes        → [{ name, updatedAt, size, sha? }]
 *   GET    /api/projects/:project/scenes/:name  → scene JSON        (+ X-Docent-Scene-Sha when bound)
 *   PUT    /api/projects/:project/scenes/:name  → { ok, sha? }      (atomic; X-Docent-Scene-Sha guards bound writes)
 *   DELETE /api/projects/:project/scenes/:name  → { ok }
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.DOCENT_STORE_PORT ?? "3400");
const DATA_DIR = path.resolve(process.env.DOCENT_DATA ?? "data");
const MAX_SCENE_BYTES = 50 * 1024 * 1024;
const EXT = ".excalidraw";

// D27's one declared exception to D17: a single dotfile at the data root
// holding project-id → binding metadata. It carries no secrets, so copying a
// portfolio can never leak a credential.
const BINDINGS_FILE = path.join(DATA_DIR, ".docent", "bindings.json");

// Tokens live outside the data tree, in deployment config. The default sits in
// the process working directory rather than under DOCENT_DATA precisely so a
// container that mounts only the data volume keeps them out of it — point
// DOCENT_SECRETS at a path outside that volume (see the README).
const SECRETS_FILE = path.resolve(process.env.DOCENT_SECRETS ?? ".docent-secrets.json");

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

// ---------------------------------------------------------------------------
// GitHub bindings (S14, D27) — metadata on disk, tokens somewhere else
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_BRANCH = "main";
/** GitHub's own account/repository shape, spelled out rather than guessed. */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;
/**
 * A branch this store is asked to *create* (D28), which is stricter than one
 * it merely addresses: it must start with a letter or a digit and stay short
 * enough to read in a select. Whatever GitHub already has keeps BRANCH_RE.
 */
const NEW_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const API_BASE_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;

/** Every GitHub answer that means "your credential is the problem". */
const TOKEN_ERROR =
  "GitHub token missing or rejected for this project — set it in the binding";
/** The one message a losing write gets, on both stores, word for word. */
const CONFLICT_ERROR =
  "scene changed on GitHub since it was loaded — reload it to get the latest";

/**
 * The other half of a 403: GitHub authenticated the token and refused the
 * write anyway. A fine-grained PAT defaults to Contents: Read, and an
 * organization can block writes by policy — either way the scenes list and
 * open, and only saving fails, so the credential message ("missing or
 * rejected") reads as nonsense. This one names what to change instead. It
 * answers writes only; a read that is refused keeps TOKEN_ERROR.
 */
const writeRejected = (binding) =>
  `GitHub rejected the write — the token needs Contents: Read and write on ${binding.owner}/${binding.repo} (organization repos may also require fine-grained token approval)`;

/** What the bind-time probe says when it could not find out (see probeAccess). */
const unverifiedAccess = (binding) =>
  `could not verify access to ${binding.owner}/${binding.repo} — check the repo name and token`;

const USER_AGENT = "docent-store";
const GITHUB_TIMEOUT_MS = 30_000;

/**
 * Per-process caches, deliberately not persisted. `listings` is the
 * If-None-Match cache for the one listing call (loads always fetch fresh);
 * `counts` is what lets `GET /api/projects` name a bound project's scene count
 * without blocking the whole listing on the network — before anything has been
 * listed a bound project simply reports zero.
 */
const listingCache = new Map();
const boundCounts = new Map();

const readJsonFile = async (file, fallback) => {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    // Missing, unreadable, or malformed all mean the same thing here: nothing
    // is bound yet. Being strict would lock a user out of their own portfolio.
    return fallback;
  }
};

/** Sorted keys and a trailing newline: the file stays diffable (I3 habits). */
const stableJson = (value) => {
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted, null, 2) + "\n";
};

async function writeJsonFile(file, value, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, stableJson(value), { encoding: "utf8", mode });
  // `mode` only applies when the file is created, so an existing tmp from a
  // crashed run cannot leave a token world-readable.
  if (mode !== undefined) await fs.chmod(tmp, mode);
  await fs.rename(tmp, file);
}

const readBindings = () => readJsonFile(BINDINGS_FILE, {});
const readSecrets = () => readJsonFile(SECRETS_FILE, {});

async function bindingFor(project) {
  const bindings = await readBindings();
  const binding = bindings[project];
  return binding && typeof binding === "object" ? binding : null;
}

async function tokenFor(project) {
  const token = (await readSecrets())[project];
  return typeof token === "string" && token !== "" ? token : null;
}

/**
 * The branch a draft is measured against. A binding written before D28 has no
 * `baseBranch` at all, and it behaves exactly as it always did: the branch it
 * points at *is* its base, so nothing is a draft and no pull request is
 * offered. No migration step, no rewrite of anyone's dotfile.
 */
const baseBranchOf = (binding) =>
  typeof binding.baseBranch === "string" && binding.baseBranch !== ""
    ? binding.baseBranch
    : binding.branch;

/**
 * A binding as the API states it — never with the token, in either direction.
 * `canWrite` is what the last bind-time probe learned, and null whenever
 * nothing has been learned: an older binding, one stored without a token, or a
 * probe that could not reach GitHub. It is metadata, not a secret.
 */
const publicBinding = (binding, hasToken) => ({
  owner: binding.owner,
  repo: binding.repo,
  path: binding.path,
  branch: binding.branch,
  baseBranch: baseBranchOf(binding),
  apiBase: binding.apiBase,
  hasToken,
  canWrite: typeof binding.canWrite === "boolean" ? binding.canWrite : null,
});

const bad = (message) => new HttpError(400, message);

/** A repository directory prefix: "" is the root, and nothing may climb out. */
function normalizeRepoPath(raw) {
  const cleaned = String(raw ?? "").replace(/^\/+|\/+$/g, "");
  if (cleaned.length > 512) throw bad(PATH_ERROR);
  if (/[\\\u0000-\u001f]/.test(cleaned)) throw bad(PATH_ERROR);
  if (
    cleaned !== "" &&
    cleaned.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw bad(PATH_ERROR);
  }
  return cleaned;
}

const PATH_ERROR =
  'invalid path — a repository directory prefix, no "..", no backslashes (max 512)';
const BRANCH_ERROR =
  'invalid branch — letters, digits, ., _, - or / (max 255, no "..")';
const BRANCH_NAME_ERROR =
  'invalid branch name — letters, digits, ., _, - or / (max 200, no "..", no "//", no leading or trailing "/")';

/** A branch this store may address: an existing one, on either store. */
function checkBranch(branch) {
  if (
    !BRANCH_RE.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("/") ||
    branch.endsWith("/")
  ) {
    throw bad(BRANCH_ERROR);
  }
  return branch;
}

/** A branch this store may create — the stricter gate (see NEW_BRANCH_RE). */
function checkNewBranch(name) {
  if (
    typeof name !== "string" ||
    !NEW_BRANCH_RE.test(name) ||
    name.includes("..") ||
    name.includes("//") ||
    name.endsWith("/")
  ) {
    throw bad(BRANCH_NAME_ERROR);
  }
  return name;
}

/**
 * Validate what the client sent and fill in the two defaults. The token is
 * deliberately not part of the result: it goes to a different file.
 */
function normalizeBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw bad("body is not a binding");
  }
  // A field that is present but not a string is wrong rather than absent, so
  // it fails its own field's gate instead of silently taking the default.
  const textOr = (key, fallback, message) => {
    const value = input[key];
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string") throw bad(message);
    return value;
  };
  const ownerError =
    "invalid owner — use letters, digits, ., - or _ (max 100, no leading symbol)";
  const repoError =
    "invalid repo — use letters, digits, ., - or _ (max 100, no leading symbol)";
  const apiBaseError = "invalid apiBase — must be an http(s) URL";

  const owner = textOr("owner", "", ownerError);
  const repo = textOr("repo", "", repoError);
  if (!OWNER_RE.test(owner)) throw bad(ownerError);
  if (!OWNER_RE.test(repo)) throw bad(repoError);
  const repoPath = normalizeRepoPath(textOr("path", "", PATH_ERROR));
  const branch = checkBranch(textOr("branch", DEFAULT_BRANCH, BRANCH_ERROR));
  // Stating the base is allowed but never required: putBinding resolves it
  // from the repository when the client leaves it out (D28).
  const baseBranch = textOr("baseBranch", "", BRANCH_ERROR);
  if (baseBranch !== "") checkBranch(baseBranch);
  const apiBase = textOr("apiBase", DEFAULT_API_BASE, apiBaseError).replace(/\/+$/, "");
  if (apiBase.length > 512 || !API_BASE_RE.test(apiBase)) throw bad(apiBaseError);
  return { owner, repo, path: repoPath, branch, baseBranch, apiBase };
}

/** Optional on update: absent or empty means "keep whatever is stored". */
function normalizeToken(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 512 || /[\s\u0000-\u001f]/.test(raw)) {
    throw bad("invalid token — no spaces or control characters (max 512)");
  }
  return raw;
}

async function putBinding(project, body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  const requested = normalizeBinding(input);
  const newToken = normalizeToken(input.token);
  // A bound project still owns a local directory: it is where it came from,
  // and where it returns to if the binding is removed.
  await fs.mkdir(projectDir(project), { recursive: true });
  // Whatever token this binding will run on — the one just given, or the one
  // already stored. Without either there is nothing to probe with.
  const token = newToken ?? (await tokenFor(project));
  const probe =
    token === null
      ? { canWrite: null, defaultBranch: null }
      : await probeAccess(requested, token);
  const bindings = await readBindings();
  const stored = bindings[project];
  // The base is sticky, and every step of this fallback is a real case: what
  // the client stated, else what this project already recorded — which is what
  // makes switching branches a PUT of `{ branch }` and nothing else — else the
  // repository's own default branch as the probe just read it, else the branch
  // being bound, because a store that cannot ask still has to answer.
  const baseBranch =
    requested.baseBranch ||
    (typeof stored?.baseBranch === "string" && stored.baseBranch !== ""
      ? stored.baseBranch
      : "") ||
    probe.defaultBranch ||
    requested.branch;
  // Field order is the order the desktop store's struct declares, so the
  // dotfile stays byte-comparable across the two implementations. Unknown
  // `canWrite` is stored as an absent field rather than an explicit null, so a
  // binding written before it existed and one written now are the same bytes.
  bindings[project] = {
    owner: requested.owner,
    repo: requested.repo,
    path: requested.path,
    branch: requested.branch,
    baseBranch,
    apiBase: requested.apiBase,
    ...(probe.canWrite === null ? {} : { canWrite: probe.canWrite }),
  };
  await writeJsonFile(BINDINGS_FILE, bindings);
  if (newToken !== null) {
    const secrets = await readSecrets();
    secrets[project] = newToken;
    await writeJsonFile(SECRETS_FILE, secrets, 0o600);
  }
  listingCache.delete(project);
  boundCounts.delete(project);
  return {
    ok: true,
    canWrite: probe.canWrite,
    baseBranch,
    ...(probe.warning ? { warning: probe.warning } : {}),
  };
}

/** Unbind: metadata and token go, the local directory and GitHub both stay. */
async function removeBinding(project) {
  const bindings = await readBindings();
  if (project in bindings) {
    delete bindings[project];
    await writeJsonFile(BINDINGS_FILE, bindings);
  }
  const secrets = await readSecrets();
  if (project in secrets) {
    delete secrets[project];
    await writeJsonFile(SECRETS_FILE, secrets, 0o600);
  }
  listingCache.delete(project);
  boundCounts.delete(project);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// the GitHub API client — HTTP only, no git binary (D27)
// ---------------------------------------------------------------------------

const encodeSegments = (segments) => segments.map(encodeURIComponent).join("/");

const repoUrl = (binding, rest) =>
  `${binding.apiBase}/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}${rest}`;

const contentsUrl = (binding, leaf) => {
  const segments = binding.path === "" ? [] : binding.path.split("/");
  if (leaf !== null) segments.push(leaf);
  const suffix = segments.length ? `/${encodeSegments(segments)}` : "";
  return repoUrl(binding, `/contents${suffix}`);
};

async function github(token, method, url, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable, refused, timed out: the store is fine, the far end is not.
    throw new HttpError(502, `GitHub request failed — ${err?.message ?? err}`);
  }
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    text: res.status === 304 ? "" : await res.text(),
  };
}

/** Whatever GitHub said, in one line, without ever guessing a status. */
function githubFailure(status, text) {
  if (status === 401 || status === 403) return new HttpError(401, TOKEN_ERROR);
  let detail = "";
  try {
    const message = JSON.parse(text)?.message;
    if (typeof message === "string" && message !== "") detail = `: ${message}`;
  } catch {
    // A non-JSON body from an API that always answers JSON says nothing worth
    // relaying — the status is the whole message.
  }
  return new HttpError(502, `GitHub API error (${status})${detail}`);
}

/**
 * The same, for a PUT or a DELETE. GitHub's 403 on a write means "I know who
 * you are and you may not do that" — which is a different fix from a bad
 * token, and the only place a user can act on the difference. A 401 still maps
 * to TOKEN_ERROR here, because a credential GitHub refuses outright is refused
 * for reads too and the read message already says so.
 */
function githubWriteFailure(binding, status, text) {
  if (status === 403 && !isTooLarge(status, text)) {
    return new HttpError(403, writeRejected(binding));
  }
  return githubFailure(status, text);
}

/**
 * Ask GitHub what this token may do with the repository, once, at bind time.
 * `GET /repos/{owner}/{repo}` answers an authenticated caller with a
 * `permissions` object — `{ admin, maintain, push, triage, pull }` — and `push`
 * is the bit that decides whether a save can ever work. Naming a read-only
 * token here is the whole point: otherwise the user learns it from a failed
 * save, long after the form is closed.
 *
 * The same answer carries `default_branch`, which is the repository's own
 * opinion of what a pull request should target (D28) — so the base branch is
 * learned from the one call that was already being made, not a second one.
 *
 * It never throws. A binding is worth storing even when the probe cannot
 * reach GitHub, so every unhappy answer is reported as "unknown" plus a
 * warning rather than as a refusal to bind.
 */
async function probeAccess(binding, token) {
  const unverified = { canWrite: null, defaultBranch: null, warning: unverifiedAccess(binding) };
  let res;
  try {
    res = await github(token, "GET", repoUrl(binding, ""));
  } catch {
    // Unreachable, refused, timed out: the repository may be perfectly fine
    // and this machine briefly not.
    return unverified;
  }
  if (res.status !== 200) return unverified;
  let repo;
  try {
    repo = JSON.parse(res.text);
  } catch {
    return { canWrite: null, defaultBranch: null };
  }
  const permissions = repo?.permissions;
  // A default branch is only worth recording if this store could address it;
  // an Enterprise answer with something odd in it falls back like an absent one.
  let defaultBranch = null;
  if (typeof repo?.default_branch === "string" && repo.default_branch !== "") {
    try {
      defaultBranch = checkBranch(repo.default_branch);
    } catch {
      defaultBranch = null;
    }
  }
  // An answer without a permissions object (an unauthenticated read, some
  // Enterprise versions) says nothing either way — and guessing "writable"
  // there is exactly the lie this probe exists to stop.
  return {
    canWrite: typeof permissions?.push === "boolean" ? permissions.push : null,
    defaultBranch,
  };
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "GitHub API error (unparseable response)");
  }
};

/**
 * Contents-API responses for files over 1 MB carry no content: older GitHub
 * refuses with a 403 naming the size, newer sets `encoding: "none"`. Either
 * way the blob API has the bytes, so both are a fallback rather than an error
 * — and the 403 is checked before the credential mapping, so a scene that is
 * merely large is never reported as a rejected token.
 */
const isTooLarge = (status, text) => status === 403 && /too large/i.test(text);

async function githubListing(project, binding, token) {
  const url = `${contentsUrl(binding, null)}?ref=${encodeURIComponent(binding.branch)}`;
  const cached = listingCache.get(project);
  const res = await github(token, "GET", url, {
    headers: cached?.etag ? { "if-none-match": cached.etag } : undefined,
  });
  if (res.status === 304 && cached) {
    boundCounts.set(project, cached.scenes.length);
    return cached.scenes;
  }
  // A bound path that does not exist yet is the normal state right after
  // binding — the first save creates it. Listing it as empty is honest; a
  // wrong owner/repo shows the same, and then fails loudly on the first write.
  if (res.status === 404) {
    boundCounts.set(project, 0);
    return [];
  }
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const entries = parseJson(res.text);
  if (!Array.isArray(entries)) {
    throw new HttpError(502, "the bound path is a file, not a directory");
  }
  const scenes = entries
    .filter(
      (entry) =>
        entry?.type === "file" &&
        typeof entry.name === "string" &&
        entry.name.endsWith(EXT) &&
        // Only names this store can address round-trip: anything else in the
        // directory belongs to the repository, not to the portfolio.
        NAME_RE.test(entry.name.slice(0, -EXT.length)),
    )
    .map((entry) => ({
      name: entry.name.slice(0, -EXT.length),
      updatedAt: null,
      size: typeof entry.size === "number" ? entry.size : 0,
      sha: String(entry.sha ?? ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // One extra request for the whole listing rather than one per scene: the
  // branch's last commit touching the bound path stamps every scene. Coarse
  // but honest — and it is exactly what the thumbnail cache keys on, so any
  // change to any scene re-renders them.
  if (scenes.length > 0) {
    const stamp = await lastCommitDate(binding, token);
    for (const scene of scenes) scene.updatedAt = stamp;
  }
  listingCache.set(project, { etag: res.etag, scenes });
  boundCounts.set(project, scenes.length);
  return scenes;
}

async function lastCommitDate(binding, token) {
  const query = new URLSearchParams({ per_page: "1", sha: binding.branch });
  if (binding.path !== "") query.set("path", binding.path);
  const res = await github(
    token,
    "GET",
    repoUrl(binding, `/commits?${query.toString()}`),
  );
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const commit = JSON.parse(res.text)?.[0]?.commit;
    const date = commit?.committer?.date ?? commit?.author?.date;
    return typeof date === "string" ? date : null;
  } catch {
    // A listing is still a listing without timestamps.
    return null;
  }
}

/** The file's metadata, or null when GitHub says it isn't there. */
async function githubFileMeta(binding, token, scene) {
  const url = `${contentsUrl(binding, scene + EXT)}?ref=${encodeURIComponent(binding.branch)}`;
  const res = await github(token, "GET", url);
  if (res.status === 404) return null;
  if (isTooLarge(res.status, res.text)) return { sha: null, oversize: true };
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const json = parseJson(res.text);
  return { sha: typeof json.sha === "string" ? json.sha : null, json };
}

/**
 * The blob sha the file currently has on the branch, or null when there is no
 * such file. A file past the contents API's size limit answers without one, so
 * the listing — which always carries shas — is the fallback.
 */
async function currentSha(project, binding, token, scene) {
  const meta = await githubFileMeta(binding, token, scene);
  if (!meta) return null;
  if (meta.sha) return meta.sha;
  const listed = (await githubListing(project, binding, token)).find(
    (entry) => entry.name === scene,
  );
  return listed?.sha ?? null;
}

async function githubLoad(project, binding, token, scene) {
  const meta = await githubFileMeta(binding, token, scene);
  if (!meta) throw new HttpError(404, `no such scene: ${project}/${scene}`);
  const json = meta.json;
  if (json?.encoding === "base64" && typeof json.content === "string" && json.content.trim() !== "") {
    return {
      raw: Buffer.from(json.content, "base64").toString("utf8"),
      sha: meta.sha ?? "",
    };
  }
  // Oversize, or content withheld: read the blob itself, addressed by the sha
  // the listing knows.
  const sha = meta.sha ?? (await currentSha(project, binding, token, scene));
  if (!sha) throw new HttpError(404, `no such scene: ${project}/${scene}`);
  const blob = await github(
    token,
    "GET",
    repoUrl(binding, `/git/blobs/${encodeURIComponent(sha)}`),
  );
  if (blob.status < 200 || blob.status >= 300) throw githubFailure(blob.status, blob.text);
  const body = parseJson(blob.text);
  if (typeof body.content !== "string") {
    throw new HttpError(502, "GitHub API error (blob carried no content)");
  }
  return { raw: Buffer.from(body.content, "base64").toString("utf8"), sha };
}

async function githubSave(project, binding, token, scene, body, headerSha) {
  let sha = headerSha ?? null;
  if (!sha) {
    // No conflict token: this is the last-write-wins path, so the current sha
    // is fetched purely to satisfy GitHub's own update requirement.
    sha = await currentSha(project, binding, token, scene);
  }
  const res = await github(token, "PUT", contentsUrl(binding, scene + EXT), {
    body: JSON.stringify({
      message: `docent: ${sha ? "update" : "create"} ${project}/${scene}`,
      content: Buffer.from(body, "utf8").toString("base64"),
      branch: binding.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  // 409 is GitHub's own conflict; 422 is what it answers when the sha is stale
  // or names a file that is no longer there. Both mean the same thing to a
  // user: someone else moved first.
  if (res.status === 409 || res.status === 422) throw new HttpError(409, CONFLICT_ERROR);
  if (res.status < 200 || res.status >= 300) {
    throw githubWriteFailure(binding, res.status, res.text);
  }
  listingCache.delete(project);
  const created = parseJson(res.text);
  const newSha = created?.content?.sha;
  return { ok: true, sha: typeof newSha === "string" ? newSha : null };
}

async function githubDelete(project, binding, token, scene) {
  const sha = await currentSha(project, binding, token, scene);
  if (!sha) throw new HttpError(404, `no such scene: ${project}/${scene}`);
  const res = await github(token, "DELETE", contentsUrl(binding, scene + EXT), {
    body: JSON.stringify({
      message: `docent: delete ${project}/${scene}`,
      sha,
      branch: binding.branch,
    }),
  });
  if (res.status === 409 || res.status === 422) throw new HttpError(409, CONFLICT_ERROR);
  if (res.status < 200 || res.status >= 300) {
    throw githubWriteFailure(binding, res.status, res.text);
  }
  listingCache.delete(project);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// branches and pull requests (D28) — the repository's own review flow
// ---------------------------------------------------------------------------

/**
 * The repository's branches. One page of 100 is the v1 cap: GitHub paginates
 * this endpoint, and a store that fetched every page would spend a user's rate
 * limit walking release history to fill a select. A repository with more
 * branches than that shows the first hundred GitHub names.
 */
async function githubBranches(binding, token) {
  const res = await github(token, "GET", repoUrl(binding, "/branches?per_page=100"));
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const entries = parseJson(res.text);
  if (!Array.isArray(entries)) {
    throw new HttpError(502, "GitHub API error (branches are not a list)");
  }
  const base = baseBranchOf(binding);
  // GitHub's own order, kept: it is the repository's alphabetical listing, and
  // re-sorting it here would only be a second opinion about the same data.
  return entries
    .filter((entry) => typeof entry?.name === "string" && entry.name !== "")
    .map((entry) => ({
      name: entry.name,
      isBase: entry.name === base,
      isActive: entry.name === binding.branch,
    }));
}

/** The body of a POST, as an object; anything else is the client's mistake. */
function objectBody(body, what) {
  const text = body.trim();
  if (text === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bad(`body is not ${what}`);
  }
  return parsed;
}

/**
 * Point the binding at another branch, keeping everything else exactly as it
 * is — the base, the probe's verdict, the token (which lives elsewhere
 * entirely). Spreading over the stored object rather than rebuilding it is
 * what makes that true even for fields added later.
 */
async function setActiveBranch(project, branch) {
  const bindings = await readBindings();
  const binding = bindings[project];
  if (!binding) return;
  bindings[project] = { ...binding, branch };
  await writeJsonFile(BINDINGS_FILE, bindings);
  // A different branch is a different set of scenes: whatever this process
  // remembered about the old one is now wrong rather than merely stale.
  listingCache.delete(project);
  boundCounts.delete(project);
}

/**
 * Create a branch off another one and start drafting on it. Creating without
 * switching would leave the user editing the base they just branched away
 * from, which is the mistake this route exists to prevent.
 */
async function createBranch(project, binding, token, body) {
  const input = objectBody(body, "a branch");
  const name = checkNewBranch(input.name);
  let from = binding.branch;
  if (input.from !== undefined && input.from !== null && input.from !== "") {
    if (typeof input.from !== "string") throw bad(BRANCH_ERROR);
    from = checkBranch(input.from);
  }
  const heads = `/git/ref/heads/${encodeSegments(from.split("/"))}`;
  const ref = await github(token, "GET", repoUrl(binding, heads));
  if (ref.status === 404) {
    throw new HttpError(404, `no branch named ${from} on ${binding.owner}/${binding.repo}`);
  }
  if (ref.status < 200 || ref.status >= 300) throw githubFailure(ref.status, ref.text);
  const sha = parseJson(ref.text)?.object?.sha;
  if (typeof sha !== "string" || sha === "") {
    throw new HttpError(502, "GitHub API error (ref carried no sha)");
  }
  const created = await github(token, "POST", repoUrl(binding, "/git/refs"), {
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  // GitHub answers a duplicate ref with a 422. That is not a lost race like a
  // stale scene sha — it is a name already taken, and saying so is the fix.
  if (created.status === 422 && /already exists/i.test(created.text)) {
    throw new HttpError(
      409,
      `branch ${name} already exists on ${binding.owner}/${binding.repo}`,
    );
  }
  if (created.status < 200 || created.status >= 300) {
    throw githubWriteFailure(binding, created.status, created.text);
  }
  await setActiveBranch(project, name);
  return { ok: true, branch: name };
}

/**
 * GitHub's own sentence about a refusal. The Validation-Failed envelope's
 * top-level message says nothing ("Validation Failed"); the useful line — "No
 * commits between main and x", "A pull request already exists for acme:x" —
 * is the first entry of `errors`.
 */
function githubMessage(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return "";
  }
  const detailed = Array.isArray(body?.errors)
    ? body.errors.find((entry) => typeof entry?.message === "string" && entry.message !== "")
    : null;
  if (detailed) return detailed.message;
  return typeof body?.message === "string" ? body.message : "";
}

/** Open a pull request from the active branch onto the recorded base. */
async function openPullRequest(binding, token, body) {
  const input = objectBody(body, "a pull request");
  const base = baseBranchOf(binding);
  if (binding.branch === base) {
    // Nothing to review: the drafts and the base are the same branch, which is
    // exactly the state a binding starts in.
    throw new HttpError(
      400,
      `the active branch ${binding.branch} is the base branch — create a branch first`,
    );
  }
  const title =
    typeof input.title === "string" && input.title.trim() !== ""
      ? input.title
      : "docent: update diagrams";
  const description = typeof input.body === "string" ? input.body : "";
  const res = await github(token, "POST", repoUrl(binding, "/pulls"), {
    body: JSON.stringify({ title, head: binding.branch, base, body: description }),
  });
  // No commits between the two branches, or a pull request already open for
  // them: GitHub knows which, and its sentence is the one worth relaying.
  if (res.status === 422) {
    const message = githubMessage(res.text);
    throw new HttpError(409, `GitHub: ${message || "the pull request was refused"}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw githubWriteFailure(binding, res.status, res.text);
  }
  const created = parseJson(res.text);
  return {
    ok: true,
    url: typeof created?.html_url === "string" ? created.html_url : "",
    number: typeof created?.number === "number" ? created.number : 0,
  };
}

/**
 * Resolve a bound project to everything a GitHub call needs. A binding with no
 * token is refused here rather than at GitHub, so the answer is the same 401
 * either way and no pointless request leaves the machine.
 */
async function boundContext(project) {
  const binding = await bindingFor(project);
  if (!binding) return null;
  const token = await tokenFor(project);
  if (!token) throw new HttpError(401, TOKEN_ERROR);
  return { binding, token };
}

/** The same, for routes that only exist on a bound project (D28). */
async function boundOrFail(project) {
  const bound = await boundContext(project);
  if (!bound) throw new HttpError(404, `no GitHub binding for project: ${project}`);
  return bound;
}

// ---------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------

async function listProjects() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const bindings = await readBindings();
  const projects = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    // The bindings dotfile's own directory is not a project (D27).
    if (entry.name.startsWith(".")) continue;
    if (bindings[entry.name]) {
      // Deliberately not a network call: the projects listing is the first
      // thing the modal asks for and must never wait on GitHub. The count is
      // whatever this process last saw, and zero until it has seen anything.
      const cached = boundCounts.get(entry.name) ?? 0;
      // What the last probe learned travels with the listing so the modal can
      // mark a read-only project without a request per project — and it is
      // still not a network call, because it comes off the bindings dotfile.
      const canWrite = bindings[entry.name].canWrite;
      projects.push({
        id: entry.name,
        scenes: cached,
        updatedAt: null,
        bound: true,
        ...(typeof canWrite === "boolean" ? { canWrite } : {}),
      });
      continue;
    }
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
  const bound = await boundContext(project);
  if (bound) return githubListing(project, bound.binding, bound.token);
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

/** The conflict token a bound save carries, when the client kept one. */
const SCENE_SHA_HEADER = "x-docent-scene-sha";

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // parts: ["api", "projects", :project?, ("scenes"|"binding")?, :scene?]
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
      // Deleting a bound project unbinds it and removes the local directory.
      // Nothing on GitHub is touched — the repository is the user's, and a
      // portfolio operation must never reach into it destructively.
      checkName(project, "project");
      await removeBinding(project);
      await fs.rm(projectDir(project), { recursive: true, force: true });
      return { ok: true };
    }
  }

  // Binding routes (S14). Every one of them validates the project name first,
  // so a malformed name never reaches the bindings file either.
  if (parts.length === 4 && parts[3] === "binding") {
    const project = checkName(parts[2], "project");
    if (req.method === "GET") {
      const binding = await bindingFor(project);
      if (!binding) {
        throw new HttpError(404, `no GitHub binding for project: ${project}`);
      }
      return publicBinding(binding, (await tokenFor(project)) !== null);
    }
    if (req.method === "PUT") return putBinding(project, await readBody(req));
    // Idempotent, like the project delete above: unbinding what is already
    // unbound is a success.
    if (req.method === "DELETE") return removeBinding(project);
  }

  // Branch routes (D28). Only a bound project has branches at all, so an
  // unbound one answers the same 404 its binding does.
  if (parts.length === 4 && parts[3] === "branches") {
    const project = checkName(parts[2], "project");
    if (req.method === "GET") {
      const bound = await boundOrFail(project);
      return githubBranches(bound.binding, bound.token);
    }
    if (req.method === "POST") {
      const bound = await boundOrFail(project);
      const created = await createBranch(
        project,
        bound.binding,
        bound.token,
        await readBody(req),
      );
      res.statusCode = 201;
      return created;
    }
  }

  if (parts.length === 4 && parts[3] === "pull-request" && req.method === "POST") {
    const project = checkName(parts[2], "project");
    const bound = await boundOrFail(project);
    const opened = await openPullRequest(bound.binding, bound.token, await readBody(req));
    res.statusCode = 201;
    return opened;
  }

  if (parts.length === 4 && parts[3] === "scenes" && req.method === "GET") {
    return listScenes(parts[2]);
  }

  if (parts.length === 5 && parts[3] === "scenes") {
    const [, , project, , scene] = parts;
    const file = scenePath(project, scene);
    // A bound project's scenes live in the repository; the local directory
    // stays on disk but is not read, not written, and not listed.
    const bound = await boundContext(project);
    if (req.method === "GET") {
      if (bound) {
        const loaded = await githubLoad(project, bound.binding, bound.token, scene);
        return {
          raw: loaded.raw,
          headers: { "x-docent-scene-sha": loaded.sha },
        };
      }
      try {
        return { raw: await fs.readFile(file, "utf8") };
      } catch {
        throw new HttpError(404, `no such scene: ${project}/${scene}`);
      }
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      // The store persists .excalidraw files and nothing else (D17) —
      // reject anything that isn't one, loudly. Bound or not.
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, "body is not JSON");
      }
      if (parsed?.type !== "excalidraw") {
        throw new HttpError(400, "body is not an .excalidraw scene");
      }
      if (bound) {
        const sha = req.headers[SCENE_SHA_HEADER];
        return githubSave(
          project,
          bound.binding,
          bound.token,
          scene,
          body,
          typeof sha === "string" && sha !== "" ? sha : null,
        );
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
      if (bound) return githubDelete(project, bound.binding, bound.token, scene);
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
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        if (value) res.setHeader(name, value);
      }
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
