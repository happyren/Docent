/**
 * Authoring operations (S19, D59–D62): what an agent asks for, in the
 * diagram's own terms, turned into one adapter write. `plan` validates a
 * batch whole and compiles it — ids assigned, looks resolved through the
 * legend and the house style, places found — without touching anything;
 * `simulate` applies a plan to a snapshot so the semantic diff (D46) can
 * say what it would change before it does; `lint` is the craft check.
 * Pure and deterministic given the id source (I3).
 */
import type { LegendRule, SceneSnapshot, SnapshotElement } from "../adapter/snapshot";
import type { SceneWrite, WriteArrow, WriteFrame, WriteMeaning, WritePatch, WriteShape, WriteStyle } from "../adapter/excalidraw";
import { applyLegend } from "../export/legend";
import { buildSceneGraph, type GraphEdge, type GraphFrame, type GraphNode, type SceneGraph } from "../scene/graph";
import { computeTiers } from "../scene/tiers";
import { countCrossings, edgeLabelSize, FRAME_HEAD, FRAME_PAD, growFrame, layeredLayout, legendBox, memberBoxes, placeFrame, placeInFrame, sizeForLabel, type Box } from "./layout";
import { absolutePoints, passesThrough, routeEdge, type Point } from "./route";
import { DEFAULT_STYLE, freshFill, houseStyle, resolveLook, type Shape } from "./style";

// ---------------------------------------------------------------------------
// the operations
// ---------------------------------------------------------------------------

export interface AddNode {
  op: "add_node";
  /** A handle later ops in the batch may refer to, e.g. `$orders`. */
  ref?: string;
  label: string;
  kind?: string;
  /** A frame id (or ref); absent = Layer 1, unframed. */
  frame?: string | null;
  shape?: Shape;
  tags?: string[];
  intents?: string[];
  logic?: string;
  /** Place it after this component (id or ref) — right of it, same row. */
  after?: string;
  /** Discouraged: a raw look. The legend and house style decide otherwise. */
  style?: Partial<WriteStyle>;
}

export interface AddEdge {
  op: "add_edge";
  ref?: string;
  from: string;
  to: string;
  label?: string;
  intents?: string[];
  logic?: string;
}

export interface Update {
  op: "update";
  id: string;
  label?: string;
  kind?: string;
  /** Replace the tags / intents wholesale … */
  tags?: string[];
  intents?: string[];
  /** … or add to what the author wrote (duplicates dropped). */
  addTags?: string[];
  addIntents?: string[];
  logic?: string | null;
  narrative?: string | null;
  name?: string;
  order?: number | null;
  /** Move a component into a frame (id or ref), or out with null. */
  frame?: string | null;
}

export interface Remove {
  op: "remove";
  id: string;
  /** Required to remove a component that has a detail layer (the layer goes too). */
  cascade?: boolean;
}

export interface AddFrame {
  op: "add_frame";
  ref?: string;
  name: string;
  narrative?: string;
  order?: number;
}

export interface AddDetailLayer {
  op: "add_detail_layer";
  ref?: string;
  node: string;
  name?: string;
  narrative?: string;
}

export interface DefineKind {
  op: "define_kind";
  kind: string;
  shape?: Shape;
  style?: { backgroundColor?: string; strokeColor?: string; strokeStyle?: string; fillStyle?: string; strokeWidth?: number };
}

export interface Layout {
  op: "layout";
  /** A frame id, or null for the unframed Layer 1 components. */
  frame: string | null;
}

export type Op = AddNode | AddEdge | Update | Remove | AddFrame | AddDetailLayer | DefineKind | Layout;

export interface Plan {
  write: SceneWrite;
  /** Caller refs (`$orders`) and new source ids → the ids the scene will carry. */
  ids: Record<string, string>;
  /** What was decided on the caller's behalf, one line each. */
  notes: string[];
  /** Source ids of everything created or changed — what to show afterwards. */
  touched: string[];
}

export class PlanError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "PlanError";
  }
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** An Excalidraw-shaped id; deterministic when a seed is given (tests). */
export function idSource(seed?: number): () => string {
  let state = seed ?? 0;
  const random = () => {
    if (seed === undefined) {
      if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] / 2 ** 32;
      }
      return Math.random();
    }
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return () => {
    let id = "";
    for (let i = 0; i < 20; i++) id += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return id;
  };
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

function sourceOf(graph: SceneGraph, id: string): { sourceId: string; kind: "node" | "edge" | "frame" } | null {
  const node = graph.nodes.find((n) => n.id === id || n.sourceId === id);
  if (node) return { sourceId: node.sourceId, kind: "node" };
  const edge = graph.edges.find((e) => e.id === id || e.sourceId === id);
  if (edge) return { sourceId: edge.sourceId, kind: "edge" };
  const frame = graph.frames.find((f) => f.id === id || f.sourceId === id);
  if (frame) return { sourceId: frame.sourceId, kind: "frame" };
  return null;
}

/**
 * Compile a batch. Throws `PlanError` with every problem found, and
 * nothing is planned unless all of it can be.
 */
