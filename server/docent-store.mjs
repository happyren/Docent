#!/usr/bin/env node
/**
 * Docent portfolio store (S12, D17, D18) — projects of scenes for one
 * deployment. A project is a directory, a scene is a plain `.excalidraw`
 * file at a **path** inside it (D92): `<DOCENT_DATA>/<project>/<a>/<b>.excalidraw`.
 * No database, no format of its own (D17) — anything this service can do, a
 * file manager can too. Zero runtime dependencies (I7): Node's built-in
 * http/fs/fetch.
 *
 * Served same-origin behind nginx at /api/ (D18); the dev server proxies
 * the same path, so the client never needs CORS.
 *
 * A project may also be **bound to a GitHub repository** (S14, D27, D29), and
 * that changes nothing about how its scenes are read and written: the project
 * directory *is* the working copy, and open/save never wait on the network.
 * What a binding adds is explicit synchronization, like code — pull, resolve,
 * push — plus the branch and pull-request routes below. No `git` binary
 * anywhere; everything speaks GitHub's HTTP API.
 *
 * Binding metadata lives in one dotfile at the data root and per-project sync
 * state beside it; neither ever carries the token (see BINDINGS_FILE /
 * SYNC_DIR / SECRETS_FILE below).
 *
 * Run:  node server/docent-store.mjs      (port 3400, data dir ./data)
 * Env:  DOCENT_STORE_PORT, DOCENT_DATA, DOCENT_SECRETS
 *
 * A bound project also gets the repository's own review flow (D28): the
 * binding records a `baseBranch`, the active `branch` is what pull and push
 * talk to, and the two branch routes below are how a user drafts on a branch
 * and opens a pull request back onto the base.
 *
 * API (JSON in/out; errors are { error } with a 4xx/5xx status):
 *   GET    /api/health                          → { ok: true }
 *   GET    /api/projects                        → [{ id, scenes, updatedAt, bound?, canWrite? }]
 *   PUT    /api/projects/:project               → { id }            (create)
 *   DELETE /api/projects/:project               → { ok }            (recursive)
 *   GET    /api/projects/:project/binding       → { owner, repo, path, branch, baseBranch, apiBase, hasToken, canWrite }
 *   PUT    /api/projects/:project/binding       → { ok, canWrite, baseBranch, warning?, pulled? }  (token write-only)
 *   DELETE /api/projects/:project/binding       → { ok }            (working copy stays)
 *   GET    /api/projects/:project/branches      → [{ name, isBase, isActive }]
 *   POST   /api/projects/:project/branches      → { ok, branch }    (creates it and switches to it)
 *   POST   /api/projects/:project/pull-request  → { ok, url, number }
 *   GET    /api/projects/:project/sync-status   → { branch, baseBranch, local, remote }
 *   POST   /api/projects/:project/pull          → { ok, updated, removed, kept, conflicts }
 *   POST   /api/projects/:project/pull/resolve  → { ok, scene, resolution }
 *   POST   /api/projects/:project/push          → { ok, commit, pushed, removedRemotely }
 *   GET    /api/projects/:project/scenes        → [{ name, updatedAt, size }]  (recursive)
 *   GET    /api/projects/:project/scenes/:name  → scene JSON
 *   PUT    /api/projects/:project/scenes/:name  → { ok }            (atomic)
 *   DELETE /api/projects/:project/scenes/:name  → { ok }
 *
 * `:name` is a scene path — up to 8 segments, URL-encoded whole into the one
 * segment (D92), so the routes have the shape they always had.
 */
import http from "node:http";
import { createHash } from "node:crypto";
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

// The same exception, for the other half of a binding: what each scene looked
// like at the last synchronization, per project (D29). It is derived state —
// delete it and the next pull rebuilds it conservatively, keeping every local
// file — and, like the bindings file, it carries no secrets.
const SYNC_DIR = path.join(DATA_DIR, ".docent", "sync");

// Tokens live outside the data tree, in deployment config. The default sits in
// the process working directory rather than under DOCENT_DATA precisely so a
// container that mounts only the data volume keeps them out of it — point
// DOCENT_SECRETS at a path outside that volume (see the README).
const SECRETS_FILE = path.resolve(process.env.DOCENT_SECRETS ?? ".docent-secrets.json");

// One flat rule keeps traversal impossible: every project and scene name
// must match this before it ever touches a path. No dots means no ".."
// and no extension games; the store adds .excalidraw itself.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

// A scene's name is a path (D92): one to eight of those segments, and the
// directories are implied by it. Eight is deep enough for any portfolio and
// shallow enough that a listing stays a listing.
const MAX_SCENE_DEPTH = 8;
// Reserved at every level, so the store's own dotfile exception can never be
// addressed as a folder. NAME_RE already refuses a leading dot; this states
// the rule the desktop store states, rather than relying on that.
const RESERVED_SEGMENT = ".docent";

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

/** One segment of a scene path, held to the one name rule (D92). */
const isSceneSegment = (segment) =>
  NAME_RE.test(segment) && segment.toLowerCase() !== RESERVED_SEGMENT;

/** A whole scene path: 1–8 such segments. A flat name is a path of one. */
const isScenePath = (scene) => {
  if (typeof scene !== "string" || scene === "") return false;
  const segments = scene.split("/");
  return segments.length <= MAX_SCENE_DEPTH && segments.every(isSceneSegment);
};

const SCENE_PATH_ERROR =
  "invalid scene path — up to 8 folders of letters, digits, spaces, - or _ (max 64 each, no leading symbol)";

const checkScenePath = (scene) => {
  if (!isScenePath(scene)) throw new HttpError(400, SCENE_PATH_ERROR);
  return scene;
};

