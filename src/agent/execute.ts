/**
 * The page-side tool executor (B4, D35): every agent tool call — arriving
 * over the self-host bridge or the desktop shell's pipe — lands here and
 * runs against the Command API plus a narrow set of shell hooks. Read-only
 * by construction: the scene document is never modified; camera, overlay,
 * narration, presentation, drill, and scene opening are navigation.
 */
import type { CommandAPI } from "../command/api";
import type { HighlightStyle } from "../overlay/state";
import type { TourStep } from "../command/api";
import { detailBadges } from "../scene/detailBadges";
import { exportFrameSidecar, exportScene } from "../export";
import { listProjects, listScenes } from "../portfolio/client";

/** What the shell (App) lends the agent — navigation, never mutation. */
export interface AgentShellHooks {
  presentation: {
    enter(): void;
    exit(): void;
    next(): void;
    prev(): void;
    overview(): void;
    state(): {
      active: boolean;
      index: number | "overview" | null;
      waypoints: { id: string; name: string; narrative: string | null }[];
    };
  };
  drill: {
    /** Dive into an element's declared detail frame; false = none. */
    dive(elementId: string): boolean;
    up(): void;
    /** Structural breadcrumb trail at the current viewport, outermost first. */
    trail(): { id: string; name: string }[];
  };
  /** Open a portfolio scene onto the canvas; rejects on failure. */
  openScene(project: string, scene: string): Promise<void>;
  isDirty(): boolean;
  currentScene(): { project: string; scene: string } | null;
}

export async function execute(
  commands: CommandAPI,
  shell: AgentShellHooks,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case "get_scene_graph":
      return commands.getSceneGraph();
    case "get_mermaid":
      return exportScene(commands.getSceneSnapshot()).mermaid;
    case "read_frame": {
      const id = params.id as string;
      const graph = commands.getSceneGraph();
      const frame = graph.frames.find((f) => f.id === id || f.sourceId === id);
      if (!frame) {
        throw new Error(`Unknown frame id: ${id} — use ids from get_scene_graph`);
      }
      return exportFrameSidecar(commands.getSceneSnapshot(), frame.sourceId);
    }
    case "list_projects": {
      const projects = await listProjects();
      return Promise.all(
        projects.map(async (p) => ({
          project: p.id,
          scenes: (await listScenes(p.id)).map((s) => s.name),
        })),
      );
    }
    case "open_scene": {
      if (shell.isDirty()) {
        throw new Error(
          "The canvas has unsaved changes — ask the user to save or discard them first; an agent never decides that.",
        );
      }
      const { project, scene } = params as { project: string; scene: string };
      await shell.openScene(project, scene);
      return { opened: { project, scene } };
    }
    case "get_view": {
      // The shell speaks in source ids; agents live in graph-id space (I5).
      const graph = commands.getSceneGraph();
      const frameGraphId = (sourceId: string) =>
        graph.frames.find((f) => f.sourceId === sourceId)?.id ?? sourceId;
      const p = shell.presentation.state();
      return {
        scene: shell.currentScene(),
        trail: shell.drill
          .trail()
          .map((crumb) => ({ id: frameGraphId(crumb.id), name: crumb.name })),
        presentation: p.active
          ? {
              active: true,
              index: p.index,
              waypoints: p.waypoints.map((w) => ({
                id: frameGraphId(w.id),
                name: w.name,
                narrative: w.narrative,
              })),
            }
          : { active: false },
      };
    }
    case "focus":
      await commands.focus(params as { id: string; padding?: number });
      return { focused: (params as { id: string }).id };
    case "dive": {
      const id = params.id as string;
      const graph = commands.getSceneGraph();
      const node = graph.nodes.find((n) => n.id === id || n.sourceId === id);
      if (!node) {
        throw new Error(`Unknown node id: ${id} — use ids from get_scene_graph`);
      }
      if (node.detailFrameId === null) {
        throw new Error(
          `${node.label ?? id} has no detail layer — only nodes whose graph entry carries \`detail\` can be dived into`,
        );
      }
      // The declared link may live on any member of a composite (D22) —
      // the badge derivation already answers which element to dive through.
      const badge = detailBadges(commands.getSceneSnapshot()).find(
        (b) => b.id === node.id,
      );
      const dived = shell.drill.dive(badge?.diveElementId ?? node.sourceId);
      if (!dived) throw new Error(`Could not dive into ${id} — the detail frame is gone`);
      return { dived: node.detailFrameId };
    }
    case "climb": {
      const trail = shell.drill.trail();
      if (trail.length === 0) {
        return { climbed: false, note: "Already at Layer 1 — nothing above this tier." };
      }
      shell.drill.up();
      return { climbed: true };
    }
    case "present": {
      const action = params.action as "enter" | "exit" | "next" | "prev" | "overview";
      const state = shell.presentation.state();
      if (action !== "enter" && !state.active) {
        throw new Error("Presentation mode is not active — present({action:'enter'}) first");
      }
      shell.presentation[action]();
      return { presentation: action };
    }
    case "highlight": {
      const p = params as { ids: string[]; style?: HighlightStyle };
      // Content-aware (D37): an agent's highlight frames itself when its
      // targets do not already read well. The user's own toolbar highlights
      // never pass through here, so their camera stays theirs.
      if (p.ids.length) await commands.frameTargets(p.ids);
      commands.highlight(p);
      return { highlighted: p.ids };
    }
    case "flow": {
      const p = params as { path: string[]; speed?: number; loop?: boolean };
      if (p.path.length) await commands.frameTargets(p.path);
      await commands.flow(p);
      return { pulsed: p.path };
    }
    case "narrate":
      commands.narrate(params as { text: string | null });
      return { narrating: true };
    case "tour": {
      const completed = await commands.tour(
        params as { steps: TourStep[]; stepMs?: number },
      );
      return { stepsCompleted: completed };
    }
    case "clear_effects":
      commands.clearEffects();
      commands.narrate({ text: null });
      return { cleared: true };
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
