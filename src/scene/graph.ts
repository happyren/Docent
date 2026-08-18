/**
 * Scene graph (S3, B6): the shared address space. Built purely from the
 * adapter's typed snapshot — nodes, edges, frames, groups, with the intent
 * model (legend, tags, notes, narratives) as attributes on the one graph.
 *
 * Provenance discipline (I4): facts read from the drawing are `explicit`;
 * author-stated intent is `declared`; proximity-resolved arrow endpoints are
 * `inferred` and marked as such — never presented as drawing-facts.
 */
import type {
  LegendRule,
  SceneSnapshot,
  SnapshotElement,
} from "../adapter/snapshot";

export type LinkProvenance = "explicit" | "inferred";

export interface GraphNode {
  id: string;
  /** Original Excalidraw element id (graph ids are sanitized derivations, I6). */
  sourceId: string;
  label: string | null;
  shape: string;
  frameId: string | null;
  groupIds: string[];
  tags: string[];
  note: string | null;
  detailFrameId: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  style: {
    strokeColor: string;
    backgroundColor: string;
    strokeStyle: string;
    fillStyle: string;
    strokeWidth: number;
  };
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  from: string | null;
  to: string | null;
  fromProvenance: LinkProvenance | null;
  toProvenance: LinkProvenance | null;
  /**
   * Declared refinement (D21): the inner component of the `to` node's
   * detail diagram this edge actually lands on. Null unless declared AND
   * currently valid (the component must live in that detail frame).
   */
  toRefined: string | null;
  /** Declared refinement of the `from` side — see `toRefined`. */
  fromRefined: string | null;
  label: string | null;
  frameId: string | null;
  style: GraphNode["style"];
}

export interface GraphFrame {
  id: string;
  sourceId: string;
  name: string;
  order: number | null;
  narrative: string | null;
  bounds: GraphNode["bounds"];
}

export interface GraphGroup {
  id: string;
  members: string[];
}

export interface SceneGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  frames: GraphFrame[];
  groups: GraphGroup[];
  legend: LegendRule[];
}

const NODE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "image",
  "embeddable",
  "iframe",
  "text",
]);

/** How far (px) an unbound arrow endpoint may sit from a node and still infer a link. */
const PROXIMITY_PAD = 24;

/** Graph ids derive from Excalidraw ids, sanitized for Mermaid/agent use (I6). */
export function sanitizeId(sourceId: string, taken: Set<string>): string {
  let id = sourceId.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(id)) id = `_${id}`;
  let candidate = id;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${id}_${n}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

function labelFor(
  el: SnapshotElement,
  byId: Map<string, SnapshotElement>,
): string | null {
  if (el.type === "text") return el.text;
  const boundText = el.boundElements.find((b) => b.type === "text");
  if (!boundText) return null;
  return byId.get(boundText.id)?.text ?? null;
}

function round(v: number): number {
  return Math.round(v);
}

function boundsOf(el: SnapshotElement): GraphNode["bounds"] {
  return {
    x: round(el.x),
    y: round(el.y),
    width: round(el.width),
    height: round(el.height),
  };
}

function styleOf(el: SnapshotElement): GraphNode["style"] {
  return {
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    strokeStyle: el.strokeStyle,
    fillStyle: el.fillStyle,
    strokeWidth: el.strokeWidth,
  };
}

function isLegendCarrier(el: SnapshotElement): boolean {
  return el.docent.legend !== null;
}

/** Nearest node whose padded bounds contain the point; null when none. */
function nodeAtPoint(
  x: number,
  y: number,
  candidates: readonly SnapshotElement[],
): SnapshotElement | null {
  let best: SnapshotElement | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const el of candidates) {
    if (
      x >= el.x - PROXIMITY_PAD &&
      x <= el.x + el.width + PROXIMITY_PAD &&
      y >= el.y - PROXIMITY_PAD &&
      y <= el.y + el.height + PROXIMITY_PAD
    ) {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
  }
  return best;
}