const projectDir = (project) => path.join(DATA_DIR, checkName(project, "project"));
const scenePath = (project, scene) =>
  path.join(projectDir(project), ...checkScenePath(scene).split("/")) + EXT;

/**
 * A directory exists because scenes live in it (D92): once the last one is
 * gone the directory is too, ancestor by ancestor, stopping at `root` — the
 * project directory, which a scene delete never removes. `rmdir` refusing a
 * non-empty directory *is* the emptiness check, so there is no race between
 * looking and removing.
 */
async function pruneEmptyDirs(root, from) {
  let dir = from;
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Every scene under a directory, as scene path → file. Depth and segment
 * rules are the addressing rules (D92): a file this store could not address
 * round-trip is left out of every listing, count and sync — it stays on disk,
 * and no verb ever claims to have carried it.
 */
async function sceneFiles(dir, prefix = "", depth = 1) {
  const found = new Map();
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth >= MAX_SCENE_DEPTH || !isSceneSegment(entry.name)) continue;
      const nested = await sceneFiles(
        path.join(dir, entry.name),
        `${prefix}${entry.name}/`,
        depth + 1,
      );
      for (const [name, file] of nested) found.set(name, file);
      continue;
    }
    if (!entry.name.endsWith(EXT)) continue;
    const leaf = entry.name.slice(0, -EXT.length);
    if (!isSceneSegment(leaf)) continue;
    found.set(prefix + leaf, path.join(dir, entry.name));
  }
  return found;
}

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
/** What a push gets when someone else committed first — the one fix is a pull. */
const MOVED_ERROR = "the remote branch moved — pull first";
/** …and what it gets on the protected trunk (D33), where only a merge lands. */
const BASE_BRANCH_ERROR =
  "pushing to the base branch is disabled — create a branch and open a pull request";
/** …and what it gets when the last pull left questions the author must answer. */
const unresolvedError = (names) =>
  `resolve the conflicted scenes first: ${names.join(", ")}`;
/** …and what a branch switch gets while the working copy is not clean. */
const dirtySwitchError = (names) =>
  `push or resolve local changes before switching branches: ${names.join(", ")}`;

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
 * The cache for the one listing every sync verb starts with, keyed by the
 * branch head the listing was read at (D94): a branch that has not moved
 * cannot have moved a blob, so the whole tree read is skipped and the project
 * costs the rate limit one ref read. Deliberately per-process and not
 * persisted: it is an optimization against GitHub's rate limit, never a source
 * of truth — the working copy on disk is that (D29).
 */
const listingCache = new Map();

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

// ---------------------------------------------------------------------------
// sync state (S14, D29) — what each scene looked like at the last sync
// ---------------------------------------------------------------------------

/**
 * The content hash the working copy is measured against. Any stable hash would
 * do; sha-256 is the one both implementations already have without a
 * dependency, and writing it down means the file is comparable by eye.
 */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const syncFile = (project) => path.join(SYNC_DIR, `${project}.json`);

/**
 * A scene's base: the blob sha it had on the branch at the last sync, and the
 * hash of the content that came with it. An empty `baseSha` means "the remote
 * has never had this scene" — which is different from "the remote deleted it",
 * and the difference is what stops a pull from deleting a file GitHub never
 * carried. `conflictSha` is present only while a scene is conflicted: it is
 * the remote sha the author has yet to accept or reject, and an empty string
 * there means the remote deleted the scene while it was being edited here.
 */
async function readSync(project) {
  const parsed = await readJsonFile(syncFile(project), {});
  const scenes = parsed.scenes;
  const state = new Map();
  if (!scenes || typeof scenes !== "object" || Array.isArray(scenes)) return state;
  for (const [name, entry] of Object.entries(scenes)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    state.set(name, {
      baseSha: typeof entry.baseSha === "string" ? entry.baseSha : "",
      baseHash: typeof entry.baseHash === "string" ? entry.baseHash : "",
      conflictSha: typeof entry.conflictSha === "string" ? entry.conflictSha : null,
    });
  }
  return state;
}

/**
 * Written atomically, with scene names in code-point order and a trailing
 * newline, so the file is byte-identical to the one the desktop store writes
 * for the same state — and diffable when a user looks at it.
 */
async function writeSync(project, state) {
  const scenes = {};
  for (const name of [...state.keys()].sort()) {
    const entry = state.get(name);
    scenes[name] = {
      baseSha: entry.baseSha,
      baseHash: entry.baseHash,
      ...(entry.conflictSha === null ? {} : { conflictSha: entry.conflictSha }),
    };
  }
  const file = syncFile(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ scenes }, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

/**
 * The "before" copies (D47): the content the recorded base sha points at,
 * kept beside the sync state so a review never needs the network. Under
 * the data root's `.docent/` exception — never inside the project directory,
 * never pushed.
 */
const baseDir = (project) => path.join(SYNC_DIR, project, "base");
const basePath = (project, scene) =>
  path.join(baseDir(project), ...checkScenePath(scene).split("/")) + EXT;
async function writeBase(project, scene, text) {
  const file = basePath(project, scene);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}
/** Nested like the working copy (D94), and pruned like it. */
async function removeBase(project, scene) {
  const file = basePath(project, scene);
  await fs.rm(file, { force: true });
  await pruneEmptyDirs(baseDir(project), path.dirname(file));
}
async function readBase(project, scene) {
  try {
    return await fs.readFile(basePath(project, scene), "utf8");
  } catch {
    return null;
  }
}
const removeSync = async (project) => {
  await fs.rm(syncFile(project), { force: true });
  await fs.rm(path.join(SYNC_DIR, project), { recursive: true, force: true });
};

/**
 * The working copy: every addressable scene in the project directory, by
 * content hash. A `.excalidraw` file whose name this store could not address
 * round-trip is left out of sync entirely — it stays on disk, and no verb ever
 * claims to have pushed it.
 */
async function workingCopy(project) {
  const copy = new Map();
  for (const [name, file] of await sceneFiles(projectDir(project))) {
    copy.set(name, sha256(await fs.readFile(file, "utf8")));
  }
  return copy;
}

/**
 * What happened to one scene since the last sync, from this side alone. No
 * network, by construction: it is a file hash against a recorded one.
 */
function sceneState(hash, base) {
  if (base && base.conflictSha !== null) return "conflicted";
  if (hash === undefined) return base ? "deleted" : "clean";
  if (!base) return "new";
  return hash === base.baseHash ? "clean" : "modified";
}

const byName = (a, b) => a.localeCompare(b);

/**
 * Scene paths, folders first (D92): compared segment by segment, so a
 * directory's contents stay together, and siblings keep the order flat names
 * always had. Where the segments agree the deeper path is the folder, and the
 * folder leads.
 */
function byScenePath(a, b) {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] === right[i]) continue;
    const leftIsDir = i < left.length - 1;
    const rightIsDir = i < right.length - 1;
    if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
    return byName(left[i], right[i]);
  }
  return right.length - left.length;
}

