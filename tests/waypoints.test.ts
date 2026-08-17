import { describe, expect, it } from "vitest";
import { orderWaypoints } from "../src/scene/waypoints";

const frame = (id: string, name: string, order: number | null = null) => ({
  id,
  name,
  order,
  narrative: null,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
});

describe("waypoint ordering (S2)", () => {
  it("sorts naturally by name", () => {
    const ordered = orderWaypoints([
      frame("c", "10 Edge"),
      frame("a", "02 Core"),
      frame("b", "01 Ingress"),
    ]);
    expect(ordered.map((f) => f.name)).toEqual([
      "01 Ingress",
      "02 Core",
      "10 Edge",
    ]);
  });

  it("declared order overrides name order", () => {
    const ordered = orderWaypoints([
      frame("a", "01 First", 2),
      frame("b", "02 Second", 1),
      frame("c", "03 Unordered"),
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["b", "a", "c"]);
  });
});
