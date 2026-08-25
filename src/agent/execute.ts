/**
 * The page-side tool executor (B4, D35): every agent tool call — arriving
 * over the self-host bridge or the desktop shell's pipe — lands here and
 * runs against the Command API plus a narrow set of shell hooks. Read-only
 * by construction: the scene document is never modified; camera, overlay,
 * narration, presentation, drill, and scene opening are navigation.
 */
import type { CommandAPI } from "../command/api";
import type { Scenario } from "../adapter/snapshot";
import type { HighlightStyle } from "../overlay/state";
import type { TourStep } from "../command/api";
import { detailBadges } from "../scene/detailBadges";
import { computeTiers } from "../scene/tiers";
import { scriptTour } from "./script";
import { GENRE_IDS, genreOf, type GenreProfile } from "../authoring/genre";
import type { Op } from "../authoring/ops";
import type { TidyScope } from "../authoring/tidy";
import type { SceneGraph } from "../scene/graph";
import { applyLegend } from "../export/legend";
import { exportFrameSidecar, exportScene, exportSidecar } from "../export";
import { listProjects, listScenes } from "../portfolio/client";
import catalogJson from "../../public/libraries/catalog.json";
import { answerFindSymbol, loadCatalog, type SymbolCatalog } from "../libraries/catalog";

/** Above this many components, get_scene_graph answers with the outline (D45). */
export const WALL_THRESHOLD = 150;

/**
 * The bundled symbol catalog (D81), parsed once: `find_symbol` reads static
 * data, so it needs no canvas and never touches the scene (D82).
 */
let catalog: SymbolCatalog | null = null;
const symbolCatalog = (): SymbolCatalog => (catalog ??= loadCatalog(catalogJson));

/** What the outline says of a paragraph: its first sentence, capped (D45). */
const opener = (text: string | null | undefined) =>
  (text ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 140);

/**
 * The table of contents (D45): tiers, frames with their tier and parentage,
 * narrative openers, component counts, and which components go deeper — and
 * the conventions the scene was drawn under, its genre and its scenarios
 * (D87, D89), which are as much a part of reading it as the frames are.
 */
export function buildOutline(commands: CommandAPI, graph: SceneGraph) {
  const snapshot = commands.getSceneSnapshot();
  const tiers = computeTiers(snapshot);
  const profile = genreOf(graph.genre);
  const frameGraphId = (sourceId: string | null) =>
    sourceId ? (graph.frames.find((f) => f.sourceId === sourceId)?.id ?? null) : null;
  const nodeBySource = new Map(graph.nodes.map((n) => [n.sourceId, n]));
  const frames = graph.frames
    .map((frame) => {
      const members = graph.nodes.filter((n) => n.frameId === frame.id);
      const parent = tiers.detailParent.get(frame.sourceId);
      const via = parent ? nodeBySource.get(parent.elementId) : undefined;
      const narrative = opener(frame.narrative);
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
        ...(narrative ? { narrative } : {}),
        components: members.length,
        deeper: members
          .filter((n) => n.detailFrameId !== null)
          .map((n) => ({ id: n.id, label: n.label, detail: n.detailFrameId })),
      };
    })
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  return {
    tiers: tiers.maxTier,
    // The genre by the name it is called, not its id: the outline is read.
    ...(profile ? { genre: profile.name } : {}),
    components: graph.nodes.length,
    edges: graph.edges.length,
    frameless: graph.nodes.filter((n) => n.frameId === null).length,
    ...(graph.scenarios.length
      ? {
          scenarios: graph.scenarios.map((s) => {
            const description = opener(s.description);
            return { name: s.name, steps: s.path.length, ...(description ? { description } : {}) };
          }),
        }
      : {}),
    frames,
  };
}

