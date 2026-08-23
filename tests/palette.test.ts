/**
 * Colour means something (S20, D77): tones and roles pick the conventional
 * hue, a kind with neither takes the fill furthest from the legend's, a
 * second channel arrives once hue has run out, and a conventional tag
 * colours itself well enough that the export reads it back.
 */
import { describe, expect, it } from "vitest";
import type { LegendRule } from "../src/adapter/snapshot";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { applyLegend } from "../src/export/legend";
import { idSource, plan, simulate } from "../src/authoring/ops";
import {
  BASE_SET,
  ROLE_FAMILIES,
  TONE_LOOK,
  deltaE,
  kindColours,
  minKindDistance,
  pickKindLook,
  toneOfTag,
  type PickKindLookArgs,
  type Role,
} from "../src/authoring/palette";

/** A kind rule the way `define_kind` writes one, so the legend grows as it would. */
function define(legend: LegendRule[], kind: string, args: Partial<PickKindLookArgs> = {}): LegendRule[] {
  const look = pickKindLook({ kind, taken: legend, ...args });
  const also: { attr: LegendRule["attr"]; value: string }[] = [];
  if (look.shape) also.push({ attr: "shape", value: look.shape });
  also.push({ attr: "strokeColor", value: look.strokeColor });
  if (look.strokeStyle) also.push({ attr: "strokeStyle", value: look.strokeStyle });
  return [...legend, { attr: "backgroundColor", value: look.backgroundColor, key: "kind", meaning: kind, also }];
}

const condition = (rule: LegendRule, attr: LegendRule["attr"]): string =>
  [{ attr: rule.attr, value: rule.value }, ...(rule.also ?? [])].find((c) => c.attr === attr)?.value ?? "";

const leastFrom = (colour: string, taken: readonly string[]): number =>
  taken.reduce((least, other) => Math.min(least, deltaE(colour, other)), Infinity);

describe("CIELAB distance (D77)", () => {
  it("puts black a hundred from white and nothing from itself", () => {
    expect(deltaE("#ffffff", "#000000")).toBeCloseTo(100, 1);
    expect(deltaE("#a5d8ff", "#a5d8ff")).toBe(0);
    expect(deltaE("#A5D8FF", "#a5d8ff")).toBe(0);
    // Short hex reads the same as long, and a transparent fill reads as the
    // white the canvas shows through it.
    expect(deltaE("#fff", "#ffffff")).toBe(0);
    expect(deltaE("transparent", "#ffffff")).toBe(0);
    // Two hues a reader calls different are far apart; two greys are near.
    expect(deltaE("#a5d8ff", "#ffc9c9")).toBeGreaterThan(30);
    expect(deltaE("#e9ecef", "#f1f3f5")).toBeLessThan(5);
  });
});

describe("tones (D77)", () => {
  it("picks the hue the reader already believes", () => {
    const taken: LegendRule[] = [];
    expect(pickKindLook({ kind: "failure", tone: "danger", taken })).toMatchObject({
      backgroundColor: "#ffc9c9",
      strokeColor: "#e03131",
      channel: "hue",
      why: "danger tone → red",
    });
    expect(pickKindLook({ kind: "ok", tone: "positive", taken }).backgroundColor).toBe("#b2f2bb");
    expect(pickKindLook({ kind: "plain", tone: "neutral", taken }).backgroundColor).toBe("#e9ecef");
    expect(pickKindLook({ kind: "wip", tone: "caution", taken }).backgroundColor).toBe("#ffec99");
    for (const [tone, look] of Object.entries(TONE_LOOK)) {
      const picked = pickKindLook({ kind: tone, tone: tone as never, taken });
      expect(picked.backgroundColor).toBe(look.fill);
      expect(picked.strokeColor).toBe(look.stroke);
    }
  });

  it("dashes an inactive kind, because grey alone is not a statement", () => {
    const picked = pickKindLook({ kind: "old", tone: "inactive", taken: [] });
    expect(picked).toMatchObject({ backgroundColor: "#f1f3f5", strokeColor: "#868e96", strokeStyle: "dashed", channel: "hue+stroke" });
  });

  it("wins over a role when both are given", () => {
    const picked = pickKindLook({ kind: "dead letters", tone: "danger", role: "messaging", taken: [] });
    expect(picked.backgroundColor).toBe(TONE_LOOK.danger.fill);
  });
});

