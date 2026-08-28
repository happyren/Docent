/**
 * The house treatment (D120): scribble fills become solid, roughness and
 * stroke come down to the house's own, and every colour survives — the hue
 * is the brand and the brand is meaning.
 */
import { describe, expect, it } from "vitest";
import { houseTreatment, treatElement } from "../src/adapter/treatment";

describe("the house treatment (D120)", () => {
  it("retires the scribble fills", () => {
    for (const fillStyle of ["hachure", "cross-hatch", "zigzag"]) {
      expect(treatElement({ fillStyle }).fillStyle).toBe("solid");
    }
    expect(treatElement({ fillStyle: "solid" }).fillStyle).toBe("solid");
  });

  it("keeps every colour — the hue is the brand", () => {
    const el = {
      fillStyle: "hachure",
      strokeColor: "#fd7e14",
      backgroundColor: "#fd7e1488",
    };
    const dressed = treatElement(el);
    expect(dressed.strokeColor).toBe("#fd7e14");
    expect(dressed.backgroundColor).toBe("#fd7e1488");
  });

  it("clamps roughness and stroke to the house's own, never up", () => {
    expect(treatElement({ roughness: 2 }).roughness).toBe(1);
    expect(treatElement({ roughness: 0 }).roughness).toBe(0);
    expect(treatElement({ strokeWidth: 4 }).strokeWidth).toBe(2);
    expect(treatElement({ strokeWidth: 1 }).strokeWidth).toBe(1);
  });

  it("returns the same record when nothing changes", () => {
    const el = { fillStyle: "solid", roughness: 1, strokeWidth: 2, points: [[0, 0]] };
    expect(treatElement(el)).toBe(el);
  });

  it("dresses a whole drawing and leaves the rest of each element alone", () => {
    const drawing = [
      { fillStyle: "cross-hatch", strokeWidth: 3, x: 4, y: 8, type: "rectangle" },
      { fillStyle: "solid", roughness: 1, type: "ellipse" },
    ];
    const dressed = houseTreatment(drawing);
    expect(dressed[0]).toMatchObject({ fillStyle: "solid", strokeWidth: 2, x: 4, y: 8, type: "rectangle" });
    expect(dressed[1]).toBe(drawing[1]);
  });
});