/** Field weights for find (D45): the author's words outrank heuristics. */
const FIND_WEIGHTS: Record<string, number> = {
  label: 5,
  scenario: 5,
  intents: 4,
  description: 4,
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
    type: "node" | "edge" | "frame" | "scenario";
    label: string | null;
    frame: string | null;
    trail: { id: string; name: string }[];
    score: number;
    matched: string[];
    /** Scenarios only (D89): how many edges the story steps through. */
    steps?: number;
  }[] = [];
  for (const node of graph.nodes) {
    const facts = applyLegend(node.style, node.shape, graph.legend, node.symbol);
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
  // A scenario is meaning the map carries (D89), so it is findable like any
  // other: the hit answers with the story's name, how long it runs, and the
  // edge it starts on — enough to focus or flow it without a second call.
  for (const scenario of graph.scenarios) {
    const { total, matched } = score({
      scenario: [scenario.name],
      description: [scenario.description ?? ""],
    });
    if (total === 0) continue;
    const first = graph.edges.find((e) => e.sourceId === scenario.path[0]);
    hits.push({
      id: first?.id ?? scenario.path[0],
      type: "scenario",
      label: scenario.name,
      frame: first?.frameId ?? null,
      trail: trailOf(first?.frameId ?? null),
      score: total,
      matched,
      steps: scenario.path.length,
    });
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
  /** Authoring (S19, D65): the store's own routes, never Git beyond a branch. */
  authoring?: {
    /** Save the canvas back where it came from; rejects for a loose file. */
    saveScene(): Promise<{ project: string; scene: string }>;
    /** Create an empty scene in a project and open it. */
    createScene(project: string, scene: string): Promise<void>;
    /** Where the open scene's project stands with GitHub, or null when unbound. */
    binding(project: string): Promise<{ branch: string; baseBranch: string } | null>;
    /** Cut a branch off the active one and move the project onto it. */
    createBranch(project: string, name: string): Promise<void>;
  };
}

/** An edit's answer with the way forward. */
function withNext(result: import("../command/api").EditResult) {
  const warns = result.lint.findings.filter((f) => f.level === "warn").length;
  return {
    ...result,
    next: warns
      ? `${warns} warning${warns === 1 ? "" : "s"} remain (see lint) — update what is missing; save_scene when done`
      : "validate is clean — save_scene when done; show the result with focus or a tour",
  };
}

/**
 * The one scope a tidy names (D73). Exactly one, always: a call that meant
 * two things would format more than the caller asked for, and Tidy may move
 * hand-placed work only because it was asked to (D60).
 */
function tidyScopeFrom(params: Record<string, unknown>): TidyScope {
  const named = ["frame", "tier", "all", "selection"].filter((key) => params[key] !== undefined);
  if (named.length !== 1) {
    throw new Error("tidy takes exactly one of frame, tier, all, selection — e.g. tidy({frame:'f_core'})");
  }
  if (params.frame !== undefined) return { frame: params.frame === null ? null : String(params.frame) };
  if (params.tier !== undefined) {
    const tier = Number(params.tier);
    if (!Number.isInteger(tier) || tier < 1) throw new Error("tidy({tier}) takes a tier number — 1 is Layer 1");
    return { tier };
  }
  if (params.all !== undefined) {
    if (params.all !== true) throw new Error("tidy({all:false}) says nothing — pass all:true, or name a frame, a tier, or a selection");
    return { all: true };
  }
  const selection = params.selection;
  if (!Array.isArray(selection) || !selection.length) throw new Error("tidy({selection}) needs a non-empty list of ids");
  return { selection: selection.map(String) };
}

/**
 * The scenario a tool named (D89): matched on the author's own name, case
 * and padding aside. An unknown name says which stories the scene does
 * carry — a replay that quietly pulsed nothing would teach nothing (I5).
 */
function scenarioOf(graph: SceneGraph, name: string): Scenario {
  const wanted = name.trim().toLowerCase();
  const found = graph.scenarios.find((s) => s.name.toLowerCase() === wanted);
  if (found) return found;
  throw new Error(
    graph.scenarios.length
      ? `Unknown scenario: ${name} — this scene has ${graph.scenarios.map((s) => `"${s.name}"`).join(", ")}`
      : `Unknown scenario: ${name} — this scene has none; define_scenario({name, path}) names one`,
  );
}

/**
 * The `narrate` a camera command may carry (D57): said on arrival, never
 * waited for — the next command's gate is what waits.
 */
function sayOnArrival(commands: CommandAPI, params: Record<string, unknown>): void {
  const text = params.narrate;
  if (typeof text === "string" && text.trim()) void commands.narrate({ text });
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
    case "find_symbol":
      return answerFindSymbol(symbolCatalog(), params);
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
      await commands.awaitSpeech(params.interrupt === true);
      await shell.openScene(project, scene);
      sayOnArrival(commands, params);
      return {
        opened: { project, scene },
        next: "get_outline to see its tiers and frames; find({query}) to locate a part",
      };
    }
    case "get_view": {
      // The shell speaks in source ids; agents live in graph-id space (I5).
      const graph = commands.getSceneGraph();
      const frameGraphId = (sourceId: string) =>
        graph.frames.find((f) => f.sourceId === sourceId)?.id ?? sourceId;
      const p = shell.presentation.state();
      const scene = shell.currentScene();
      const binding = scene && shell.authoring ? await shell.authoring.binding(scene.project).catch(() => null) : null;
      return {
        scene,
        canEdit: commands.canEdit(),
        ...(binding
          ? {
              git: {
                branch: binding.branch,
                baseBranch: binding.baseBranch,
                onBase: binding.branch === binding.baseBranch,
              },
            }
          : {}),
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
        params as {
          id: string;
          padding?: number;
          context?: "neighbors" | "self";
          narrate?: string;
          interrupt?: boolean;
        },
      );
      return {
        focused: (params as { id: string }).id,
        next: "focus the next stop (with narrate), highlight or flow to show a point, dive if it has detail",
      };
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
      await commands.awaitSpeech(params.interrupt === true);
      const dived = shell.drill.dive(badge?.diveElementId ?? node.sourceId);
      if (!dived) throw new Error(`Could not dive into ${id} — the detail frame is gone`);
      sayOnArrival(commands, params);
      return {
        dived: node.detailFrameId,
        next: "read_frame this layer, then focus its components in order; climb to return",
      };
    }
    case "climb": {
      const trail = shell.drill.trail();
      if (trail.length === 0) {
        return { climbed: false, note: "Already at Layer 1 — nothing above this tier." };
      }
      await commands.awaitSpeech(params.interrupt === true);
      shell.drill.up();
      sayOnArrival(commands, params);
      return { climbed: true, next: "focus the next component on this tier" };
    }
    case "present": {
      const action = params.action as "enter" | "exit" | "next" | "prev" | "overview";
      const state = shell.presentation.state();
      if (action !== "enter" && !state.active) {
        throw new Error("Presentation mode is not active — present({action:'enter'}) first");
      }
      if ((action === "next" || action === "prev") && state.mode === "guided") {
        throw new Error(
          "This is a guided presentation — move the camera with focus or tour; there is no next frame",
        );
      }
      await commands.awaitSpeech(params.interrupt === true);
      if (action === "enter") {
        const mode = (params.mode as "frames" | "guided" | undefined) ?? "frames";
        shell.presentation.enter(mode);
        sayOnArrival(commands, params);
        return {
          presentation: action,
          mode,
          next:
            mode === "guided"
              ? "focus each stop with narrate, or run a tour; present({action:'exit'}) when done"
              : "present({action:'next'}) as you narrate each waypoint",
        };
      }
      shell.presentation[action]();
      sayOnArrival(commands, params);
      return { presentation: action, mode: state.mode };
    }
    case "highlight": {
      const p = params as { ids: string[]; style?: HighlightStyle; interrupt?: boolean };
      // Content-aware (D37): an agent's highlight frames itself when its
      // targets do not already read well. The user's own toolbar highlights
      // never pass through here, so their camera stays theirs.
      await commands.awaitSpeech(p.interrupt === true);
      if (p.ids.length) await commands.frameTargets(p.ids);
      commands.highlight(p);
      sayOnArrival(commands, params);
      return { highlighted: p.ids, next: "narrate what is lit, or highlight({ids:[]}) to clear" };
    }
    case "flow": {
      const p = params as { path?: string[]; scenario?: string; speed?: number; loop?: boolean; interrupt?: boolean };
      const named = typeof p.scenario === "string" && p.scenario.trim() !== "";
      if (named && p.path) {
        throw new Error("flow takes a path of edge ids or a scenario, never both — flow({scenario:'Checkout'}) replays the one the author named");
      }
      if (!named && !p.path) {
        throw new Error("flow needs a path of edge ids or a scenario — flow({path:['e_req','e_charge']}) or flow({scenario:'Checkout'})");
      }
      // Replay is the machinery that already exists (D89): the same pulse,
      // over the path the author named, with its steps numbered on the
      // overlay for as long as it runs (I2).
      let scenario: Scenario | null = null;
      let path = p.path ?? [];
      if (named) {
        const graph = commands.getSceneGraph();
        scenario = scenarioOf(graph, p.scenario!);
        // Scenarios are stored by element id (I6); agents live in graph ids.
        path = scenario.path.map((step) => graph.edges.find((e) => e.sourceId === step)?.id ?? step);
      }
      await commands.awaitSpeech(p.interrupt === true);
      if (path.length) await commands.frameTargets(path);
      sayOnArrival(commands, params);
      await commands.flow({ path, speed: p.speed, loop: p.loop, steps: scenario !== null });
      return scenario
        ? { pulsed: path, scenario: scenario.name, steps: path.length }
        : { pulsed: path };
    }
    case "narrate": {
      // Returns as soon as the voice has started (D57): the camera is what
      // waits for the sentence, not the agent. wait:true asks to stay.
      const p = params as { text: string | null; wait?: boolean };
      const spoken = await commands.narrate({ text: p.text, wait: p.wait === true });
      return { narrating: true, spoken };
    }
    case "tour": {
      const completed = await commands.tour(
        params as { steps: TourStep[]; stepMs?: number },
      );
      return { stepsCompleted: completed };
    }
    case "script_tour": {
      // Derived, never authored (D58): the diagram's own order and words —
      // or, for a scenario, the path the author named and the words on it.
      const graph = commands.getSceneGraph();
      const named = typeof params.scenario === "string" && params.scenario.trim() !== "";
      const script = scriptTour(graph, commands.getSceneSnapshot(), {
        frame: (params.frame as string | undefined) ?? null,
        scenario: named ? scenarioOf(graph, params.scenario as string) : null,
      });
      return {
        ...script,
        next:
          "run it as is with tour({steps}) — or rewrite the `inferred` lines in your own words first, keeping the `declared` ones; for a guided walkthrough, present({action:'enter', mode:'guided'}) before the tour",
      };
    }
    case "clear_effects":
      commands.clearEffects();
      void commands.narrate({ text: null });
      return { cleared: true };

    // --- authoring (S19) --------------------------------------------------
    case "add_node":
    case "add_edge":
    case "update":
    case "remove":
    case "add_frame":
    case "add_detail_layer":
    case "define_kind":
    case "layout":
      return withNext(await commands.edit([{ ...params, op: tool } as Op]));
    case "edit": {
      const ops = params.ops as Op[] | undefined;
      if (!Array.isArray(ops) || !ops.length) throw new Error("edit needs a non-empty ops list");
      return withNext(await commands.edit(ops));
    }
    // The conventions (D87, D89) go down the same path as any other edit —
    // one validated batch, one undo step, the changelog — and answer with
    // what the caller needs next rather than with the lint's warnings.
    case "use_genre": {
      const asked = String(params.genre ?? "");
      const result = await commands.edit([{ op: "use_genre", genre: asked }]);
      // The op refuses an unknown genre, so by here the profile is there.
      const profile = genreOf(asked)!;
      return {
        ...result,
        genre: profile.id,
        // The recipe arrives when it is ordered (D91) — the menu stays short.
        guidance: profile.guidance,
        next: "draw with the seeded kinds — a kind and an intent on every component — then validate() and tidy()",
      };
    }
    case "define_scenario": {
      const name = String(params.name ?? "");
      const path = (params.path as string[] | undefined) ?? [];
      const result = await commands.edit([
        {
          op: "define_scenario",
          name,
          path,
          ...(params.description !== undefined ? { description: String(params.description) } : {}),
        },
      ]);
      return {
        ...result,
        scenario: name,
        steps: path.length,
        next: `replay it: flow({scenario:'${name}'}) pulses the path with numbered steps, script_tour({scenario:'${name}'}) walks and speaks it`,
      };
    }
    // The formatter (D73): the same write path as edit, and a meaning
    // changelog that comes back empty or the whole thing is put back.
    case "tidy":
      return await commands.tidy(tidyScopeFrom(params));
    case "propose": {
      const ops = params.ops as Op[] | undefined;
      if (!Array.isArray(ops) || !ops.length) throw new Error("propose needs a non-empty ops list");
      return { ...commands.propose(ops), next: "edit({ops}) with the same ops to apply, or revise" };
    }
    case "validate":
      return { ...commands.validate(), next: "fix what is listed with update / add_detail_layer, then validate again" };
    case "undo_edit":
      return { undone: commands.undoAgentEdit() };
    case "save_scene": {
      if (!shell.authoring) throw new Error("Saving is not available here");
      const saved = await shell.authoring.saveScene();
      return { saved, next: "the checkpointer lands it on the branch; the person opens the pull request" };
    }
    case "create_scene": {
      if (!shell.authoring) throw new Error("Creating scenes is not available here");
      if (shell.isDirty()) {
        throw new Error("The canvas has unsaved changes — ask the person to save or discard them first");
      }
      const { project, scene } = params as { project: string; scene: string };
      // A genre is checked before the scene is made (D87): a typo must not
      // leave an empty scene behind to explain.
      const asked = params.genre === undefined || params.genre === null ? null : String(params.genre);
      const profile: GenreProfile | null = asked ? genreOf(asked) : null;
      if (asked && !profile) throw new Error(`Unknown genre "${asked}" — one of ${GENRE_IDS.join(", ")}`);
      await commands.awaitSpeech(params.interrupt === true);
      await shell.authoring.createScene(project, scene);
      if (!profile) {
        return { created: { project, scene }, next: "define_kind for the kinds you will use, add_frame, then edit in batches" };
      }
      // The genre seeds the new scene down the same op an agent would call
      // itself, and answers with the recipe (D87, D91).
      const seeded = await commands.edit([{ op: "use_genre", genre: profile.id }]);
      // The seeding is part of the creation, so it is saved as part of it:
      // an unsaved genre would evaporate on the next open, and the dirty
      // canvas would block the next create_scene besides.
      await shell.authoring.saveScene();
      return {
        created: { project, scene },
        genre: profile.id,
        changelog: seeded.changelog,
        notes: seeded.notes,
        guidance: profile.guidance,
        next: "add_frame, then draw with the seeded kinds in batches — validate() and tidy() as you go",
      };
    }
    case "create_branch": {
      if (!shell.authoring) throw new Error("Branches are not available here");
      const scene = shell.currentScene();
      if (!scene) throw new Error("No portfolio scene is open — open_scene first");
      const name = String(params.name ?? "").trim();
      if (!name) throw new Error("create_branch needs a name, e.g. docent/retry-queue");
      await shell.authoring.createBranch(scene.project, name);
      return { branch: name, project: scene.project, next: "edit; saves check point onto this branch; the person opens the pull request" };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
