/**
 * Tidy's scope (S20, D73): what "this frame", "this tier", "the whole
 * diagram", or "what I have selected" means, compiled into the `layout`
 * ops that re-flow exactly those regions — the D74 pipeline, the D75
 * edges, nothing else. Pure and deterministic (I3): the same scene and
 * the same scope give the same ops in the same order, so two runs draw
 * one picture.
 *
 * A region is a frame, or `null` for the components that sit on Layer 1
 * without one. Regions come out in the author's own order — frames by
 * declared order, then name, then id (the order a tour walks them in) —
 * shallowest tier first, with the unframed leftovers last.
 */
import type { SceneSnapshot } from "../adapter/snapshot";
import { orderFrames } from "../agent/script";
import { buildSceneGraph, type SceneGraph } from "../scene/graph";
import { computeTiers, type TierInfo } from "../scene/tiers";
import type { Layout, Op } from "./ops";

/** Exactly one of these: a frame (null = the unframed Layer 1), a tier, everything, a selection. */
export type TidyScope =
  | { frame: string | null }
  | { tier: number }
  | { all: true }
  | { selection: string[] };

export interface TidyTargets {
  /** The `layout` ops, in the order they should run. */
  ops: Layout[];
  /** How many frames the ops name — the unframed Layer 1 bucket is not a frame. */
  frames: number;
  /** How many components the ops re-flow, every region together. */
  components: number;
}

/** A region: a frame's graph id, or null for the unframed Layer 1 components. */
type Region = string | null;

/** Frames of one tier, in the author's order. */
function framesOfTier(graph: SceneGraph, tiers: TierInfo, tier: number): string[] {
  return orderFrames(graph.frames.filter((f) => (tiers.frameTier.get(f.sourceId) ?? 1) === tier)).map((f) => f.id);
}

function membersOf(graph: SceneGraph, region: Region): number {
  return graph.nodes.filter((n) => n.frameId === region).length;
}

/** A frame handle from a caller — a graph id, or the raw element id it derives from. */
function resolveFrame(graph: SceneGraph, handle: string): string {
  const found = graph.frames.find((f) => f.id === handle) ?? graph.frames.find((f) => f.sourceId === handle);
  // Unknown handles pass through untouched: `plan` is the one that reports
  // an id nobody knows, and it says so better than a silent empty tidy.
  return found?.id ?? handle;
}

/** The regions a selection touches, deduplicated; a selected frame is itself. */
function regionsOfSelection(graph: SceneGraph, ids: readonly string[]): Set<Region> {
  const regions = new Set<Region>();
  for (const id of ids) {
    const frame = graph.frames.find((f) => f.id === id || f.sourceId === id);
    if (frame) {
      regions.add(frame.id);
      continue;
    }
    const node = graph.nodes.find((n) => n.id === id || n.sourceId === id);
    if (node) {
      regions.add(node.frameId);
      continue;
    }
    const edge = graph.edges.find((e) => e.id === id || e.sourceId === id);
    if (edge) regions.add(edge.frameId);
  }
  return regions;
}

/** Every region of the diagram, tier by tier, the unframed leftovers last. */
function allRegions(graph: SceneGraph, tiers: TierInfo): Region[] {
  const regions: Region[] = [];
  for (let tier = 1; tier <= tiers.maxTier; tier++) regions.push(...framesOfTier(graph, tiers, tier));
  regions.push(null);
  return regions;
}

function regionsFor(graph: SceneGraph, tiers: TierInfo, scope: TidyScope): Region[] {
  if ("frame" in scope) return [scope.frame === null ? null : resolveFrame(graph, scope.frame)];
  if ("tier" in scope) {
    const frames = framesOfTier(graph, tiers, scope.tier);
    // Layer 1 is its frames *and* whatever was never framed.
    return scope.tier === 1 ? [...frames, null] : frames;
  }
  if ("all" in scope) return allRegions(graph, tiers);
  const wanted = regionsOfSelection(graph, scope.selection);
  return allRegions(graph, tiers).filter((r) => wanted.has(r));
}

/**
 * The `layout` ops for a scope, with what they will re-flow (D73). Regions
 * holding nothing are dropped — a tidy reports what it moved, and an op
 * that arranges nothing is not part of that.
 */
export function tidyTargets(snapshot: SceneSnapshot, scope: TidyScope): TidyTargets {
  const graph = buildSceneGraph(snapshot);
  const tiers = computeTiers(snapshot);
  const known = new Set(graph.frames.map((f) => f.id));
  let frames = 0;
  let components = 0;
  const ops: Layout[] = [];
  for (const region of regionsFor(graph, tiers, scope)) {
    const count = membersOf(graph, region);
    // A frame nobody knows still becomes an op, so `plan` can say so.
    if (!count && (region === null || known.has(region))) continue;
    if (region !== null) frames += 1;
    components += count;
    ops.push({ op: "layout", frame: region });
  }
  return { ops, frames, components };
}

/** The ops alone — `plan` them, `simulate` them, or hand them to `edit`. */
export function tidyOps(snapshot: SceneSnapshot, scope: TidyScope): Op[] {
  return tidyTargets(snapshot, scope).ops;
}
