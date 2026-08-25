/**
 * The page-side tool executor (D35): the read-only boundary and the id
 * discipline, tested against a real scene graph and a scripted shell. The
 * transports around it are tested elsewhere — this is the part that decides
 * what an agent may actually do.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements, type SceneSnapshot } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import type { CommandAPI } from "../src/command/api";
import { GENRES } from "../src/authoring/genre";
import type { Op } from "../src/authoring/ops";
import { execute, type AgentShellHooks, WALL_THRESHOLD } from "../src/agent/execute";

const base = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  strokeStyle: "solid",
  fillStyle: "solid",
  strokeWidth: 2,
  opacity: 100,
  groupIds: [],
  frameId: null,
  isDeleted: false,
  locked: false,
};

const snapshot = snapshotFromRawElements([
  { ...base, id: "F", type: "frame", name: "Core", x: 0, y: 0, width: 600, height: 400 },
  { ...base, id: "G", type: "frame", name: "Worker internals", x: 0, y: 30000, width: 600, height: 400 },
  {
    ...base,
    id: "worker",
    type: "rectangle",
    x: 40,
    y: 60,
    width: 160,
    height: 80,
    frameId: "F",
    customData: { docent: { detail: { frameId: "G" } } },
  },
  {
    ...base,
    id: "plain",
    type: "rectangle",
    x: 300,
    y: 60,
    width: 160,
    height: 80,
    frameId: "F",
    customData: { docent: { intents: ["accepts orders", "retries on failure"], logic: "if retries > 3: park" } },
  },
  { ...base, id: "queue", type: "rectangle", x: 40, y: 30060, width: 160, height: 80, frameId: "G" },
]);

function fakeCommands(scene: SceneSnapshot = snapshot): CommandAPI {
  return {
    getSceneGraph: () => buildSceneGraph(scene),
    getSceneSnapshot: () => scene,
    focus: async () => {},
    highlight: () => {},
    flow: async () => {},
    narrate: async () => false,
    awaitSpeech: async () => {},
    canEdit: () => true,
    edit: async (ops: unknown[]) => ({ applied: true, changelog: `${ops.length} op(s)`, ids: {}, notes: [], touched: [], lint: { findings: [], summary: "clean" } }),
    propose: (ops: unknown[]) => ({ applied: false, changelog: `${ops.length} op(s)`, ids: {}, notes: [], touched: [], lint: { findings: [{ level: "warn", about: null, message: "x" }], summary: "1 warning" } }),
    validate: () => ({ findings: [], summary: "clean" }),
    undoAgentEdit: () => true,
    frameTargets: async () => {},
    tour: async () => 0,
    clearEffects: () => {},
  } as unknown as CommandAPI;
}

function fakeShell(overrides: Partial<Record<string, unknown>> = {}): {
  shell: AgentShellHooks;
  calls: string[];
} {
  const calls: string[] = [];
  const shell: AgentShellHooks = {
    presentation: {
      enter: (mode) => calls.push(`present:enter:${mode ?? "frames"}`),
      exit: () => calls.push("present:exit"),
      next: () => calls.push("present:next"),
      prev: () => calls.push("present:prev"),
      overview: () => calls.push("present:overview"),
      state: () =>
        (overrides.presentationState as ReturnType<
          AgentShellHooks["presentation"]["state"]
        >) ?? { active: false, mode: null, index: null, waypoints: [] },
    },
    drill: {
      dive: (elementId) => {
        calls.push(`dive:${elementId}`);
        return true;
      },
      up: () => calls.push("climb"),
      trail: () =>
        (overrides.trail as { id: string; name: string }[]) ?? [],
    },
    openScene: async (project, scene) => {
      calls.push(`open:${project}/${scene}`);
    },
    isDirty: () => (overrides.dirty as boolean) ?? false,
    currentScene: () =>
      (overrides.scene as { project: string; scene: string } | null) ?? null,
  };
  return { shell, calls };
}

describe("agent executor", () => {
  it("dives through the element that carries the declared link", async () => {
    const { shell, calls } = fakeShell();
    const result = await execute(fakeCommands(), shell, "dive", { id: "worker" });
    expect(calls).toEqual(["dive:worker"]);
    expect(result).toMatchObject({ dived: "G" });
  });

  it("refuses to dive where no detail layer is declared", async () => {
    const { shell } = fakeShell();
    await expect(
      execute(fakeCommands(), shell, "dive", { id: "plain" }),
    ).rejects.toThrow(/no detail layer/);
    await expect(
      execute(fakeCommands(), shell, "dive", { id: "ghost" }),
    ).rejects.toThrow(/Unknown node id/);
  });

  it("climb at Layer 1 is a spoken no-op, not an error", async () => {
    const { shell, calls } = fakeShell();
    const result = (await execute(fakeCommands(), shell, "climb", {})) as {
      climbed: boolean;
    };
    expect(result.climbed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("open_scene refuses while the canvas is dirty — the user decides, never the agent", async () => {
    const { shell, calls } = fakeShell({ dirty: true });
    await expect(
      execute(fakeCommands(), shell, "open_scene", { project: "p", scene: "s" }),
    ).rejects.toThrow(/unsaved changes/);
    expect(calls).toEqual([]);
  });

  it("present steps are gated on presentation being active", async () => {
    const { shell, calls } = fakeShell();
    await expect(
      execute(fakeCommands(), shell, "present", { action: "next" }),
    ).rejects.toThrow(/not active/);
    await execute(fakeCommands(), shell, "present", { action: "enter" });
    expect(calls).toEqual(["present:enter:frames"]);
  });

  it("a guided presentation leaves the camera to the narrator (D54)", async () => {
    const { shell, calls } = fakeShell({
      presentationState: { active: true, mode: "guided", index: "overview", waypoints: [] },
    });
    const entered = await execute(fakeCommands(), shell, "present", { action: "enter", mode: "guided" });
    expect(entered).toMatchObject({ presentation: "enter", mode: "guided" });
    expect(calls).toEqual(["present:enter:guided"]);
    // No frame walk: next/prev are refused with the way forward.
    await expect(
      execute(fakeCommands(), shell, "present", { action: "next" }),
    ).rejects.toThrow(/focus or tour/);
    // Overview and exit still work.
    await execute(fakeCommands(), shell, "present", { action: "overview" });
    await execute(fakeCommands(), shell, "present", { action: "exit" });
    expect(calls.slice(1)).toEqual(["present:overview", "present:exit"]);
    const view = (await execute(fakeCommands(), shell, "get_view", {})) as {
      presentation: { mode?: string };
    };
    expect(view.presentation.mode).toBe("guided");
  });

  it("narrate returns at once; wait:true stays for the voice (D57)", async () => {
    const seen: { text: string | null; wait?: boolean }[] = [];
    const commands = {
      ...fakeCommands(),
      narrate: async (p: { text: string | null; wait?: boolean }) => {
        seen.push(p);
        if (p.wait) await new Promise((r) => setTimeout(r, 40));
        return Boolean(p.wait);
      },
    } as unknown as CommandAPI;
    const { shell } = fakeShell();
    const started = Date.now();
    const quick = await execute(commands, shell, "narrate", { text: "Hello" });
    expect(Date.now() - started).toBeLessThan(30);
    expect(quick).toEqual({ narrating: true, spoken: false });
    const waited = await execute(commands, shell, "narrate", { text: "Hello", wait: true });
    expect(waited).toEqual({ narrating: true, spoken: true });
    expect(seen.map((p) => p.wait)).toEqual([false, true]);
  });

  it("the camera waits for the voice, and says its narrate on arrival (D57)", async () => {
    const log: string[] = [];
    let gated = 0;
    const commands = {
      ...fakeCommands(),
      awaitSpeech: async (interrupt?: boolean) => {
        gated += 1;
        log.push(interrupt ? "interrupt" : "gate");
        await new Promise((r) => setTimeout(r, 20));
      },
      narrate: async (p: { text: string | null }) => {
        log.push(`say:${p.text}`);
        return false;
      },
    } as unknown as CommandAPI;
    const { shell, calls } = fakeShell({
      presentationState: { active: true, mode: "guided", index: "overview", waypoints: [] },
    });
    // Every picture-moving call passes the gate before acting.
    await execute(commands, shell, "highlight", { ids: [], narrate: "Lit." });
    await execute(commands, shell, "present", { action: "overview", narrate: "The whole tier." });
    await execute(commands, shell, "flow", { path: [], interrupt: true });
    expect(gated).toBe(3);
    expect(log).toEqual(["gate", "say:Lit.", "gate", "say:The whole tier.", "interrupt"]);
    expect(calls).toEqual(["present:overview"]);
    // Results carry the next step.
    const r = (await execute(commands, shell, "highlight", { ids: [] })) as { next: string };
    expect(r.next).toMatch(/narrate/);
  });

  it("get_view speaks graph ids, not source ids (I5)", async () => {
    const { shell } = fakeShell({ trail: [{ id: "G", name: "Worker internals" }] });
    const view = (await execute(fakeCommands(), shell, "get_view", {})) as {
      trail: { id: string; name: string }[];
    };
    // Source frame id "G" resolves to its graph id — identical here by
    // sanitization, but the mapping is what this asserts.
    const graph = buildSceneGraph(snapshot);
    const expected = graph.frames.find((f) => f.sourceId === "G")!.id;
    expect(view.trail).toEqual([{ id: expected, name: "Worker internals" }]);
  });

  it("read_frame is one tier deep and refuses non-frames", async () => {
    const { shell } = fakeShell();
    const result = (await execute(fakeCommands(), shell, "read_frame", {
      id: "F",
    })) as { name: string; sidecar: string };
    expect(result.name).toBe("Core");
    expect(result.sidecar).not.toContain("Worker internals");
    await expect(
      execute(fakeCommands(), shell, "read_frame", { id: "worker" }),
    ).rejects.toThrow(/Unknown frame id/);
  });

  it("get_mermaid exports through the one pipeline", async () => {
    const { shell } = fakeShell();
    const mermaid = (await execute(fakeCommands(), shell, "get_mermaid", {})) as string;
    expect(mermaid).toContain("flowchart");
  });
});

describe("agent reading (D43, D45)", () => {
  it("get_scene_graph is the legend-applied semantic view, not paint", async () => {
    const { shell } = fakeShell();
    const graph = (await execute(fakeCommands(), shell, "get_scene_graph", {})) as {
      provenanceDefault: string;
      nodes: { id: string; intents?: string[]; logic?: string; style?: unknown; provenance?: Record<string, string> }[];
    };
    expect(graph.provenanceDefault).toBe("explicit");
    const plain = graph.nodes.find((n) => n.id === "plain")!;
    expect(plain.intents).toEqual(["accepts orders", "retries on failure"]);
    expect(plain.logic).toBe("if retries > 3: park");
    expect(plain.provenance?.intents).toBe("declared");
    expect(plain.style).toBeUndefined();
  });

  it("get_outline maps the tiers and who goes deeper", async () => {
    const { shell } = fakeShell();
    const outline = (await execute(fakeCommands(), shell, "get_outline", {})) as {
      tiers: number;
      components: number;
      frames: { id: string; tier: number; parent?: string | null; via?: { id: string } | null; deeper: { id: string }[] }[];
    };
    expect(outline.tiers).toBe(2);
    expect(outline.components).toBe(3);
    const core = outline.frames.find((f) => f.id === "F")!;
    const internals = outline.frames.find((f) => f.id === "G")!;
    expect(core.tier).toBe(1);
    expect(core.deeper.map((d) => d.id)).toEqual(["worker"]);
    expect(internals.tier).toBe(2);
    expect(internals.parent).toBe("F");
    expect(internals.via?.id).toBe("worker");
  });

  it("find locates by keyword across fields and tiers, with the trail", async () => {
    const { shell } = fakeShell();
    const byLogic = (await execute(fakeCommands(), shell, "find", { query: "retries" })) as {
      hits: { id: string; matched: string[]; trail: { id: string }[] }[];
    };
    expect(byLogic.hits[0].id).toBe("plain");
    expect(byLogic.hits[0].matched).toEqual(expect.arrayContaining(["intents", "logic"]));
    expect(byLogic.hits[0].trail).toEqual([]);
    // A component inside a detail layer carries the path down to it.
    const deep = (await execute(fakeCommands(), shell, "find", { query: "queue" })) as {
      hits: { id: string; trail: { id: string }[] }[];
    };
    expect(deep.hits[0].id).toBe("queue");
    expect(deep.hits[0].trail.map((t) => t.id)).toEqual(["G"]);
    const none = (await execute(fakeCommands(), shell, "find", { query: "zebra" })) as { hits: unknown[] };
    expect(none.hits).toEqual([]);
  });

  it("a wall of a diagram answers with the outline unless forced", async () => {
    const many = snapshotFromRawElements([
      { ...base, id: "F", type: "frame", name: "Big", x: 0, y: 0, width: 9000, height: 9000 },
      ...Array.from({ length: WALL_THRESHOLD + 1 }, (_, i) => ({
        ...base,
        id: `n${i}`,
        type: "rectangle",
        x: (i % 20) * 200,
        y: Math.floor(i / 20) * 200,
        width: 100,
        height: 60,
        frameId: "F",
      })),
    ]);
    const commands = {
      getSceneGraph: () => buildSceneGraph(many),
      getSceneSnapshot: () => many,
    } as unknown as CommandAPI;
    const { shell } = fakeShell();
    const gated = (await execute(commands, shell, "get_scene_graph", {})) as {
      note?: string;
      outline?: { components: number };
      nodes?: unknown[];
    };
    expect(gated.nodes).toBeUndefined();
    expect(gated.outline?.components).toBe(WALL_THRESHOLD + 1);
    const forced = (await execute(commands, shell, "get_scene_graph", { force: true })) as {
      nodes: unknown[];
    };
    expect(forced.nodes).toHaveLength(WALL_THRESHOLD + 1);
  });

  it("authoring tools batch through edit, answer with next, and stay off Git (S19, D62, D65)", async () => {
    const { shell, calls } = fakeShell();
    const single = (await execute(fakeCommands(), shell, "add_node", { label: "Retry queue", kind: "queue" })) as { applied: boolean; changelog: string; next: string };
    expect(single.applied).toBe(true);
    expect(single.changelog).toBe("1 op(s)");
    expect(single.next).toMatch(/save_scene/);
    const batch = (await execute(fakeCommands(), shell, "edit", { ops: [{ op: "add_frame", name: "A" }, { op: "add_node", label: "B" }] })) as { changelog: string };
    expect(batch.changelog).toBe("2 op(s)");
    await expect(execute(fakeCommands(), shell, "edit", { ops: [] })).rejects.toThrow(/non-empty/);
    const dry = (await execute(fakeCommands(), shell, "propose", { ops: [{ op: "add_node", label: "B" }] })) as { applied: boolean; next: string };
    expect(dry.applied).toBe(false);
    expect(dry.next).toMatch(/edit\(\{ops\}\)/);
    expect(await execute(fakeCommands(), shell, "validate", {})).toMatchObject({ summary: "clean" });
    expect(await execute(fakeCommands(), shell, "undo_edit", {})).toEqual({ undone: true });
    // No Git beyond a branch: there is no push, no pull request, no switch.
    await expect(execute(fakeCommands(), shell, "push", {})).rejects.toThrow(/Unknown tool/);
    await expect(execute(fakeCommands(), shell, "open_pull_request", {})).rejects.toThrow(/Unknown tool/);
    // Scenes go through the store; a branch needs an open portfolio scene.
    await expect(execute(fakeCommands(), shell, "create_branch", { name: "docent/x" })).rejects.toThrow(/available here|No portfolio scene/);
    expect(calls).toEqual([]);
  });

  it("create_scene, save_scene and create_branch go through the shell's store routes", async () => {
    const log: string[] = [];
    const { shell } = fakeShell({ scene: { project: "work", scene: "payments" } });
    shell.authoring = {
      saveScene: async () => {
        log.push("save");
        return { project: "work", scene: "payments" };
      },
      createScene: async (project, scene) => {
        log.push(`create:${project}/${scene}`);
      },
      binding: async () => ({ branch: "main", baseBranch: "main" }),
      createBranch: async (project, name) => {
        log.push(`branch:${project}:${name}`);
      },
    };
    expect(await execute(fakeCommands(), shell, "save_scene", {})).toMatchObject({ saved: { project: "work", scene: "payments" } });
    expect(await execute(fakeCommands(), shell, "create_branch", { name: "docent/retry" })).toMatchObject({ branch: "docent/retry" });
    await execute(fakeCommands(), shell, "create_scene", { project: "work", scene: "new" });
    expect(log).toEqual(["save", "branch:work:docent/retry", "create:work/new"]);
    const view = (await execute(fakeCommands(), shell, "get_view", {})) as { canEdit: boolean; git: { onBase: boolean } };
    expect(view.canEdit).toBe(true);
    expect(view.git).toEqual({ branch: "main", baseBranch: "main", onBase: true });
  });
});

// ---------------------------------------------------------------------------
// genres and scenarios at the surface (A21: D87, D89, D91)
// ---------------------------------------------------------------------------

/** A map with a genre recorded and one story told over it (D87, D89). */
const story = snapshotFromRawElements([
  {
    ...base,
    id: "legend_carrier",
    type: "text",
    x: 0,
    y: -80,
    width: 200,
    height: 40,
    text: "Legend",
    customData: {
      docent: {
        legend: [{ attr: "backgroundColor", value: "#e7f5ff", key: "kind", meaning: "service" }],
        genre: "request",
        scenarios: [
          {
            name: "Checkout",
            description: "A customer places an order and the card is charged.",
            path: ["e_place", "e_charge"],
          },
        ],
      },
    },
  },
  { ...base, id: "F", type: "frame", name: "Core", x: 0, y: 0, width: 900, height: 400 },
  { ...base, id: "checkout", type: "rectangle", x: 40, y: 60, width: 160, height: 80, frameId: "F", boundElements: [{ id: "checkout_t", type: "text" }] },
  { ...base, id: "checkout_t", type: "text", x: 50, y: 90, width: 140, height: 20, text: "Checkout page", containerId: "checkout", frameId: "F" },
  { ...base, id: "orders", type: "rectangle", x: 340, y: 60, width: 160, height: 80, frameId: "F", boundElements: [{ id: "orders_t", type: "text" }] },
  { ...base, id: "orders_t", type: "text", x: 350, y: 90, width: 140, height: 20, text: "Orders", containerId: "orders", frameId: "F" },
  { ...base, id: "payments", type: "rectangle", x: 640, y: 60, width: 160, height: 80, frameId: "F", boundElements: [{ id: "payments_t", type: "text" }] },
  { ...base, id: "payments_t", type: "text", x: 650, y: 90, width: 140, height: 20, text: "Payments", containerId: "payments", frameId: "F" },
  {
    ...base, id: "e_place", type: "arrow", x: 200, y: 100, width: 140, height: 0, frameId: "F",
    points: [[0, 0], [140, 0]], startBinding: { elementId: "checkout" }, endBinding: { elementId: "orders" },
    boundElements: [{ id: "e_place_t", type: "text" }],
  },
  { ...base, id: "e_place_t", type: "text", x: 240, y: 90, width: 80, height: 20, text: "place order", containerId: "e_place", frameId: "F" },
  {
    ...base, id: "e_charge", type: "arrow", x: 500, y: 100, width: 140, height: 0, frameId: "F",
    points: [[0, 0], [140, 0]], startBinding: { elementId: "orders" }, endBinding: { elementId: "payments" },
    customData: { docent: { note: "only after stock is reserved" } },
  },
]);