describe("roles (D77)", () => {
  it("picks inside the family, furthest from what the legend already spends", () => {
    for (const role of Object.keys(ROLE_FAMILIES) as Role[]) {
      const family = ROLE_FAMILIES[role];
      // The legend already draws the family's first member — and a hue from
      // somewhere else, so the choice is not vacuous.
      const legend: LegendRule[] = [
        { attr: "backgroundColor", value: family[0].fill === "transparent" ? family[0].stroke : family[0].fill, key: "kind", meaning: "first" },
        { attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" },
      ];
      const picked = pickKindLook({ kind: `a ${role}`, role, taken: legend });
      expect(family.map((s) => s.fill)).toContain(picked.backgroundColor);
      expect(family.map((s) => s.stroke)).toContain(picked.strokeColor);
      expect(picked.why.startsWith(`${role} family, `)).toBe(true);
      // No member of the family stands further from the legend than the pick.
      const taken = kindColours(legend);
      const colour = picked.backgroundColor === "transparent" ? picked.strokeColor : picked.backgroundColor;
      const best = leastFrom(colour, taken);
      for (const member of family) {
        expect(best).toBeGreaterThanOrEqual(leastFrom(member.fill === "transparent" ? member.stroke : member.fill, taken) - 1e-9);
      }
    }
  });

  it("draws a boundary as a dashed outline, not a filled thing", () => {
    const picked = pickKindLook({ kind: "trust boundary", role: "boundary", taken: [] });
    expect(picked.backgroundColor).toBe("transparent");
    expect(picked.strokeStyle).toBe("dashed");
  });
});

describe("distinctness (D77)", () => {
  it("takes the base fill furthest from every kind in the legend", () => {
    const legend: LegendRule[] = [
      { attr: "backgroundColor", value: "#a5d8ff", key: "kind", meaning: "datastore" },
      { attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" },
      // A tag rule is not a kind and does not constrain the choice.
      { attr: "strokeColor", value: "#e03131", key: "tag", meaning: "hot-path" },
    ];
    const picked = pickKindLook({ kind: "queue", taken: legend });
    const taken = kindColours(legend);
    expect(taken).toEqual(["#a5d8ff", "#ffec99"]);
    const best = leastFrom(picked.backgroundColor, taken);
    for (const swatch of BASE_SET) {
      expect(best).toBeGreaterThanOrEqual(leastFrom(swatch.fill, taken) - 1e-9);
    }
    expect(picked.channel).toBe("hue");
  });

  it("adds a second channel at the seventh kind, and says so", () => {
    let legend: LegendRule[] = [];
    for (let n = 1; n <= 6; n += 1) legend = define(legend, `kind${n}`);
    // Six is still hue alone.
    expect(legend.every((r) => condition(r, "strokeStyle") === "")).toBe(true);
    const seventh = pickKindLook({ kind: "kind7", taken: legend });
    expect(seventh.strokeStyle).toBe("dashed");
    expect(seventh.channel).toBe("hue+stroke");
    expect(seventh.why).toContain("7th kind → dashed stroke added");
    // And the one after reaches for the next distinct stroke style.
    const eighth = pickKindLook({ kind: "kind8", taken: define(legend, "kind7") });
    expect(eighth.strokeStyle).toBe("dotted");
    expect(eighth.why).toContain("8th kind → dotted stroke added");
    // Once stroke styles are spent, shape is what is left.
    const ninth = pickKindLook({ kind: "kind9", taken: define(define(legend, "kind7"), "kind8") });
    expect(ninth.channel).toBe("hue+shape");
    expect(ninth.shape).toBeDefined();
    expect(ninth.why).toContain("9th kind → ");
  });

  it("leaves no two of eight kinds alike in fill, stroke style, and shape", () => {
    let legend: LegendRule[] = [];
    for (let n = 1; n <= 8; n += 1) legend = define(legend, `kind${n}`);
    const signatures = legend.map((r) => `${r.value}|${condition(r, "strokeStyle") || "solid"}|${condition(r, "shape")}`);
    expect(new Set(signatures).size).toBe(8);
    // Hue alone would not have carried it: every pair is separated.
    expect(minKindDistance(legend)).toBeGreaterThan(0);
  });

  it("forces a second channel when a tone would draw two kinds alike", () => {
    const legend = define([], "outage", { tone: "danger" });
    const second = pickKindLook({ kind: "data loss", tone: "danger", taken: legend });
    expect(second.backgroundColor).toBe(TONE_LOOK.danger.fill);
    expect(second.channel).not.toBe("hue");
  });

  it("reports the legend's least colour distance for the craft score (D76)", () => {
    expect(minKindDistance([])).toBe(Infinity);
    const one: LegendRule[] = [{ attr: "backgroundColor", value: "#a5d8ff", key: "kind", meaning: "datastore" }];
    expect(minKindDistance(one)).toBe(Infinity);
    const two: LegendRule[] = [...one, { attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" }];
    expect(minKindDistance(two)).toBeCloseTo(deltaE("#a5d8ff", "#ffec99"), 6);
    const near: LegendRule[] = [...two, { attr: "backgroundColor", value: "#a5d8fe", key: "kind", meaning: "cache" }];
    expect(minKindDistance(near)).toBeLessThan(1);
  });

  it("picks the same look twice", () => {
    const legend: LegendRule[] = [{ attr: "backgroundColor", value: "#a5d8ff", key: "kind", meaning: "datastore" }];
    const args: PickKindLookArgs = { kind: "queue", role: "messaging", taken: legend };
    expect(pickKindLook(args)).toEqual(pickKindLook(args));
    let a: LegendRule[] = [];
    let b: LegendRule[] = [];
    for (let n = 1; n <= 9; n += 1) {
      a = define(a, `kind${n}`);
      b = define(b, `kind${n}`);
    }
    expect(a).toEqual(b);
  });
});

describe("tags that colour themselves (D77)", () => {
  it("knows the conventional names, and only those", () => {
    expect(toneOfTag("hot-path")).toBe("danger");
    expect(toneOfTag("hot path")).toBe("danger");
    expect(toneOfTag("HOT_PATH")).toBe("danger");
    expect(toneOfTag("critical")).toBe("danger");
    expect(toneOfTag("urgent")).toBe("danger");
    expect(toneOfTag("deprecated")).toBe("inactive");
    expect(toneOfTag("legacy")).toBe("inactive");
    expect(toneOfTag("retired")).toBe("inactive");
    expect(toneOfTag("draft")).toBe("caution");
    expect(toneOfTag("experimental")).toBe("caution");
    expect(toneOfTag("todo")).toBe("caution");
    expect(toneOfTag("healthy")).toBe("positive");
    expect(toneOfTag("ok")).toBe("positive");
    expect(toneOfTag("done")).toBe("positive");
    expect(toneOfTag("pass")).toBe("positive");
    expect(toneOfTag("orders")).toBe(null);
    expect(toneOfTag("")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// the round trip: a tagged component draws the tag, and the export reads it
// ---------------------------------------------------------------------------

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
  groupIds: [], frameId: null, isDeleted: false, locked: false,
};
const sceneLegend = [{ attr: "backgroundColor", value: "#ffec99", key: "kind", meaning: "service" }];
const raw = [
  { ...base, id: "F", type: "frame", name: "01 Core", x: 0, y: 0, width: 900, height: 400 },
  { ...base, id: "legend", type: "text", x: 0, y: -120, width: 200, height: 40, text: "Legend", locked: true, customData: { docent: { legend: sceneLegend } } },
  { ...base, id: "svc", type: "rectangle", x: 40, y: 100, width: 160, height: 80, frameId: "F", backgroundColor: "#ffec99", boundElements: [{ id: "svc_t", type: "text" }] },
  { ...base, id: "svc_t", type: "text", x: 50, y: 120, width: 140, height: 20, text: "Orders", containerId: "svc", frameId: "F", fontFamily: 5, fontSize: 20 },
];
const snapshot = snapshotFromRawElements(raw as never);

describe("a tagged component (D77)", () => {
  it("adds the tag's rule, wears its stroke, and exports as that tag", () => {
    const result = plan(
      [{ op: "add_node", label: "Payments", kind: "service", frame: "F", tags: ["hot-path"] }],
      snapshot,
      idSource(1),
    );
    const rule = result.write.legend!.find((r) => r.key === "tag" && r.meaning === "hot-path");
    expect(rule).toMatchObject({ attr: "strokeColor", value: "#e03131" });
    expect(result.write.shapes![0].style.strokeColor).toBe("#e03131");
    expect(result.write.shapes![0].meaning!.tags).toEqual(["hot-path"]);
    expect(result.notes).toContain("tag hot-path → red stroke (danger)");

    // The round trip: the scene the write would make reads the tag back off
    // the picture, and still reads the kind.
    const after = buildSceneGraph(simulate(snapshot, result.write));
    const node = after.nodes.find((n) => n.label === "Payments")!;
    const facts = applyLegend(node.style, node.shape, after.legend);
    expect(facts.tags).toContain("hot-path");
    expect(facts.kind).toBe("service");
  });

  it("dashes a deprecated component and leaves an unknown tag alone", () => {
    const result = plan(
      [
        { op: "add_node", ref: "$old", label: "Legacy billing", kind: "service", frame: "F", tags: ["deprecated"] },
        { op: "add_node", label: "Ledger", kind: "service", frame: "F", tags: ["orders"] },
      ],
      snapshot,
      idSource(1),
    );
    const rule = result.write.legend!.find((r) => r.key === "tag" && r.meaning === "deprecated")!;
    expect(rule).toMatchObject({ attr: "strokeColor", value: "#868e96" });
    expect(rule.also).toEqual([{ attr: "strokeStyle", value: "dashed" }]);
    expect(result.write.shapes![0].style).toMatchObject({ strokeColor: "#868e96", strokeStyle: "dashed" });
    // An invented tag means nothing to a reader, so it means nothing here.
    expect(result.write.legend!.some((r) => r.key === "tag" && r.meaning === "orders")).toBe(false);
    expect(result.write.shapes![1].style.strokeColor).toBe("#1e1e1e");

    const after = buildSceneGraph(simulate(snapshot, result.write));
    const node = after.nodes.find((n) => n.label === "Legacy billing")!;
    expect(applyLegend(node.style, node.shape, after.legend).tags).toContain("deprecated");
  });

  it("colours a tag added to a component that is already drawn", () => {
    const result = plan([{ op: "update", id: "svc", addTags: ["critical"] }], snapshot, idSource(1));
    const patch = result.write.patches!.find((p) => p.id === "svc")!;
    expect(patch.style!.strokeColor).toBe("#e03131");
    const after = buildSceneGraph(simulate(snapshot, result.write));
    const node = after.nodes.find((n) => n.label === "Orders")!;
    expect(applyLegend(node.style, node.shape, after.legend).tags).toContain("critical");
  });

  it("adds a kind's rule for its tone, and says why", () => {
    const result = plan([{ op: "define_kind", kind: "outage", tone: "danger" }], snapshot, idSource(1));
    const rule = result.write.legend!.find((r) => r.meaning === "outage")!;
    expect(rule.value).toBe("#ffc9c9");
    expect(rule.also).toContainEqual({ attr: "strokeColor", value: "#e03131" });
    expect(result.notes.some((n) => n.includes("danger tone → red"))).toBe(true);
    // A raw style is still the author's own.
    const raw2 = plan([{ op: "define_kind", kind: "odd", style: { backgroundColor: "#123456" } }], snapshot, idSource(1));
    expect(raw2.write.legend!.find((r) => r.meaning === "odd")!.value).toBe("#123456");
  });
});