/** Every scene the project knows about — on disk, recorded, or both. */
function sceneNames(...maps) {
  const names = new Set();
  for (const map of maps) for (const name of map.keys()) names.add(name);
  return [...names].sort(byName);
}

async function localStates(project) {
  const copy = await workingCopy(project);
  const bases = await readSync(project);
  return sceneNames(copy, bases).map((name) => ({
    name,
    state: sceneState(copy.get(name), bases.get(name) ?? null),
  }));
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
  // What this binding sends to GitHub beside the scenes (D49) — both off
  // unless the team asked.
  review: {
    images: binding.review?.images === true,
    sidecars: binding.review?.sidecars === true,
  },
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
  // Absent stays absent: the active branch resolves in putBinding — stored
  // binding first, else the repository's own default branch as the probe
  // reads it. Defaulting to a *name* here would bind projects to a branch
  // the repository may simply not have.
  const branch = textOr("branch", "", BRANCH_ERROR);
  if (branch !== "") checkBranch(branch);
  // Stating the base is allowed but never required: putBinding resolves it
  // from the repository when the client leaves it out (D28).
  const baseBranch = textOr("baseBranch", "", BRANCH_ERROR);
  if (baseBranch !== "") checkBranch(baseBranch);
  const apiBase = textOr("apiBase", DEFAULT_API_BASE, apiBaseError).replace(/\/+$/, "");
  if (apiBase.length > 512 || !API_BASE_RE.test(apiBase)) throw bad(apiBaseError);
  // Review artifacts (D49): absent keeps what is stored; present sets both.
  let review = null;
  if (input.review !== undefined) {
    if (typeof input.review !== "object" || input.review === null) {
      throw bad("invalid review — an object with images/sidecars booleans");
    }
    review = { images: input.review.images === true, sidecars: input.review.sidecars === true };
  }
  return { owner, repo, path: repoPath, branch, baseBranch, apiBase, review };
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
  // A bound project's directory is its working copy (D29): binding creates it
  // if it is missing and never touches what is already in it — the first pull
  // is what reconciles those files with the repository.
  await fs.mkdir(projectDir(project), { recursive: true });
  // Moving an existing binding to another branch means the working copy is
  // about to be replaced with that branch's content, so it has to be clean
  // first. Answered before the probe: there is no point asking GitHub anything
  // when the switch cannot happen.
  const previous = await bindingFor(project);
  // What the caller means by "the branch": stated explicitly, else whatever
  // this project is already on. Absent both, the binding is fresh and the
  // probe below names the branch — which cannot be a switch.
  const statedBranch = requested.branch || previous?.branch || "";
  const switching =
    previous !== null && statedBranch !== "" && previous.branch !== statedBranch;
  if (switching) {
    const dirty = (await localStates(project))
      .filter((scene) => scene.state !== "clean")
      .map((scene) => scene.name);
    if (dirty.length > 0) throw new HttpError(409, dirtySwitchError(dirty));
  }
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
  // The active branch: what was asked for (or already recorded), else the
  // repository's own default as the probe just read it, else the
  // conventional name — a store that cannot ask still has to answer.
  const branch = statedBranch || probe.defaultBranch || DEFAULT_BRANCH;
  const baseBranch =
    requested.baseBranch ||
    (typeof stored?.baseBranch === "string" && stored.baseBranch !== ""
      ? stored.baseBranch
      : "") ||
    probe.defaultBranch ||
    branch;
  // Field order is the order the desktop store's struct declares, so the
  // dotfile stays byte-comparable across the two implementations. Unknown
  // `canWrite` is stored as an absent field rather than an explicit null, so a
  // binding written before it existed and one written now are the same bytes.
  bindings[project] = {
    owner: requested.owner,
    repo: requested.repo,
    path: requested.path,
    branch,
    baseBranch,
    apiBase: requested.apiBase,
    ...(probe.canWrite === null ? {} : { canWrite: probe.canWrite }),
  };
  // Stored only when a flag is on, so a binding that never asked for
  // artifacts is the same bytes it always was.
  const review = requested.review ?? stored?.review ?? null;
  if (review && (review.images || review.sidecars)) {
    bindings[project].review = { images: review.images === true, sidecars: review.sidecars === true };
  }
  await writeJsonFile(BINDINGS_FILE, bindings);
  if (newToken !== null) {
    const secrets = await readSecrets();
    secrets[project] = newToken;
    await writeJsonFile(SECRETS_FILE, secrets, 0o600);
  }
  // A different branch is a different set of blobs: whatever this process
  // remembered about the old one is now wrong rather than merely stale.
  listingCache.delete(project);
  const answer = {
    ok: true,
    canWrite: probe.canWrite,
    baseBranch,
    ...(probe.warning ? { warning: probe.warning } : {}),
  };
  if (!switching) return answer;
  // The copy was clean, so this can only fast-forward it: every scene either
  // arrives, changes, or goes, and nothing of the user's is at stake. A pull
  // that cannot reach GitHub throws, loudly — the binding has moved, and the
  // fix is to pull again rather than to pretend the switch did not happen.
  const pulled =
    token === null ? { updated: [], removed: [] } : await pullProject(project, bindings[project], token);
  return { ...answer, pulled: pulled.updated.length + pulled.removed.length };
}

