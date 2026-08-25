/**
 * The portfolio's tree (D92, D93): a scene's name is a path, so a project's
 * flat listing is already a tree of folders that exist because scenes are in
 * them. These are the pure parts of the modal — the shape it renders, the
 * rule it checks a typed path against — read without a DOM or a store.
 */
import { describe, expect, it } from "vitest";
import {
  buildSceneTree,
  displayPath,
  folderOf,
  folderPaths,
  isFolderPath,
  isScenePath,
  joinPath,
  leafOf,
  MAX_SEGMENTS,
  normalizeScenePath,
  scenesUnder,
  SCENE_PATH_ERROR,
  type FolderNode,
} from "../src/portfolio/tree";
import type { SceneInfo } from "../src/portfolio/client";

const scene = (name: string, updatedAt: string | null = null): SceneInfo => ({
  name,
  updatedAt,
  size: 128,
});

const folder = (node: FolderNode, path: string): FolderNode => {
  const found = folderPaths(node);
  expect(found).toContain(path);
  const walk = (at: FolderNode): FolderNode | null => {
    for (const child of at.children) {
      if (child.kind !== "folder") continue;
      if (child.path === path) return child;
      const deeper = walk(child);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(node)!;
};

const names = (node: FolderNode) => node.children.map((child) => child.path);

describe("scene paths (D92)", () => {
  it("takes one to eight segments of the store's name rule", () => {
    expect(isScenePath("checkout")).toBe(true);
    expect(isScenePath("payments/flows/checkout")).toBe(true);
    expect(isScenePath("a/b/c/d/e/f/g/h")).toBe(true);
    expect(isScenePath("a/b/c/d/e/f/g/h/i")).toBe(false);
    expect(isScenePath("")).toBe(false);
    expect(isScenePath("payments//checkout")).toBe(false);
    expect(isScenePath("payments/")).toBe(false);
  });

  it("holds every segment to the one name rule, leading symbol included", () => {
    expect(isScenePath("Order flows/Step 1")).toBe(true);
    expect(isScenePath("payments/-checkout")).toBe(false);
    expect(isScenePath("payments/check.out")).toBe(false);
    expect(isScenePath(`payments/${"c".repeat(64)}`)).toBe(true);
    expect(isScenePath(`payments/${"c".repeat(65)}`)).toBe(false);
  });

  it("reserves .docent at every level, by the rule it already had", () => {
    expect(isScenePath(".docent")).toBe(false);
    expect(isScenePath("payments/.docent/checkout")).toBe(false);
  });

  it("says what the store says, before the round trip", () => {
    expect(SCENE_PATH_ERROR).toContain("invalid scene path");
    expect(SCENE_PATH_ERROR).toContain("no leading symbol");
  });

  it("keeps a folder one segment shallower — the name still has to fit", () => {
    expect(isFolderPath("")).toBe(true);
    expect(isFolderPath("payments")).toBe(true);
    expect(isFolderPath("a/b/c/d/e/f/g")).toBe(true);
    expect(isFolderPath("a/b/c/d/e/f/g/h")).toBe(false);
    expect(MAX_SEGMENTS).toBe(8);
  });

  it("reads what was typed as a path, extension and stray spaces aside", () => {
    expect(normalizeScenePath("  payments / checkout  ")).toBe("payments/checkout");
    expect(normalizeScenePath("payments/checkout.excalidraw")).toBe("payments/checkout");
    expect(normalizeScenePath("/payments//checkout/")).toBe("payments/checkout");
    expect(normalizeScenePath("   ")).toBe("");
  });

  it("splits and joins a path the same way round", () => {
    expect(folderOf("payments/flows/checkout")).toBe("payments/flows");
    expect(folderOf("checkout")).toBe("");
    expect(leafOf("payments/flows/checkout")).toBe("checkout");
    expect(leafOf("checkout")).toBe("checkout");
    expect(joinPath("payments", "checkout")).toBe("payments/checkout");
    expect(joinPath("", "checkout")).toBe("checkout");
  });

  it("shows a path as a trail rather than a file name", () => {
    expect(displayPath("payments/flows/checkout")).toBe("payments / flows / checkout");
    expect(displayPath("checkout")).toBe("checkout");
  });
});

describe("the tree the portfolio browses (D93)", () => {
  it("leaves a flat listing flat — every scene at the project's root", () => {
    const tree = buildSceneTree([scene("auth"), scene("payments")]);
    expect(names(tree)).toEqual(["auth", "payments"]);
    expect(folderPaths(tree)).toEqual([]);
    expect(tree.scenes).toBe(2);
  });

  it("makes a folder out of every prefix the scenes share", () => {
    const tree = buildSceneTree([
      scene("payments/flows/checkout"),
      scene("payments/flows/refund"),
      scene("payments/overview"),
      scene("readme"),
    ]);
    expect(folderPaths(tree)).toEqual(["payments", "payments/flows"]);
    const payments = folder(tree, "payments");
    expect(payments.name).toBe("payments");
    expect(names(payments)).toEqual(["payments/flows", "payments/overview"]);
    expect(names(folder(tree, "payments/flows"))).toEqual([
      "payments/flows/checkout",
      "payments/flows/refund",
    ]);
  });

  it("counts every scene under a folder, however deep", () => {
    const tree = buildSceneTree([
      scene("payments/flows/checkout"),
      scene("payments/flows/refund"),
      scene("payments/overview"),
      scene("readme"),
    ]);
    expect(tree.scenes).toBe(4);
    expect(folder(tree, "payments").scenes).toBe(3);
    expect(folder(tree, "payments/flows").scenes).toBe(2);
  });

  it("puts folders first and keeps the store's order inside each group", () => {
    const tree = buildSceneTree([
      scene("zeta"),
      scene("alpha/one"),
      scene("beta"),
      scene("omega/two"),
    ]);
    expect(names(tree)).toEqual(["alpha", "omega", "zeta", "beta"]);
  });

  it("shows a scene by its last segment, the folder giving the context", () => {
    const tree = buildSceneTree([scene("payments/flows/checkout")]);
    const [node] = scenesUnder(tree);
    expect(node.path).toBe("payments/flows/checkout");
    expect(node.name).toBe("checkout");
    expect(node.info.size).toBe(128);
  });

  it("carries a staged folder that holds nothing, and marks it as such", () => {
    const tree = buildSceneTree([scene("payments/checkout")], ["payments/drafts", "ideas"]);
    expect(folderPaths(tree)).toEqual(["payments", "payments/drafts", "ideas"]);
    expect(folder(tree, "payments/drafts").staged).toBe(true);
    expect(folder(tree, "payments/drafts").scenes).toBe(0);
    // The folder its scenes are in was never staging.
    expect(folder(tree, "payments").staged).toBe(false);
    expect(tree.staged).toBe(false);
  });

  it("stops staging a folder the moment a scene lands in it", () => {
    const tree = buildSceneTree([scene("ideas/sketch")], ["ideas"]);
    expect(folder(tree, "ideas").staged).toBe(false);
    expect(folder(tree, "ideas").scenes).toBe(1);
    expect(folderPaths(tree)).toEqual(["ideas"]);
  });

  it("lists what deleting a folder would delete, depth first", () => {
    const tree = buildSceneTree([
      scene("payments/flows/checkout"),
      scene("payments/overview"),
      scene("elsewhere"),
    ]);
    expect(scenesUnder(folder(tree, "payments")).map((s) => s.path)).toEqual([
      "payments/flows/checkout",
      "payments/overview",
    ]);
    expect(scenesUnder(tree)).toHaveLength(3);
  });
});