export function plan(ops: readonly Op[], snapshot: SceneSnapshot, nextId: () => string = idSource()): Plan {
  const graph = buildSceneGraph(snapshot);
  const house = houseStyle(snapshot, graph);
  const elements = new Map(snapshot.elements.map((el) => [el.id, el]));
  const problems: string[] = [];
  const notes: string[] = [];
  const ids: Record<string, string> = {};
  const touched: string[] = [];
  let legend: LegendRule[] = [...graph.legend];
  let legendChanged = false;

  const write: Required<Pick<SceneWrite, "shapes" | "arrows" | "frames" | "patches" | "remove">> = {
    shapes: [],
    arrows: [],
    frames: [],
    patches: [],
    remove: [],
  };
  // What the batch itself created, by source id — for placement and bounds.
  const created = new Map<string, Box & { type: string; frameId: string | null; label: string | null; kind: string | null }>();
  const createdFrames = new Map<string, WriteFrame & { members: string[] }>();
  const removed = new Set<string>();

  const resolve = (handle: string, what: string, kinds: ("node" | "edge" | "frame")[]): string | null => {
    if (handle.startsWith("$")) {
      const real = ids[handle];
      if (!real) {
        problems.push(`${what}: unknown ref ${handle} — refs must be created earlier in the same batch`);
        return null;
      }
      const made = created.get(real) ?? createdFrames.get(real);
      const kind = createdFrames.has(real) ? "frame" : created.get(real)?.type === "arrow" ? "edge" : "node";
      if (made && !kinds.includes(kind)) {
        problems.push(`${what}: ${handle} is a ${kind}, expected ${kinds.join(" or ")}`);
        return null;
      }
      return real;
    }
    const found = sourceOf(graph, handle);
    if (!found) {
      problems.push(`${what}: unknown id ${handle} — use ids from get_scene_graph or refs from this batch`);
      return null;
    }
    if (!kinds.includes(found.kind)) {
      problems.push(`${what}: ${handle} is a ${found.kind}, expected ${kinds.join(" or ")}`);
      return null;
    }
    if (removed.has(found.sourceId)) {
      problems.push(`${what}: ${handle} is removed earlier in this batch`);
      return null;
    }
    return found.sourceId;
  };
  const frameBox = (sourceId: string): Box | null => {
    const made = createdFrames.get(sourceId);
    if (made) return { x: made.x, y: made.y, width: made.width, height: made.height };
    const el = elements.get(sourceId);
    return el ? { x: el.x, y: el.y, width: el.width, height: el.height } : null;
  };
  const boxOf = (sourceId: string): Box | null => {
    const made = created.get(sourceId);
    if (made) return { x: made.x, y: made.y, width: made.width, height: made.height };
    const el = elements.get(sourceId);
    return el ? { x: el.x, y: el.y, width: el.width, height: el.height } : null;
  };
  // The legend is never drawn over (D69): on Layer 1 it is occupied space,
  // and every new frame goes below it.
  const legendArea = legendBox(snapshot.elements);
  const occupiedIn = (frameId: string | null): Box[] => [
    ...(frameId === null && legendArea ? [legendArea] : []),
    ...memberBoxes(snapshot.elements.filter((el) => !removed.has(el.id)), frameId),
    ...[...created.values()]
      .filter((c) => c.frameId === frameId && c.type !== "arrow")
      .map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
  ];
  const labelsIn = (frameId: string | null): Set<string> => {
    const set = new Set<string>();
    for (const n of graph.nodes) if (n.frameId === (frameId ? graph.frames.find((f) => f.sourceId === frameId)?.id ?? null : null) && n.label && !removed.has(n.sourceId)) set.add(clean(n.label).toLowerCase());
    for (const c of created.values()) if (c.frameId === frameId && c.label) set.add(clean(c.label).toLowerCase());
    return set;
  };
  const grownFrames = new Map<string, Box>();
  const noteGrow = (frameId: string | null, box: Box) => {
    if (!frameId) return;
    const current = grownFrames.get(frameId) ?? frameBox(frameId);
    if (!current) return;
    const grown = growFrame(current, [box]);
    if (grown.width !== current.width || grown.height !== current.height || grown.x !== current.x || grown.y !== current.y) {
      grownFrames.set(frameId, grown);
    }
  };

  for (const [i, op] of ops.entries()) {
    const at = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case "define_kind": {
        const kind = clean(op.kind);
        if (!kind) {
          problems.push(`${at}: kind is empty`);
          break;
        }
        if (legend.some((r) => r.key === "kind" && r.meaning === kind)) {
          notes.push(`${kind} is already in the legend — kept as is`);
          break;
        }
        const fill = op.style?.backgroundColor ?? freshFill(legend.filter((r) => r.attr === "backgroundColor").map((r) => r.value));
        const rule: LegendRule = { attr: "backgroundColor", value: fill, key: "kind", meaning: kind };
        const also: { attr: LegendRule["attr"]; value: string }[] = [];
        if (op.shape) also.push({ attr: "shape", value: op.shape });
        if (op.style?.strokeColor) also.push({ attr: "strokeColor", value: op.style.strokeColor });
        if (op.style?.strokeStyle) also.push({ attr: "strokeStyle", value: op.style.strokeStyle });
        if (op.style?.fillStyle) also.push({ attr: "fillStyle", value: op.style.fillStyle });
        if (op.style?.strokeWidth) also.push({ attr: "strokeWidth", value: String(op.style.strokeWidth) });
        if (also.length) rule.also = also;
        legend = [...legend, rule];
        legendChanged = true;
        notes.push(`legend: ${kind} → ${op.shape ?? "any shape"} with fill ${fill}`);
        break;
      }
      case "add_frame": {
        const name = clean(op.name);
        if (!name) {
          problems.push(`${at}: name is empty`);
          break;
        }
        const id = nextId();
        const tier1 = snapshot.elements.filter((el) => el.type === "frame" && (computeTiers(snapshot).frameTier.get(el.id) ?? 1) === 1).map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height }));
        const size = { width: 760, height: 460 };
        const box = placeFrame([...(legendArea ? [legendArea] : []), ...tier1, ...[...createdFrames.values()].map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height }))], size);
        const frame: WriteFrame & { members: string[] } = {
          id,
          name,
          ...box,
          meaning: op.narrative || op.order !== undefined ? { narrative: op.narrative ?? null, order: op.order ?? null } : null,
          members: [],
        };
        createdFrames.set(id, frame);
        if (op.ref) ids[op.ref] = id;
        ids[id] = id;
        touched.push(id);
        break;
      }
      case "add_detail_layer": {
        const node = resolve(op.node, at, ["node"]);
        if (!node) break;
        const existing = graph.nodes.find((n) => n.sourceId === node)?.detailFrameId;
        if (existing) {
          problems.push(`${at}: ${op.node} already has a detail layer (${existing}) — add into it instead`);
          break;
        }
        const label = created.get(node)?.label ?? clean(graph.nodes.find((n) => n.sourceId === node)?.label) ?? "component";
        const id = nextId();
        const everything = [
          ...(legendArea ? [legendArea] : []),
          ...snapshot.elements.filter((el) => el.type === "frame").map((el) => ({ x: el.x, y: el.y, width: el.width, height: el.height })),
          ...[...createdFrames.values()].map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height })),
        ];
        // Detail layers live on their own band, well below the parent tier.
        const box = placeFrame(everything, { width: 760, height: 460 });
        const parentTier = (() => {
          const n = graph.nodes.find((x) => x.sourceId === node);
          const f = n?.frameId ? graph.frames.find((fr) => fr.id === n.frameId) : null;
          return f ? (computeTiers(snapshot).frameTier.get(f.sourceId) ?? 1) : 1;
        })();
        const band = 20000 * parentTier;
        if (box.y < band) box.y = band + 1200;
        const frame: WriteFrame & { members: string[] } = {
          id,
          name: op.name ? clean(op.name) : `${label} — detail`,
          ...box,
          meaning: op.narrative ? { narrative: op.narrative } : null,
          members: [],
        };
        createdFrames.set(id, frame);
        // The link lives on the node.
        if (created.has(node)) {
          const shape = write.shapes.find((s) => s.id === node)!;
          shape.meaning = { ...(shape.meaning ?? {}), detailFrameId: id };
        } else {
          write.patches.push({ id: node, meaning: { detailFrameId: id } });
          touched.push(node);
        }
        if (op.ref) ids[op.ref] = id;
        ids[id] = id;
        touched.push(id);
        notes.push(`${label}: detail layer "${frame.name}" created on tier ${parentTier + 1}`);
        break;
      }
      case "add_node": {
        const label = clean(op.label);
        if (!label) {
          problems.push(`${at}: label is empty`);
          break;
        }
        let frameId: string | null = null;
        if (op.frame) {
          frameId = resolve(op.frame, at, ["frame"]);
          if (!frameId) break;
        }
        if (labelsIn(frameId).has(label.toLowerCase())) {
          problems.push(`${at}: a component labeled "${label}" already exists in that frame — update it, or choose another label`);
          break;
        }
        const kind = op.kind ? clean(op.kind) : null;
        const look = resolveLook(kind, house, legend);
        if (kind && look.source === "house") {
          notes.push(`${label}: kind "${kind}" is not in the legend and nothing is drawn as it yet — define_kind to give it a look`);
        }
        const shape: Shape = op.shape ?? look.shape;
        const style: WriteStyle = { ...look.style, ...(op.style ?? {}) };
        const size = sizeForLabel(label, style.fontSize, shape);
        let anchor: Box | null = null;
        // The gap from the anchor is at least the words on the edge between them (D70).
        const edgesHere = op.ref
          ? ops.slice(i + 1).filter((o): o is AddEdge => o.op === "add_edge" && (o.to === op.ref || o.from === op.ref))
          : [];
        const labelRoom = edgesHere.reduce((w, o) => Math.max(w, edgeLabelSize(o.label, house.arrow.style.fontSize).width), 0);
        if (op.after) {
          const afterId = resolve(op.after, at, ["node"]);
          if (afterId) anchor = boxOf(afterId);
        } else if (op.ref) {
          // No `after`: the column after every feeder the batch names, at
          // the feeders' mean row (D66) — never merely right of the last one.
          const feeders = edgesHere
            .filter((o) => o.to === op.ref)
            .map((o) => (o.from.startsWith("$") ? ids[o.from] : sourceOf(graph, o.from)?.sourceId))
            .map((id) => (id ? boxOf(id) : null))
            .filter((b): b is Box => b !== null);
          if (feeders.length) {
            const right = Math.max(...feeders.map((b) => b.x + b.width));
            const meanY = feeders.reduce((sum, b) => sum + b.y, 0) / feeders.length;
            anchor = { x: right - feeders[0].width, y: meanY, width: feeders[0].width, height: feeders[0].height };
            anchor = { ...anchor, x: right - anchor.width };
          }
        }
        const box = placeInFrame(
          frameId ? (grownFrames.get(frameId) ?? frameBox(frameId)) : null,
          occupiedIn(frameId),
          size,
          anchor,
          frameId === null && legendArea ? legendArea.y + legendArea.height : null,
          labelRoom,
        );
        noteGrow(frameId, box);
        const id = nextId();
        const meaning: WriteMeaning = {};
        if (op.tags?.length) meaning.tags = op.tags.map(clean).filter(Boolean);
        if (op.intents?.length) meaning.intents = op.intents.map(clean).filter(Boolean);
        if (op.logic) meaning.logic = op.logic;
        const node: WriteShape = {
          id,
          type: shape,
          ...box,
          label,
          frameId,
          style,
          meaning: Object.keys(meaning).length ? meaning : null,
        };
        write.shapes.push(node);
        created.set(id, { ...box, type: shape, frameId, label, kind });
        if (frameId && createdFrames.has(frameId)) createdFrames.get(frameId)!.members.push(id);
        if (op.ref) ids[op.ref] = id;
        ids[id] = id;
        touched.push(id);
        break;
      }
      case "add_edge": {
        const from = resolve(op.from, at, ["node"]);
        const to = resolve(op.to, at, ["node"]);
        if (!from || !to) break;
        if (from === to) {
          problems.push(`${at}: an edge cannot join a component to itself`);
          break;
        }
        const fromFrame = created.get(from)?.frameId ?? elements.get(from)?.frameId ?? null;
        const toFrame = created.get(to)?.frameId ?? elements.get(to)?.frameId ?? null;
        const id = nextId();
        const meaning: WriteMeaning = {};
        if (op.intents?.length) meaning.intents = op.intents.map(clean).filter(Boolean);
        if (op.logic) meaning.logic = op.logic;
        const arrow: WriteArrow = {
          id,
          from,
          to,
          label: op.label ? clean(op.label) : null,
          // An arrow inside one frame belongs to it; one that crosses frames is Layer 1's.
          frameId: fromFrame === toFrame ? fromFrame : null,
          style: house.arrow.style,
          startArrowhead: house.arrow.startArrowhead,
          endArrowhead: house.arrow.endArrowhead,
          meaning: Object.keys(meaning).length ? meaning : null,
        };
        write.arrows.push(arrow);
        created.set(id, { x: 0, y: 0, width: 0, height: 0, type: "arrow", frameId: arrow.frameId, label: arrow.label, kind: null });
        if (op.ref) ids[op.ref] = id;
        ids[id] = id;
        touched.push(id);
        break;
      }
      case "update": {
        const target = resolve(op.id, at, ["node", "edge", "frame"]);
        if (!target) break;
        const kindOfTarget = createdFrames.has(target) ? "frame" : created.get(target)?.type === "arrow" ? "edge" : sourceOf(graph, op.id)?.kind ?? "node";
        const patch: WritePatch = { id: target };
        const meaning: WriteMeaning = {};
        if (op.label !== undefined) {
          if (kindOfTarget === "frame") problems.push(`${at}: a frame has a name, not a label`);
          else patch.label = clean(op.label);
        }
        if (op.name !== undefined) {
          if (kindOfTarget !== "frame") problems.push(`${at}: only a frame has a name`);
          else patch.name = clean(op.name);
        }
        const current = graph.nodes.find((n) => n.sourceId === target) ?? graph.edges.find((e) => e.sourceId === target);
        if (op.tags !== undefined) meaning.tags = op.tags.map(clean).filter(Boolean);
        if (op.intents !== undefined) meaning.intents = op.intents.map(clean).filter(Boolean);
        if (op.addTags?.length) {
          const have = meaning.tags ?? (current && "tags" in current ? current.tags : []);
          meaning.tags = [...new Set([...have, ...op.addTags.map(clean).filter(Boolean)])];
        }
        if (op.addIntents?.length) {
          const have = meaning.intents ?? current?.intents ?? [];
          meaning.intents = [...new Set([...have, ...op.addIntents.map(clean).filter(Boolean)])];
        }
        if (op.logic !== undefined) meaning.logic = op.logic;
        if (op.narrative !== undefined) {
          if (kindOfTarget !== "frame") problems.push(`${at}: only a frame has a narrative`);
          else meaning.narrative = op.narrative;
        }
        if (op.order !== undefined) meaning.order = op.order;
        if (op.kind !== undefined) {
          if (kindOfTarget !== "node") problems.push(`${at}: only a component has a kind`);
          else {
            const look = resolveLook(clean(op.kind), house, legend);
            if (look.source === "house") problems.push(`${at}: kind "${op.kind}" has no look yet — define_kind first`);
            else patch.style = look.style;
          }
        }
        if (op.frame !== undefined) {
          if (kindOfTarget !== "node") problems.push(`${at}: only a component moves between frames`);
          else if (op.frame === null) patch.frameId = null;
          else {
            const f = resolve(op.frame, at, ["frame"]);
            if (f) {
              patch.frameId = f;
              // Re-place inside the new frame so it is not sitting in the old one's space.
              const box = boxOf(target);
              if (box) {
                const placed = placeInFrame(grownFrames.get(f) ?? frameBox(f), occupiedIn(f), { width: box.width, height: box.height }, null);
                patch.x = placed.x;
                patch.y = placed.y;
                noteGrow(f, placed);
              }
            }
          }
        }
        if (Object.keys(meaning).length) patch.meaning = meaning;
        if (Object.keys(patch).length > 1) {
          write.patches.push(patch);
          touched.push(target);
        }
        break;
      }
      case "remove": {
        const target = resolve(op.id, at, ["node", "edge", "frame"]);
        if (!target) break;
        const node = graph.nodes.find((n) => n.sourceId === target);
        if (node?.detailFrameId && !op.cascade) {
          problems.push(`${at}: ${op.id} has a detail layer — pass cascade:true to remove the layer with it`);
          break;
        }
        const toRemove = new Set<string>([target]);
        if (node?.detailFrameId && op.cascade) {
          // The layer and everything in it, and their layers, and so on.
          const queue = [node.detailFrameId];
          while (queue.length) {
            const frameSource = graph.frames.find((f) => f.id === queue.shift())?.sourceId;
            if (!frameSource) continue;
            toRemove.add(frameSource);
            for (const el of snapshot.elements) {
              if (el.frameId === frameSource) {
                toRemove.add(el.id);
                const inner = graph.nodes.find((n) => n.sourceId === el.id)?.detailFrameId;
                if (inner) queue.push(inner);
              }
            }
          }
        }
        const frame = graph.frames.find((f) => f.sourceId === target);
        if (frame) {
          // Removing a frame removes what it holds.
          for (const el of snapshot.elements) if (el.frameId === target) toRemove.add(el.id);
        }
        // Edges bound to a removed node go with it.
        for (const e of graph.edges) {
          const f = e.from ? graph.nodes.find((n) => n.id === e.from)?.sourceId : null;
          const t = e.to ? graph.nodes.find((n) => n.id === e.to)?.sourceId : null;
          if ((f && toRemove.has(f)) || (t && toRemove.has(t))) toRemove.add(e.sourceId);
        }
        for (const id of toRemove) {
          if (!removed.has(id)) {
            removed.add(id);
            write.remove.push(id);
          }
        }
        notes.push(`${op.id}: ${toRemove.size} element${toRemove.size === 1 ? "" : "s"} removed`);
        break;
      }
      case "layout": {
        let frameSource: string | null = null;
        if (op.frame) {
          frameSource = resolve(op.frame, at, ["frame"]);
          if (!frameSource) break;
        }
        const frameGraphId = frameSource ? (graph.frames.find((f) => f.sourceId === frameSource)?.id ?? null) : null;
        const members = graph.nodes.filter((n) => n.frameId === frameGraphId && !removed.has(n.sourceId));
        if (!members.length) {
          notes.push(`layout: nothing to arrange${op.frame ? ` in ${op.frame}` : " on Layer 1"}`);
          break;
        }
        const sizes = new Map(members.map((n) => [n.id, { width: n.bounds.width, height: n.bounds.height }]));
        const fb = frameSource ? (grownFrames.get(frameSource) ?? frameBox(frameSource)) : null;
        const origin = fb ? { x: fb.x + FRAME_PAD, y: fb.y + FRAME_HEAD + FRAME_PAD } : { x: Math.min(...members.map((m) => m.bounds.x)), y: Math.min(...members.map((m) => m.bounds.y)) };
        // The legend is what says two components are the same thing, so it
        // is what decides which of them are drawn one size (D74).
        const kinds = new Map(members.map((n) => [n.id, applyLegend(n.style, n.shape, legend).kind]));
        const boxes = layeredLayout(members, graph.edges, sizes, origin, {
          labelSize: (e) => edgeLabelSize(e.label, house.arrow.style.fontSize),
          kindOf: (id) => kinds.get(id) ?? null,
        });
        for (const n of members) {
          const box = boxes.get(n.id);
          if (!box) continue;
          const sized = box.width !== n.bounds.width || box.height !== n.bounds.height;
          if (box.x !== n.bounds.x || box.y !== n.bounds.y || sized) {
            const patch: WritePatch = { id: n.sourceId, x: box.x, y: box.y };
            if (sized) {
              patch.width = box.width;
              patch.height = box.height;
            }
            write.patches.push(patch);
            touched.push(n.sourceId);
          }
          noteGrow(frameSource, box);
        }
        notes.push(`layout: ${members.length} components re-flowed${op.frame ? ` in ${op.frame}` : ""}`);
        break;
      }
    }
  }

  // Frames the agent built — every component in them new — are laid out
  // whole (D66): rank by flow, rows ordered to minimize crossings. Nothing
  // hand-placed is in them, so D60 has nothing to guard.
  const framesToLayOut = new Set<string>();
  for (const c of created.values()) {
    if (c.type === "arrow" || !c.frameId) continue;
    const existing = memberBoxes(snapshot.elements.filter((el) => !removed.has(el.id)), c.frameId);
    if (createdFrames.has(c.frameId) || existing.length === 0) framesToLayOut.add(c.frameId);
  }
  for (const frameId of framesToLayOut) {
    const members = [...created.entries()].filter(([, c]) => c.frameId === frameId && c.type !== "arrow");
    if (members.length < 2) continue;
    const nodes = members.map(([id, c]) => ({ id, bounds: { x: c.x, y: c.y, width: c.width, height: c.height } })) as unknown as GraphNode[];
    const edges = write.arrows
      .filter((a) => created.has(a.from) && created.has(a.to))
      .map((a) => ({ id: a.id, from: a.from, to: a.to, label: a.label })) as unknown as GraphEdge[];
    const sizes = new Map(members.map(([id, c]) => [id, { width: c.width, height: c.height }]));
    const fb = grownFrames.get(frameId) ?? frameBox(frameId);
    const origin = fb ? { x: fb.x + FRAME_PAD, y: fb.y + FRAME_HEAD + FRAME_PAD } : { x: 0, y: 0 };
    const boxes = layeredLayout(nodes, edges, sizes, origin, {
      labelSize: (e) => edgeLabelSize(e.label, house.arrow.style.fontSize),
      // The batch said what each component is, so peers are drawn one size (D74).
      kindOf: (id) => created.get(id)?.kind ?? null,
    });
    // Start the frame from its own origin again: what grew it is being re-placed.
    let grown: Box = fb ? { x: fb.x, y: fb.y, width: 0, height: 0 } : { x: 0, y: 0, width: 0, height: 0 };
    for (const [id, c] of members) {
      const box = boxes.get(id);
      if (!box) continue;
      c.x = box.x;
      c.y = box.y;
      c.width = box.width;
      c.height = box.height;
      const shape = write.shapes.find((sh) => sh.id === id);
      if (shape) {
        shape.x = box.x;
        shape.y = box.y;
        shape.width = box.width;
        shape.height = box.height;
      }
      grown = growFrame(grown, [box]);
    }
    const made = createdFrames.get(frameId);
    if (made) Object.assign(made, { x: grown.x, y: grown.y, width: Math.max(grown.width, 300), height: Math.max(grown.height, 200) });
    else grownFrames.set(frameId, growFrame(frameBox(frameId) ?? grown, [grown]));
    const crossings = countCrossings(
      members.map(([id, c]) => ({ id, bounds: { x: c.x, y: c.y, width: c.width, height: c.height } })) as unknown as GraphNode[],
      edges,
    );
    notes.push(`${createdFrames.get(frameId)?.name ?? frameId}: ${members.length} components laid out by flow${crossings ? ` — ${crossings} crossing${crossings === 1 ? "" : "s"} remain; consider a detail layer` : ", no crossings"}`);
  }

  // Frames that grew to hold what was added.
  for (const [frameId, box] of grownFrames) {
    const made = createdFrames.get(frameId);
    if (made) Object.assign(made, box);
    else {
      write.patches.push({ id: frameId, ...box });
      if (!touched.includes(frameId)) touched.push(frameId);
    }
  }
  // Frames created with members: size to them.
  for (const frame of createdFrames.values()) {
    const memberBoxList = frame.members.map((m) => created.get(m)!).filter(Boolean);
    if (memberBoxList.length) {
      const base = framesToLayOut.has(frame.id) ? { x: frame.x, y: frame.y, width: 0, height: 0 } : { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
      Object.assign(frame, growFrame(base, memberBoxList));
    }
    write.frames.push({ id: frame.id, name: frame.name, x: frame.x, y: frame.y, width: frame.width, height: frame.height, meaning: frame.meaning });
  }

  // Every edge the batch draws or moves is routed around what lies between
  // its ends (D72): the final boxes of every component, and the legend.
  // A component that was resized moved as far as its edges are concerned (D74).
  const moved = new Set(
    write.patches.filter((p) => p.x !== undefined || p.y !== undefined || p.width !== undefined || p.height !== undefined).map((p) => p.id),
  );
  const finalBoxes = new Map<string, Box & { id: string }>();
  for (const n of graph.nodes) {
    if (removed.has(n.sourceId)) continue;
    const patch = write.patches.find((p) => p.id === n.sourceId);
    finalBoxes.set(n.sourceId, {
      id: n.sourceId,
      x: patch?.x ?? n.bounds.x,
      y: patch?.y ?? n.bounds.y,
      width: patch?.width ?? n.bounds.width,
      height: patch?.height ?? n.bounds.height,
    });
  }
  for (const [id, c] of created) if (c.type !== "arrow") finalBoxes.set(id, { id, x: c.x, y: c.y, width: c.width, height: c.height });
  if (legendArea) finalBoxes.set("__legend", { id: "__legend", ...legendArea });
  const obstacles = [...finalBoxes.values()];
  const routeBetween = (from: string, to: string): Point[] | null => {
    const a = finalBoxes.get(from);
    const b = finalBoxes.get(to);
    if (!a || !b) return null;
    return routeEdge(a, b, obstacles.filter((o) => o.id !== from && o.id !== to));
  };
  let routed = 0;
  for (const arrow of write.arrows) {
    const via = routeBetween(arrow.from, arrow.to);
    if (via) {
      arrow.via = via;
      routed += 1;
    }
  }
  for (const e of graph.edges) {
    if (!e.from || !e.to || removed.has(e.sourceId)) continue;
    const from = graph.nodes.find((n) => n.id === e.from)?.sourceId;
    const to = graph.nodes.find((n) => n.id === e.to)?.sourceId;
    if (!from || !to || (!moved.has(from) && !moved.has(to))) continue;
    const via = routeBetween(from, to);
    const patch = write.patches.find((p) => p.id === e.sourceId);
    if (patch) patch.via = via ?? [];
    else write.patches.push({ id: e.sourceId, via: via ?? [] });
    if (!touched.includes(e.sourceId)) touched.push(e.sourceId);
    if (via) routed += 1;
  }
  if (routed) notes.push(`${routed} edge${routed === 1 ? "" : "s"} routed around components`);

  if (problems.length) throw new PlanError(problems);
  const result: SceneWrite = {};
  if (write.shapes.length) result.shapes = write.shapes;
  if (write.arrows.length) result.arrows = write.arrows;
  if (write.frames.length) result.frames = write.frames;
  if (write.patches.length) result.patches = write.patches;
  if (write.remove.length) result.remove = write.remove;
  if (legendChanged) result.legend = legend;
  return { write: result, ids, notes, touched };
}