/**
 * Unbind: metadata, sync state and token go; the working copy and GitHub both
 * stay. Dropping the sync state is what makes rebinding safe — with no
 * recorded base, every local file reads as never-synced and the first pull
 * keeps all of them.
 */
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
  await removeSync(project);
  listingCache.delete(project);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// the GitHub API client — HTTP only, no git binary (D27)
// ---------------------------------------------------------------------------

const encodeSegments = (segments) => segments.map(encodeURIComponent).join("/");

const repoUrl = (binding, rest) =>
  `${binding.apiBase}/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}${rest}`;

async function github(token, method, url, { body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable, refused, timed out: the store is fine, the far end is not.
    throw new HttpError(502, `GitHub request failed — ${err?.message ?? err}`);
  }
  return { status: res.status, text: await res.text() };
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

/** What a tree too big for one answer gets: a refusal, never half a sync. */
const TRUNCATED_ERROR =
  "the repository tree is too large to list in one request — bind a narrower path";

/**
 * What the bound subtree holds on the active branch: scene path → blob sha,
 * recursively (D94). The Git trees API rather than the contents API, because
 * the contract with the repository was always the subtree and contents only
 * ever answers one directory. Two requests at most: the branch's head, and —
 * only when that head has moved since the last listing — the tree itself.
 */
async function remoteListing(project, binding, token) {
  const head = await githubHeadCommit(binding, token);
  const cached = listingCache.get(project);
  if (cached?.commit === head) return new Map(cached.entries);
  const tree = await githubCommitTree(binding, token, head);
  const res = await github(
    token,
    "GET",
    repoUrl(binding, `/git/trees/${encodeURIComponent(tree)}?recursive=1`),
  );
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const body = parseJson(res.text);
  // GitHub truncates a tree it will not answer whole. Syncing against half a
  // repository would read as "the remote deleted everything below here", so
  // this is a refusal rather than a listing.
  if (body?.truncated === true) throw new HttpError(502, TRUNCATED_ERROR);
  if (!Array.isArray(body?.tree)) {
    throw new HttpError(502, "GitHub API error (tree carried no entries)");
  }
  // A bound path that does not exist yet is the normal state right after
  // binding — the first push creates it — and answers as no entries at all.
  const prefix = binding.path === "" ? "" : `${binding.path}/`;
  const listed = [];
  for (const entry of body.tree) {
    if (entry?.type !== "blob" || typeof entry.path !== "string") continue;
    if (!entry.path.startsWith(prefix) || !entry.path.endsWith(EXT)) continue;
    const scene = entry.path.slice(prefix.length, -EXT.length);
    // Only paths this store can address round-trip: anything else under the
    // bound path belongs to the repository, not to the portfolio.
    if (!isScenePath(scene)) continue;
    listed.push([scene, String(entry.sha ?? "")]);
  }
  listed.sort((a, b) => byName(a[0], b[0]));
  listingCache.set(project, { commit: head, entries: listed });
  return new Map(listed);
}

/**
 * One blob, by sha. Every read goes through the Git Data API rather than the
 * contents API: blobs carry no 1 MB inline ceiling, so a large scene needs no
 * fallback path at all.
 */
async function githubBlob(binding, token, sha) {
  const res = await github(
    token,
    "GET",
    repoUrl(binding, `/git/blobs/${encodeURIComponent(sha)}`),
  );
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const body = parseJson(res.text);
  if (typeof body.content !== "string") {
    throw new HttpError(502, "GitHub API error (blob carried no content)");
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}

/** The branch's head commit — one request, and the key a listing caches on. */
async function githubHeadCommit(binding, token) {
  const heads = `/git/ref/heads/${encodeSegments(binding.branch.split("/"))}`;
  const ref = await github(token, "GET", repoUrl(binding, heads));
  if (ref.status === 404) {
    throw new HttpError(
      404,
      `no branch named ${binding.branch} on ${binding.owner}/${binding.repo}`,
    );
  }
  if (ref.status < 200 || ref.status >= 300) throw githubFailure(ref.status, ref.text);
  const commit = parseJson(ref.text)?.object?.sha;
  if (typeof commit !== "string" || commit === "") {
    throw new HttpError(502, "GitHub API error (ref carried no sha)");
  }
  return commit;
}

/** The tree one commit points at. */
async function githubCommitTree(binding, token, commit) {
  const res = await github(
    token,
    "GET",
    repoUrl(binding, `/git/commits/${encodeURIComponent(commit)}`),
  );
  if (res.status < 200 || res.status >= 300) throw githubFailure(res.status, res.text);
  const tree = parseJson(res.text)?.tree?.sha;
  if (typeof tree !== "string" || tree === "") {
    throw new HttpError(502, "GitHub API error (commit carried no tree)");
  }
  return tree;
}

/** The branch's head commit and the tree that commit points at. */
async function githubHead(binding, token) {
  const commit = await githubHeadCommit(binding, token);
  return { commit, tree: await githubCommitTree(binding, token, commit) };
}

/** POST one of the Git Data objects and read the sha back out of the answer. */
async function githubCreate(binding, token, endpoint, payload) {
  const res = await github(token, "POST", repoUrl(binding, endpoint), {
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw githubWriteFailure(binding, res.status, res.text);
  }
  const sha = parseJson(res.text)?.sha;
  if (typeof sha !== "string" || sha === "") {
    throw new HttpError(502, `GitHub API error (${endpoint} carried no sha)`);
  }
  return sha;
}

/**
 * Move the branch to the new commit, without force. GitHub answers a
 * non-fast-forward with a 422, which is the whole point: it is what makes
 * "someone else pushed while you were drawing" a refusal instead of a lost
 * commit. Nothing is left behind by the refusal — the blobs, tree and commit
 * exist unreferenced and GitHub collects them.
 */
async function githubUpdateRef(binding, token, commit) {
  const heads = `/git/refs/heads/${encodeSegments(binding.branch.split("/"))}`;
  const res = await github(token, "PATCH", repoUrl(binding, heads), {
    body: JSON.stringify({ sha: commit, force: false }),
  });
  if (res.status === 422) throw new HttpError(409, MOVED_ERROR);
  if (res.status < 200 || res.status >= 300) {
    throw githubWriteFailure(binding, res.status, res.text);
  }
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
  // A different branch is a different set of blobs: whatever this process
  // remembered about the old one is now wrong rather than merely stale. The
  // recorded bases stay valid — a branch cut here starts at the same head, so
  // every scene's blob is the same object on both names (D28).
  listingCache.delete(project);
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

// ---------------------------------------------------------------------------
// the sync verbs (D29) — the only routes that touch the network
// ---------------------------------------------------------------------------

/** Where a scene lives inside the repository, from the repository's root. */
const repoFile = (binding, scene) =>
  binding.path === "" ? scene + EXT : `${binding.path}/${scene}${EXT}`;

/** Write one scene of the working copy, atomically, as a save would. */
async function writeWorkingFile(project, scene, text) {
  const file = scenePath(project, scene);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** Remove one scene of the working copy, and the folders it emptied (D92). */
async function removeWorkingFile(project, scene) {
  const file = scenePath(project, scene);
  await fs.rm(file, { force: true });
  await pruneEmptyDirs(projectDir(project), path.dirname(file));
}

/**
 * Fast-forward the working copy from the branch. Every scene is decided on its
 * own, and the rule never varies: when only one side moved, that side wins;
 * when both moved, nothing is touched and the author is asked (D29). There is
 * no merge, because there is no meaningful line-merge for a drawing.
 *
 * A scene that has never been synced — a project bound before any of this
 * existed, or a file drawn before the first pull — has no recorded base, so it
 * is local-new and kept. That is what makes the first pull of a legacy binding
 * safe: it can add and it can flag, but it cannot delete.
 */
async function pullProject(project, binding, token) {
  const remote = await remoteListing(project, binding, token);
  const bases = await readSync(project);
  const copy = await workingCopy(project);
  const updated = [];
  const removed = [];
  const kept = [];
  const conflicts = [];

  for (const name of sceneNames(copy, bases, remote)) {
    const hash = copy.get(name);
    const base = bases.get(name) ?? null;
    const remoteSha = remote.has(name) ? remote.get(name) : null;
    const state = sceneState(hash, base);
    // "Changed" is measured against the recorded base, never against the file:
    // a scene the remote has never carried (empty baseSha) is absent, not
    // deleted, and absence is not a change.
    const remoteChanged =
      remoteSha === null
        ? base !== null && base.baseSha !== ""
        : base === null || remoteSha !== base.baseSha;

    if (!remoteChanged) {
      if (state !== "clean") kept.push(name);
      continue;
    }
    if (state === "clean") {
      if (remoteSha === null) {
        await removeWorkingFile(project, name);
        await removeBase(project, name);
        bases.delete(name);
        removed.push(name);
      } else {
        const text = await githubBlob(binding, token, remoteSha);
        await writeWorkingFile(project, name, text);
        await writeBase(project, name, text);
        bases.set(name, { baseSha: remoteSha, baseHash: sha256(text), conflictSha: null });
        updated.push(name);
      }
      continue;
    }
    if (state === "deleted" && remoteSha === null) {
      // Both sides deleted it: there is nothing to reconcile and nothing to
      // ask about — the copy and the branch already agree.
      await removeBase(project, name);
      bases.delete(name);
      removed.push(name);
      continue;
    }
    if (state === "new" && remoteSha !== null) {
      // A file and a blob that have never met. Identical content is the common
      // case — a project bound to a repository that already held its scenes —
      // and it is an agreement rather than a conflict.
      const text = await githubBlob(binding, token, remoteSha);
      if (sha256(text) === hash) {
        await writeBase(project, name, text);
        bases.set(name, { baseSha: remoteSha, baseHash: hash, conflictSha: null });
        updated.push(name);
        continue;
      }
    }
    // Both sides moved. The file on disk is not touched — the author's work is
    // never overwritten by a pull — and the remote sha is recorded as the
    // question to answer. An empty one means the remote deleted it.
    bases.set(name, {
      baseSha: base?.baseSha ?? "",
      baseHash: base?.baseHash ?? "",
      conflictSha: remoteSha ?? "",
    });
    conflicts.push(name);
  }

  await writeSync(project, bases);
  return { ok: true, updated, removed, kept, conflicts };
}

/**
 * Answer one conflicted scene. Keeping the local copy does not write anything
 * — it records that the remote sha has been seen and rejected, so the next
 * push overwrites it deliberately rather than tripping the same conflict
 * again. Taking the remote's copy overwrites the file, which is why it is the
 * one resolution that has to be asked for explicitly.
 */
async function resolveScene(project, binding, token, body) {
  const input = objectBody(body, "a resolution");
  if (typeof input.scene !== "string") {
    throw bad("body is not a resolution — name the scene to resolve");
  }
  const scene = checkScenePath(input.scene);
  const resolution = input.resolution;
  if (resolution !== "keep-local" && resolution !== "take-remote") {
    throw bad('invalid resolution — use "keep-local" or "take-remote"');
  }
  const bases = await readSync(project);
  const base = bases.get(scene);
  if (!base || base.conflictSha === null) {
    throw bad(`scene is not conflicted: ${project}/${scene}`);
  }
  if (resolution === "keep-local") {
    // The recorded base becomes the remote's version, so the "before" copy
    // follows it: a review after this shows the local work against what the
    // push will overwrite.
    if (base.conflictSha === "") await removeBase(project, scene);
    else await writeBase(project, scene, await githubBlob(binding, token, base.conflictSha));
    bases.set(scene, {
      baseSha: base.conflictSha,
      baseHash: base.baseHash,
      conflictSha: null,
    });
  } else if (base.conflictSha === "") {
    // The remote deleted it and the author accepts that, so the local file
    // goes too and the scene stops being tracked.
    await removeWorkingFile(project, scene);
    await removeBase(project, scene);
    bases.delete(scene);
  } else {
    const text = await githubBlob(binding, token, base.conflictSha);
    await writeWorkingFile(project, scene, text);
    await writeBase(project, scene, text);
    bases.set(scene, {
      baseSha: base.conflictSha,
      baseHash: sha256(text),
      conflictSha: null,
    });
  }
  await writeSync(project, bases);
  return { ok: true, scene, resolution };
}

/**
 * Land every local change on the branch as **one** commit, built through the
 * Git Data API: a blob per changed scene, one tree over the head's tree with
 * deletions as null-sha entries, one commit, and a non-force ref update. One
 * commit rather than one per scene because a drawing session is one change to
 * a reader of the repository's history, and because a half-applied push is not
 * a state anyone should have to reason about.
 */
/**
 * What a push may carry beside the scenes: a changelog for the commit
 * message (D46) and attachments — files written into the same commit at
 * paths relative to the bound path, null content meaning "remove" (D49's
 * semantic sidecars). Paths are one flat name: no separators, no dots
 * leading, no traversal.
 */
const ATTACHMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,120}$/;
function parsePushBody(body) {
  if (!body || !body.trim()) return { message: "", attachments: [] };
  const input = objectBody(body, "a push");
  const message = typeof input.message === "string" ? input.message.trim().slice(0, 4000) : "";
  const attachments = [];
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) throw bad("attachments must be a list");
    for (const item of input.attachments) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.path !== "string" ||
        !ATTACHMENT_RE.test(item.path) ||
        item.path.endsWith(EXT) ||
        (item.content !== null && typeof item.content !== "string")
      ) {
        throw bad("invalid attachment — a flat file name and string or null content");
      }
      attachments.push({ path: item.path, content: item.content });
    }
  }
  return { message, attachments };
}