export function buildSceneGraph(snapshot: SceneSnapshot): SceneGraph {
  const byId = new Map(snapshot.elements.map((el) => [el.id, el]));

  const legend =
    snapshot.elements.find((el) => isLegendCarrier(el))?.docent.legend ?? [];

  const nodeElements = snapshot.elements.filter(
    (el) =>
      NODE_TYPES.has(el.type) &&
      el.containerId === null && // bound labels belong to their containers
      !isLegendCarrier(el),
  );
  const frameElements = snapshot.elements.filter((el) => el.type === "frame");
  const edgeElements = snapshot.elements.filter((el) => el.type === "arrow");

  // Deterministic id assignment: all graph elements sorted by source id, so
  // sanitization collisions resolve identically on every export (I3/I6).
  const taken = new Set<string>();
  const graphId = new Map<string, string>();
  for (const el of [...frameElements, ...nodeElements, ...edgeElements].sort(
    (a, b) => (a.id < b.id ? -1 : 1),
  )) {
    graphId.set(el.id, sanitizeId(el.id, taken));
  }

  const frames: GraphFrame[] = frameElements
    .map((el) => ({
      id: graphId.get(el.id)!,
      sourceId: el.id,
      name: el.name ?? "",
      order: el.docent.order,
      narrative: el.docent.narrative,
      bounds: boundsOf(el),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const nodes: GraphNode[] = nodeElements
    .map((el) => ({
      id: graphId.get(el.id)!,
      sourceId: el.id,
      label: labelFor(el, byId),
      shape: el.type,
      frameId: el.frameId ? (graphId.get(el.frameId) ?? null) : null,
      groupIds: [...el.groupIds].sort(),
      tags: [...el.docent.tags],
      note: el.docent.note,
      detailFrameId: el.docent.detailFrameId
        ? (graphId.get(el.docent.detailFrameId) ?? null)
        : null,
      bounds: boundsOf(el),
      style: styleOf(el),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = edgeElements
    .map((el) => {
      const resolve = (
        boundId: string | null,
        point: [number, number] | null,
      ): { id: string | null; provenance: LinkProvenance | null } => {
        if (boundId && byId.has(boundId)) {
          const target = graphId.get(boundId);
          if (target) return { id: target, provenance: "explicit" };
        }
        if (point) {
          const hit = nodeAtPoint(
            el.x + point[0],
            el.y + point[1],
            nodeElements,
          );
          if (hit) return { id: graphId.get(hit.id)!, provenance: "inferred" };
        }
        return { id: null, provenance: null };
      };
      const first = el.points?.[0] ?? null;
      const last = el.points?.[el.points.length - 1] ?? null;
      const from = resolve(el.startBindingId, first);
      const to = resolve(el.endBindingId, last);
      // Declared refinement resolves only when the referenced component
      // actually lives in the endpoint's detail diagram — anything else
      // (deleted component, moved out of the frame, no detail declared)
      // reads as no refinement, mirroring detail-link validation.
      const refineOf = (
        endpointId: string | null,
        refinedSourceId: string | null,
      ): string | null => {
        if (!endpointId || !refinedSourceId) return null;
        const endpoint = nodeById.get(endpointId);
        if (!endpoint?.detailFrameId) return null;
        const refinedGraphId = graphId.get(refinedSourceId);
        const refined = refinedGraphId ? nodeById.get(refinedGraphId) : null;
        return refined && refined.frameId === endpoint.detailFrameId
          ? refined.id
          : null;
      };
      return {
        id: graphId.get(el.id)!,
        sourceId: el.id,
        from: from.id,
        to: to.id,
        toRefined: refineOf(to.id, el.docent.refine?.to ?? null),
        fromRefined: refineOf(from.id, el.docent.refine?.from ?? null),
        fromProvenance: from.provenance,
        toProvenance: to.provenance,
        label: labelFor(el, byId),
        frameId: el.frameId ? (graphId.get(el.frameId) ?? null) : null,
        style: styleOf(el),
      };
    })
    .filter((edge) => edge.from !== null || edge.to !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const groupMembers = new Map<string, string[]>();
  for (const node of nodes) {
    for (const groupId of node.groupIds) {
      const members = groupMembers.get(groupId) ?? [];
      members.push(node.id);
      groupMembers.set(groupId, members);
    }
  }
  const groups: GraphGroup[] = [...groupMembers.entries()]
    .map(([id, members]) => ({ id, members: members.sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { nodes, edges, frames, groups, legend };
}