// ---------------------------------------------------------------------------
// simulation — the snapshot a write would produce
// ---------------------------------------------------------------------------

const LOOK_DEFAULT = { roughness: 1, roundness: 3, fontFamily: 5, fontSize: 20, textAlign: "center", startArrowhead: null, endArrowhead: "arrow", arrowType: "round" };

function emptyDocent(): SnapshotElement["docent"] {
  return { detailFrameId: null, tags: [], note: null, intents: [], logic: null, narrative: null, order: null, legend: null, legendSample: false, refine: null, composite: {} };
}

function docentFromMeaning(meaning: WriteMeaning | null | undefined, base: SnapshotElement["docent"]): SnapshotElement["docent"] {
  const next = { ...base };
  if (!meaning) return next;
  if (meaning.tags !== undefined) next.tags = meaning.tags;
  if (meaning.intents !== undefined) {
    next.intents = meaning.intents;
    next.note = meaning.intents[0] ?? null;
  }
  if (meaning.logic !== undefined) next.logic = meaning.logic;
  if (meaning.narrative !== undefined) next.narrative = meaning.narrative;
  if (meaning.order !== undefined) next.order = meaning.order;
  if (meaning.detailFrameId !== undefined) next.detailFrameId = meaning.detailFrameId;
  return next;
}