/** A Command API that records the batches it is asked to apply. */
function recordingCommands(scene: SceneSnapshot) {
  const batches: Op[][] = [];
  const flows: { path: string[]; steps?: boolean }[] = [];
  const commands = {
    ...fakeCommands(scene),
    edit: async (ops: Op[]) => {
      batches.push(ops);
      return { applied: true, changelog: "legend: +person, +service", ids: {}, notes: ["genre: Life of a request"], touched: [], lint: { findings: [], summary: "clean" } };
    },
    flow: async (p: { path: string[]; steps?: boolean }) => {
      flows.push(p);
    },
  } as unknown as CommandAPI;
  return { commands, batches, flows };
}

describe("genres at the surface (D87, D91)", () => {
  it("use_genre runs the op through edit and answers with the guidance", async () => {
    const { shell } = fakeShell();
    const { commands, batches } = recordingCommands(story);
    const answer = (await execute(commands, shell, "use_genre", { genre: "event-flow" })) as {
      applied: boolean;
      changelog: string;
      genre: string;
      guidance: string;
      next: string;
    };
    expect(batches).toEqual([[{ op: "use_genre", genre: "event-flow" }]]);
    expect(answer.applied).toBe(true);
    expect(answer.changelog).toBe("legend: +person, +service");
    expect(answer.genre).toBe("event-flow");
    // The recipe arrives when it is ordered (D91) — verbatim from the profile.
    expect(answer.guidance).toBe(GENRES["event-flow"].guidance);
    expect(answer.next).toMatch(/seeded kinds/);
  });

  it("an unknown genre is refused by the op, which names the five", async () => {
    const { shell } = fakeShell();
    const commands = {
      ...fakeCommands(story),
      edit: async (ops: { genre?: string }[]) => {
        throw new Error(`Nothing applied — 1 problem:\n- op 1 (use_genre): unknown genre "${ops[0].genre}" — one of architecture, request, event-flow, data-flow, lifecycle`);
      },
    } as unknown as CommandAPI;
    await expect(execute(commands, shell, "use_genre", { genre: "uml" })).rejects.toThrow(
      /unknown genre "uml" — one of architecture, request, event-flow, data-flow, lifecycle/,
    );
  });

  it("define_scenario lands as an edit and reminds how to replay it", async () => {
    const { shell } = fakeShell();
    const { commands, batches } = recordingCommands(story);
    const answer = (await execute(commands, shell, "define_scenario", {
      name: "Checkout",
      path: ["e_place", "e_charge"],
      description: "A customer places an order.",
    })) as { applied: boolean; scenario: string; steps: number; next: string };
    expect(batches).toEqual([[{ op: "define_scenario", name: "Checkout", path: ["e_place", "e_charge"], description: "A customer places an order." }]]);
    expect(answer).toMatchObject({ applied: true, scenario: "Checkout", steps: 2 });
    expect(answer.next).toContain("flow({scenario:'Checkout'})");
    expect(answer.next).toContain("script_tour({scenario:'Checkout'})");
  });

  it("create_scene seeds the genre at birth, and refuses a typo before making anything", async () => {
    const log: string[] = [];
    const { shell } = fakeShell();
    shell.authoring = {
      saveScene: async () => ({ project: "work", scene: "s" }),
      createScene: async (project, scene) => {
        log.push(`create:${project}/${scene}`);
      },
      binding: async () => null,
      createBranch: async () => {},
    };
    const { commands, batches } = recordingCommands(story);
    const answer = (await execute(commands, shell, "create_scene", { project: "work", scene: "orders", genre: "Life of a request" })) as {
      created: { scene: string };
      genre: string;
      guidance: string;
      changelog: string;
    };
    expect(log).toEqual(["create:work/orders"]);
    expect(batches).toEqual([[{ op: "use_genre", genre: "request" }]]);
    expect(answer.genre).toBe("request");
    expect(answer.guidance).toBe(GENRES.request.guidance);
    expect(answer.changelog).toBe("legend: +person, +service");
    // A genre nobody knows never reaches the store.
    await expect(
      execute(commands, shell, "create_scene", { project: "work", scene: "nope", genre: "uml" }),
    ).rejects.toThrow(/Unknown genre "uml" — one of architecture, request/);
    expect(log).toEqual(["create:work/orders"]);
    // And without one, nothing changed: no batch, the old way forward.
    const plain = (await execute(commands, shell, "create_scene", { project: "work", scene: "plain" })) as { next: string; genre?: string };
    expect(plain.genre).toBeUndefined();
    expect(plain.next).toMatch(/define_kind/);
    expect(batches).toHaveLength(1);
  });
});

