/**
 * Derived walkthroughs (D58): a tour compiled from what the diagram
 * already carries, nothing authored for it. Stops are the frames in
 * declared order and, inside a frame, the components in flow order —
 * edges first (sources before what they feed), position as the tie-break.
 * Words are the author's where there are any — a frame's narrative, a
 * component's intents, note and logic — and a plain factual line from the
 * graph and legend where there are none, marked `inferred` so a model
 * knows which sentences are its to rewrite. Pure and deterministic (I3).
 */
import type { SceneSnapshot } from "../adapter/snapshot";
import type { TourStep } from "../command/api";
import { applyLegend } from "../export/legend";
import type { GraphEdge, GraphFrame, GraphNode, SceneGraph } from "../scene/graph";
import { computeTiers } from "../scene/tiers";

export interface ScriptStep extends TourStep {
  /** `declared` when the words are the author's; `inferred` when derived. */
  provenance: "declared" | "inferred";
  /** The graph id the step is about — a frame or a node. */
  about: string;
}

export interface TourScript {
  frame: { id: string; name: string } | null;
  tier: number;
  steps: ScriptStep[];
  /** How many of the steps speak the author's own words. */
  declared: number;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Frames in the author's order: declared `order` first, then name, then id. */
export function orderFrames(frames: readonly GraphFrame[]): GraphFrame[] {
  return [...frames].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Components in reading order: a topological order over the edges among
 * them (what feeds comes before what is fed), ties and cycles broken by
 * position — top to bottom, then left to right.
 */
export function flowOrder(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!edge.from || !edge.to || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    out.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const byPosition = (a: GraphNode, b: GraphNode) =>
    a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || (a.id < b.id ? -1 : 1);
  const remaining = new Set(ids);
  const ordered: GraphNode[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (remaining.size) {
    // Everything with no unvisited feeder, in position order; if the rest
    // is a cycle, take the topmost of it and carry on.
    let ready = [...remaining].map((id) => byId.get(id)!).filter((n) => (indegree.get(n.id) ?? 0) === 0);
    if (!ready.length) ready = [[...remaining].map((id) => byId.get(id)!).sort(byPosition)[0]];
    ready.sort(byPosition);
    const next = ready[0];
    ordered.push(next);
    remaining.delete(next.id);
    for (const to of out.get(next.id) ?? []) {
      if (remaining.has(to)) indegree.set(to, (indegree.get(to) ?? 1) - 1);
    }
  }
  return ordered;
}

/** A component's spoken name: its label, else its legend kind, never a raw id. */
function nameOf(node: GraphNode, graph?: SceneGraph): string {
  const label = clean(node.label);
  if (label) return label;
  const kind = graph ? applyLegend(node.style, node.shape, graph.legend).kind : null;
  return kind ? `an unnamed ${kind}` : "an unnamed component";
}

/** A sentence from the graph and legend when the author declared nothing. */
function inferredLine(node: GraphNode, graph: SceneGraph, inFrame: ReadonlySet<string>): string {
  const facts = applyLegend(node.style, node.shape, graph.legend);
  const names = (ids: string[]) =>
    ids
      .map((id) => graph.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => n !== undefined)
      .map((n) => nameOf(n, graph));
  const feeds = names(graph.edges.filter((e) => e.from === node.id && e.to).map((e) => e.to!));
  const fedBy = names(graph.edges.filter((e) => e.to === node.id && e.from).map((e) => e.from!));
  const kind = facts.kind ? `, ${facts.kind},` : "";
  const parts: string[] = [];
  if (fedBy.length) parts.push(`receives from ${list(fedBy)}`);
  if (feeds.length) parts.push(`sends to ${list(feeds)}`);
  const role = parts.length ? ` ${parts.join(" and ")}` : inFrame.size > 1 ? " stands alone here" : "";
  const tags = facts.tags.length ? ` Tagged ${list(facts.tags)}.` : "";
  const detail = node.detailFrameId ? " It opens into a detail layer." : "";
  const name = nameOf(node, graph);
  // "an unnamed StockPool, StockPool," would say the kind twice.
  const kindPart = name.startsWith("an unnamed") ? "" : kind;
  return `${name}${kindPart}${role}.${tags}${detail}`.replace(/\s+\./g, ".");
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** The author's words for a component, or null when there are none. */
function declaredLine(node: GraphNode, graph: SceneGraph): string | null {
  const intents = node.intents.map(clean).filter(Boolean);
  const logic = clean(node.logic);
  if (!intents.length && !logic) return null;
  const name = nameOf(node, graph);
  const sentences: string[] = [];
  if (intents.length) {
    const said = intents.map((i) => (/[.!?]$/.test(i) ? i : `${i}.`));
    sentences.push(`${name}: ${said.join(" ")}`);
  }
  if (logic) sentences.push(`Its logic: ${/[.!?]$/.test(logic) ? logic : `${logic}.`}`);
  return sentences.join(" ");
}

/**
 * Compile the walkthrough. With a frame, that frame's stops; without one,
 * every Layer 1 frame in order, each opened by its narrative and followed
 * by its components. Components outside any frame come last as Layer 1.
 */
export function scriptTour(
  graph: SceneGraph,
  snapshot: SceneSnapshot,
  options: { frame?: string | null } = {},
): TourScript {
  const tiers = computeTiers(snapshot);
  const tierOf = (frame: GraphFrame) => tiers.frameTier.get(frame.sourceId) ?? 1;
  let frames: GraphFrame[];
  let chosen: GraphFrame | null = null;
  if (options.frame) {
    chosen =
      graph.frames.find((f) => f.id === options.frame || f.sourceId === options.frame) ?? null;
    if (!chosen) throw new Error(`Unknown frame id: ${options.frame} — use ids from get_outline`);
    frames = [chosen];
  } else {
    frames = orderFrames(graph.frames.filter((f) => tierOf(f) === 1));
  }
  const steps: ScriptStep[] = [];
  const frameStep = (frame: GraphFrame, members: GraphNode[]) => {
    const narrative = clean(frame.narrative);
    const name = clean(frame.name) || "this frame";
    steps.push({
      focus: frame.id,
      about: frame.id,
      narrate:
        narrative ||
        `${name}: ${members.length} component${members.length === 1 ? "" : "s"}${
          members.length ? ` — ${list(members.slice(0, 4).map((n) => nameOf(n, graph)))}${members.length > 4 ? ", and more" : ""}` : ""
        }.`,
      provenance: narrative ? "declared" : "inferred",
    });
  };
  const nodeSteps = (members: GraphNode[]) => {
    const inFrame = new Set(members.map((n) => n.id));
    for (const node of flowOrder(members, graph.edges)) {
      const declared = declaredLine(node, graph);
      steps.push({
        focus: node.id,
        about: node.id,
        highlight: [node.id],
        narrate: declared ?? inferredLine(node, graph, inFrame),
        provenance: declared ? "declared" : "inferred",
      });
    }
  };
  for (const frame of frames) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    frameStep(frame, members);
    nodeSteps(members);
  }
  if (!chosen) {
    const loose = graph.nodes.filter((n) => n.frameId === null);
    if (loose.length) nodeSteps(loose);
  }
  return {
    frame: chosen ? { id: chosen.id, name: chosen.name } : null,
    tier: chosen ? tierOf(chosen) : 1,
    steps,
    declared: steps.filter((s) => s.provenance === "declared").length,
  };
}