function blank(id: string, type: string, box: Box, style: WriteStyle, frameId: string | null): SnapshotElement {
  return {
    id,
    type,
    ...box,
    angle: 0,
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    strokeStyle: style.strokeStyle,
    fillStyle: style.fillStyle,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    frameId,
    groupIds: [],
    locked: false,
    text: null,
    containerId: null,
    boundElements: [],
    points: null,
    startBindingId: null,
    endBindingId: null,
    name: null,
    link: null,
    docent: emptyDocent(),
    look: { ...LOOK_DEFAULT, roughness: style.roughness, roundness: style.roundness, fontFamily: style.fontFamily, fontSize: style.fontSize },
  };
}

/** The snapshot after a write — enough for the graph, the diff, and the lint. */
export function simulate(snapshot: SceneSnapshot, write: SceneWrite): SceneSnapshot {
  const removing = new Set(write.remove ?? []);
  for (const el of snapshot.elements) {
    if (el.containerId && removing.has(el.containerId)) removing.add(el.id);
  }
  const patches = new Map((write.patches ?? []).map((p) => [p.id, p]));
  const out: SnapshotElement[] = [];
  for (const el of snapshot.elements) {
    if (removing.has(el.id)) continue;
    let next = { ...el, boundElements: el.boundElements.filter((b) => !removing.has(b.id)), docent: { ...el.docent } };
    if (next.startBindingId && removing.has(next.startBindingId)) next.startBindingId = null;
    if (next.endBindingId && removing.has(next.endBindingId)) next.endBindingId = null;
    const patch = patches.get(el.id);
    if (patch) {
      if (patch.frameId !== undefined) next.frameId = patch.frameId;
      if (patch.x !== undefined) next.x = patch.x;
      if (patch.y !== undefined) next.y = patch.y;
      if (patch.width !== undefined) next.width = patch.width;
      if (patch.height !== undefined) next.height = patch.height;
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.style) next = { ...next, ...Object.fromEntries(Object.entries(patch.style).filter(([k]) => ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "opacity"].includes(k))) } as SnapshotElement;
      if (patch.meaning) next.docent = docentFromMeaning(patch.meaning, next.docent);
    }
    // A bound label follows its container's frame and label.
    if (el.containerId) {
      const containerPatch = patches.get(el.containerId);
      if (containerPatch?.frameId !== undefined) next.frameId = containerPatch.frameId;
      if (typeof containerPatch?.label === "string") next.text = containerPatch.label;
    }
    out.push(next);
  }
  for (const frame of write.frames ?? []) {
    const el = blank(frame.id, "frame", frame, DEFAULT_STYLE, null);
    el.name = frame.name;
    el.docent = docentFromMeaning(frame.meaning, el.docent);
    out.push(el);
  }
  for (const shape of write.shapes ?? []) {
    const el = blank(shape.id, shape.type, shape, shape.style, shape.frameId);
    el.docent = docentFromMeaning(shape.meaning, el.docent);
    if (shape.label) {
      const textId = `${shape.id}_label`;
      el.boundElements = [{ id: textId, type: "text" }];
      const text = blank(textId, "text", { x: shape.x + 10, y: shape.y + 10, width: shape.width - 20, height: 24 }, shape.style, shape.frameId);
      text.text = shape.label;
      text.containerId = shape.id;
      out.push(text);
    }
    out.push(el);
  }
  for (const text of write.texts ?? []) {
    const el = blank(text.id, "text", { x: text.x, y: text.y, width: 100, height: 24 }, text.style, text.frameId);
    el.text = text.text;
    el.docent = docentFromMeaning(text.meaning, el.docent);
    out.push(el);
  }
  const byId = new Map(out.map((el) => [el.id, el]));
  for (const arrow of write.arrows ?? []) {
    const a = byId.get(arrow.from);
    const b = byId.get(arrow.to);
    const ax = a ? a.x + a.width / 2 : 0;
    const ay = a ? a.y + a.height / 2 : 0;
    const bx = b ? b.x + b.width / 2 : 0;
    const by = b ? b.y + b.height / 2 : 0;
    const el = blank(arrow.id, "arrow", { x: ax, y: ay, width: Math.abs(bx - ax), height: Math.abs(by - ay) }, arrow.style, arrow.frameId);
    el.points = [[0, 0], ...(arrow.via ?? []).map(([px, py]): [number, number] => [px - ax, py - ay]), [bx - ax, by - ay]];
    el.startBindingId = arrow.from;
    el.endBindingId = arrow.to;
    el.docent = docentFromMeaning(arrow.meaning, el.docent);
    if (arrow.label) {
      const textId = `${arrow.id}_label`;
      el.boundElements = [{ id: textId, type: "text" }];
      const text = blank(textId, "text", { x: (ax + bx) / 2, y: (ay + by) / 2, width: 80, height: 20 }, arrow.style, arrow.frameId);
      text.text = arrow.label;
      text.containerId = arrow.id;
      out.push(text);
    }
    for (const end of [a, b]) if (end) end.boundElements = [...end.boundElements, { id: arrow.id, type: "arrow" }];
    out.push(el);
  }
  // Re-routed arrows follow their ends' final places.
  for (const patch of write.patches ?? []) {
    if (patch.via === undefined) continue;
    const el = byId.get(patch.id);
    if (!el || el.type !== "arrow" || !el.startBindingId || !el.endBindingId) continue;
    const a = byId.get(el.startBindingId);
    const b = byId.get(el.endBindingId);
    if (!a || !b) continue;
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    el.x = ax;
    el.y = ay;
    el.points = [[0, 0], ...patch.via.map(([px, py]): [number, number] => [px - ax, py - ay]), [bx - ax, by - ay]];
  }
  if (write.legend) {
    const carrier = out.find((el) => el.docent.legend !== null);
    if (carrier) carrier.docent = { ...carrier.docent, legend: write.legend };
    else {
      const el = blank("__legend", "text", { x: 0, y: -80, width: 200, height: 40 }, DEFAULT_STYLE, null);
      el.text = "Legend";
      el.locked = true;
      el.docent = { ...emptyDocent(), legend: write.legend };
      out.push(el);
    }
  }
  return { elements: out };
}

