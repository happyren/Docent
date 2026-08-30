/**
 * Genres (S22): a category of diagram written down as data (D87) — its
 * vocabulary seeded into the legend, its grammar spoken by the lint
 * (D88), its scenarios stored beside it (D89), its posture handed to the
 * one layout pipeline (D90).
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements, type SceneSnapshot } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import { GENRES, genreOf } from "../src/authoring/genre";
import { ROLE_FAMILIES, TONE_LOOK } from "../src/authoring/palette";
import { idSource, lint, plan, PlanError, simulate, type Op } from "../src/authoring/ops";

const base = {
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid",
  fillStyle: "solid", strokeWidth: 2, roughness: 1, roundness: { type: 3 }, opacity: 100,
  groupIds: [], frameId: null, isDeleted: false, locked: false,
};

/** The legend's carrier — where the rules, the genre and the scenarios live. */
const carrier = (genre: string | null, kinds: readonly (readonly [string, string])[], scenarios: unknown[] = []) => ({
  ...base,
  id: "legend", type: "text", x: 0, y: -220, width: 200, height: 40, text: "Legend", locked: true,
  customData: {
    docent: {
      legend: kinds.map(([meaning, fill]) => ({ attr: "backgroundColor", value: fill, key: "kind", meaning })),
      ...(genre ? { genre } : {}),
      ...(scenarios.length ? { scenarios } : {}),
    },
  },
});

const node = (id: string, x: number, y: number, label: string, fill: string) => [
  { ...base, id, type: "rectangle", x, y, width: 160, height: 80, backgroundColor: fill, boundElements: [{ id: `${id}_t`, type: "text" }] },
  { ...base, id: `${id}_t`, type: "text", x: x + 10, y: y + 20, width: 140, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20 },
];

