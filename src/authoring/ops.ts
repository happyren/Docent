/**
 * Authoring operations (S19, D59–D62): what an agent asks for, in the
 * diagram's own terms, turned into one adapter write. `plan` validates a
 * batch whole and compiles it — ids assigned, looks resolved through the
 * legend and the house style, places found — without touching anything;
 * `simulate` applies a plan to a snapshot so the semantic diff (D46) can
 * say what it would change before it does; `lint` is the craft check.
 * Pure and deterministic given the id source (I3).
 */
import type { Proposal, LegendRule, Scenario, SceneLink, SceneSnapshot, SnapshotElement } from "../adapter/snapshot";
import type { SceneWrite, WriteArrow, WriteFrame, WriteMeaning, WritePatch, WriteShape, WriteStyle, WriteSymbol } from "../adapter/excalidraw";
import { applyLegend } from "../export/legend";
import { buildSceneGraph, type GraphEdge, type GraphFrame, type GraphNode, type SceneGraph } from "../scene/graph";
import { computeTiers } from "../scene/tiers";
import { isScenePath, SCENE_PATH_ERROR, segmentsOf } from "../portfolio/tree";
import { GENRE_IDS, genreFindings, genreOf, scenarioFindings, type GenreProfile } from "./genre";
import { countCrossings, edgeLabelSize, FRAME_HEAD, FRAME_PAD, growFrame, hugFrame, laneLayout, layeredLayout, legendBox, memberBoxes, placeFrame, placeInFrame, separateFrames, sizeForLabel, type Box, type FramePlacement, type LayoutOptions } from "./layout";
import {
  absolutePoints,
  arcCorners,
  assignPorts,
  chooseSidesWithLine,
  dropCollinear,
  edgeWiggles,
  NUDGE,
  nudgeRoutes,
  type NudgeRoute,
  passesThrough,
  polylineThroughBox,
  ROUTE_PAD,
  routeEdge,
  segmentsCrossProperly,
  settleApproaches,
  settleGrazes,
  simplifyRoute,
  type Point,
  type SidePair,
} from "./route";
import { pickKindLook, toneLook, toneOfTag, type Role, type Tone } from "./palette";
import { craftScore, type CraftScore } from "./score";
import { DEFAULT_STYLE, houseStyle, kindOf, resolveLook, type Shape } from "./style";
import { placeSymbol, symbolEntry } from "./symbols";

// ---------------------------------------------------------------------------
// the operations
// ---------------------------------------------------------------------------

export interface AddNode {
  op: "add_node";
  /** A handle later ops in the batch may refer to, e.g. `$orders`. */
  ref?: string;
  label: string;
  kind?: string;
  /**
   * A library symbol id from the catalog, e.g. `aws/lambda` (S21, D83):
   * the component is drawn as that icon with the label under it, instead
   * of as a shape. `find_symbol` is how one is looked up.
   */
  symbol?: string;
  /** A frame id (or ref); absent = Layer 1, unframed. */
  frame?: string | null;
  shape?: Shape;
  tags?: string[];
  intents?: string[];
  logic?: string;
  /**
   * Another scene this component points at (D95, D97): link when it is
   * another diagram's story, `add_detail_layer` when it is this one going
   * deeper. Only the shape is checked here — whether the target exists is
   * `validate`'s question, asked where the store can answer it.
   */
  link?: SceneLink;
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
  /** Point at another scene (D95, D97); null clears the link, absent keeps it. */
  link?: SceneLink | null;
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
  /**
   * The kind IS a library symbol (D84): the legend rule matches on the
   * symbol, the drawn legend shows the icon, and no colour is picked —
   * the brand's colour is not Docent's to choose.
   */
  symbol?: string;
  /** What the kind means to a reader — picks the conventional hue (D77). */
  tone?: Tone;
  /** What family of thing it is, when no tone applies (D77). */
  role?: Role;
  style?: { backgroundColor?: string; strokeColor?: string; strokeStyle?: string; fillStyle?: string; strokeWidth?: number };
}

export interface Layout {
  op: "layout";
  /** A frame id, or null for the unframed Layer 1 components. */
  frame: string | null;
}

/**
 * Adopt a genre (D87): the id (or the name) of one of the five. The genre
 * is recorded beside the legend, its kinds are seeded into the legend it
 * does not already hold, and everything downstream — the lint, the
 * layout's posture — reads what was recorded.
 */
export interface UseGenre {
  op: "use_genre";
  genre: string;
}

/**
 * Name a path through the diagram (D89): the edges one request takes, in
 * the order it takes them. Stored beside the legend, replayed by `flow`
 * and the guided tour. A name already used is replaced.
 */
export interface DefineScenario {
  op: "define_scenario";
  name: string;
  /** Edge ids (or refs from this batch), in the order the story runs. */
  path: string[];
  description?: string;
}

export interface DefineProposal {
  op: "define_proposal";
  ref?: string;
  /** The proposal's one-line name. Required unless clearing. */
  title?: string;
  /** What the lens compares with — "base", "saved", or "project/path". */
  against?: string;
  /** Each win one sentence — what the change buys. */
  wins?: string[];
  /** Each cost one sentence — what it spends. */
  costs?: string[];
  /** True removes the recorded case (D135). */
  clear?: boolean;
}

export type Op = AddNode | AddEdge | Update | Remove | AddFrame | AddDetailLayer | DefineKind | Layout | UseGenre | DefineScenario | DefineProposal;

/**
 * A write, and what rides beside the legend on its carrier (D87, D89):
 * the scene's genre and its scenarios. Optional additions, so a
 * `MeaningWrite` is a `SceneWrite` everywhere one is asked for. The scene
 * link (D95) needs no addition at all — it is meaning, so it travels on
 * `WriteMeaning` with the intents and the detail pointer.
 */
export interface MeaningWrite extends SceneWrite {
  /** The genre this write records; absent leaves what the scene has. */
  genre?: string;
  /** The scenarios this write records, whole, in authored order. */
  scenarios?: Scenario[];
  /** The proposal's case this write records (D135); null clears it. */
  proposal?: Proposal | null;
}

export interface Plan {
  write: MeaningWrite;
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

/** The store's own refusal for a project name, said before the round trip. */
const PROJECT_NAME_ERROR =
  "invalid project name — use letters, digits, spaces, - or _ (max 64, no leading symbol)";

/**
 * A scene link's SHAPE (D97): D92's one rule for the path, the store's one
 * rule for the project, and an arrival point that is either a component id
 * or nothing at all. Existence is not asked here — a planner that listed
 * the store would refuse a link to a scene about to be created, and the
 * lint is where a stale link is caught (D97).
 */
function checkLink(link: SceneLink, at: string, problems: string[]): SceneLink | null {
  const scene = clean(link.scene);
  if (!isScenePath(scene)) {
    problems.push(`${at}: ${SCENE_PATH_ERROR}`);
    return null;
  }
  const project = clean(link.project);
  if (link.project !== undefined && (!isScenePath(project) || segmentsOf(project).length !== 1)) {
    problems.push(`${at}: ${PROJECT_NAME_ERROR}`);
    return null;
  }
  const point = clean(link.at);
  if (link.at !== undefined && !point) {
    problems.push(`${at}: link.at is empty — name the component to arrive on, or leave it out`);
    return null;
  }
  return { scene, ...(project ? { project } : {}), ...(point ? { at: point } : {}) };
}

/** A link as a note says it: the project when it names one, then the path. */
const linkNote = (link: SceneLink) => `${link.project ? `${link.project}/` : ""}${link.scene}`;

/** How a drawn element's type sizes a label: anything else takes a box's room (D80). */
const drawnShape = (type: string): Shape => (type === "ellipse" || type === "diamond" ? type : "rectangle");

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
  // The scene's conventions, as this batch will leave them (D87, D89).
  let genre: string | null = graph.genre;
  let genreChanged = false;
  let scenarios: Scenario[] = [...graph.scenarios];
  let scenariosChanged = false;
  let proposal: Proposal | null = graph.proposal;
  let proposalChanged = false;
  // The genre this plan lays out by (D90): what the scene records, or
  // what a `use_genre` in this very batch establishes — an agent's first
  // batch adopts a genre and draws in it, and the posture has to hold for
  // the drawing made in the same breath.
  const adopted = [...ops].reverse().find((o): o is UseGenre => o.op === "use_genre" && genreOf(o.genre) !== null);
  const profile: GenreProfile | null = adopted ? genreOf(adopted.genre) : genreOf(graph.genre);
  const posture = profile?.posture ?? "map";

