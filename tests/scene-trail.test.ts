/**
 * D136: the title bar's breadcrumb readout. The trail is D92's own
 * segments — project first, folders between, scene last — extension
 * dropped, "Untitled" while nothing is addressed.
 */
import { describe, expect, it } from "vitest";
import { sceneTrail } from "../src/shell/scene-trail";

describe("sceneTrail (D136)", () => {
  it("splits a bound scene into project, folders, scene", () => {
    expect(sceneTrail("acme/payments/billing/checkout")).toEqual([
      "acme",
      "payments",
      "billing",
      "checkout",
    ]);
  });

  it("drops the extension a local file carries", () => {
    expect(sceneTrail("welcome.excalidraw")).toEqual(["welcome"]);
    expect(sceneTrail("Notes.EXCALIDRAW")).toEqual(["Notes"]);
  });

  it("reads Untitled while nothing is addressed", () => {
    expect(sceneTrail(null)).toEqual(["Untitled"]);
    expect(sceneTrail("")).toEqual(["Untitled"]);
    expect(sceneTrail(".excalidraw")).toEqual(["Untitled"]);
  });

  it("keeps a scene named like a path readable", () => {
    // D92 allows spaces inside segments; the trail keeps them.
    expect(sceneTrail("acme/event flows/order placed")).toEqual([
      "acme",
      "event flows",
      "order placed",
    ]);
  });
});
