/**
 * What a push carries and what the pull request says (D46, D49).
 */
import { describe, expect, it } from "vitest";
import {
  imagePath,
  labelFor,
  projectChangelog,
  pullRequestBody,
  pushExtrasFor,
  reviewImageUrl,
  type SceneReview,
} from "../src/review/session";
import { planReview } from "../src/review/plan";
import { snapshotFromRawElements } from "../src/adapter/snapshot";

const binding = { owner: "acme", repo: "diagrams", apiBase: "https://api.github.com" };

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, opacity: 100, groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const box = (id: string, label: string) => [
  { ...base, id, type: "rectangle", x: 0, y: 0, width: 100, height: 50, boundElements: [{ id: `${id}_t`, type: "text" }] },
  { ...base, id: `${id}_t`, type: "text", x: 10, y: 10, width: 80, height: 20, text: label, containerId: id },
];
const sceneJSON = (elements: unknown[]) => JSON.stringify({ type: "excalidraw", version: 2, elements });

const review = (scene: string, before: unknown[] | null, after: unknown[] | null): SceneReview => ({
  scene,
  state: before === null ? "new" : after === null ? "deleted" : "modified",
  before: before ? sceneJSON(before) : null,
  after: after ? sceneJSON(after) : null,
  plan: planReview(
    before ? snapshotFromRawElements(before as never) : null,
    after ? snapshotFromRawElements(after as never) : null,
  ),
});

describe("review session (D46, D49)", () => {
  it("prefixes the changelog with the scene only when several scenes changed", () => {
    const one = review("plan", [], box("a", "Orders"));
    expect(projectChangelog([one])).toBe("Layer 1: +Orders");
    const two = review("flow", box("b", "Legacy"), []);
    expect(projectChangelog([one, two])).toBe("plan / Layer 1: +Orders\nflow / Layer 1: −Legacy");
  });

  it("attaches sidecars only when the binding asked, and removes one with a deleted scene", () => {
    const added = review("plan", [], box("a", "Orders"));
    const gone = review("old", box("b", "Legacy"), null);
    const off = pushExtrasFor([added, gone], { review: { images: false, sidecars: false } } as never);
    expect(off.attachments).toBeUndefined();
    expect(off.message).toContain("+Orders");
    const on = pushExtrasFor([added, gone], { review: { images: false, sidecars: true } } as never);
    expect(on.attachments?.map((a) => a.path)).toEqual(["plan.docent.json", "old.docent.json"]);
    expect(on.attachments?.[1].content).toBeNull();
    expect(JSON.parse(on.attachments?.[0].content ?? "{}")).toHaveProperty("nodes");
  });

  it("names pictures and their raw URLs deterministically", () => {
    expect(labelFor("abc1234def", new Date("2026-08-22T10:00:00Z"))).toBe("2026-08-22-abc1234");
    expect(imagePath("plan", { frameName: "Core Services", key: "F" }, "before")).toBe("plan/Core Services-before.png");
    expect(imagePath("plan", { frameName: "", key: "layer-1" }, "after")).toBe("plan/layer-1-after.png");
    expect(reviewImageUrl(binding, "2026-08-22-abc1234", "plan/Core Services-before.png")).toBe(
      "https://github.com/acme/diagrams/blob/docent-review/2026-08-22-abc1234/plan/Core%20Services-before.png?raw=true",
    );
    expect(reviewImageUrl({ ...binding, apiBase: "https://ghe.example.com/api/v3" }, "l", "a/b.png")).toBe(
      "https://ghe.example.com/acme/diagrams/blob/docent-review/l/a/b.png?raw=true",
    );
  });

  it("writes the pull request body from the remembered pushes", () => {
    expect(pullRequestBody(binding, [])).toBe("");
    const body = pullRequestBody(binding, [
      { commit: "abc1234def", changelog: "Core Services: +Retry queue", label: null, pictures: [] },
      {
        commit: "fed4321abc",
        changelog: "Core Services: −Legacy sync",
        label: "2026-08-22-fed4321",
        pictures: [{ scene: "plan", frameName: "Core Services", before: "plan/Core Services-before.png", after: "plan/Core Services-after.png" }],
      },
    ]);
    expect(body).toContain("**abc1234**\n- Core Services: +Retry queue");
    expect(body).toContain("| plan / Core Services (fed4321) | ![before](https://github.com/acme/diagrams/blob/docent-review/2026-08-22-fed4321/plan/Core%20Services-before.png?raw=true) | ![after](");
    expect(body).toContain("docent-review");
  });
});
