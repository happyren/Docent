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
import { computeTiers } from "../scene/tiers";
import type { SceneGraph } from "../scene/graph";
import { applyLegend } from "../export/legend";
import { exportFrameSidecar, exportScene, exportSidecar } from "../export";
import { listProjects, listScenes } from "../portfolio/client";

/** Above this many components, get_scene_graph answers with the outline (D45). */
export const WALL_THRESHOLD = 150;

/**
 * The table of contents (D45): tiers, frames with their tier and parentage,
 * narrative openers, component counts, and which components go deeper.
 */
export function buildOutline(commands: CommandAPI, graph: SceneGraph) {
  const snapshot = commands.getSceneSnapshot();
  const tiers = computeTiers(snapshot);
  const frameGraphId = (sourceId: string | null) =>
    sourceId ? (graph.frames.find((f) => f.sourceId === sourceId)?.id ?? null) : null;
  const nodeBySource = new Map(graph.nodes.map((n) => [n.sourceId, n]));
  const frames = graph.frames
    .map((frame) => {
      const members = graph.nodes.filter((n) => n.frameId === frame.id);
      const parent = tiers.detailParent.get(frame.sourceId);
      const via = parent ? nodeBySource.get(parent.elementId) : undefined;
      const opener = (frame.narrative ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 140);
      return {
        id: frame.id,
        name: frame.name,
        tier: tiers.frameTier.get(frame.sourceId) ?? 1,
        ...(parent
          ? {
              parent: frameGraphId(parent.parentFrameId),
              via: via ? { id: via.id, label: via.label } : null,
            }
          : {}),
        ...(opener ? { narrative: opener } : {}),
        components: members.length,
        deeper: members
          .filter((n) => n.detailFrameId !== null)
          .map((n) => ({ id: n.id, label: n.label, detail: n.detailFrameId })),
      };
    })
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  return {
    tiers: tiers.maxTier,
    components: graph.nodes.length,
    edges: graph.edges.length,
    frameless: graph.nodes.filter((n) => n.frameId === null).length,
    frames,
  };
}

/** Field weights for find (D45): the author's words outrank heuristics. */
const FIND_WEIGHTS: Record<string, number> = {
  label: 5,
  intents: 4,
  note: 4,
  tags: 3,
  name: 3,
  kind: 3,
  logic: 2,
  narrative: 2,
  id: 1,
};

/**
 * Keyword search across every tier (D45). Any token may match; hits are
 * ranked by how many fields and tokens matched, weighted by field, and
 * each carries its tier trail.
 */
