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
  Scenario,
  SceneLink,
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
  /** Every declared intent in order (D41); `note` is the first. */
  intents: string[];
  /** Declared pseudocode/rules (D42). */
  logic: string | null;
  detailFrameId: string | null;
  /**
   * The scene this component points at (D95), declared by the author: the
   * drill affordance dives on `detailFrameId` and links on this one.
   */
  link: SceneLink | null;
  /**
   * Set when this node stands for a grouped composite (D22) — a library
   * icon drawn from many primitives reads as ONE component. `members` is
   * how many source elements it collapses; `provenance` is `declared`
   * when the author marked the group, `inferred` from the glyph
   * signature (the group draws with primitives, not just shapes).
   */
  composite: { members: number; provenance: "declared" | "inferred" } | null;
  /**
   * The library symbol this component is drawn as (D83), read off its
   * carrier — the invisible rectangle on the icon's bounds. Null for a
   * component drawn as a shape.
   */
  symbol: string | null;
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
  /** Declared intents of the edge (D41) and its logic (D42). */
  intents: string[];
  logic: string | null;
  /** The scene this edge points at (D95) — an arrow tells a story too. */
  link: SceneLink | null;
  style: GraphNode["style"];
}

export interface GraphFrame {
  id: string;
  sourceId: string;
  name: string;
  order: number | null;
  narrative: string | null;
  /** The scene this frame points at (D95). */
  link: SceneLink | null;
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
  /**
   * The genre the scene was drawn in (D87), off the same carrier the
   * legend comes from — what turns on a genre's lint and its posture.
   * Null when the author has adopted none.
   */
  genre: string | null;
  /** The scene's scenarios (D89), in the order they were authored. */
  scenarios: Scenario[];
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

/** How far apart two parts of one glyph may sit and still read as touching. */
const CLUSTER_PAD = 8;

/**
 * Free-floating text drawn inside one of the group's own shapes — glyph
 * lettering rather than a component's name. Bound labels are excluded by
 * definition: typing into a shape is how an author names a component,
 * while icon lettering is placed over the artwork.
 */
function isInternalLettering(
  element: SnapshotElement,
  members: SnapshotElement[],
): boolean {
  if (element.type !== "text" || element.containerId !== null) return false;
  // Drawn within one of the glyph's own shapes. A caption sits outside the
  // artwork (below or beside it), which keeps it counting as the name.
  return members.some(
    (other) =>
      other !== element &&
      other.type !== "text" &&
      element.x >= other.x - CLUSTER_PAD &&
      element.y >= other.y - CLUSTER_PAD &&
      element.x + element.width <= other.x + other.width + CLUSTER_PAD &&
      element.y + element.height <= other.y + other.height + CLUSTER_PAD,
  );
}

/**
 * Whether the shape members form a single connected cluster — parts of one
 * drawn thing overlap or abut (a cylinder's ellipses and body), while
 * separately grouped components stand apart. Text members float free (a
 * caption sits below its glyph) and don't affect connectivity.
 */
function formsOneCluster(members: SnapshotElement[]): boolean {
  const shapes = members.filter((m) => m.type !== "text");
  if (shapes.length < 2) return true;
  const touches = (a: SnapshotElement, b: SnapshotElement) =>
    a.x - CLUSTER_PAD < b.x + b.width &&
    b.x - CLUSTER_PAD < a.x + a.width &&
    a.y - CLUSTER_PAD < b.y + b.height &&
    b.y - CLUSTER_PAD < a.y + a.height;
  const seen = new Set([shapes[0].id]);
  const queue = [shapes[0]];
  while (queue.length) {
    const current = queue.pop()!;
    for (const other of shapes) {
      if (seen.has(other.id) || !touches(current, other)) continue;
      seen.add(other.id);
      queue.push(other);
    }
  }
  return seen.size === shapes.length;
}

/** Enclosing box of several elements — a composite's real extent. */
function unionBounds(elements: SnapshotElement[]): GraphNode["bounds"] {
  const minX = Math.min(...elements.map((el) => el.x));
  const minY = Math.min(...elements.map((el) => el.y));
  const maxX = Math.max(...elements.map((el) => el.x + el.width));
  const maxY = Math.max(...elements.map((el) => el.y + el.height));
  return {
    x: round(minX),
    y: round(minY),
    width: round(maxX - minX),
    height: round(maxY - minY),
  };
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

/** The legend's own elements: the carrier, and the drawn samples (D69). */
function isLegendCarrier(el: SnapshotElement): boolean {
  return el.docent.legend !== null || el.docent.legendSample;
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

  // The legend's carrier carries the scene's conventions whole (D87,
  // D89): the rules, the genre, and the scenarios come off the one
  // element, so they cannot drift apart.
  const carrier = snapshot.elements.find((el) => isLegendCarrier(el));
  const legend = carrier?.docent.legend ?? [];
  const genre = carrier?.docent.genre ?? null;
  const scenarios = carrier?.docent.scenarios ?? [];

  const frameElements = snapshot.elements.filter((el) => el.type === "frame");
  const edgeElements = snapshot.elements.filter((el) => el.type === "arrow" && !isLegendCarrier(el));

  // Grouped composites (D22): a library icon is a group of primitives —
  // lines, freedraw strokes, shapes — that means ONE component. Collapse
  // such a group into a single node instead of exporting its drawing
  // parts as separate components.
  //
  // Signature: the group draws with primitives (a member outside the
  // node vocabulary), which is what separates an icon from a plain
  // grouping of several real shapes. The author can always override:
  // `customData.docent.composite` true forces a collapse, false forbids
  // it — declared beats inferred (D10/I4).
  const groupMembers = new Map<string, SnapshotElement[]>();
  for (const el of snapshot.elements) {
    if (el.type === "frame" || el.type === "arrow" || isLegendCarrier(el)) continue;
    for (const groupId of el.groupIds) {
      const members = groupMembers.get(groupId) ?? [];
      members.push(el);
      groupMembers.set(groupId, members);
    }
  }
  const compositeGroups = new Map<
    string,
    { members: SnapshotElement[]; provenance: "declared" | "inferred" }
  >();
  for (const [groupId, members] of groupMembers) {
    if (members.length < 2) continue;
    // Declarations are keyed by group, so marking an outer grouping
    // non-composite steps the search inward instead of silencing the icon
    // groups nested inside it.
    const flags = members
      .map((m) => m.docent.composite[groupId])
      .filter((v) => v !== undefined);
    if (flags.length && flags.every((v) => v === false)) continue;
    if (flags.some((v) => v === true)) {
      compositeGroups.set(groupId, {
        members: [...members].sort((a, b) => (a.id < b.id ? -1 : 1)),
        provenance: "declared",
      });
      continue;
    }
    // Inferred signature, measured against real icon libraries: a glyph
    // names itself at most once (its caption), while a grouping of real
    // components labels each one. Lettering drawn INSIDE the glyph — the
    // "T" in a Textract icon, "</>" in a pipeline icon, "53" in a Route 53
    // badge — is decoration, not a second component, so it doesn't count
    // as a label (measured: it was the single reason 16 of 249 AWS icons
    // failed to collapse). Beyond the label test the group either draws
    // with primitives, carries such internal lettering, or its shapes form
    // one touching cluster — a cylinder is stacked ellipses, whereas
    // grouped services stand apart.
    const internalText = members.filter((m) => isInternalLettering(m, members));
    const labelled = members.filter(
      (m) => labelFor(m, byId) !== null && !internalText.includes(m),
    ).length;
    if (labelled > 1) continue;
    const drawsPrimitives = members.some((m) => !NODE_TYPES.has(m.type));
    if (!drawsPrimitives && !internalText.length && !formsOneCluster(members))
      continue;
    compositeGroups.set(groupId, {
      members: [...members].sort((a, b) => (a.id < b.id ? -1 : 1)),
      provenance: "inferred",
    });
  }
  // Library icons nest their groups: the icon's own parts carry inner
  // groups (the strokes together, the box alone) inside one outer group
  // that holds the whole glyph plus its label. Collapse at the OUTERMOST
  // qualifying group — Excalidraw orders groupIds innermost-first, so
  // that is the last entry — or the icon would split into its
  // sub-groupings. Declaring a group non-composite steps the search
  // inward, which is how a deliberate grouping of several icons keeps
  // each icon whole.
  const compositeOf = new Map<string, string>();
  for (const el of snapshot.elements) {
    const groupId = [...el.groupIds]
      .reverse()
      .find((g) => compositeGroups.has(g));
    if (groupId) compositeOf.set(el.id, groupId);
  }
  /** Representative = smallest source id, preferring real shapes; stable
   *  under resizes and restyles, so composite ids survive edits (I6). A
   *  placed symbol names its own: the carrier IS the component (D83), so
   *  its id is the one arrows bind to and every reader addresses. */
  const representativeOf = new Map<string, SnapshotElement>();
  for (const [groupId, { members }] of compositeGroups) {
    const owned = members.filter((m) => compositeOf.get(m.id) === groupId);
    if (!owned.length) continue;
    const carrier = owned.find((m) => m.docent.symbol !== null);
    const shapes = owned.filter((m) => NODE_TYPES.has(m.type));
    representativeOf.set(groupId, carrier ?? shapes[0] ?? owned[0]);
  }

  const plainNodeElements = snapshot.elements.filter(
    (el) =>
      NODE_TYPES.has(el.type) &&
      el.containerId === null && // bound labels belong to their containers
      !isLegendCarrier(el) &&
      !compositeOf.has(el.id),
  );
  const representatives = [...representativeOf.values()];
  const nodeElements = [...plainNodeElements, ...representatives];

  // Deterministic id assignment: all graph elements sorted by source id, so
  // sanitization collisions resolve identically on every export (I3/I6).
  const taken = new Set<string>();
  const graphId = new Map<string, string>();
  for (const el of [...frameElements, ...nodeElements, ...edgeElements].sort(
    (a, b) => (a.id < b.id ? -1 : 1),
  )) {
    graphId.set(el.id, sanitizeId(el.id, taken));
  }
  // Every member resolves to its composite's id, so an arrow bound to any
  // part of an icon lands on the one component.
  for (const [memberId, groupId] of compositeOf) {
    const rep = representativeOf.get(groupId);
    if (rep) graphId.set(memberId, graphId.get(rep.id)!);
  }

  const frames: GraphFrame[] = frameElements
    .map((el) => ({
      id: graphId.get(el.id)!,
      sourceId: el.id,
      name: el.name ?? "",
      order: el.docent.order,
      narrative: el.docent.narrative,
      link: el.docent.link,
      bounds: boundsOf(el),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const nodes: GraphNode[] = nodeElements
    .map((el) => {
      const groupId = compositeOf.get(el.id);
      const composite = groupId ? compositeGroups.get(groupId) : undefined;
      // A composite speaks for all its parts: any member's label, intent,
      // and detail link belong to the one component, and its box is the
      // whole glyph.
      const parts = composite?.members ?? [el];
      // Name it by its caption, never by lettering drawn inside the glyph.
      const naming = composite
        ? parts.filter((p) => !isInternalLettering(p, parts))
        : parts;
      const label =
        naming.map((p) => labelFor(p, byId)).find((l) => l !== null) ??
        parts.map((p) => labelFor(p, byId)).find((l) => l !== null) ??
        null;
      const detailSource = parts.find((p) => p.docent.detailFrameId !== null);
      const linkSource = parts.find((p) => p.docent.link !== null);
      const tags = [...new Set(parts.flatMap((p) => p.docent.tags))].sort();
      const intents = parts.flatMap((p) => p.docent.intents);
      const note = intents[0] ?? null;
      const logic = parts.map((p) => p.docent.logic).find((l) => l !== null) ?? null;
      const symbol = parts.map((p) => p.docent.symbol).find((sym) => sym != null) ?? null;
      return {
        id: graphId.get(el.id)!,
        sourceId: el.id,
        label,
        shape: el.type,
        frameId: el.frameId ? (graphId.get(el.frameId) ?? null) : null,
        groupIds: [...el.groupIds].sort(),
        tags,
        note,
        intents,
        logic,
        detailFrameId: detailSource?.docent.detailFrameId
          ? (graphId.get(detailSource.docent.detailFrameId) ?? null)
          : null,
        link: linkSource?.docent.link ?? null,
        composite: composite
          ? { members: parts.length, provenance: composite.provenance }
          : null,
        symbol,
        bounds: composite ? unionBounds(parts) : boundsOf(el),
        style: styleOf(el),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = edgeElements
    // An arrow inside a composite group is part of the icon's drawing —
    // the arrow in an EventBridge rule, the loop in a cycle glyph — never
    // a connection: it takes no part in the graph, is never re-routed, and
    // infers no endpoints (D22, D83).
    .filter((el) => !el.groupIds.some((groupId) => compositeGroups.has(groupId)))
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
        intents: el.docent.intents,
        logic: el.docent.logic,
        link: el.docent.link,
        style: styleOf(el),
      };
    })
    .filter((edge) => edge.from !== null || edge.to !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Collapsed groups ARE nodes now — listing them as groups too would
  // double-report the same thing.
  const layoutGroupMembers = new Map<string, string[]>();
  for (const node of nodes) {
    for (const groupId of node.groupIds) {
      if (compositeGroups.has(groupId)) continue;
      const members = layoutGroupMembers.get(groupId) ?? [];
      members.push(node.id);
      layoutGroupMembers.set(groupId, members);
    }
  }
  const groups: GraphGroup[] = [...layoutGroupMembers.entries()]
    .map(([id, members]) => ({ id, members: members.sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { nodes, edges, frames, groups, legend, genre, scenarios };
}
