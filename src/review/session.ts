/**
 * The review of a bound project (S16): every scene the working copy
 * changed since the last sync, each diffed against its base copy (D47)
 * into a plan (D48); what a push carries for it (D46, D49); and what the
 * pull request says afterwards. Fetching goes through the portfolio
 * client; everything else here is pure and tested.
 */
import { snapshotFromSceneJSON } from "../adapter/snapshot";
import { exportScene } from "../export";
import {
  loadBase,
  loadScene,
  syncStatus,
  type Binding,
  type PushExtras,
  type SceneSyncState,
} from "../portfolio/client";
import { planReview, type ReviewCrop, type ReviewPlan } from "./plan";

export type ChangedState = Extract<SceneSyncState, "new" | "modified" | "deleted">;

export interface SceneReview {
  scene: string;
  state: ChangedState;
  /** The base copy, or null for a scene the branch never had. */
  before: string | null;
  /** The working copy, or null for a deleted scene. */
  after: string | null;
  plan: ReviewPlan;
}

const isChanged = (state: SceneSyncState): state is ChangedState =>
  state === "new" || state === "modified" || state === "deleted";

/** Review every changed scene of the project. Scenes whose diff is empty are left out. */
export async function reviewProject(project: string): Promise<SceneReview[]> {
  const status = await syncStatus(project);
  const reviews: SceneReview[] = [];
  for (const entry of status.local) {
    if (!isChanged(entry.state)) continue;
    const [before, after] = await Promise.all([
      loadBase(project, entry.name),
      entry.state === "deleted" ? Promise.resolve(null) : loadScene(project, entry.name),
    ]);
    const plan = planReview(
      before ? snapshotFromSceneJSON(before) : null,
      after ? snapshotFromSceneJSON(after) : null,
    );
    if (plan.diff.empty) continue;
    reviews.push({ scene: entry.name, state: entry.state, before, after, plan });
  }
  return reviews;
}

/**
 * The project's changelog for one push: each scene's changelog, prefixed
 * with the scene's name when more than one scene changed.
 */
export function projectChangelog(reviews: readonly SceneReview[]): string {
  const named = reviews.filter((r) => r.plan.changelog);
  if (named.length === 0) return "";
  if (named.length === 1) return named[0].plan.changelog;
  return named
    .map((r) =>
      r.plan.changelog
        .split("\n")
        .map((line) => `${r.scene} / ${line}`)
        .join("\n"),
    )
    .join("\n");
}

/**
 * What the push sends beside the scenes: the changelog, and — when the
 * binding asked for sidecars (D49) — `<scene>.docent.json` for every
 * changed scene, removed with a deleted one.
 */
export function pushExtrasFor(reviews: readonly SceneReview[], binding: Binding | null): PushExtras {
  const extras: PushExtras = {};
  const message = projectChangelog(reviews);
  if (message) extras.message = message;
  if (binding?.review.sidecars) {
    extras.attachments = reviews.map((r) => ({
      path: `${r.scene}.docent.json`,
      content: r.after ? exportScene(snapshotFromSceneJSON(r.after)).sidecar : null,
    }));
  }
  return extras;
}

// ---------------------------------------------------------------------------
// pictures on the review branch, and the pull request that shows them (D49)
// ---------------------------------------------------------------------------

export const REVIEW_BRANCH = "docent-review";

/** `YYYY-MM-DD-<sha7>`: the label a push's pictures live under. */
export function labelFor(commit: string, when: Date): string {
  const stamp = when.toISOString().slice(0, 10);
  return `${stamp}-${commit.slice(0, 7)}`;
}

const slug = (text: string) =>
  text
    .replace(/[^A-Za-z0-9 _.-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "frame";

/** Where a crop's picture goes under the label: `<scene>/<frame>-<side>.png`. */
export function imagePath(scene: string, crop: Pick<ReviewCrop, "frameName" | "key">, side: "before" | "after"): string {
  const frame = crop.frameName ? slug(crop.frameName) : slug(crop.key);
  return `${slug(scene)}/${frame}-${side}.png`;
}

/**
 * The URL a PR body embeds for a picture on the review branch. The
 * `blob/…?raw=true` form is served by the GitHub host itself, through
 * the reader's own session — so it renders in private repositories too,
 * where `raw.githubusercontent.com` would not; and it is the same shape
 * on GitHub Enterprise.
 */
export function reviewImageUrl(binding: Pick<Binding, "owner" | "repo" | "apiBase">, label: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const api = binding.apiBase.replace(/\/+$/, "");
  const host =
    api === "https://api.github.com" || api === "" ? "https://github.com" : api.replace(/\/api\/v3$/, "");
  return `${host}/${binding.owner}/${binding.repo}/blob/${REVIEW_BRANCH}/${label}/${encoded}?raw=true`;
}

/** One pushed review, remembered for the pull request that follows. */
export interface PushedReview {
  commit: string;
  changelog: string;
  /** The label the pictures went under, or null when none were pushed. */
  label: string | null;
  pictures: { scene: string; frameName: string; before: string | null; after: string | null }[];
}

const pushes = new Map<string, PushedReview[]>();

export function rememberPush(project: string, pushed: PushedReview): void {
  const list = pushes.get(project) ?? [];
  list.push(pushed);
  pushes.set(project, list);
}

export function pushesOf(project: string): PushedReview[] {
  return pushes.get(project) ?? [];
}

export function forgetPushes(project: string): void {
  pushes.delete(project);
}

/**
 * The pull request body: every remembered push's changelog, newest last,
 * and — when pictures were pushed — a before/after table per frame. Empty
 * when nothing is remembered; the caller then leaves the body alone.
 */
export function pullRequestBody(
  binding: Pick<Binding, "owner" | "repo" | "apiBase">,
  pushed: readonly PushedReview[],
): string {
  const withWords = pushed.filter((p) => p.changelog || p.pictures.length);
  if (withWords.length === 0) return "";
  const parts: string[] = ["## Changes", ""];
  for (const push of withWords) {
    const lines = push.changelog ? push.changelog.split("\n") : ["(no semantic change — geometry or style only)"];
    parts.push(`**${push.commit.slice(0, 7)}**`);
    for (const line of lines) parts.push(`- ${line}`);
    parts.push("");
  }
  const pictured = withWords.filter((p) => p.label && p.pictures.length);
  if (pictured.length) {
    parts.push("## Review pictures", "", "| Frame | Before | After |", "|---|---|---|");
    for (const push of pictured) {
      for (const picture of push.pictures) {
        const cell = (path: string | null, alt: string) =>
          path ? `![${alt}](${reviewImageUrl(binding, push.label!, path)})` : "—";
        const name = `${picture.scene} / ${picture.frameName || "frame"}`;
        parts.push(`| ${name} (${push.commit.slice(0, 7)}) | ${cell(picture.before, "before")} | ${cell(picture.after, "after")} |`);
      }
    }
    parts.push("", `_Pictures live on the \`${REVIEW_BRANCH}\` branch, pruned after 90 days; they are never merged._`);
  }
  parts.push("", "_Reviewed with Docent._");
  return parts.join("\n");
}