describe("scenario replay (D89)", () => {
  it("flow({scenario}) pulses the declared path, numbered", async () => {
    const { shell } = fakeShell();
    const { commands, flows } = recordingCommands(story);
    const answer = (await execute(commands, shell, "flow", { scenario: "checkout" })) as {
      pulsed: string[];
      scenario: string;
      steps: number;
    };
    // Matched on the author's own name, case aside; answered in graph ids.
    expect(answer).toEqual({ pulsed: ["e_place", "e_charge"], scenario: "Checkout", steps: 2 });
    expect(flows).toEqual([{ path: ["e_place", "e_charge"], speed: undefined, loop: undefined, steps: true }]);
  });

  it("an unknown scenario names the ones the scene has (I5)", async () => {
    const { shell } = fakeShell();
    const { commands, flows } = recordingCommands(story);
    await expect(execute(commands, shell, "flow", { scenario: "Refund" })).rejects.toThrow(
      /Unknown scenario: Refund — this scene has "Checkout"/,
    );
    // A scene with no stories says that instead of listing nothing.
    const bare = recordingCommands(snapshot);
    await expect(execute(bare.commands, shell, "flow", { scenario: "Refund" })).rejects.toThrow(
      /this scene has none; define_scenario/,
    );
    expect(flows).toEqual([]);
  });

  it("a path and a scenario together, or neither, is refused", async () => {
    const { shell } = fakeShell();
    const { commands, flows } = recordingCommands(story);
    await expect(
      execute(commands, shell, "flow", { path: ["e_place"], scenario: "Checkout" }),
    ).rejects.toThrow(/never both/);
    await expect(execute(commands, shell, "flow", {})).rejects.toThrow(/path of edge ids or a scenario/);
    expect(flows).toEqual([]);
    // A plain path still pulses exactly as it always did, unnumbered.
    await execute(commands, shell, "flow", { path: ["e_place"] });
    expect(flows).toEqual([{ path: ["e_place"], speed: undefined, loop: undefined, steps: false }]);
  });

  it("the outline reads the genre and the scenarios (D87, D89)", async () => {
    const { shell } = fakeShell();
    const outline = (await execute(fakeCommands(story), shell, "get_outline", {})) as {
      genre?: string;
      scenarios?: { name: string; steps: number; description?: string }[];
    };
    expect(outline.genre).toBe("Life of a request");
    expect(outline.scenarios).toEqual([
      { name: "Checkout", steps: 2, description: "A customer places an order and the card is charged." },
    ]);
    // A scene with neither says neither.
    const plain = (await execute(fakeCommands(), shell, "get_outline", {})) as { genre?: string; scenarios?: unknown };
    expect(plain.genre).toBeUndefined();
    expect(plain.scenarios).toBeUndefined();
  });

  it("find matches a scenario's description and answers with its first edge", async () => {
    const { shell } = fakeShell();
    const hits = (await execute(fakeCommands(story), shell, "find", { query: "charged" })) as {
      hits: { id: string; type: string; label: string; steps?: number; matched: string[] }[];
    };
    const scenario = hits.hits.find((h) => h.type === "scenario")!;
    expect(scenario.label).toBe("Checkout");
    expect(scenario.steps).toBe(2);
    // The first edge's id: enough to focus or flow it without another call.
    expect(scenario.id).toBe("e_place");
    expect(scenario.matched).toEqual(["description"]);
    // The name matches too.
    const byName = (await execute(fakeCommands(story), shell, "find", { query: "checkout" })) as {
      hits: { type: string; matched: string[] }[];
    };
    expect(byName.hits.find((h) => h.type === "scenario")?.matched).toEqual(["scenario"]);
  });
});