  const write: Required<Pick<MeaningWrite, "shapes" | "symbols" | "arrows" | "frames" | "patches" | "remove">> = {
    shapes: [],
    symbols: [],
    arrows: [],
    frames: [],
    patches: [],
    remove: [],
  };
  // What the batch itself created, by source id — for placement and bounds.
  // A symbol component carries two boxes (D83): the whole thing (icon ∪
  // label) is what placement and routing avoid, while `port` — the icon's
  // own bounds, which is the carrier — is where its edges meet it.
  const created = new Map<
    string,
    Box & { type: string; frameId: string | null; label: string | null; kind: string | null; symbol?: string; port?: Box }
  >();
  const createdFrames = new Map<string, WriteFrame & { members: string[]; tier?: number }>();
  const removed = new Set<string>();
  // What a `layout` re-laid, moved or not: tidy re-routes every bound edge
  // in its scope, so the whole frame is redrawn as one stroke each (D73, D78).
  const relaid = new Set<string>();

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
  /** A component that was placed as a library symbol (D83), or null. */
  const symbolNode = (sourceId: string) => graph.nodes.find((n) => n.sourceId === sourceId && n.symbol) ?? null;
  const boxOf = (sourceId: string): Box | null => {
    const made = created.get(sourceId);
    if (made) return { x: made.x, y: made.y, width: made.width, height: made.height };
    // A symbol's box is the whole component — icon and label (D83) — not the
    // carrier rectangle the element table holds.
    const symbol = symbolNode(sourceId);
    if (symbol) return { ...symbol.bounds };
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

  /**
   * A tag with a conventional name colours itself (D77): the legend gains a
   * stroke rule for it and the component wears that stroke, so the export
   * reads the tag back off the picture. The kind is the louder meaning,
   * though — if the stroke would stop the component reading as the kind it
   * is (a legend rule that names a stroke colour), the tag keeps quiet.
   */
  const tagTones = (tags: readonly string[], shape: Shape, style: WriteStyle, about: string): WriteStyle => {
    let next = style;
    const was = kindOf(style, shape, legend);
    for (const tag of tags) {
      if (legend.some((r) => r.key === "tag" && r.meaning === tag)) continue;
      const tone = toneOfTag(tag);
      if (!tone) continue;
      const look = toneLook(tone);
      const candidate: WriteStyle = { ...next, strokeColor: look.stroke, ...(look.strokeStyle ? { strokeStyle: look.strokeStyle } : {}) };
      const rule: LegendRule = { attr: "strokeColor", value: look.stroke, key: "tag", meaning: tag };
      if (look.strokeStyle) rule.also = [{ attr: "strokeStyle", value: look.strokeStyle }];
      const trial = [...legend, rule];
      if (kindOf(candidate, shape, trial) !== was) {
        notes.push(`${about}: tag ${tag} kept the kind's stroke — a ${tone} one would change what kind it reads as`);
        continue;
      }
      legend = trial;
      legendChanged = true;
      next = candidate;
      notes.push(`tag ${tag} → ${look.name} stroke (${tone})`);
    }
    return next;
  };

  // Strokes the palette paired with kinds defined in this batch (D77): drawn
  // on the kind's first components, and carried on by the house style after.
  const kindStrokes = new Map<string, string>();
  /**
   * A kind's rule in the legend, chosen by the palette (D77): the body of
   * `define_kind`, standing on its own so a genre seeds its vocabulary
   * down exactly the path an agent's own call takes (D87). `announce` is
   * off while a genre seeds — the genre says in one line what it seeded,
   * rather than a line per kind.
   */
  const defineKind = (op: DefineKind, at: string, announce = true): void => {
    const kind = clean(op.kind);
    if (!kind) {
      problems.push(`${at}: kind is empty`);
      return;
    }
    if (legend.some((r) => r.key === "kind" && r.meaning === kind)) {
      if (announce) notes.push(`${kind} is already in the legend — kept as is`);
      return;
    }
    // A kind may BE a library symbol (D84): the rule matches on the
    // symbol, the drawn legend shows the icon beside the meaning, and
    // no colour is picked — the brand chose that already.
    if (op.symbol) {
      const wanted = clean(op.symbol).toLowerCase();
      const entry = symbolEntry(wanted);
      if (!entry) {
        problems.push(`${at}: unknown symbol ${op.symbol} — find_symbol first`);
        return;
      }
      legend = [...legend, { attr: "symbol", value: entry.symbol, key: "kind", meaning: kind }];
      legendChanged = true;
      if (announce) notes.push(`legend: ${kind} → symbol ${entry.symbol} (${entry.name})`);
      return;
    }
    // Colour means something (D77): a tone or a role picks the hue the
    // reader already knows, and without either the fill that stands
    // furthest from every kind the legend draws — with a second channel
    // once hue alone has stopped separating. A raw style still wins,
    // field by field, as it always has (D59).
    const picked = pickKindLook({ kind, tone: op.tone, role: op.role, taken: legend, shape: op.shape });
    const fill = op.style?.backgroundColor ?? picked.backgroundColor;
    const shape = op.shape ?? picked.shape;
    const strokeColor = op.style?.strokeColor ?? picked.strokeColor;
    const strokeStyle = op.style?.strokeStyle ?? picked.strokeStyle;
    const fillStyle = op.style?.fillStyle ?? picked.fillStyle;
    const rule: LegendRule = { attr: "backgroundColor", value: fill, key: "kind", meaning: kind };
    const also: { attr: LegendRule["attr"]; value: string }[] = [];
    if (shape) also.push({ attr: "shape", value: shape });
    // A kind is its fill and shape; the stroke is the tags' channel (D77).
    // The palette's matching stroke is drawn, not required — only a stroke
    // the caller named becomes a condition of the match.
    if (op.style?.strokeColor) also.push({ attr: "strokeColor", value: op.style.strokeColor });
    else if (strokeColor) kindStrokes.set(kind, strokeColor);
    if (strokeStyle) also.push({ attr: "strokeStyle", value: strokeStyle });
    if (fillStyle) also.push({ attr: "fillStyle", value: fillStyle });
    if (op.style?.strokeWidth) also.push({ attr: "strokeWidth", value: String(op.style.strokeWidth) });
    if (also.length) rule.also = also;
    legend = [...legend, rule];
    legendChanged = true;
    const chosen = `legend: ${kind} → ${shape ?? "any shape"} with ${fill === "transparent" ? "no fill" : `fill ${fill}`}`;
    if (announce) notes.push(op.style ? chosen : `${chosen} — ${picked.why}`);
  };
  for (const [i, op] of ops.entries()) {
    const at = `op ${i + 1} (${op.op})`;
    switch (op.op) {
      case "define_kind": {
        defineKind(op, at);
        break;
      }
      case "use_genre": {
        // A genre is a set of conventions, and the legend is where
        // conventions live (D87): record it beside the rules, and seed the
        // vocabulary the legend does not already hold. Never delete —
        // switching genre leaves what was drawn readable.
        const wanted = genreOf(op.genre);
        if (!wanted) {
          problems.push(`${at}: unknown genre "${op.genre}" — one of ${GENRE_IDS.join(", ")}`);
          break;
        }
        const inForce = genre === wanted.id;
        if (!inForce) {
          genre = wanted.id;
          genreChanged = true;
        }
        const seeded: string[] = [];
        const held: string[] = [];
        for (const kind of wanted.kinds) {
          if (legend.some((r) => r.key === "kind" && r.meaning === kind.kind)) {
            held.push(kind.kind);
            continue;
          }
          defineKind({ op: "define_kind", kind: kind.kind, tone: kind.tone, role: kind.role, shape: kind.shape }, at, false);
          seeded.push(kind.kind);
        }
        const said: string[] = [];
        if (seeded.length) said.push(`seeded ${seeded.join(", ")}`);
        if (held.length) said.push(`${held.join(", ")} already in the legend`);
        notes.push(`genre: ${wanted.name}${inForce ? " is already in force" : ""}${said.length ? ` — ${said.join("; ")}` : ""}`);
        break;
      }
      case "define_scenario": {
        // A scenario is a path of edges (D89) — the map already says what
        // the components are; the story is which arrows it travels.
        const name = clean(op.name);
        if (!name) {
          problems.push(`${at}: name is empty`);
          break;
        }
        if (!op.path?.length) {
          problems.push(`${at}: path is empty — a scenario is the edges the request takes, in order`);
          break;
        }
        const path: string[] = [];
        op.path.forEach((step, n) => {
          const where = `${at}: step ${n + 1}`;
          const found = step.startsWith("$")
            ? ids[step]
              ? { sourceId: ids[step], kind: createdFrames.has(ids[step]) ? "frame" : created.get(ids[step])?.type === "arrow" ? "edge" : "node" }
              : null
            : sourceOf(graph, step);
          if (!found) {
            problems.push(`${where}: unknown id ${step} — use ids from get_scene_graph or refs from this batch`);
            return;
          }
          if (found.kind !== "edge") {
            problems.push(`${where}: ${step} is a ${found.kind} — a scenario is a path of edges, so name the arrows the request travels, in order`);
            return;
          }
          if (removed.has(found.sourceId)) {
            problems.push(`${where}: ${step} is removed earlier in this batch`);
            return;
          }
          path.push(found.sourceId);
        });
        if (path.length !== op.path.length) break;
        const scenario: Scenario = op.description ? { name, description: clean(op.description), path } : { name, path };
        const existing = scenarios.findIndex((s) => s.name === name);
        if (existing >= 0) {
          scenarios = scenarios.map((s, k) => (k === existing ? scenario : s));
          notes.push(`scenario "${name}" replaced (${path.length} step${path.length === 1 ? "" : "s"})`);
        } else {
          scenarios = [...scenarios, scenario];
          notes.push(`scenario "${name}" defined (${path.length} step${path.length === 1 ? "" : "s"})`);
        }
        scenariosChanged = true;
        break;
      }
      case "define_proposal": {
        // The case is meaning (D135): a title and the argument, beside the
        // legend where the genre and the scenarios live.
        if (op.clear) {
          if (proposal !== null) {
            proposal = null;
            proposalChanged = true;
            notes.push("proposal cleared");
          }
          break;
        }
        const title = clean(op.title ?? "");
        if (!title) {
          problems.push(`${at}: title is empty — name the proposal, or pass clear:true to remove it`);
          break;
        }
        const lines = (raw: string[] | undefined): string[] =>
          (raw ?? []).map((line) => clean(line)).filter((line) => line !== "");
        const against = clean(op.against ?? "");
        proposal = {
          title,
          ...(against ? { against } : {}),
          wins: lines(op.wins),
          costs: lines(op.costs),
        };
        proposalChanged = true;
        notes.push(`proposal "${title}" recorded (${proposal.wins.length} win${proposal.wins.length === 1 ? "" : "s"}, ${proposal.costs.length} cost${proposal.costs.length === 1 ? "" : "s"})`);
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
        const frame: WriteFrame & { members: string[]; tier?: number } = {
          id,
          name,
          ...box,
          meaning: op.narrative || op.order !== undefined ? { narrative: op.narrative ?? null, order: op.order ?? null } : null,
          members: [],
          tier: 1,
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
        const frame: WriteFrame & { members: string[]; tier?: number } = {
          id,
          name: op.name ? clean(op.name) : `${label} — detail`,
          ...box,
          meaning: op.narrative ? { narrative: op.narrative } : null,
          members: [],
          tier: parentTier + 1,
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
        const tags = op.tags?.length ? op.tags.map(clean).filter(Boolean) : [];
        let style: WriteStyle = { ...look.style, ...(op.style ?? {}) };
        if (kind && look.source === "legend" && !op.style?.strokeColor && kindStrokes.has(kind)) style.strokeColor = kindStrokes.get(kind)!;
        // A raw stroke is the author's own; otherwise a conventional tag may
        // colour it (D77).
        if (tags.length && !op.style?.strokeColor) style = tagTones(tags, shape, style, label);
        // A symbol is a component (D83): the agent names one, or the kind's
        // legend rule already does (D84). Its box is the catalog's native
        // size grown to the label — icon ∪ label, for placement and routing.
        const wantedSymbol = op.symbol ? clean(op.symbol).toLowerCase() : (look.symbol ?? null);
        const entry = wantedSymbol ? symbolEntry(wantedSymbol) : null;
        if (wantedSymbol && !entry) {
          problems.push(`${at}: unknown symbol ${op.symbol ?? wantedSymbol} — find_symbol first`);
          break;
        }
        const placement = entry ? placeSymbol(entry, label, style.fontSize) : null;
        const size = placement ? placement.size : sizeForLabel(label, style.fontSize, shape);
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
        if (tags.length) meaning.tags = tags;
        if (op.intents?.length) meaning.intents = op.intents.map(clean).filter(Boolean);
        if (op.logic) meaning.logic = op.logic;
        if (op.link) {
          const link = checkLink(op.link, at, problems);
          if (link) {
            meaning.link = link;
            notes.push(`${label}: linked to ${linkNote(link)}`);
          }
        }
        if (placement) {
          // The carrier's box is the icon's; arrows meet the drawing, not
          // the caption's room (D83). The label rides where the library put
          // the caption it replaces, wrapped to the icon's width.
          const icon = { x: box.x + placement.icon.x, y: box.y + placement.icon.y, width: placement.icon.width, height: placement.icon.height };
          const symbol: WriteSymbol = {
            id,
            symbol: placement.entry.symbol,
            library: placement.entry.library,
            index: placement.entry.index,
            x: box.x + placement.item.x,
            y: box.y + placement.item.y,
            icon,
            label,
            labelLines: placement.label.lines,
            labelBox: { x: box.x + placement.label.x, y: box.y + placement.label.y, width: placement.label.width, height: placement.label.height },
            frameId,
            labelStyle: style,
            meaning: Object.keys(meaning).length ? meaning : null,
          };
          write.symbols.push(symbol);
          // Same symbol, same size (D85): the layout groups by the symbol,
          // never by the kind, so an icon is never stretched to a peer's box.
          created.set(id, { ...box, type: "rectangle", frameId, label, kind: `symbol:${placement.entry.symbol}`, symbol: placement.entry.symbol, port: icon });
          notes.push(`${label}: drawn as ${placement.entry.name} (${placement.entry.symbol})`);
        } else {
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
        }
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
        if (op.link !== undefined) {
          const about = clean(patch.label ?? current?.label) || op.id;
          if (op.link === null) {
            meaning.link = null;
            notes.push(`${about}: link cleared`);
          } else {
            const link = checkLink(op.link, at, problems);
            if (link) {
              meaning.link = link;
              notes.push(`${about}: linked to ${linkNote(link)}`);
            }
          }
        }
        // A placed symbol wears the library's drawing, not a style (D83):
        // nothing a kind or a tag would paint has anywhere to go on it.
        const symbolTarget = symbolNode(target);
        if (op.kind !== undefined) {
          if (kindOfTarget !== "node") problems.push(`${at}: only a component has a kind`);
          else {
            const look = resolveLook(clean(op.kind), house, legend);
            if (look.source === "house") problems.push(`${at}: kind "${op.kind}" has no look yet — define_kind first`);
            else if (symbolTarget) notes.push(`${op.id}: kept the ${symbolTarget.symbol} drawing — a kind's colour does not dress an icon`);
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
                // A symbol's patch names its carrier, so the move is a delta
                // on the icon; the whole group goes with it (D83).
                const carrier = symbolTarget ? elements.get(target) : null;
                patch.x = carrier ? carrier.x + (placed.x - box.x) : placed.x;
                patch.y = carrier ? carrier.y + (placed.y - box.y) : placed.y;
                noteGrow(f, placed);
              }
            }
          }
        }
        // Tags gained here colour themselves the same way they do on a new
        // component (D77) — on the shape this batch just made, or as a patch.
        if (meaning.tags?.length && kindOfTarget === "node" && !symbolTarget) {
          const made = write.shapes.find((s) => s.id === target);
          const node = graph.nodes.find((n) => n.sourceId === target);
          const tagShape = (made?.type ?? node?.shape ?? house.defaultShape) as Shape;
          const before: WriteStyle = { ...(made?.style ?? { ...DEFAULT_STYLE, ...(node?.style ?? {}) }), ...(patch.style ?? {}) };
          const toned = tagTones(meaning.tags, tagShape, before, patch.label ?? node?.label ?? op.id);
          if (toned !== before) {
            if (made) {
              made.style = toned;
              delete patch.style;
            } else patch.style = { ...(patch.style ?? {}), strokeColor: toned.strokeColor, strokeStyle: toned.strokeStyle };
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
        // A symbol is one component (D83): its carrier, the icon's own
        // elements, and its label go together.
        const carrierEl = elements.get(target);
        if (carrierEl?.docent.symbol) {
          const group = carrierEl.groupIds[carrierEl.groupIds.length - 1];
          if (group) for (const el of snapshot.elements) if (el.groupIds.includes(group)) toRemove.add(el.id);
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
        // A scenario is a path of edges by id (D89): taking one of them out
        // leaves a step pointing at nothing. Said, never refused — the
        // author may be redrawing that leg (D60, I5).
        for (const scenario of scenarios) {
          for (const step of new Set(scenario.path.filter((s) => toRemove.has(s)))) {
            const label = clean(graph.edges.find((e) => e.sourceId === step)?.label) || step;
            notes.push(`"${label}": scenario "${scenario.name}" steps through it — the scenario will flag until re-pointed`);
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
        // is what decides which of them share a width (D74, D80) — except a
        // symbol, whose peers are the components drawn as the same icon, and
        // whose size is the catalog's, never a sibling's (D85).
        const kinds = new Map(
          members.map((n) => [n.id, n.symbol ? `symbol:${n.symbol}` : applyLegend(n.style, n.shape, legend, n.symbol).kind]),
        );
        // What each label needs is what its kind's shared width is the
        // median of, and what a longer one is re-wrapped to (D80).
        const memberById = new Map(members.map((n) => [n.id, n]));
        const fontOf = (sourceId: string): number => {
          const el = elements.get(sourceId);
          const text = el?.boundElements.find((b) => b.type === "text");
          return (text ? elements.get(text.id)?.look.fontSize : null) ?? house.shape.fontSize;
        };
        const options: LayoutOptions = {
          labelSize: (e) => edgeLabelSize(e.label, house.arrow.style.fontSize),
          kindOf: (id) => kinds.get(id) ?? null,
          labelOf: (id) => {
            const n = memberById.get(id);
            // A symbol's label is already wrapped to its icon; it is not a
            // box that can be re-wrapped wider or narrower (D85).
            if (!n || n.symbol) return null;
            return n.label ? { text: n.label, fontSize: fontOf(n.sourceId), shape: drawnShape(n.shape) } : null;
          },
          // Components already on the canvas are authored in the order they
          // read: position order, which is what the layout defaults to (D79).
          ...(posture === "straight" ? { posture: "straight" as const } : {}),
        };
        // The genre's posture on the same pipeline (D90). A lanes genre
        // laid one scope out at a time has one lane in front of it — this
        // frame, or the unframed components, which name none — and lanes
        // never fold, which is the discipline that matters here.
        const boxes =
          posture === "lanes"
            ? laneLayout(members, graph.edges, sizes, origin, {
                ...options,
                lanes: frameSource ? [frameSource] : [],
                laneOf: () => frameSource,
              })
            : layeredLayout(members, graph.edges, sizes, origin, options);
        const laidBoxes: Box[] = [];
        for (const n of members) {
          relaid.add(n.sourceId);
          const box = boxes.get(n.id);
          if (!box) continue;
          if (n.symbol) {
            // A symbol keeps the size the library drew it at (D85): it takes
            // the place the layout gives it, centred in a row that may be
            // taller. The patch names its carrier, and the whole group —
            // the icon's elements and the label — goes with it (D83).
            const carrier = elements.get(n.sourceId);
            const dx = box.x + Math.round((box.width - n.bounds.width) / 2) - n.bounds.x;
            const dy = box.y + Math.round((box.height - n.bounds.height) / 2) - n.bounds.y;
            if (carrier && (dx !== 0 || dy !== 0)) {
              write.patches.push({ id: n.sourceId, x: carrier.x + dx, y: carrier.y + dy });
              touched.push(n.sourceId);
            }
            const kept = { x: n.bounds.x + dx, y: n.bounds.y + dy, width: n.bounds.width, height: n.bounds.height };
            noteGrow(frameSource, kept);
            laidBoxes.push(kept);
            continue;
          }
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
          laidBoxes.push(box);
        }
        // Tidy hugs the frame (D101): the border comes back at the members'
        // bounds plus the standard room, with no memory of the acreage a
        // write had grown — the asking includes the border. An empty frame
        // keeps its size.
        if (frameSource) {
          const hugged = hugFrame(laidBoxes);
          if (hugged) grownFrames.set(frameSource, hugged);
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
  // The batch wrote its components in the order they happen, and that is
  // the order a cycle in it is ranked by (D79).
  const createdAt = new Map([...created.keys()].map((id, i) => [id, i] as const));
  const shapeById = new Map(write.shapes.map((sh) => [sh.id, sh]));
  // The label and the peer-width a laid-out component is given, whichever
  // posture lays it out (D74, D80).
  const laidOutLabel = (id: string) => {
    const sh = shapeById.get(id);
    return sh?.label ? { text: sh.label, fontSize: sh.style.fontSize, shape: sh.type } : null;
  };
  // The lanes posture (D90): every tier-1 frame the batch built is one
  // lane of ONE layout, because rank is time and time has to line up
  // across the contexts — which a frame-at-a-time pass cannot do. Detail
  // layers (tier ≥ 2) are maps of a mechanism and keep the map's fold.
  const laneFrames =
    posture === "lanes"
      ? [...createdFrames.keys()].filter((id) => framesToLayOut.has(id) && (createdFrames.get(id)!.tier ?? 1) === 1)
      : [];
  const laneMembers = laneFrames.length
    ? [...created.entries()].filter(([, c]) => c.type !== "arrow" && c.frameId !== null && laneFrames.includes(c.frameId))
    : [];
  if (laneMembers.length > 1) {
    for (const id of laneFrames) framesToLayOut.delete(id);
    // Lanes in the order the batch declared its frames — the first is the
    // top row. An empty frame is no lane at all.
    const lanes = laneFrames.filter((id) => laneMembers.some(([, c]) => c.frameId === id));
    const memberIds = new Set(laneMembers.map(([id]) => id));
    const nodes = laneMembers.map(([id, c]) => ({ id, bounds: { x: c.x, y: c.y, width: c.width, height: c.height } })) as unknown as GraphNode[];
    // Edges across lanes rank as edges within one do: a command in one
    // context and the event it causes in another are one step apart.
    const edges = write.arrows
      .filter((a) => memberIds.has(a.from) && memberIds.has(a.to))
      .map((a) => ({ id: a.id, from: a.from, to: a.to, label: a.label })) as unknown as GraphEdge[];
    const sizes = new Map(laneMembers.map(([id, c]) => [id, { width: c.width, height: c.height }]));
    const first = grownFrames.get(lanes[0]) ?? frameBox(lanes[0])!;
    const boxes = laneLayout(nodes, edges, sizes, { x: first.x + FRAME_PAD, y: first.y + FRAME_HEAD + FRAME_PAD }, {
      labelSize: (e) => edgeLabelSize(e.label, house.arrow.style.fontSize),
      kindOf: (id) => created.get(id)?.kind ?? null,
      labelOf: laidOutLabel,
      order: (id) => createdAt.get(id) ?? 0,
      lanes,
      laneOf: (id) => created.get(id)?.frameId ?? null,
    });
    for (const [id, c] of laneMembers) {
      const box = boxes.get(id);
      if (!box) continue;
      if (c.symbol) {
        // A symbol keeps its native size (D85) and moves whole (D83).
        const dx = box.x + Math.round((box.width - c.width) / 2) - c.x;
        const dy = box.y + Math.round((box.height - c.height) / 2) - c.y;
        c.x += dx;
        c.y += dy;
        if (c.port) c.port = { ...c.port, x: c.port.x + dx, y: c.port.y + dy };
        const symbol = write.symbols.find((sym) => sym.id === id);
        if (symbol) {
          symbol.x += dx;
          symbol.y += dy;
          symbol.icon = { ...symbol.icon, x: symbol.icon.x + dx, y: symbol.icon.y + dy };
          symbol.labelBox = { ...symbol.labelBox, x: symbol.labelBox.x + dx, y: symbol.labelBox.y + dy };
        }
        continue;
      }
      c.x = box.x;
      c.y = box.y;
      c.width = box.width;
      c.height = box.height;
      const shape = write.shapes.find((sh) => sh.id === id);
      if (shape) Object.assign(shape, { x: box.x, y: box.y, width: box.width, height: box.height });
    }
    // Every lane spans the whole time axis, so the frames read as bands of
    // one diagram rather than boxes of their own. LANE_GAP left the room
    // between them, so D86 finds nothing to part.
    const placed = laneMembers.map(([, c]) => ({ x: c.x, y: c.y, width: c.width, height: c.height }));
    const left = Math.min(...placed.map((b) => b.x)) - FRAME_PAD;
    const right = Math.max(...placed.map((b) => b.x + b.width)) + FRAME_PAD;
    for (const frameId of lanes) {
      const own = laneMembers.filter(([, c]) => c.frameId === frameId).map(([, c]) => ({ x: c.x, y: c.y, width: c.width, height: c.height }));
      const grown = growFrame({ x: left, y: Math.min(...own.map((b) => b.y)), width: right - left, height: 0 }, own);
      Object.assign(createdFrames.get(frameId)!, { x: grown.x, y: grown.y, width: Math.max(grown.width, 300), height: Math.max(grown.height, 200) });
      // What the frame grew by while its members were being placed is
      // stale now: every one of them has just been re-placed.
      grownFrames.delete(frameId);
    }
    notes.push(`${profile!.name}: ${laneMembers.length} components in ${lanes.length} lane${lanes.length === 1 ? "" : "s"}, time left to right`);
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
      // The batch said what each component is, so peers share a width (D74, D80).
      kindOf: (id) => created.get(id)?.kind ?? null,
      // And what each label says, so a long one wraps taller (D80).
      labelOf: laidOutLabel,
      order: (id) => createdAt.get(id) ?? 0,
      // The genre's posture, on the one pipeline (D90).
      ...(posture === "straight" ? { posture: "straight" as const } : {}),
    });
    // Start the frame from its own origin again: what grew it is being re-placed.
    let grown: Box = fb ? { x: fb.x, y: fb.y, width: 0, height: 0 } : { x: 0, y: 0, width: 0, height: 0 };
    for (const [id, c] of members) {
      const box = boxes.get(id);
      if (!box) continue;
      if (c.symbol) {
        // A symbol keeps its native size (D85): it moves, centred in a row
        // the layout may have made taller, and the whole item moves with it.
        const dx = box.x + Math.round((box.width - c.width) / 2) - c.x;
        const dy = box.y + Math.round((box.height - c.height) / 2) - c.y;
        c.x += dx;
        c.y += dy;
        if (c.port) c.port = { ...c.port, x: c.port.x + dx, y: c.port.y + dy };
        const symbol = write.symbols.find((sym) => sym.id === id);
        if (symbol) {
          symbol.x += dx;
          symbol.y += dy;
          symbol.icon = { ...symbol.icon, x: symbol.icon.x + dx, y: symbol.icon.y + dy };
          symbol.labelBox = { ...symbol.labelBox, x: symbol.labelBox.x + dx, y: symbol.labelBox.y + dy };
        }
        grown = growFrame(grown, [{ x: c.x, y: c.y, width: c.width, height: c.height }]);
        continue;
      }
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

  // The tier each frame sits on and the author's own order of them: what
  // D86's separation is judged by, and what D100's arrangement ranks by.
  // Read once, since both passes below want them.
  const tierOfFrame = computeTiers(snapshot).frameTier;
  const declared = [...graph.frames].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : 1;
  });

  /**
   * A frame moves and takes everything with it (D86): its own bounds, the
   * components in it — the ones this batch put there and the ones that were
   * there already — and their bound labels, which follow their containers
   * in the adapter. The separation pass has always carried a frame this
   * way; D100's arrangement carries one the same way, which is why the
   * carrying stands here on its own rather than inside either of them.
   */
  const carryFrame = (frameId: string, dx: number, dy: number): void => {
    if (dx === 0 && dy === 0) return;
    const made = createdFrames.get(frameId);
    if (made) {
      made.x += dx;
      made.y += dy;
      const pushed = write.frames.find((f) => f.id === frameId);
      if (pushed) {
        pushed.x += dx;
        pushed.y += dy;
      }
    } else {
      const el = elements.get(frameId);
      if (!el) return;
      const framePatch = write.patches.find((pp) => pp.id === frameId);
      if (framePatch) {
        framePatch.x = (framePatch.x ?? el.x) + dx;
        framePatch.y = (framePatch.y ?? el.y) + dy;
      } else {
        write.patches.push({ id: frameId, x: el.x + dx, y: el.y + dy });
      }
      if (!touched.includes(frameId)) touched.push(frameId);
    }
    // What this batch put in the frame: a symbol moves whole, icon and
    // caption together (D83).
    for (const [memberId, c] of created) {
      if (c.frameId !== frameId || c.type === "arrow") continue;
      c.x += dx;
      c.y += dy;
      if (c.port) c.port = { ...c.port, x: c.port.x + dx, y: c.port.y + dy };
      const sh = write.shapes.find((s) => s.id === memberId);
      if (sh) {
        sh.x += dx;
        sh.y += dy;
      }
      const sy = write.symbols.find((s) => s.id === memberId);
      if (sy) {
        sy.x += dx;
        sy.y += dy;
        sy.icon = { ...sy.icon, x: sy.icon.x + dx, y: sy.icon.y + dy };
        sy.labelBox = { ...sy.labelBox, x: sy.labelBox.x + dx, y: sy.labelBox.y + dy };
      }
    }
    // And what was in it before. A component this batch moved OUT to
    // another frame is that frame's business now, not this one's.
    for (const member of snapshot.elements) {
      if (member.frameId !== frameId || removed.has(member.id) || member.containerId) continue;
      const memberPatch = write.patches.find((pp) => pp.id === member.id);
      if (memberPatch?.frameId !== undefined && memberPatch.frameId !== frameId) continue;
      if (memberPatch) {
        memberPatch.x = (memberPatch.x ?? member.x) + dx;
        memberPatch.y = (memberPatch.y ?? member.y) + dy;
      } else {
        write.patches.push({ id: member.id, x: member.x + dx, y: member.y + dy });
      }
    }
  };

  // -------------------------------------------------------------------------
  // Layer 1 is arranged whole (D100)
  // -------------------------------------------------------------------------
  // The picture the pipeline never composed is the outermost one: today the
  // members inside each frame are ranked, and the unframed components are
  // placed beside them, so an external ends up in a row in the sky with a
  // long diagonal down to the frame it feeds. Ranking the tier as ONE graph
  // is the same algorithm one level up — each tier-1 frame a box of its
  // drawn size, each unframed component a box of its own, every edge from a
  // loose component to a frame MEMBER projected onto the frame, and member
  // edges that cross two frames projected the same way. An edge inside one
  // frame is internal and takes no part. Sources take the columns before
  // what they feed and sinks the columns after, because that is what the
  // layered pipeline does (D74); the boxes are only MOVED, never resized —
  // a frame's size is its members' business and a component's is its
  // label's (D80, D99).
  {
    /** A frame handle a `layout` op named, as a source id. */
    const frameSourceOf = (handle: string): string | null =>
      handle.startsWith("$") ? (ids[handle] ?? null) : (sourceOf(graph, handle)?.sourceId ?? null);
    /** The frame a component sits in as this batch leaves it. */
    const frameOfNode = (sourceId: string): string | null => {
      const madeHere = created.get(sourceId);
      if (madeHere) return madeHere.frameId;
      const patch = write.patches.find((p) => p.id === sourceId && p.frameId !== undefined);
      if (patch) return patch.frameId ?? null;
      return elements.get(sourceId)?.frameId ?? null;
    };
    const tierOf = (frameId: string): number => createdFrames.get(frameId)?.tier ?? tierOfFrame.get(frameId) ?? 1;
    /** A tier-1 frame's box as the passes above left it. */
    const frameNow = (frameId: string): Box => {
      const made = createdFrames.get(frameId);
      if (made) return { x: made.x, y: made.y, width: made.width, height: made.height };
      const el = elements.get(frameId)!;
      const patch = write.patches.find((p) => p.id === frameId);
      return { x: patch?.x ?? el.x, y: patch?.y ?? el.y, width: patch?.width ?? el.width, height: patch?.height ?? el.height };
    };
    /** An unframed component's box as the passes above left it (D83: icon ∪ label). */
    const looseNow = (sourceId: string): Box => {
      const made = created.get(sourceId);
      if (made) return { x: made.x, y: made.y, width: made.width, height: made.height };
      const n = graph.nodes.find((x) => x.sourceId === sourceId)!;
      const patch = write.patches.find((p) => p.id === sourceId);
      if (n.symbol) {
        const carrier = elements.get(sourceId);
        const dx = carrier ? (patch?.x ?? carrier.x) - carrier.x : 0;
        const dy = carrier ? (patch?.y ?? carrier.y) - carrier.y : 0;
        return { x: n.bounds.x + dx, y: n.bounds.y + dy, width: n.bounds.width, height: n.bounds.height };
      }
      return {
        x: patch?.x ?? n.bounds.x,
        y: patch?.y ?? n.bounds.y,
        width: patch?.width ?? n.bounds.width,
        height: patch?.height ?? n.bounds.height,
      };
    };
    /** An unframed component takes its new box; a symbol moves whole (D83). */
    const placeLoose = (sourceId: string, dx: number, dy: number): void => {
      const made = created.get(sourceId);
      if (made) {
        made.x += dx;
        made.y += dy;
        if (made.port) made.port = { ...made.port, x: made.port.x + dx, y: made.port.y + dy };
        const sh = write.shapes.find((s) => s.id === sourceId);
        if (sh) {
          sh.x += dx;
          sh.y += dy;
        }
        const sy = write.symbols.find((s) => s.id === sourceId);
        if (sy) {
          sy.x += dx;
          sy.y += dy;
          sy.icon = { ...sy.icon, x: sy.icon.x + dx, y: sy.icon.y + dy };
          sy.labelBox = { ...sy.labelBox, x: sy.labelBox.x + dx, y: sy.labelBox.y + dy };
        }
        return;
      }
      const el = elements.get(sourceId);
      if (!el) return;
      const patch = write.patches.find((p) => p.id === sourceId);
      if (patch) {
        patch.x = (patch.x ?? el.x) + dx;
        patch.y = (patch.y ?? el.y) + dy;
      } else {
        write.patches.push({ id: sourceId, x: el.x + dx, y: el.y + dy });
      }
      if (!touched.includes(sourceId)) touched.push(sourceId);
    };

    // The boxes of the tier, in the author's own order (D79): frames as
    // declared — the order D86 parts them by — then the ones this batch
    // built, then the loose components in the order they read.
    const tier1 = [
      ...declared.filter((f) => !removed.has(f.sourceId) && elements.has(f.sourceId) && tierOf(f.sourceId) === 1).map((f) => f.sourceId),
      ...[...createdFrames.values()].filter((f) => (f.tier ?? 1) === 1).map((f) => f.id),
    ];
    const looseIds = [
      ...graph.nodes
        .filter((n) => !removed.has(n.sourceId) && frameOfNode(n.sourceId) === null)
        .map((n) => n.sourceId)
        .sort((a, b) => {
          const A = looseNow(a);
          const B = looseNow(b);
          return A.x + A.width / 2 - (B.x + B.width / 2) || A.y + A.height / 2 - (B.y + B.height / 2) || (a < b ? -1 : 1);
        }),
      ...[...created.entries()].filter(([, c]) => c.type !== "arrow" && c.frameId === null).map(([id]) => id),
    ];

    // A meta-node: a set of frames that move together, or one loose
    // component. In a lanes genre every tier-1 frame is a LANE (D90) — the
    // lanes pass has already said where they go and what they span, and
    // this pass must not fight it — so they enter as ONE block that moves
    // as one, and what is left to rank around it is the loose components.
    type Meta = { id: string; box: Box; frames: string[]; node: string | null };
    const spanning = (boxes: readonly Box[]): Box => {
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
    };
    const metas: Meta[] = [];
    if (posture === "lanes" && tier1.length) {
      metas.push({ id: "__lanes", box: spanning(tier1.map(frameNow)), frames: tier1, node: null });
    } else {
      for (const frameId of tier1) metas.push({ id: frameId, box: frameNow(frameId), frames: [frameId], node: null });
    }
    for (const sourceId of looseIds) metas.push({ id: sourceId, box: looseNow(sourceId), frames: [], node: sourceId });

    // Which box each component belongs to — the projection: a member speaks
    // for its frame, a loose component for itself, and a member of a deeper
    // tier speaks for nothing on Layer 1.
    const metaOfNode = new Map<string, string>();
    for (const meta of metas) {
      if (meta.node) metaOfNode.set(meta.node, meta.id);
      for (const frameId of meta.frames) {
        for (const n of graph.nodes) if (!removed.has(n.sourceId) && frameOfNode(n.sourceId) === frameId) metaOfNode.set(n.sourceId, meta.id);
        for (const [id, c] of created) if (c.type !== "arrow" && c.frameId === frameId) metaOfNode.set(id, meta.id);
      }
    }
    const arrowFont = house.arrow.style.fontSize;
    // One projection per pair, wearing the widest of the labels that ride
    // it, so the column gap still holds the words (D70).
    const projected = new Map<string, { id: string; from: string; to: string; label: string | null }>();
    const project = (from: string, to: string, label: string | null) => {
      const a = metaOfNode.get(from);
      const b = metaOfNode.get(to);
      // Both ends inside one box is an internal edge: the frame's own
      // layout drew it, and Layer 1 knows nothing about it.
      if (!a || !b || a === b) return;
      const key = `${a} ${b}`;
      const have = projected.get(key);
      if (!have) projected.set(key, { id: `__meta${projected.size}`, from: a, to: b, label });
      else if (edgeLabelSize(label, arrowFont).width > edgeLabelSize(have.label, arrowFont).width) have.label = label;
    };
    for (const e of graph.edges) {
      if (!e.from || !e.to || removed.has(e.sourceId)) continue;
      const from = graph.nodes.find((n) => n.id === e.from)?.sourceId;
      const to = graph.nodes.find((n) => n.id === e.to)?.sourceId;
      if (from && to) project(from, to, e.label);
    }
    for (const a of write.arrows) project(a.from, a.to, a.label);

    // Hand-placed arrangements move only when asked (D60). The asking is
    // `layout({frame:null})` — which is what tidy of the whole diagram, of
    // tier 1, and of the unframed bucket all compile to (D73) — or a tidy
    // that names every tier-1 frame there is, on a diagram with nothing
    // loose to name. A batch that BUILT the tier arranges it too: every
    // frame and every loose component in it new, which is D66's judgement
    // one tier up, with no hand placement in it for D60 to guard. A batch
    // that only edited inside one frame arranges nothing outer.
    const layoutOps = ops.filter((o): o is Layout => o.op === "layout");
    const askedLoose = layoutOps.some((o) => o.frame === null);
    const namedFrames = new Set(
      layoutOps.map((o) => (o.frame ? frameSourceOf(o.frame) : null)).filter((id): id is string => id !== null),
    );
    const holdsMembers = (frameId: string): boolean =>
      graph.nodes.some((n) => !removed.has(n.sourceId) && frameOfNode(n.sourceId) === frameId) ||
      [...created.values()].some((c) => c.type !== "arrow" && c.frameId === frameId);
    const withMembers = tier1.filter(holdsMembers);
    const askedEveryFrame = !looseIds.length && withMembers.length >= 2 && withMembers.every((f) => namedFrames.has(f));
    const builtWhole = tier1.every((f) => createdFrames.has(f)) && looseIds.every((n) => created.has(n));
    const compose = tier1.length > 0 && metas.length > 1 && (askedLoose || askedEveryFrame || builtWhole);

    if (compose) {
      const origin = {
        x: Math.min(...metas.map((m) => m.box.x)),
        // Nothing is drawn over the legend (D69), on Layer 1 least of all.
        y: Math.max(Math.min(...metas.map((m) => m.box.y)), legendArea ? legendArea.y + legendArea.height : Number.NEGATIVE_INFINITY),
      };
      const at = new Map(metas.map((m, i) => [m.id, i]));
      const placed = layeredLayout(
        metas.map((m) => ({ id: m.id, bounds: m.box })) as unknown as GraphNode[],
        [...projected.values()] as unknown as GraphEdge[],
        new Map(metas.map((m) => [m.id, { width: m.box.width, height: m.box.height }])),
        origin,
        {
          labelSize: (e) => edgeLabelSize(e.label, arrowFont),
          // No kinds up here: a frame is one of a kind, and nothing on
          // Layer 1 shares a size with anything else (D80).
          order: (id) => at.get(id) ?? 0,
          // The genre's posture rides the same one pipeline (D90).
          ...(posture === "straight" ? { posture: "straight" as const } : {}),
        },
      );
      let arranged = false;
      for (const meta of metas) {
        const box = placed.get(meta.id);
        if (!box) continue;
        const dx = box.x - meta.box.x;
        const dy = box.y - meta.box.y;
        if (dx === 0 && dy === 0) continue;
        arranged = true;
        for (const frameId of meta.frames) carryFrame(frameId, dx, dy);
        if (meta.node) placeLoose(meta.node, dx, dy);
      }
      // One line for the whole tier, not one per frame: what moved is the
      // outer picture, and it moved for one reason.
      if (arranged) notes.push("Layer 1: arranged whole — sources lead, sinks follow (D100)");
    }
  }

  // Frames keep their distance (D86): no write leaves two frames
  // overlapping, or a frame over the legend. Overlaps are parted in the
  // declared order, members carried along, and the edges that touch them
  // are re-routed by the pass below.
  {
    const placements: FramePlacement[] = [];
    declared.forEach((f, i) => {
      if (removed.has(f.sourceId)) return;
      const el = elements.get(f.sourceId);
      if (!el) return;
      const patch = write.patches.find((pp) => pp.id === f.sourceId);
      placements.push({
        id: f.sourceId,
        box: { x: patch?.x ?? el.x, y: patch?.y ?? el.y, width: patch?.width ?? el.width, height: patch?.height ?? el.height },
        tier: tierOfFrame.get(f.sourceId) ?? 1,
        order: i,
      });
    });
    let next = declared.length;
    for (const frame of createdFrames.values()) {
      placements.push({ id: frame.id, box: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, tier: frame.tier ?? 1, order: next++ });
    }
    const parted = separateFrames(placements, legendArea);
    for (const [frameId, d] of parted) {
      // Members and their labels carried along, by the one piece of
      // machinery that carries a frame (D86, D100).
      carryFrame(frameId, d.dx, d.dy);
      if (createdFrames.has(frameId)) continue;
      notes.push(`${graph.frames.find((f) => f.sourceId === frameId)?.name ?? frameId}: moved clear of its neighbour (D86)`);
    }
  }

  // Every edge the batch draws or moves leaves and enters at a port spread
  // along the side it uses (D75) and is routed around what lies between its
  // ends (D72) — over the final boxes of every component, and the legend.
  // When the straight line is blocked the sides are chosen by route cost
  // (D78) before the ports are spread on them; the route is then simplified,
  // the segments that would run along one line are nudged apart, and every
  // turn is drawn as an explicit arc. Each step is given up when it would
  // put the edge through something: D72's guarantee stands beneath all of it.
  // A component that was resized moved as far as its edges are concerned (D74).
  const moved = new Set(
    write.patches.filter((p) => p.x !== undefined || p.y !== undefined || p.width !== undefined || p.height !== undefined).map((p) => p.id),
  );
  // Two boxes per component where they differ (D83): the whole thing is what
  // an edge routes around, while `port` — a symbol's icon, without its
  // caption's room — is where the edge leaves and enters. Everything else
  // has one box and it is both.
  const finalBoxes = new Map<string, Box & { id: string; shape?: string; port?: Box }>();
  for (const n of graph.nodes) {
    if (removed.has(n.sourceId)) continue;
    const patch = write.patches.find((p) => p.id === n.sourceId);
    if (n.symbol) {
      // A symbol's patch names its carrier, so what moved is a delta on the
      // icon; the component's own box follows it.
      const carrier = elements.get(n.sourceId);
      const dx = carrier ? (patch?.x ?? carrier.x) - carrier.x : 0;
      const dy = carrier ? (patch?.y ?? carrier.y) - carrier.y : 0;
      finalBoxes.set(n.sourceId, {
        id: n.sourceId,
        x: n.bounds.x + dx,
        y: n.bounds.y + dy,
        width: n.bounds.width,
        height: n.bounds.height,
        shape: n.shape,
        ...(carrier ? { port: { x: carrier.x + dx, y: carrier.y + dy, width: carrier.width, height: carrier.height } } : {}),
      });
      continue;
    }
    finalBoxes.set(n.sourceId, {
      id: n.sourceId,
      x: patch?.x ?? n.bounds.x,
      y: patch?.y ?? n.bounds.y,
      width: patch?.width ?? n.bounds.width,
      height: patch?.height ?? n.bounds.height,
      shape: n.shape,
    });
  }
  for (const [id, c] of created) {
    if (c.type === "arrow") continue;
    finalBoxes.set(id, { id, x: c.x, y: c.y, width: c.width, height: c.height, shape: c.type, ...(c.port ? { port: c.port } : {}) });
  }
  if (legendArea) finalBoxes.set("__legend", { id: "__legend", ...legendArea });
  const obstacles = [...finalBoxes.values()];
  const around = (from: string, to: string) => obstacles.filter((o) => o.id !== from && o.id !== to);
  // Where an edge meets each end: the port box when there is one.
  const endBoxes = new Map(
    [...finalBoxes].map(([id, box]) => {
      if (!box.port) return [id, box] as const;
      // A symbol's caption extends the component below its icon (D83): the
      // bottom port stands at the component's foot, past the words.
      const foot = box.y + box.height;
      return [id, { ...box.port, id, shape: box.shape, ...(foot > box.port.y + box.port.height + 1 ? { foot } : {}) }] as const;
    }),
  );
  // The edges this write is responsible for: the ones it draws, the existing
  // ones whose ends it moves, and — since a tidy re-routes every bound edge
  // in its scope (D73, amended by A19) — every edge of a frame it re-laid,
  // moved or not. Untouched edges of an ordinary edit keep what they have.
  const jobs: { id: string; from: string; to: string; arrow?: WriteArrow }[] = [];
  for (const arrow of write.arrows) {
    if (finalBoxes.has(arrow.from) && finalBoxes.has(arrow.to)) jobs.push({ id: arrow.id, from: arrow.from, to: arrow.to, arrow });
  }
  for (const e of graph.edges) {
    if (!e.from || !e.to || removed.has(e.sourceId)) continue;
    const from = graph.nodes.find((n) => n.id === e.from)?.sourceId;
    const to = graph.nodes.find((n) => n.id === e.to)?.sourceId;
    if (!from || !to) continue;
    const inScope = moved.has(from) || moved.has(to) || relaid.has(from) || relaid.has(to);
    if (!inScope) continue;
    if (!finalBoxes.has(from) || !finalBoxes.has(to)) continue;
    jobs.push({ id: e.sourceId, from, to });
  }
  // Sides by route cost where the straight line is blocked (D78); the ports
  // are then spread along the chosen sides, as D75 has always spread them.
  const chosen = new Map<string, SidePair>();
  // Lines already chosen are kept out of the next edge's way: a second
  // return over one row goes under it rather than across the first.
  const taken: Point[][] = [];
  for (const job of jobs) {
    const choice = chooseSidesWithLine(endBoxes.get(job.from)!, endBoxes.get(job.to)!, around(job.from, job.to), ROUTE_PAD, taken);
    if (choice) {
      chosen.set(job.id, choice.pair);
      taken.push(choice.line);
    }
  }
  const ports = assignPorts(jobs, endBoxes, ROUTE_PAD, chosen);
  // The whole drawn polyline of each routed edge — port, turns, port.
  const lines = new Map<string, Point[]>();
  const endsOf = new Map<string, { start: Point; end: Point }>();
  const aligned = (p: Point, q: Point) => Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
  for (const job of jobs) {
    // The ends the edge leaves and enters: a symbol's icon, not its caption.
    const a = endBoxes.get(job.from)!;
    const b = endBoxes.get(job.to)!;
    const port = ports.get(job.id);
    const turns = routeEdge(a, b, around(job.from, job.to), ROUTE_PAD, port, chosen.has(job.id) ? { leaveBySide: true } : undefined);
    // An edge whose route could not leave from its port — the router fell
    // back to a side's middle to get through at all — keeps D72's line to
    // the centres: the guarantee outranks the port.
    const ported = !!port && (!turns || (aligned(port.start.at, turns[0]) && aligned(port.end.at, turns[turns.length - 1])));
    if (ported) endsOf.set(job.id, { start: port!.start.at, end: port!.end.at });
    if (turns) {
      const head: Point = ported ? port!.start.at : [a.x + a.width / 2, a.y + a.height / 2];
      const tail: Point = ported ? port!.end.at : [b.x + b.width / 2, b.y + b.height / 2];
      lines.set(job.id, [head, ...turns, tail]);
    }
  }
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  // Fan legs must not cross each other (D75): the ports of a side are
  // ordered by where the other ends stand, but a routed line among straight
  // ones — or a two-way pair whose halves took different ways — can still
  // knot. Any two edges sharing a node's side whose lines cross swap their
  // ports on that side and are re-derived; the swap stays when it unknots
  // them.
  {
    const effLine = (id: string): Point[] => {
      const line = lines.get(id);
      if (line) return line;
      const e = endsOf.get(id);
      if (e) return [e.start, e.end];
      const j = jobOf.get(id)!;
      const A = endBoxes.get(j.from)!;
      const B = endBoxes.get(j.to)!;
      return [
        [A.x + A.width / 2, A.y + A.height / 2],
        [B.x + B.width / 2, B.y + B.height / 2],
      ];
    };
    const derive = (id: string) => {
      const job = jobOf.get(id)!;
      const a = endBoxes.get(job.from)!;
      const b = endBoxes.get(job.to)!;
      const port = ports.get(id);
      const turns = routeEdge(a, b, around(job.from, job.to), ROUTE_PAD, port, chosen.has(id) ? { leaveBySide: true } : undefined);
      const ported = !!port && (!turns || (aligned(port.start.at, turns[0]) && aligned(port.end.at, turns[turns.length - 1])));
      if (ported) endsOf.set(id, { start: port!.start.at, end: port!.end.at });
      else endsOf.delete(id);
      if (turns) {
        const head: Point = ported ? port!.start.at : [a.x + a.width / 2, a.y + a.height / 2];
        const tail: Point = ported ? port!.end.at : [b.x + b.width / 2, b.y + b.height / 2];
        lines.set(id, [head, ...turns, tail]);
      } else {
        lines.delete(id);
      }
    };
    const crossings = (u: Point[], v: Point[]): number => {
      let n = 0;
      for (let i = 0; i + 1 < u.length; i++) {
        for (let j = 0; j + 1 < v.length; j++) {
          if (segmentsCrossProperly(u[i], u[i + 1], v[j], v[j + 1])) n += 1;
        }
      }
      return n;
    };
    // A swap is judged against every line, not the pair alone: freeing the
    // pair while knotting a third is no gain.
    const allIds = jobs.map((j) => j.id);
    const cost = (id: string): number => {
      let n = 0;
      const mine = effLine(id);
      for (const other of allIds) if (other !== id) n += crossings(mine, effLine(other));
      return n;
    };
    type SideEnd = { id: string; which: "start" | "end" };
    const bySide = new Map<string, SideEnd[]>();
    for (const job of jobs) {
      const port = ports.get(job.id);
      if (!port) continue;
      for (const [which, node] of [["start", job.from], ["end", job.to]] as const) {
        // Keyed by the node alone: two legs of one fan can leave different
        // sides — right and bottom — and cross at the corner; swapping
        // their ports across sides is what untangles those.
        const list = bySide.get(node) ?? [];
        list.push({ id: job.id, which });
        bySide.set(node, list);
      }
    }
    for (let sweep = 0; sweep < 2; sweep++) {
      let swapped = false;
      for (const key of [...bySide.keys()].sort()) {
        const ends = bySide.get(key)!;
        for (let i = 0; i < ends.length; i++) {
          for (let j = i + 1; j < ends.length; j++) {
            const a = ends[i];
            const b = ends[j];
            if (a.id === b.id) continue;
            if (!crossings(effLine(a.id), effLine(b.id))) continue;
            const before = cost(a.id) + cost(b.id);
            const pa = ports.get(a.id)!;
            const pb = ports.get(b.id)!;
            const held = pa[a.which];
            pa[a.which] = pb[b.which];
            pb[b.which] = held;
            derive(a.id);
            derive(b.id);
            if (cost(a.id) + cost(b.id) >= before) {
              pb[b.which] = pa[a.which];
              pa[a.which] = held;
              derive(a.id);
              derive(b.id);
            } else {
              swapped = true;
            }
          }
        }
      }
      if (!swapped) break;
    }
  }
  // Simplified before it is drawn (D78): a jog collapsed, a hairpin taken
  // out, no leg left shorter than a corner — each step refused when it would
  // put the edge through a component.
  for (const [id, points] of lines) {
    lines.set(id, simplifyRoute(points, around(jobOf.get(id)!.from, jobOf.get(id)!.to)));
  }
  // The arrowhead earns a runway (D137): no turn within a corner of either
  // port. A port may walk along its side onto the run's line — but never
  // onto a seat another edge holds, so the fans D75 spread stay spread.
  {
    const seatCoord = (side: string, at: Point) => (side === "left" || side === "right" ? at[1] : at[0]);
    const seats = new Map<string, { id: string; which: "start" | "end"; c: number }[]>();
    for (const j of jobs) {
      const p = ports.get(j.id);
      if (!p) continue;
      for (const [node, which, port] of [
        [j.from, "start", p.start],
        [j.to, "end", p.end],
      ] as const) {
        const key = `${node}|${port.side}`;
        const list = seats.get(key) ?? [];
        list.push({ id: j.id, which, c: seatCoord(port.side, port.at) });
        seats.set(key, list);
      }
    }
    for (const [id, points] of lines) {
      if (!endsOf.has(id)) continue;
      const job = jobOf.get(id)!;
      const port = ports.get(id)!;
      const seatFree = (which: "start" | "end", side: string, pos: number) => {
        const node = which === "start" ? job.from : job.to;
        const held = seats.get(`${node}|${side}`) ?? [];
        // Half the nudge gap: two settled runs this close diverge at once,
        // and the side's own spread (D75) already sits tighter than a nudge.
        return held.some((s) => !(s.id === id && s.which === which) && Math.abs(s.c - pos) < NUDGE / 2);
      };
      // The other lines as they stand — a settled line must not tangle
      // them, and edges settled earlier are seen settled.
      const otherLines = [...lines].filter(([otherId]) => otherId !== id).map(([, otherPts]) => otherPts);
      const settled = settleApproaches(
        points,
        port,
        endBoxes.get(job.from)!,
        endBoxes.get(job.to)!,
        around(job.from, job.to),
        seatFree,
        otherLines,
        ROUTE_PAD,
      );
      // A port leg lying on a bystander's shoulder walks its port (D139).
      const grazed = settleGrazes(
        settled,
        port,
        endBoxes.get(job.from)!,
        endBoxes.get(job.to)!,
        around(job.from, job.to),
        seatFree,
        otherLines,
        ROUTE_PAD,
      );
      lines.set(id, grazed);
      endsOf.set(id, { start: port.start.at, end: port.end.at });
      // A walked port sits in a new seat; later edges must respect it.
      for (const which of ["start", "end"] as const) {
        const node = which === "start" ? job.from : job.to;
        const p = which === "start" ? port.start : port.end;
        const mine = (seats.get(`${node}|${p.side}`) ?? []).find((s) => s.id === id && s.which === which);
        if (mine) mine.c = seatCoord(p.side, p.at);
      }
    }
  }
  // The words own their air (D138): each route carries the height of the
  // label riding it, and the drawn lines of edges OUTSIDE this batch join
  // the nudge as fixed neighbours — a scope's tidy must not lay its lines
  // onto a stranger's at a stroke's width.
  {
    const labelOf = (id: string): string | null =>
      jobOf.get(id)?.arrow?.label ?? graph.edges.find((e) => e.sourceId === id)?.label ?? null;
    const airOf = (label: string | null) =>
      label ? { labelHeight: edgeLabelSize(label, house.arrow.style.fontSize).height } : {};
    const batch = [...lines].map(([id, points]) => ({
      id,
      points,
      obstacles: around(jobOf.get(id)!.from, jobOf.get(id)!.to),
      ...airOf(labelOf(id)),
    }));
    const standing: NudgeRoute[] = [];
    for (const e of graph.edges) {
      // A batch edge is a traveller even when it routed straight — only the
      // lines this write does not touch stand as walls.
      if (removed.has(e.sourceId) || jobOf.has(e.sourceId)) continue;
      const el = elements.get(e.sourceId);
      if (!el || el.type !== "arrow" || !el.points || el.points.length < 2) continue;
      standing.push({
        id: e.sourceId,
        points: absolutePoints(el.x, el.y, el.points),
        obstacles: [],
        locked: true,
        ...airOf(e.label),
      });
    }
    // Every component's outline joins the corridors as a wall (D139): a
    // routed run that hugs a box drifts off it whenever its legs allow —
    // the stubs that ATTACH to a box are port legs, which never nudge.
    const walls: NudgeRoute[] = obstacles.map((box) => ({
      id: `__wall:${box.id}`,
      points: [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height],
        [box.x, box.y + box.height],
        [box.x, box.y],
      ],
      obstacles: [],
      locked: true,
    }));
    for (const [id, points] of nudgeRoutes([...batch, ...standing, ...walls])) {
      lines.set(id, points);
    }
  }
  for (const [id, points] of lines) {
    const drawn = dropCollinear(arcCorners(points));
    const blocked = around(jobOf.get(id)!.from, jobOf.get(id)!.to).some((o) => polylineThroughBox(drawn, o, 2));
    lines.set(id, blocked ? points : drawn);
  }
  let routed = 0;
  for (const job of jobs) {
    const ends = endsOf.get(job.id);
    const line = lines.get(job.id);
    const via = line ? line.slice(1, -1) : null;
    // Turning points are arc points now (D78), so the arrow is drawn sharp:
    // what the reader sees is the route and not Excalidraw's curve through it.
    const sharp = !!via && via.length > 0;
    if (job.arrow) {
      if (ends) job.arrow.ends = ends;
      if (via) job.arrow.via = via;
      if (sharp) job.arrow.sharp = true;
    } else {
      const patch = write.patches.find((p) => p.id === job.id);
      if (patch) {
        patch.via = via ?? [];
        patch.sharp = sharp;
        if (ends) patch.ends = ends;
      } else write.patches.push({ id: job.id, via: via ?? [], sharp, ...(ends ? { ends } : {}) });
      if (!touched.includes(job.id)) touched.push(job.id);
    }
    if (via) routed += 1;
  }
  if (routed) notes.push(`${routed} edge${routed === 1 ? "" : "s"} routed around components`);

  if (problems.length) throw new PlanError(problems);
  const result: MeaningWrite = {};
  if (write.shapes.length) result.shapes = write.shapes;
  if (write.symbols.length) result.symbols = write.symbols;
  if (write.arrows.length) result.arrows = write.arrows;
  if (write.frames.length) result.frames = write.frames;
  if (write.patches.length) result.patches = write.patches;
  if (write.remove.length) result.remove = write.remove;
  if (legendChanged) result.legend = legend;
  // The genre and the scenarios ride to the same carrier the rules do
  // (D87, D89) — one home for the scene's conventions.
  if (genreChanged && genre) result.genre = genre;
  if (scenariosChanged) result.scenarios = scenarios;
  if (proposalChanged) result.proposal = proposal;
  return { write: result, ids, notes, touched };
}

// ---------------------------------------------------------------------------
// simulation — the snapshot a write would produce
// ---------------------------------------------------------------------------

const LOOK_DEFAULT = { roughness: 1, roundness: 3, fontFamily: 5, fontSize: 20, textAlign: "center", startArrowhead: null, endArrowhead: "arrow", arrowType: "round" };

function emptyDocent(): SnapshotElement["docent"] {
  return { detailFrameId: null, link: null, tags: [], note: null, intents: [], logic: null, narrative: null, order: null, legend: null, genre: null, scenarios: [], proposal: null, legendSample: false, refine: null, composite: {}, symbol: null };
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
  if (meaning.link !== undefined) next.link = meaning.link;
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
export function simulate(snapshot: SceneSnapshot, write: MeaningWrite): SceneSnapshot {
  const removing = new Set(write.remove ?? []);
  for (const el of snapshot.elements) {
    if (el.containerId && removing.has(el.containerId)) removing.add(el.id);
  }
  const patches = new Map((write.patches ?? []).map((p) => [p.id, p]));
  // A symbol component moves as one (D83): a patch on its carrier carries
  // the icon's elements and the label by the same delta, as the adapter does.
  const groupShift = new Map<string, { dx: number; dy: number }>();
  for (const el of snapshot.elements) {
    if (el.docent.symbol === null || !el.groupIds.length) continue;
    const patch = patches.get(el.id);
    if (!patch || (patch.x === undefined && patch.y === undefined)) continue;
    groupShift.set(el.groupIds[el.groupIds.length - 1], { dx: (patch.x ?? el.x) - el.x, dy: (patch.y ?? el.y) - el.y });
  }
  const out: SnapshotElement[] = [];
  for (const el of snapshot.elements) {
    if (removing.has(el.id)) continue;
    let next = { ...el, boundElements: el.boundElements.filter((b) => !removing.has(b.id)), docent: { ...el.docent } };
    const carried = el.groupIds.length && !patches.has(el.id) ? groupShift.get(el.groupIds[el.groupIds.length - 1]) : undefined;
    if (carried) {
      next.x += carried.dx;
      next.y += carried.dy;
    }
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
  // A symbol stands for its whole group here (D83): the carrier on the
  // icon's bounds and the label under it, declared composite so the graph
  // reads them as ONE component (D22). The icon's own strokes add nothing
  // the graph, the diff or the lint would look at, so they are not drawn.
  for (const symbol of write.symbols ?? []) {
    const groupId = `symbol-${symbol.id}`;
    const carrier = blank(
      symbol.id,
      "rectangle",
      symbol.icon,
      { ...symbol.labelStyle, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0, roundness: null },
      symbol.frameId,
    );
    carrier.groupIds = [groupId];
    carrier.docent = { ...docentFromMeaning(symbol.meaning, carrier.docent), symbol: symbol.symbol, composite: { [groupId]: true } };
    const text = blank(`${symbol.id}-label`, "text", symbol.labelBox, symbol.labelStyle, symbol.frameId);
    text.text = symbol.label;
    text.groupIds = [groupId];
    out.push(carrier, text);
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
    // The ports the write chose (D75), or the centres when it chose none.
    const ax = arrow.ends ? arrow.ends.start[0] : a ? a.x + a.width / 2 : 0;
    const ay = arrow.ends ? arrow.ends.start[1] : a ? a.y + a.height / 2 : 0;
    const bx = arrow.ends ? arrow.ends.end[0] : b ? b.x + b.width / 2 : 0;
    const by = arrow.ends ? arrow.ends.end[1] : b ? b.y + b.height / 2 : 0;
    const el = blank(arrow.id, "arrow", { x: ax, y: ay, width: Math.abs(bx - ax), height: Math.abs(by - ay) }, arrow.style, arrow.frameId);
    el.points = [[0, 0], ...(arrow.via ?? []).map(([px, py]): [number, number] => [px - ax, py - ay]), [bx - ax, by - ay]];
    // A routed edge is a sharp polyline carrying its own arcs (D78).
    if (arrow.sharp) el.look = { ...el.look, roundness: null };
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
    const ax = patch.ends ? patch.ends.start[0] : a.x + a.width / 2;
    const ay = patch.ends ? patch.ends.start[1] : a.y + a.height / 2;
    const bx = patch.ends ? patch.ends.end[0] : b.x + b.width / 2;
    const by = patch.ends ? patch.ends.end[1] : b.y + b.height / 2;
    el.x = ax;
    el.y = ay;
    el.points = [[0, 0], ...patch.via.map(([px, py]): [number, number] => [px - ax, py - ay]), [bx - ax, by - ay]];
    // Turning points mean arcs of Docent's own (D78) and a sharp polyline;
    // a re-route that came out straight gets the house curvature back.
    el.look = { ...el.look, roundness: patch.via.length ? null : (el.look.roundness ?? 2) };
  }
  // The rules, the genre and the scenarios all live on the one carrier
  // (D9, D87, D89): whichever of them a write carries goes there, and a
  // scene with no legend yet has the carrier made for it — the empty rule
  // list is what marks the element as the carrier.
  if (write.legend || write.genre !== undefined || write.scenarios !== undefined || write.proposal !== undefined) {
    const recorded = (base: SnapshotElement["docent"]): SnapshotElement["docent"] => ({
      ...base,
      ...(write.legend ? { legend: write.legend } : {}),
      ...(write.genre !== undefined ? { genre: write.genre } : {}),
      ...(write.scenarios !== undefined ? { scenarios: write.scenarios } : {}),
      ...(write.proposal !== undefined ? { proposal: write.proposal } : {}),
    });
    const carrier = out.find((el) => el.docent.legend !== null);
    if (carrier) carrier.docent = recorded(carrier.docent);
    else {
      const el = blank("__legend", "text", { x: 0, y: -80, width: 200, height: 40 }, DEFAULT_STYLE, null);
      el.text = "Legend";
      el.locked = true;
      el.docent = recorded({ ...emptyDocent(), legend: write.legend ?? [] });
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

/** What the lint answers: what a reviewer would say, and the number (D76). */
export interface LintReport {
  findings: LintFinding[];
  summary: string;
  score: CraftScore;
}

/** What a reviewer would say about the diagram's craft (D62, D63, D76). */
export function lint(snapshot: SceneSnapshot): LintReport {
  const graph = buildSceneGraph(snapshot);
  const findings: LintFinding[] = [];
  const tiers = computeTiers(snapshot);
  for (const node of graph.nodes) {
    const name = clean(node.label) || node.id;
    if (!clean(node.label)) findings.push({ level: "warn", about: node.id, message: `component ${node.id} has no label` });
    const facts = applyLegend(node.style, node.shape, graph.legend, node.symbol);
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
      const drawn = absolutePoints(el.x, el.y, el.points);
      const through = passesThrough(drawn, nodeBoxes, new Set([from.id, to.id]));
      if (through.length) {
        const names = through.map((b) => clean(graph.nodes.find((n) => n.id === b.id)?.label) || b.id);
        const frame = from.frameId ? `layout({frame:'${from.frameId}'})` : "layout({frame:null})";
        findings.push({ level: "warn", about: edge.id, message: `edge ${clean(from.label)} → ${clean(to.label)} passes through ${names.join(", ")} — ${frame} re-routes it, or move what is in the way` });
      }
      // A leg shorter than a corner, or a turn that doubles straight back,
      // both say the line was not drawn on purpose (D78).
      if (edgeWiggles(drawn)) {
        const scope = from.frameId ? `tidy({frame:'${from.frameId}'})` : "tidy({frame:null})";
        findings.push({ level: "warn", about: edge.id, message: `edge ${clean(from.label)} → ${clean(to.label)} doubles back on itself — ${scope} redraws it as one stroke` });
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
  // The genre's own grammar, in the genre's name (D88) — advice, never a
  // veto. A scene that adopted no genre still has its scenarios read
  // back, since one can be named without one (D89).
  const profile = genreOf(graph.genre);
  findings.push(...(profile ? genreFindings(graph, profile) : scenarioFindings(graph)));
  // The number, and one line of it among the findings, so a reader who only
  // sees the list still sees the score (D76).
  const score = craftScore(snapshot, graph);
  const worst = [...score.parts].sort((a, b) => b.penalty - a.penalty)[0];
  const said = worst && worst.penalty > 0 ? `worst: ${worst.key} — ${worst.detail}` : "nothing measured costs it anything";
  findings.push({ level: "info", about: null, message: `craft score ${score.score} of 100 — ${said}${score.advice.length ? `. ${score.advice[0]}` : ""}` });
  const warns = findings.filter((f) => f.level === "warn").length;
  const summary = findings.length ? `${warns} warning${warns === 1 ? "" : "s"}, ${findings.length - warns} note${findings.length - warns === 1 ? "" : "s"}` : "clean — every component has a kind and an intent, every frame a narrative";
  return { findings, summary, score };
}

export type { GraphFrame, GraphNode };
