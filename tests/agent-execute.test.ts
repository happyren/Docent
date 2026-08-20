/**
 * The page-side tool executor (D35): the read-only boundary and the id
 * discipline, tested against a real scene graph and a scripted shell. The
 * transports around it are tested elsewhere — this is the part that decides
 * what an agent may actually do.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { buildSceneGraph } from "../src/scene/graph";
import type { CommandAPI } from "../src/command/api";
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

function fakeCommands(): CommandAPI {
  return {
    getSceneGraph: () => buildSceneGraph(snapshot),
    getSceneSnapshot: () => snapshot,
    focus: async () => {},
    highlight: () => {},
    flow: async () => {},
    narrate: () => {},
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
      enter: () => calls.push("present:enter"),
      exit: () => calls.push("present:exit"),
      next: () => calls.push("present:next"),
      prev: () => calls.push("present:prev"),
      overview: () => calls.push("present:overview"),
      state: () =>
        (overrides.presentationState as ReturnType<
          AgentShellHooks["presentation"]["state"]
        >) ?? { active: false, index: null, waypoints: [] },
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
    expect(result).toEqual({ dived: "G" });
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
    expect(calls).toEqual(["present:enter"]);
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
});