async function pushProject(project, binding, token, body = "") {
  const { message, attachments } = parsePushBody(body);
  // The trunk is protected (D33): through Docent the base branch only ever
  // changes by a pull request someone merged. Checked before anything else,
  // because it is a fact about the branch rather than about the changes —
  // saving stays local and unblocked either way.
  if (binding.branch === baseBranchOf(binding)) {
    throw new HttpError(409, BASE_BRANCH_ERROR);
  }
  const bases = await readSync(project);
  const copy = await workingCopy(project);
  const conflicted = [];
  const changed = [];
  const deleted = [];
  for (const name of sceneNames(copy, bases)) {
    const state = sceneState(copy.get(name), bases.get(name) ?? null);
    if (state === "conflicted") conflicted.push(name);
    else if (state === "new" || state === "modified") changed.push(name);
    else if (state === "deleted") deleted.push(name);
  }
  // Pushing over an unanswered question would silently pick a side, which is
  // exactly what D29 forbids.
  if (conflicted.length > 0) throw new HttpError(409, unresolvedError(conflicted));
  if (changed.length === 0 && deleted.length === 0) {
    throw bad("nothing to push");
  }

  // The branch may have moved since the last pull. Everything this push
  // would write or delete is checked against what the last synchronization
  // recorded — a scene someone else changed meanwhile must be pulled and
  // answered (D29), never silently overwritten. Scenes this push does not
  // touch are the base tree's business and ride through unchanged, so
  // unrelated remote work never blocks a push.
  const remote = await remoteListing(project, binding, token);
  const movedScenes = [...changed, ...deleted].filter((name) => {
    const base = bases.get(name)?.baseSha ?? null;
    return (remote.get(name) ?? null) !== base;
  });
  if (movedScenes.length > 0) throw new HttpError(409, MOVED_ERROR);

  // Read the branch before creating anything: a push at a branch that is not
  // there costs no objects at all.
  const head = await githubHead(binding, token);
  const entries = [];
  const written = [];
  for (const name of changed) {
    const text = await fs.readFile(scenePath(project, name), "utf8");
    const sha = await githubCreate(binding, token, "/git/blobs", {
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    });
    written.push({ name, sha, hash: sha256(text), text });
    entries.push({ path: repoFile(binding, name), mode: "100644", type: "blob", sha });
  }
  for (const name of deleted) {
    // A null sha in a tree entry is how the Git Data API spells "remove this
    // path from the base tree".
    entries.push({ path: repoFile(binding, name), mode: "100644", type: "blob", sha: null });
  }
  for (const attachment of attachments) {
    const filePath =
      binding.path === "" ? attachment.path : `${binding.path}/${attachment.path}`;
    if (attachment.content === null) {
      entries.push({ path: filePath, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const sha = await githubCreate(binding, token, "/git/blobs", {
      content: Buffer.from(attachment.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    entries.push({ path: filePath, mode: "100644", type: "blob", sha });
  }
  const tree = await githubCreate(binding, token, "/git/trees", {
    base_tree: head.tree,
    tree: entries,
  });
  const total = changed.length + deleted.length;
  const commit = await githubCreate(binding, token, "/git/commits", {
    message:
      `docent: update ${project} (${total} scene(s))` + (message ? `\n\n${message}` : ""),
    tree,
    parents: [head.commit],
  });
  await githubUpdateRef(binding, token, commit);

  for (const scene of written) {
    await writeBase(project, scene.name, scene.text);
    bases.set(scene.name, { baseSha: scene.sha, baseHash: scene.hash, conflictSha: null });
  }
  for (const name of deleted) {
    await removeBase(project, name);
    bases.delete(name);
  }
  await writeSync(project, bases);
  listingCache.delete(project);
  return { ok: true, commit, pushed: changed, removedRemotely: deleted };
}

/**
 * The review pictures (D49): before/after crops for one push, committed to
 * the quarantined `docent-review` branch under `<label>/…` — an orphan
 * branch that is never merged and is pruned here to the last 90 days by
 * the date its labels start with. The working branch is never touched.
 */
const REVIEW_BRANCH = "docent-review";
const REVIEW_KEEP_DAYS = 90;
const REVIEW_LABEL_RE = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]{1,40}$/;
const REVIEW_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,200}\.png$/;
async function pushReviewImages(project, binding, token, body) {
  const input = objectBody(body, "review images");
  if (typeof input.label !== "string" || !REVIEW_LABEL_RE.test(input.label)) {
    throw bad("invalid label — YYYY-MM-DD-<id>");
  }
  if (!Array.isArray(input.images) || input.images.length === 0) {
    throw bad("images must be a non-empty list of {path, base64}");
  }
  for (const image of input.images) {
    if (
      typeof image !== "object" ||
      image === null ||
      typeof image.path !== "string" ||
      !REVIEW_PATH_RE.test(image.path) ||
      image.path.includes("..") ||
      typeof image.base64 !== "string"
    ) {
      throw bad("invalid image — a relative .png path and base64 content");
    }
  }
  const heads = `/git/ref/heads/${REVIEW_BRANCH}`;
  const existing = await github(token, "GET", repoUrl(binding, heads));
  let parent = null;
  let baseTree = null;
  if (existing.status === 200) {
    parent = parseJson(existing.text)?.object?.sha ?? null;
    if (parent) {
      const commitRes = await github(token, "GET", repoUrl(binding, `/git/commits/${parent}`));
      if (commitRes.status === 200) baseTree = parseJson(commitRes.text)?.tree?.sha ?? null;
    }
  } else if (existing.status !== 404) {
    throw githubFailure(existing.status, existing.text);
  }
  const entries = [];
  for (const image of input.images) {
    const sha = await githubCreate(binding, token, "/git/blobs", {
      content: image.base64,
      encoding: "base64",
    });
    entries.push({ path: `${input.label}/${image.path}`, mode: "100644", type: "blob", sha });
  }
  let pruned = 0;
  if (baseTree) {
    const listed = await github(token, "GET", repoUrl(binding, `/git/trees/${baseTree}?recursive=1`));
    if (listed.status === 200) {
      const cutoff = Date.now() - REVIEW_KEEP_DAYS * 86_400_000;
      for (const entry of parseJson(listed.text)?.tree ?? []) {
        if (entry.type !== "blob" || typeof entry.path !== "string") continue;
        const stamp = entry.path.slice(0, 10);
        const when = Date.parse(stamp);
        if (/^\d{4}-\d{2}-\d{2}$/.test(stamp) && Number.isFinite(when) && when < cutoff) {
          entries.push({ path: entry.path, mode: "100644", type: "blob", sha: null });
          pruned += 1;
        }
      }
    }
  }
  const tree = await githubCreate(binding, token, "/git/trees", {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries,
  });
  const commit = await githubCreate(binding, token, "/git/commits", {
    message: `docent review ${input.label}`,
    tree,
    parents: parent ? [parent] : [],
  });
  const refUrl = parent
    ? repoUrl(binding, `/git/refs/heads/${REVIEW_BRANCH}`)
    : repoUrl(binding, "/git/refs");
  const res = await github(token, parent ? "PATCH" : "POST", refUrl, {
    body: JSON.stringify(
      parent ? { sha: commit, force: false } : { ref: `refs/heads/${REVIEW_BRANCH}`, sha: commit },
    ),
  });
  if (res.status < 200 || res.status >= 300) throw githubWriteFailure(binding, res.status, res.text);
  return { ok: true, branch: REVIEW_BRANCH, label: input.label, commit, pruned };
}

/**
 * Where this project stands, in one answer: what the working copy did, and
 * what the branch did. The local half never touches the network — it is file
 * hashes against recorded ones — so a project with no token, or a machine with
 * no route to GitHub, still gets the truth about its own scenes and a remote
 * half that says plainly it could not be reached.
 */
async function syncStatus(project) {
  const binding = await bindingFor(project);
  if (!binding) {
    throw new HttpError(404, `no GitHub binding for project: ${project}`);
  }
  const local = await localStates(project);
  let remote = { reachable: false, changed: [], removed: [] };
  const token = await tokenFor(project);
  if (token !== null) {
    try {
      const listing = await remoteListing(project, binding, token);
      const bases = await readSync(project);
      const changed = [];
      const removed = [];
      for (const [name, sha] of listing) {
        const base = bases.get(name);
        if (!base || base.baseSha !== sha) changed.push(name);
      }
      for (const [name, base] of bases) {
        if (base.baseSha !== "" && !listing.has(name)) removed.push(name);
      }
      remote = {
        reachable: true,
        changed: changed.sort(byName),
        removed: removed.sort(byName),
      };
    } catch {
      // Unreachable, refused, rate-limited: the local half is still true, and
      // saying so beats failing the whole answer.
      remote = { reachable: false, changed: [], removed: [] };
    }
  }
  return {
    branch: binding.branch,
    baseBranch: baseBranchOf(binding),
    local,
    remote,
  };
}

/**
 * Resolve a bound project to everything a GitHub call needs — every route that
 * reaches the network starts here, and no other route does (D29). An unbound
 * project has no such route at all, and a binding with no token is refused
 * here rather than at GitHub, so the answer is the same 401 either way and no
 * pointless request leaves the machine.
 */
async function boundOrFail(project) {
  const binding = await bindingFor(project);
  if (!binding) throw new HttpError(404, `no GitHub binding for project: ${project}`);
  const token = await tokenFor(project);
  if (!token) throw new HttpError(401, TOKEN_ERROR);
  return { binding, token };
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
    // Recursively: a scene in a folder is a scene of this project (D92).
    const scenes = await sceneFiles(path.join(DATA_DIR, entry.name));
    let updatedAt = 0;
    for (const file of scenes.values()) {
      const st = await fs.stat(file);
      updatedAt = Math.max(updatedAt, st.mtimeMs);
    }
    // A bound project counts its working copy exactly like any other (D29):
    // the count is a directory read, never a network call, and it is true
    // whether or not GitHub can be reached. What the last probe learned about
    // the token travels with it so the modal can mark a read-only project
    // without a request per project.
    const binding = bindings[entry.name];
    const canWrite = binding?.canWrite;
    projects.push({
      id: entry.name,
      scenes: scenes.size,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      ...(binding ? { bound: true } : {}),
      ...(binding && typeof canWrite === "boolean" ? { canWrite } : {}),
    });
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A project's scenes: every scene under its directory, at the path it lives
 * at (D92), folders first. A binding changes where those files came from and
 * where they will go, never how they are read (D29).
 */
async function listScenes(project) {
  const dir = projectDir(project);
  try {
    await fs.readdir(dir);
  } catch {
    throw new HttpError(404, `no such project: ${project}`);
  }
  const scenes = [];
  for (const [name, file] of await sceneFiles(dir)) {
    const st = await fs.stat(file);
    scenes.push({
      name,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      size: st.size,
    });
  }
  return scenes.sort((a, b) => byScenePath(a.name, b.name));
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
  // parts: ["api", "projects", :project?, ("scenes"|"binding"|…)?, :scene?]
  // …where :scene is the whole scene path, URL-encoded into one segment, so
  // decoding hands it back with its slashes intact (D92).
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
      // Deleting a bound project unbinds it and removes the working copy and
      // its sync state. Nothing on GitHub is touched — the repository is the
      // user's, and a portfolio operation must never reach into it
      // destructively.
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

  // The sync verbs (S14, D29). `sync-status` needs no token: its local half is
  // the whole point, and a project whose credential is gone still has to be
  // able to say what its own files did.
  if (parts.length === 4 && parts[3] === "sync-status" && req.method === "GET") {
    return syncStatus(checkName(parts[2], "project"));
  }

  if (parts.length === 4 && parts[3] === "pull" && req.method === "POST") {
    const project = checkName(parts[2], "project");
    const bound = await boundOrFail(project);
    return pullProject(project, bound.binding, bound.token);
  }

  if (
    parts.length === 5 &&
    parts[3] === "pull" &&
    parts[4] === "resolve" &&
    req.method === "POST"
  ) {
    const project = checkName(parts[2], "project");
    const bound = await boundOrFail(project);
    return resolveScene(project, bound.binding, bound.token, await readBody(req));
  }

  if (parts.length === 4 && parts[3] === "push" && req.method === "POST") {
    const project = checkName(parts[2], "project");
    const bound = await boundOrFail(project);
    return pushProject(project, bound.binding, bound.token, await readBody(req));
  }

  // The review pictures (D49): pushed to the quarantined `docent-review`
  // branch, never the working branch.
  if (parts.length === 4 && parts[3] === "review-images" && req.method === "POST") {
    const project = checkName(parts[2], "project");
    const bound = await boundOrFail(project);
    return pushReviewImages(project, bound.binding, bound.token, await readBody(req));
  }

  // The "before" copy of a scene (D47): what the recorded base sha says.
  if (parts.length === 6 && parts[3] === "scenes" && parts[5] === "base" && req.method === "GET") {
    const project = checkName(parts[2], "project");
    const scene = checkScenePath(parts[4]);
    const text = await readBase(project, scene);
    if (text === null) {
      throw new HttpError(404, `no base copy yet for ${project}/${scene} — pull or push first`);
    }
    return { raw: text };
  }

  if (parts.length === 4 && parts[3] === "scenes" && req.method === "GET") {
    return listScenes(parts[2]);
  }

  // Scene CRUD is the same code for every project (D29): a bound project's
  // directory is its working copy, so opening and saving are file operations
  // that never wait on — or even reach — the network.
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
      try {
        await fs.access(projectDir(project));
      } catch {
        throw new HttpError(404, `no such project: ${project}`);
      }
      // The folders in a scene's path exist because the scene does (D92).
      await fs.mkdir(path.dirname(file), { recursive: true });
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
      // The folders it was the last scene in go with it — never the project.
      await pruneEmptyDirs(projectDir(project), path.dirname(file));
      return { ok: true };
    }
  }

  throw new HttpError(404, "not found");
}

const server = http.createServer(async (req, res) => {
  try {
    const result = await handle(req, res);
    // A scene answers with its own bytes rather than a JSON envelope: it is
    // already a JSON document, and re-encoding it would change them.
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