export function findInDiagram(commands: CommandAPI, graph: SceneGraph, query: string) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return { hits: [] };
  const snapshot = commands.getSceneSnapshot();
  const tiers = computeTiers(snapshot);
  const frameBySource = new Map(graph.frames.map((f) => [f.sourceId, f]));
  const frameById = new Map(graph.frames.map((f) => [f.id, f]));
  // The tier path from Layer 1 down to (and including) a frame.
  const trailOf = (frameGraphId: string | null): { id: string; name: string }[] => {
    const trail: { id: string; name: string }[] = [];
    let current = frameGraphId ? (frameById.get(frameGraphId)?.sourceId ?? null) : null;
    while (current) {
      const frame = frameBySource.get(current);
      if (!frame) break;
      const parent = tiers.detailParent.get(current);
      // Only detail frames are part of a trail; a Layer-1 frame is the floor.
      if (!parent) break;
      trail.unshift({ id: frame.id, name: frame.name });
      current = parent.parentFrameId;
    }
    return trail;
  };
  const score = (fields: Record<string, string[]>) => {
    let total = 0;
    const matched: string[] = [];
    for (const [field, values] of Object.entries(fields)) {
      const text = values.join(" ").toLowerCase();
      if (!text) continue;
      const hits = tokens.filter((t) => text.includes(t)).length;
      if (hits > 0) {
        total += hits * (FIND_WEIGHTS[field] ?? 1);
        matched.push(field);
      }
    }
    return { total, matched };
  };
  const hits: {
    id: string;
    type: "node" | "edge" | "frame";
    label: string | null;
    frame: string | null;
    trail: { id: string; name: string }[];
    score: number;
    matched: string[];
  }[] = [];
  for (const node of graph.nodes) {
    const facts = applyLegend(node.style, node.shape, graph.legend);
    const { total, matched } = score({
      label: [node.label ?? ""],
      id: [node.id],
      intents: node.intents,
      tags: [...node.tags, ...facts.tags],
      kind: [facts.kind ?? "", ...Object.values(facts.props)],
      logic: [node.logic ?? ""],
    });
    if (total > 0) {
      hits.push({
        id: node.id,
        type: "node",
        label: node.label,
        frame: node.frameId,
        trail: trailOf(node.frameId),
        score: total,
        matched,
      });
    }
  }
  for (const edge of graph.edges) {
    const facts = applyLegend(edge.style, "arrow", graph.legend);
    const { total, matched } = score({
      label: [edge.label ?? ""],
      id: [edge.id],
      intents: edge.intents,
      tags: facts.tags,
      kind: Object.values(facts.props),
      logic: [edge.logic ?? ""],
    });
    if (total > 0) {
      hits.push({
        id: edge.id,
        type: "edge",
        label: edge.label,
        frame: edge.frameId,
        trail: trailOf(edge.frameId),
        score: total,
        matched,
      });
    }
  }
  for (const frame of graph.frames) {
    const { total, matched } = score({
      name: [frame.name],
      id: [frame.id],
      narrative: [frame.narrative ?? ""],
    });
    if (total > 0) {
      hits.push({
        id: frame.id,
        type: "frame",
        label: frame.name,
        frame: null,
        trail: trailOf(frame.id),
        score: total,
        matched,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { hits: hits.slice(0, 25) };
}

/** What the shell (App) lends the agent — navigation, never mutation. */
export interface AgentShellHooks {
  presentation: {
    /** `frames` walks the author's waypoints; `guided` leaves the camera to the narrator (D54). */
    enter(mode?: "frames" | "guided"): void;
    exit(): void;
    next(): void;
    prev(): void;
    overview(): void;
    state(): {
      active: boolean;
      mode: "frames" | "guided" | null;
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
    case "get_scene_graph": {
      // The legend-applied semantic view (D43): the sidecar's entity model
      // — the same thing the file export and read_frame say.
      const graph = commands.getSceneGraph();
      if (graph.nodes.length > WALL_THRESHOLD && params.force !== true) {
        return {
          note: `This diagram has ${graph.nodes.length} components — read it progressively: get_outline, then read_frame on the frame in question, find({query}) to locate a part, dive/climb between tiers. Pass force: true for the whole graph anyway.`,
          outline: buildOutline(commands, graph),
        };
      }
      return JSON.parse(exportSidecar(graph));
    }
    case "get_outline":
      return buildOutline(commands, commands.getSceneGraph());
    case "find":
      return findInDiagram(commands, commands.getSceneGraph(), String(params.query ?? ""));
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
              mode: p.mode,
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
      await commands.focus(
        params as { id: string; padding?: number; context?: "neighbors" | "self" },
      );
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
      if (action === "enter") {
        const mode = (params.mode as "frames" | "guided" | undefined) ?? "frames";
        shell.presentation.enter(mode);
        return { presentation: action, mode };
      }
      if ((action === "next" || action === "prev") && state.mode === "guided") {
        throw new Error(
          "This is a guided presentation — move the camera with focus or tour; there is no next frame",
        );
      }
      shell.presentation[action]();
      return { presentation: action, mode: state.mode };
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
    case "narrate": {
      // Waits for the voice by default (D55): the agent is the narrator and
      // moves on when the sentence is done. Silent shells answer at once.
      const p = params as { text: string | null; wait?: boolean };
      const spoken = await commands.narrate({ text: p.text, wait: p.wait !== false });
      return { narrating: true, spoken };
    }
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
