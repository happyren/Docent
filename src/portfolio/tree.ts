/**
 * The scene tree (D92, D93). A scene's name is a path — one to eight
 * slash-separated segments — so a project's listing is already a tree, and
 * this is the shape the portfolio browses it in. Everything here is pure:
 * the modal renders what these functions build, and the tests read them
 * without a canvas or a store.
 *
 * There is no folder record to read: a directory exists because scenes live
 * in it (D92), so the folders ARE the prefixes of the listed paths. A folder
 * the user has just made holds nothing yet, which is why it comes in as its
 * own argument — the store would never list one.
 */
import type { SceneInfo } from "./client";

/** One scene, at its place in the tree. */
export interface SceneNode {
  kind: "scene";
  /** The scene's whole path in the project — what every store call takes. */
  path: string;
  /** The last segment: what the card shows, the folder giving the context. */
  name: string;
  info: SceneInfo;
}

/** One folder, which is to say: one prefix that scenes were found under. */
export interface FolderNode {
  kind: "folder";
  /** The folder's path in the project; "" is the project root itself. */
  path: string;
  name: string;
  /** Folders first, then scenes — the store's order kept inside each group. */
  children: TreeNode[];
  /** Every scene under it, however deep: what the folder row counts. */
  scenes: number;
  /** Nothing in it yet, so it lives in the UI alone until a scene lands. */
  staged: boolean;
}

export type TreeNode = FolderNode | SceneNode;

/**
 * One rule per segment — the store's own name rule, unchanged (D92). The
 * leading-character half of it is also what reserves `.docent` at every
 * level: a segment may not start with a symbol, so it can never be typed.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/** How deep a scene path goes; a folder is one shallower, holding the name. */
export const MAX_SEGMENTS = 8;

/** The store's refusal, said here before the round trip rather than after. */
export const SCENE_PATH_ERROR =
  "invalid scene path — up to 8 folders of letters, digits, spaces, - or _ (max 64 each, no leading symbol)";

export const segmentsOf = (path: string): string[] => path.split("/");

/** The folder a scene sits in — "" at the project root. */
export const folderOf = (path: string): string =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The scene's own name: the last segment. */
export const leafOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** A folder and a leaf, the root being no folder at all. */
export const joinPath = (folder: string, name: string): string =>
  folder ? `${folder}/${name}` : name;

/** A path as people read it — "payments / checkout", not a file name. */
export const displayPath = (path: string): string =>
  segmentsOf(path).join(" / ");

/**
 * What was typed, as a path. Spaces are legal inside a segment but almost
 * never meant around a separator, and the store adds the extension itself —
 * so "Payments / Checkout.excalidraw" is a path, not a refusal.
 */
export function normalizeScenePath(input: string): string {
  return input
    .trim()
    .replace(/\.excalidraw$/i, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** Whether a scene may be stored at this path (D92). */
export function isScenePath(path: string): boolean {
  const segments = segmentsOf(path);
  return (
    path.length > 0 &&
    segments.length <= MAX_SEGMENTS &&
    segments.every((segment) => SEGMENT_RE.test(segment))
  );
}

/**
 * Whether a folder may hold a scene at this path: the same rule one segment
 * shallower, because the scene's own name is the segment that has to fit.
 * The project root ("") is always a place to put one.
 */
export function isFolderPath(path: string): boolean {
  return (
    path === "" ||
    (isScenePath(path) && segmentsOf(path).length < MAX_SEGMENTS)
  );
}

/**
 * The project's scenes as the tree they already are. `stagedFolders` are the
 * ones the user made in this session that hold nothing yet (D93) — they show
 * with the rest and disappear with the modal if no scene lands in them.
 */
export function buildSceneTree(
  scenes: readonly SceneInfo[],
  stagedFolders: readonly string[] = [],
): FolderNode {
  const root: FolderNode = {
    kind: "folder",
    path: "",
    name: "",
    children: [],
    scenes: 0,
    staged: false,
  };
  const folders = new Map<string, FolderNode>([["", root]]);

  /** The folder at this path, made — with its parents — when first named. */
  const folderAt = (path: string): FolderNode => {
    const found = folders.get(path);
    if (found) return found;
    const node: FolderNode = {
      kind: "folder",
      path,
      name: leafOf(path),
      children: [],
      scenes: 0,
      staged: false,
    };
    folders.set(path, node);
    folderAt(folderOf(path)).children.push(node);
    return node;
  };

  for (const info of scenes) {
    const folder = folderAt(folderOf(info.name));
    folder.children.push({
      kind: "scene",
      path: info.name,
      name: leafOf(info.name),
      info,
    });
    // The count a folder row shows is recursive, so every ancestor gains one.
    for (let at = folder.path; ; at = folderOf(at)) {
      const node = folders.get(at);
      if (node) node.scenes += 1;
      if (at === "") break;
    }
  }
  for (const path of stagedFolders) folderAt(path);

  for (const folder of folders.values()) {
    // Folders first at every level; the sort is stable, so the store's order
    // survives inside each group.
    folder.children.sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1,
    );
    // Empty is the only way a folder can be staging: the store lists no
    // directory that holds nothing (D92).
    folder.staged = folder.path !== "" && folder.scenes === 0;
  }
  return root;
}

/** Every folder in the tree, depth-first — the move picker's options. */
export function folderPaths(root: FolderNode): string[] {
  const out: string[] = [];
  const walk = (node: FolderNode) => {
    for (const child of node.children) {
      if (child.kind !== "folder") continue;
      out.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every scene under a folder, however deep — what deleting it deletes. */
export function scenesUnder(node: FolderNode): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (folder: FolderNode) => {
    for (const child of folder.children) {
      if (child.kind === "scene") out.push(child);
      else walk(child);
    }
  };
  walk(node);
  return out;
}
