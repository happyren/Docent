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
import { execute, type AgentShellHooks } from "../src/agent/execute";

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
  { ...base, id: "plain", type: "rectangle", x: 300, y: 60, width: 160, height: 80, frameId: "F" },
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