const link = (id: string, from: string, to: string, label?: string) => [
  {
    ...base, id, type: "arrow", x: 0, y: 0, width: 10, height: 10, roundness: { type: 2 },
    points: [[0, 0], [10, 10]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: "arrow",
    ...(label ? { boundElements: [{ id: `${id}_t`, type: "text" }] } : {}),
  },
  ...(label ? [{ ...base, id: `${id}_t`, type: "text", x: 5, y: 5, width: 60, height: 20, text: label, containerId: id, fontFamily: 5, fontSize: 20 }] : []),
];

const sceneOf = (raw: unknown[]): SceneSnapshot => snapshotFromRawElements(raw as never);
const empty = sceneOf([]);

/** A batch run on a scene, and the scene it leaves behind. */
const run = (snapshot: SceneSnapshot, ops: Op[], seed = 11) => {
  const result = plan(ops, snapshot, idSource(seed));
  return { result, after: simulate(snapshot, result.write) };
};

/** What a genre finding says, without the base lint's own sentences. */
const genreSaid = (snapshot: SceneSnapshot, opening: string) =>
  lint(snapshot).findings.filter((f) => f.message.startsWith(opening)).map((f) => f.message);

// ---------------------------------------------------------------------------
// the profiles (D87)
// ---------------------------------------------------------------------------

describe("a genre is a profile (D87)", () => {
  it("is found by id, by name, and by what an agent is likely to type", () => {
    expect(genreOf("architecture")).toBe(GENRES.architecture);
    expect(genreOf("Life of a request")).toBe(GENRES.request);
    expect(genreOf("EVENT FLOW")).toBe(GENRES["event-flow"]);
    expect(genreOf("data_flow")).toBe(GENRES["data-flow"]);
    expect(genreOf(null)).toBeNull();
    expect(genreOf("  ")).toBeNull();
    expect(genreOf("sequence")).toBeNull();
  });

  it("says when it fits and what to do, and speaks only tones and roles (D77)", () => {
    for (const profile of Object.values(GENRES)) {
      expect(profile.when.length).toBeGreaterThan(10);
      expect(profile.guidance.length).toBeGreaterThan(80);
      expect(profile.kinds.length).toBeGreaterThan(1);
      // No raw styling anywhere: a kind's colour is the palette's to pick.
      for (const kind of profile.kinds) expect(Object.keys(kind).sort()).not.toContain("style");
    }
  });
});

describe("use_genre records the genre and seeds its vocabulary (D87)", () => {
  it("writes the genre beside the legend and defines the kinds it does not hold", () => {
    const { result, after } = run(empty, [{ op: "use_genre", genre: "architecture" }]);
    expect(result.write.genre).toBe("architecture");
    const graph = buildSceneGraph(after);
    expect(graph.genre).toBe("architecture");
    const kinds = graph.legend.filter((r) => r.key === "kind");
    expect(kinds.map((r) => r.meaning)).toEqual(["person", "system", "service", "store", "queue"]);
    // Every kind reads as a different thing: distinct fills (D77).
    expect(new Set(kinds.map((r) => r.value)).size).toBe(kinds.length);
    // A role picks from its family; a person is drawn as an ellipse.
    const person = kinds.find((r) => r.meaning === "person")!;
    expect(ROLE_FAMILIES.people.map((s) => s.fill)).toContain(person.value);
    expect(person.also).toContainEqual({ attr: "shape", value: "ellipse" });
    expect(ROLE_FAMILIES.storage.map((s) => s.fill)).toContain(kinds.find((r) => r.meaning === "store")!.value);
    expect(result.notes.join("\n")).toContain("genre: Architecture map — seeded person, system, service, store, queue");
  });

  it("takes the conventional hue where the genre names a tone", () => {
    const { after } = run(empty, [{ op: "use_genre", genre: "event-flow" }]);
    const kinds = buildSceneGraph(after).legend.filter((r) => r.key === "kind");
    expect(kinds.find((r) => r.meaning === "command")!.value).toBe(TONE_LOOK.neutral.fill);
    expect(kinds.find((r) => r.meaning === "event")!.value).toBe(TONE_LOOK.caution.fill);
    expect(kinds.find((r) => r.meaning === "read model")!.value).toBe(TONE_LOOK.positive.fill);
  });

  it("seeds nothing the second time, and never deletes when the genre changes", () => {
    const first = run(empty, [{ op: "use_genre", genre: "architecture" }]);
    const again = plan([{ op: "use_genre", genre: "architecture" }], first.after, idSource(3));
    expect(again.write.legend).toBeUndefined();
    expect(again.write.genre).toBeUndefined();
    expect(again.notes.join("\n")).toContain("Architecture map is already in force");
    // Switching keeps every rule the map left behind, and adds what the
    // new genre needs.
    const switched = plan([{ op: "use_genre", genre: "lifecycle" }], first.after, idSource(4));
    const graph = buildSceneGraph(simulate(first.after, switched.write));
    expect(graph.genre).toBe("lifecycle");
    expect(graph.legend.filter((r) => r.key === "kind").map((r) => r.meaning)).toEqual([
      "person", "system", "service", "store", "queue", "state", "terminal",
    ]);
  });

  it("names the genres it knows when asked for one it does not (I5)", () => {
    expect(() => plan([{ op: "use_genre", genre: "sequence" }], empty, idSource(1))).toThrow(PlanError);
    try {
      plan([{ op: "use_genre", genre: "sequence" }], empty, idSource(1));
    } catch (err) {
      expect((err as PlanError).problems.join("")).toContain("architecture, request, event-flow, data-flow, lifecycle");
    }
  });
});

// ---------------------------------------------------------------------------
// scenarios (D89)
// ---------------------------------------------------------------------------

describe("a scenario is a named path of edges (D89)", () => {
  const drawn: Op[] = [
    { op: "use_genre", genre: "request" },
    { op: "add_node", ref: "$web", label: "Web", kind: "system" },
    { op: "add_node", ref: "$api", label: "API", kind: "service" },
    { op: "add_node", ref: "$db", label: "Orders DB", kind: "store" },
    { op: "add_edge", ref: "$in", from: "$web", to: "$api", label: "POST /orders" },
    { op: "add_edge", ref: "$save", from: "$api", to: "$db", label: "insert" },
  ];

  it("stores the name, the description and the path in the order authored", () => {
    const { result, after } = run(empty, [
      ...drawn,
      { op: "define_scenario", name: "checkout", description: "the happy path", path: ["$in", "$save"] },
    ]);
    expect(result.write.scenarios).toEqual([
      { name: "checkout", description: "the happy path", path: [result.ids["$in"], result.ids["$save"]] },
    ]);
    expect(result.notes.join("\n")).toContain('scenario "checkout" defined (2 steps)');
    const graph = buildSceneGraph(after);
    expect(graph.scenarios).toHaveLength(1);
    expect(graph.scenarios[0].path).toEqual([result.ids["$in"], result.ids["$save"]]);
  });

  it("refuses a step that is not an edge, and one that is nothing at all (I5)", () => {
    try {
      plan([...drawn, { op: "define_scenario", name: "checkout", path: ["$in", "$api"] }], empty, idSource(2));
      expect.unreachable();
    } catch (err) {
      expect((err as PlanError).problems.join("")).toContain("a scenario is a path of edges");
    }
    try {
      plan([...drawn, { op: "define_scenario", name: "checkout", path: ["$in", "$nope"] }], empty, idSource(2));
      expect.unreachable();
    } catch (err) {
      expect((err as PlanError).problems.join("")).toContain("unknown id $nope");
    }
    expect(() => plan([...drawn, { op: "define_scenario", name: " ", path: ["$in"] }], empty, idSource(2))).toThrow(PlanError);
    expect(() => plan([...drawn, { op: "define_scenario", name: "checkout", path: [] }], empty, idSource(2))).toThrow(PlanError);
  });

  it("replaces the scenario of the same name rather than keeping two", () => {
    const { result, after } = run(empty, [...drawn, { op: "define_scenario", name: "checkout", path: ["$in"] }]);
    const edges = buildSceneGraph(after).edges;
    const again = plan(
      [{ op: "define_scenario", name: "checkout", path: edges.map((e) => e.id) }],
      after,
      idSource(5),
    );
    expect(again.notes.join("\n")).toContain(`scenario "checkout" replaced (${edges.length} steps)`);
    expect(again.write.scenarios).toHaveLength(1);
    expect(again.write.scenarios![0].path).toHaveLength(edges.length);
    expect(result.write.scenarios![0].path).toHaveLength(1);
  });

  it("says which scenario an edge on its way out was part of, and flags it after (D89, I5)", () => {
    const { result, after } = run(empty, [
      ...drawn,
      { op: "define_scenario", name: "checkout", path: ["$in", "$save"] },
    ]);
    const gone = plan([{ op: "remove", id: result.ids["$save"] }], after, idSource(6));
    expect(gone.notes.join("\n")).toContain('scenario "checkout" steps through it — the scenario will flag until re-pointed');
    expect(gone.notes.join("\n")).toContain('"insert"');
    const findings = lint(simulate(after, gone.write)).findings;
    expect(findings).toContainEqual({
      level: "warn",
      about: null,
      message: 'scenario "checkout" step 2 points at an edge that is gone',
    });
  });
});

// ---------------------------------------------------------------------------
// the grammar (D88)
// ---------------------------------------------------------------------------

describe("event flow speaks command, event, read model (D88)", () => {
  const kinds = [
    ["command", TONE_LOOK.neutral.fill],
    ["event", TONE_LOOK.caution.fill],
    ["read model", TONE_LOOK.positive.fill],
  ] as const;

  it("is quiet when every event has a cause and every read model an event", () => {
    const scene = sceneOf([
      carrier("event-flow", kinds),
      ...node("cmd", 0, 0, "Place order", TONE_LOOK.neutral.fill),
      ...node("evt", 300, 0, "Order placed", TONE_LOOK.caution.fill),
      ...node("rm", 600, 0, "Open orders", TONE_LOOK.positive.fill),
      ...link("e1", "cmd", "evt", "places"),
      ...link("e2", "evt", "rm", "projects"),
    ]);
    expect(genreSaid(scene, "Event flow:")).toEqual([]);
  });

  it("names the event nothing causes and the read model nothing feeds", () => {
    const scene = sceneOf([
      carrier("event-flow", kinds),
      ...node("evt", 0, 0, "Payment failed", TONE_LOOK.caution.fill),
      ...node("rm", 300, 0, "Revenue", TONE_LOOK.positive.fill),
    ]);
    expect(genreSaid(scene, "Event flow:")).toEqual([
      'Event flow: event "Payment failed" has no cause — a command or policy should feed it',
      'Event flow: read model "Revenue" derives from nothing — feed it an event',
    ]);
    // Advice, never a veto (D88): nothing here is a warning.
    expect(lint(scene).findings.filter((f) => f.message.startsWith("Event flow:")).every((f) => f.level === "info")).toBe(true);
  });
});

describe("the options genre keeps the decision honest (D140)", () => {
  const kinds = [
    ["option", TONE_LOOK.neutral.fill],
    ["win", TONE_LOOK.positive.fill],
    ["cost", TONE_LOOK.danger.fill],
  ] as const;

  it("is quiet when every option pays and every win and cost is held", () => {
    const scene = sceneOf([
      carrier("options", kinds),
      ...node("a", 0, 0, "Managed queue", TONE_LOOK.neutral.fill),
      ...node("aw", 300, 0, "No ops burden", TONE_LOOK.positive.fill),
      ...node("ac", 300, 200, "Vendor lock-in", TONE_LOOK.danger.fill),
      ...node("b", 0, 400, "Self-hosted", TONE_LOOK.neutral.fill),
      ...node("bc", 300, 400, "On-call pages", TONE_LOOK.danger.fill),
      ...link("e1", "a", "aw", "gains"),
      ...link("e2", "a", "ac", "pays"),
      ...link("e3", "b", "bc", "pays"),
    ]);
    expect(genreSaid(scene, "Solution options:")).toEqual([]);
  });

  it("names the free lunch, the lone option, and the adrift cost", () => {
    const scene = sceneOf([
      carrier("options", kinds),
      ...node("a", 0, 0, "Managed queue", TONE_LOOK.neutral.fill),
      ...node("w", 300, 0, "No ops burden", TONE_LOOK.positive.fill),
      ...node("c", 600, 0, "Vendor lock-in", TONE_LOOK.danger.fill),
      ...link("e1", "a", "w", "gains"),
    ]);
    expect(genreSaid(scene, "Solution options:")).toEqual([
      'Solution options: one option is a conclusion wearing a question\'s clothes — draw the alternative, even the do-nothing one',
      'Solution options: option "Managed queue" declares no cost — there is no free lunch, only an undeclared price',
      'Solution options: cost "Vendor lock-in" belongs to no option — link it from the option that pays it',
    ]);
    expect(lint(scene).findings.filter((f) => f.message.startsWith("Solution options:")).every((f) => f.level === "info")).toBe(true);
  });
});

describe("the explainer tells one story in steps (D125)", () => {
  const kinds = [
    ["step", TONE_LOOK.neutral.fill],
    ["decision", TONE_LOOK.caution.fill],
    ["aside", TONE_LOOK.inactive.fill],
    ["outcome", TONE_LOOK.positive.fill],
  ] as const;

  it("is found by its own name", () => {
    expect(genreOf("explainer")).toBe(GENRES.explainer);
    expect(genreOf("Explainer")).toBe(GENRES.explainer);
  });

  it("is quiet when the spine is short, labelled, and lands", () => {
    const scene = sceneOf([
      carrier("explainer", kinds),
      ...node("s1", 0, 0, "Parse the input", TONE_LOOK.neutral.fill),
      ...node("s2", 300, 0, "Check the cache", TONE_LOOK.neutral.fill),
      ...node("done", 600, 0, "Answer served", TONE_LOOK.positive.fill),
      ...link("e1", "s1", "s2", "then"),
      ...link("e2", "s2", "done", "on a hit"),
    ]);
    expect(genreSaid(scene, "Explainer:")).toEqual([]);
  });

  it("asks for the scenario, the outcome, the loose aside and the silent branch", () => {
    const scene = sceneOf([
      carrier("explainer", kinds),
      ...node("s1", 0, 0, "First", TONE_LOOK.neutral.fill),
      ...node("s2", 300, 0, "Second", TONE_LOOK.neutral.fill),
      ...node("s3", 600, 0, "Third", TONE_LOOK.neutral.fill),
      ...node("why", 300, 200, "Background", TONE_LOOK.inactive.fill),
      ...node("dec", 900, 0, "Cache warm?", TONE_LOOK.caution.fill),
      ...node("s4", 1200, 0, "Serve it", TONE_LOOK.neutral.fill),
      ...node("s5", 1200, 200, "Rebuild it", TONE_LOOK.neutral.fill),
      ...link("e1", "s1", "s2", "then"),
      ...link("e2", "s2", "s3", "then"),
      ...link("e3", "why", "s2"),
      ...link("e4", "s3", "dec", "then"),
      ...link("e5", "dec", "s4", "yes"),
      ...link("e6", "dec", "s5"),
    ]);
    expect(genreSaid(scene, "Explainer:")).toEqual([
      "Explainer: no scenario yet — define_scenario over the spine so flow replays the story and script_tour speaks it",
      "Explainer: the story has no outcome — end the spine where it lands",
      'Explainer: aside "Background" feeds "Second" — an aside hangs off the spine, nothing follows from it',
      'Explainer: decision "Cache warm?" has an unlabelled branch — label each leaving edge with its answer',
    ]);
    // Advice, never a veto (D88).
    expect(
      lint(scene).findings.filter((f) => f.message.startsWith("Explainer:")).every((f) => f.level === "info"),
    ).toBe(true);
  });
});

describe("data flow reads one way and carries its contracts (D88)", () => {
  const kinds = [["source", "#ced4da"], ["transform", "#ffd8a8"], ["store", "#a5d8ff"]] as const;

  it("is quiet when the pipeline runs forward and every edge names what flows", () => {
    const scene = sceneOf([
      carrier("data-flow", kinds),
      ...node("src", 0, 0, "Events topic", "#ced4da"),
      ...node("tf", 300, 0, "Enrich", "#ffd8a8"),
      ...node("out", 600, 0, "Warehouse", "#a5d8ff"),
      ...link("e1", "src", "tf", "raw events"),
      ...link("e2", "tf", "out", "enriched rows"),
    ]);
    expect(genreSaid(scene, "Data flow:")).toEqual([]);
  });

  it("flags the edge that closes a cycle and the edge with no contract", () => {
    const scene = sceneOf([
      carrier("data-flow", kinds),
      ...node("src", 0, 0, "Events topic", "#ced4da"),
      ...node("tf", 300, 0, "Enrich", "#ffd8a8"),
      ...link("e1", "src", "tf", "raw events"),
      ...link("e2", "tf", "src"),
    ]);
    expect(genreSaid(scene, "Data flow:")).toEqual([
      'Data flow: "Enrich → Events topic" closes a cycle — pipelines read one way',
      'Data flow: "Enrich → Events topic" carries no contract — name what flows',
    ]);
  });
});

describe("a lifecycle starts somewhere and ends somewhere (D88)", () => {
  const kinds = [["state", "#a5d8ff"], ["terminal", "#f1f3f5"]] as const;

  it("is quiet when every state is reached and one of them is terminal", () => {
    const scene = sceneOf([
      carrier("lifecycle", kinds),
      ...node("draft", 0, 0, "Draft", "#a5d8ff"),
      ...node("sent", 300, 0, "Sent", "#a5d8ff"),
      ...node("paid", 600, 0, "Paid", "#f1f3f5"),
      ...link("t1", "draft", "sent", "send"),
      ...link("t2", "sent", "paid", "pay"),
    ]);
    expect(genreSaid(scene, "Lifecycle:")).toEqual([]);
  });

  it("names the state no transition reaches, and a machine that never ends", () => {
    const scene = sceneOf([
      carrier("lifecycle", kinds),
      ...node("draft", 0, 0, "Draft", "#a5d8ff"),
      ...node("sent", 300, 0, "Sent", "#a5d8ff"),
      ...node("void", 600, 0, "Voided", "#a5d8ff"),
      ...link("t1", "draft", "sent", "send"),
      ...link("t2", "sent", "draft", "revise"),
      // Voided leads back and nothing leads to it: a state outside the
      // machine, in a machine that never stops.
      ...link("t3", "void", "draft", "reopen"),
    ]);
    expect(genreSaid(scene, "Lifecycle:")).toEqual([
      'Lifecycle: state "Voided" is unreachable',
      "Lifecycle: no state is terminal — every machine ends somewhere",
    ]);
  });
});

describe("the architecture map leaves the kindless component to the base lint (D88)", () => {
  it("says it once, in the lint's own words", () => {
    const scene = sceneOf([
      carrier("architecture", [["service", "#ffd8a8"]]),
      ...node("odd", 0, 0, "Mystery", "#ffffff"),
    ]);
    const said = lint(scene).findings.filter((f) => f.message.includes("no kind"));
    expect(said).toHaveLength(1);
    expect(said[0].message).toBe("Mystery has no kind — its style matches no legend rule");
  });
});

describe("a scene of no genre hears nothing from the genres", () => {
  it("keeps the lint exactly as it was", () => {
    const scene = sceneOf([
      carrier(null, [["service", "#ffd8a8"]]),
      ...node("a", 0, 0, "Alpha", "#ffd8a8"),
      ...node("b", 300, 0, "Beta", "#ffd8a8"),
      ...link("e1", "a", "b"),
    ]);
    for (const opening of ["Event flow:", "Data flow:", "Lifecycle:", "Architecture map:"]) {
      expect(genreSaid(scene, opening)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// postures (D90)
// ---------------------------------------------------------------------------

describe("a data flow does not fold (D90)", () => {
  const pipeline = (withGenre: boolean): Op[] => {
    const ops: Op[] = withGenre ? [{ op: "use_genre", genre: "data-flow" }] : [];
    ops.push({ op: "add_frame", ref: "$f", name: "Ingest", narrative: "Events to the warehouse." });
    for (let i = 0; i < 9; i++) {
      ops.push({ op: "add_node", ref: `$s${i}`, label: `stage ${i}`, kind: i === 0 ? "source" : "transform", frame: "$f" });
    }
    for (let i = 0; i + 1 < 9; i++) ops.push({ op: "add_edge", from: `$s${i}`, to: `$s${i + 1}`, label: "rows" });
    return ops;
  };
  const boxes = (ops: Op[]) => {
    const result = plan(ops, empty, idSource(9));
    const byId = new Map(result.write.shapes!.map((s) => [s.id, s]));
    return Array.from({ length: 9 }, (_, i) => byId.get(result.ids[`$s${i}`])!);
  };

  it("keeps a nine-stage pipeline on one line, left to right", () => {
    const straight = boxes(pipeline(true));
    for (let i = 0; i + 1 < straight.length; i++) {
      expect(straight[i].x + straight[i].width).toBeLessThanOrEqual(straight[i + 1].x);
      expect(straight[i + 1].y).toBe(straight[0].y);
    }
  });

  it("folds the same pipeline when no genre says not to (D71)", () => {
    const folded = boxes(pipeline(false));
    expect(new Set(folded.map((b) => b.y)).size).toBeGreaterThan(1);
  });

  it("unfolds a pipeline the scene already recorded a genre for", () => {
    // Drawn folded, by hand, in a scene whose carrier says data flow.
    const placed = [
      [0, 0], [200, 0], [400, 0], [600, 0], [800, 0],
      [800, 200], [600, 200], [400, 200], [200, 200],
    ];
    const scene = sceneOf([
      carrier("data-flow", [["transform", "#ffd8a8"]]),
      { ...base, id: "F", type: "frame", name: "Ingest", x: -40, y: -40, width: 1100, height: 400 },
      ...placed.flatMap(([x, y], i) =>
        node(`s${i}`, x, y, `stage ${i}`, "#ffd8a8").map((el) => ({ ...el, frameId: "F" })),
      ),
      ...placed.slice(1).flatMap((_, i) => link(`t${i}`, `s${i}`, `s${i + 1}`, "rows").map((el) => ({ ...el, frameId: "F" }))),
    ]);
    const result = plan([{ op: "layout", frame: "F" }], scene, idSource(17));
    const at = (i: number) => result.write.patches!.find((p) => p.id === `s${i}`)!;
    for (let i = 0; i + 1 < placed.length; i++) {
      expect(at(i).x!).toBeLessThan(at(i + 1).x!);
      expect(at(i + 1).y).toBe(at(0).y);
    }
  });
});

describe("an event flow lays its contexts out as lanes (D90)", () => {
  const result = plan(
    [
      { op: "use_genre", genre: "event-flow" },
      { op: "add_frame", ref: "$ordering", name: "Ordering", narrative: "Orders are placed here." },
      { op: "add_frame", ref: "$billing", name: "Billing", narrative: "Invoices are raised here." },
      { op: "add_node", ref: "$place", label: "Place order", kind: "command", frame: "$ordering" },
      { op: "add_node", ref: "$placed", label: "Order placed", kind: "event", frame: "$ordering" },
      { op: "add_node", ref: "$issue", label: "Issue invoice", kind: "command", frame: "$billing" },
      { op: "add_node", ref: "$issued", label: "Invoice issued", kind: "event", frame: "$billing" },
      { op: "add_edge", from: "$place", to: "$placed", label: "places" },
      { op: "add_edge", from: "$placed", to: "$issue", label: "bills" },
      { op: "add_edge", from: "$issue", to: "$issued", label: "issues" },
    ],
    empty,
    idSource(13),
  );
  const shapeOf = (ref: string) => result.write.shapes!.find((s) => s.id === result.ids[ref])!;
  const frameOf = (name: string) => result.write.frames!.find((f) => f.name === name)!;

  it("puts every component in its own frame's band", () => {
    for (const [ref, name] of [["$place", "Ordering"], ["$placed", "Ordering"], ["$issue", "Billing"], ["$issued", "Billing"]] as const) {
      const shape = shapeOf(ref);
      const frame = frameOf(name);
      expect(shape.x).toBeGreaterThanOrEqual(frame.x);
      expect(shape.x + shape.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(shape.y).toBeGreaterThanOrEqual(frame.y);
      expect(shape.y + shape.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });

  it("stacks the lanes in the order declared, disjoint and spanning the same time (D86)", () => {
    const ordering = frameOf("Ordering");
    const billing = frameOf("Billing");
    expect(ordering.y + ordering.height).toBeLessThanOrEqual(billing.y);
    expect(billing.x).toBe(ordering.x);
    expect(billing.width).toBe(ordering.width);
    // Nothing was parted afterwards: the lanes left the room themselves.
    expect(result.notes.join("\n")).not.toContain("moved clear of its neighbour");
    expect(result.notes.join("\n")).toContain("Event flow: 4 components in 2 lanes, time left to right");
  });

  it("runs time left to right across the lanes", () => {
    const xs = ["$place", "$placed", "$issue", "$issued"].map((ref) => shapeOf(ref).x);
    for (let i = 0; i + 1 < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i + 1]);
  });

  it("keeps one frame's own lane unfolded when the layout is asked for again", () => {
    const scene = sceneOf([
      carrier("event-flow", [["command", TONE_LOOK.neutral.fill]]),
      { ...base, id: "F", type: "frame", name: "Ordering", x: -40, y: -40, width: 900, height: 400 },
      ...Array.from({ length: 7 }, (_, i) =>
        node(`n${i}`, i * 200, 0, `step ${i}`, TONE_LOOK.neutral.fill).map((el) => ({ ...el, frameId: "F" })),
      ).flat(),
      ...Array.from({ length: 6 }, (_, i) => link(`t${i}`, `n${i}`, `n${i + 1}`, "then").map((el) => ({ ...el, frameId: "F" }))).flat(),
    ]);
    const laid = plan([{ op: "layout", frame: "F" }], scene, idSource(19));
    const at = (i: number) => laid.write.patches!.find((p) => p.id === `n${i}`)!;
    for (let i = 0; i + 1 < 7; i++) {
      expect(at(i).x!).toBeLessThan(at(i + 1).x!);
      expect(at(i + 1).y).toBe(at(0).y);
    }
  });
});

describe("the lanes and the outer picture do not fight (D90, D100)", () => {
  // The same two contexts, and two components nobody framed: the customer
  // the flow starts with and the ledger it ends in. The lanes pass places
  // the frames; the meta-arrangement ranks the loose pair around them.
  const ops: Op[] = [
    { op: "use_genre", genre: "event-flow" },
    { op: "add_frame", ref: "$ordering", name: "Ordering", narrative: "Orders are placed here." },
    { op: "add_frame", ref: "$billing", name: "Billing", narrative: "Invoices are raised here." },
    { op: "add_node", ref: "$place", label: "Place order", kind: "command", frame: "$ordering" },
    { op: "add_node", ref: "$placed", label: "Order placed", kind: "event", frame: "$ordering" },
    { op: "add_node", ref: "$issue", label: "Issue invoice", kind: "command", frame: "$billing" },
    { op: "add_node", ref: "$issued", label: "Invoice issued", kind: "event", frame: "$billing" },
    { op: "add_node", ref: "$customer", label: "Customer", kind: "read model" },
    { op: "add_node", ref: "$ledger", label: "Ledger", kind: "read model" },
    { op: "add_edge", from: "$place", to: "$placed", label: "places" },
    { op: "add_edge", from: "$placed", to: "$issue", label: "bills" },
    { op: "add_edge", from: "$issue", to: "$issued", label: "issues" },
    { op: "add_edge", from: "$customer", to: "$place", label: "orders" },
    { op: "add_edge", from: "$issued", to: "$ledger", label: "posts" },
  ];
  const result = plan(ops, empty, idSource(37));
  const shapeOf = (ref: string) => result.write.shapes!.find((s) => s.id === result.ids[ref])!;
  const frameOf = (name: string) => result.write.frames!.find((f) => f.name === name)!;
  const clear = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

  it("leaves the lanes lanes — stacked, aligned, spanning the same time (D90)", () => {
    const ordering = frameOf("Ordering");
    const billing = frameOf("Billing");
    expect(ordering.y + ordering.height).toBeLessThanOrEqual(billing.y);
    expect(billing.x).toBe(ordering.x);
    expect(billing.width).toBe(ordering.width);
    expect(result.notes.join("\n")).toContain("Event flow: 4 components in 2 lanes, time left to right");
    expect(result.notes.join("\n")).not.toContain("moved clear of its neighbour");
    // Every member is still in its own band.
    for (const [ref, name] of [["$place", "Ordering"], ["$placed", "Ordering"], ["$issue", "Billing"], ["$issued", "Billing"]] as const) {
      const shape = shapeOf(ref);
      const frame = frameOf(name);
      expect(shape.x).toBeGreaterThanOrEqual(frame.x);
      expect(shape.x + shape.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(shape.y).toBeGreaterThanOrEqual(frame.y);
      expect(shape.y + shape.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
  });

  it("ranks the loose pair around the lane block, clear of it and of each other (D100)", () => {
    const ordering = frameOf("Ordering");
    const billing = frameOf("Billing");
    const customer = shapeOf("$customer");
    const ledger = shapeOf("$ledger");
    // The lanes move as one block, so what feeds into them leads all of
    // them and what they feed follows all of them.
    expect(customer.x + customer.width).toBeLessThanOrEqual(Math.min(ordering.x, billing.x));
    expect(ledger.x).toBeGreaterThanOrEqual(Math.max(ordering.x + ordering.width, billing.x + billing.width));
    for (const loose of [customer, ledger]) {
      for (const frame of [ordering, billing]) expect(clear(loose, frame)).toBe(true);
    }
    expect(clear(customer, ledger)).toBe(true);
    expect(result.notes.filter((n) => n === "Layer 1: arranged whole — sources lead, sinks follow (D100)")).toHaveLength(1);
  });

  it("reads the same twice (I3)", () => {
    expect(plan(ops, empty, idSource(37)).write).toEqual(result.write);
  });
});

describe("one batch gives one write (I3)", () => {
  it("plans a genre, a drawing and a scenario the same way twice", () => {
    const ops: Op[] = [
      { op: "use_genre", genre: "event-flow" },
      { op: "add_frame", ref: "$f", name: "Ordering" },
      { op: "add_node", ref: "$cmd", label: "Place order", kind: "command", frame: "$f" },
      { op: "add_node", ref: "$evt", label: "Order placed", kind: "event", frame: "$f" },
      { op: "add_edge", ref: "$e", from: "$cmd", to: "$evt", label: "places" },
      { op: "define_scenario", name: "checkout", path: ["$e"] },
    ];
    const once = plan(ops, empty, idSource(21));
    const twice = plan(ops, empty, idSource(21));
    expect(twice.write).toEqual(once.write);
    expect(twice.ids).toEqual(once.ids);
    expect(twice.notes).toEqual(once.notes);
  });
});
