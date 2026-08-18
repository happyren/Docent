import { describe, expect, it } from "vitest";
import {
  OVERVIEW,
  orderWaypoints,
  resolveWaypointTarget,
} from "../src/scene/waypoints";

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

  it("resolves any target to OVERVIEW when there are no waypoints", () => {
    // Regression: arrow keys while presenting a frameless scene crashed on
    // frames[0].id — Math.max(0, min(-1, target)) indexed an empty array.
    expect(resolveWaypointTarget(0, 0)).toBe(OVERVIEW);
    expect(resolveWaypointTarget(3, 0)).toBe(OVERVIEW);
    expect(resolveWaypointTarget(OVERVIEW, 0)).toBe(OVERVIEW);
  });

  it("clamps in-range and out-of-range targets", () => {
    expect(resolveWaypointTarget(1, 3)).toBe(1);
    expect(resolveWaypointTarget(9, 3)).toBe(2);
    expect(resolveWaypointTarget(OVERVIEW, 3)).toBe(OVERVIEW);
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