// ---------------------------------------------------------------------------
// the lint
// ---------------------------------------------------------------------------

export interface LintFinding {
  level: "warn" | "info";
  about: string | null;
  message: string;
}

export const MAX_FRAME_COMPONENTS = 12;

/** What a reviewer would say about the diagram's craft (D62, D63). */
export function lint(snapshot: SceneSnapshot): { findings: LintFinding[]; summary: string } {
  const graph = buildSceneGraph(snapshot);
  const findings: LintFinding[] = [];
  const tiers = computeTiers(snapshot);
  for (const node of graph.nodes) {
    const name = clean(node.label) || node.id;
    if (!clean(node.label)) findings.push({ level: "warn", about: node.id, message: `component ${node.id} has no label` });
    const facts = applyLegend(node.style, node.shape, graph.legend);
    if (!facts.kind) findings.push({ level: "warn", about: node.id, message: `${name} has no kind — its style matches no legend rule` });
    if (!node.intents.length) findings.push({ level: "warn", about: node.id, message: `${name} has no intent` });
  }
  const nodeBoxes = graph.nodes.map((n) => ({ id: n.id, ...n.bounds }));
  const elementOf = new Map(snapshot.elements.map((el) => [el.id, el]));
  for (const edge of graph.edges) {
    const from = edge.from ? graph.nodes.find((n) => n.id === edge.from) : null;
    const to = edge.to ? graph.nodes.find((n) => n.id === edge.to) : null;
    if (!from || !to) findings.push({ level: "warn", about: edge.id, message: `edge ${edge.id} does not join two components (${from ? clean(from.label) : "—"} → ${to ? clean(to.label) : "—"})` });
    else if (!edge.intents.length && !clean(edge.label)) findings.push({ level: "info", about: edge.id, message: `edge ${clean(from.label)} → ${clean(to.label)} has no label or intent` });
    // An edge through a component says the component is on its path (D72).
    const el = elementOf.get(edge.sourceId);
    if (from && to && el?.points && el.points.length >= 2) {
      const through = passesThrough(absolutePoints(el.x, el.y, el.points), nodeBoxes, new Set([from.id, to.id]));
      if (through.length) {
        const names = through.map((b) => clean(graph.nodes.find((n) => n.id === b.id)?.label) || b.id);
        const frame = from.frameId ? `layout({frame:'${from.frameId}'})` : "layout({frame:null})";
        findings.push({ level: "warn", about: edge.id, message: `edge ${clean(from.label)} → ${clean(to.label)} passes through ${names.join(", ")} — ${frame} re-routes it, or move what is in the way` });
      }
    }
  }
  const linked = new Set(graph.nodes.map((n) => n.detailFrameId).filter(Boolean));
  for (const frame of graph.frames) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    const name = clean(frame.name) || frame.id;
    if (!clean(frame.narrative)) findings.push({ level: "warn", about: frame.id, message: `frame ${name} has no narrative` });
    if (members.length > MAX_FRAME_COMPONENTS) findings.push({ level: "warn", about: frame.id, message: `frame ${name} holds ${members.length} components — split with detail layers (max ${MAX_FRAME_COMPONENTS})` });
    if (!members.length) findings.push({ level: "info", about: frame.id, message: `frame ${name} is empty` });
    const tier = tiers.frameTier.get(frame.sourceId) ?? 1;
    if (tier > 1 && !linked.has(frame.id)) findings.push({ level: "warn", about: frame.id, message: `detail frame ${name} is linked from no component` });
  }
  for (const frame of graph.frames) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    const crossings = countCrossings(members, graph.edges);
    if (crossings) {
      findings.push({
        level: "warn",
        about: frame.id,
        message: `frame ${clean(frame.name) || frame.id} has ${crossings} arrow crossing${crossings === 1 ? "" : "s"} — layout({frame:'${frame.id}'}) if you built it, or re-place the component, or add a detail layer`,
      });
    }
  }
  const loose = graph.nodes.filter((n) => n.frameId === null);
  const looseCrossings = countCrossings(loose, graph.edges);
  if (looseCrossings) findings.push({ level: "warn", about: null, message: `Layer 1 has ${looseCrossings} arrow crossing${looseCrossings === 1 ? "" : "s"} among unframed components` });
  const warns = findings.filter((f) => f.level === "warn").length;
  const summary = findings.length ? `${warns} warning${warns === 1 ? "" : "s"}, ${findings.length - warns} note${findings.length - warns === 1 ? "" : "s"}` : "clean — every component has a kind and an intent, every frame a narrative";
  return { findings, summary };
}

export type { GraphFrame, GraphNode };
