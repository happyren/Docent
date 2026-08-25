/**
 * Genres (S22, D87): the five categories of diagram a developer actually
 * reaches for, each written down as data — the vocabulary of kinds it
 * speaks, the posture it reads in (D90), the grammar its lint knows
 * (D88), and the recipe an agent is answered with when it adopts one.
 *
 * A kind is declared through a tone or a role, never a raw style: colour
 * means something, and what it means is the palette's to say (D77). A
 * genre advises and never refuses — everything here returns findings, and
 * a finding is a sentence, not a veto (D88).
 *
 * Pure and deterministic, no new dependencies (I3, I7).
 */
import { applyLegend } from "../export/legend";
import type { GraphEdge, GraphNode, SceneGraph } from "../scene/graph";
import { backEdges } from "./layout";
import type { Role, Tone } from "./palette";
import type { Shape } from "./style";

export type GenreId = "architecture" | "request" | "event-flow" | "data-flow" | "lifecycle";

/** One word of a genre's vocabulary, in the terms `define_kind` speaks (D77). */
export interface GenreKind {
  kind: string;
  tone?: Tone;
  role?: Role;
  shape?: Shape;
}

export interface GenreProfile {
  id: GenreId;
  /** What the genre is called — and what its findings speak in the name of. */
  name: string;
  /** How the layout reads it (D90). */
  posture: "map" | "straight" | "lanes";
  /** The kinds `use_genre` seeds into a legend that does not hold them yet. */
  kinds: readonly GenreKind[];
  /** One line for the instructions menu — when this genre is the right one (D91). */
  when: string;
  /** The recipe `use_genre` answers with: how this genre is drawn well. */
  guidance: string;
}

export const GENRES: Readonly<Record<GenreId, GenreProfile>> = {
  architecture: {
    id: "architecture",
    name: "Architecture map",
    posture: "map",
    kinds: [
      { kind: "person", role: "people", shape: "ellipse" },
      { kind: "system", role: "external" },
      { kind: "service", role: "compute" },
      { kind: "store", role: "storage" },
      { kind: "queue", role: "messaging" },
    ],
    when: "systems, services, and stores and how they talk — the default map",
    guidance:
      "Architecture map (C4-shaped). Layer 1 is the context: people and outside systems at the edges, your system's containers as frames. Every component carries a kind — person, system, service, store, queue — and an intent saying why it exists. A container's inner mechanism goes a tier down: add_detail_layer on the component and draw its parts there. Edges say what travels (the label) and how (tags the legend maps, e.g. async). Name frames after the container and give each a narrative. Loop: draw, validate, tidy.",
  },
  request: {
    id: "request",
    name: "Life of a request",
    posture: "map",
    kinds: [
      { kind: "person", role: "people", shape: "ellipse" },
      { kind: "service", role: "compute" },
      { kind: "store", role: "storage" },
      { kind: "queue", role: "messaging" },
      { kind: "system", role: "external" },
    ],
    when: "how one request moves through the map — scenarios, replayed and spoken",
    guidance:
      "Life of a request. Draw (or reuse) the architecture map, then tell each request's story as a scenario: define_scenario({name, path}) with the edges in the order the request takes them. One map carries many scenarios. Replay: flow({scenario}) pulses the path with numbered steps; script_tour({scenario}) walks and speaks it. Keep edge labels short — the scenario's description carries the story.",
  },
  "event-flow": {
    id: "event-flow",
    name: "Event flow",
    posture: "lanes",
    kinds: [
      { kind: "command", tone: "neutral" },
      { kind: "event", tone: "caution" },
      { kind: "read model", tone: "positive" },
      { kind: "policy", role: "compute" },
    ],
    when: "commands, events, read models in lanes — event-driven designs",
    guidance:
      "Event flow (Event-Modeling-shaped). One frame per context — each becomes a lane; time runs left to right and never turns back. The grammar: a command (blue-grey) causes an event (amber); events feed read models (green); a policy (orange) reacts to events by issuing commands. Draw the flow in time order — the layout keeps each context in its lane. The lint speaks this grammar; validate to hear it.",
  },
  "data-flow": {
    id: "data-flow",
    name: "Data flow",
    posture: "straight",
    kinds: [
      { kind: "source", role: "external" },
      { kind: "transform", role: "compute" },
      { kind: "store", role: "storage" },
      { kind: "consumer", role: "people" },
    ],
    when: "pipelines: sources to consumers, contracts on the edges",
    guidance:
      "Data flow. Sources, transforms, stores, consumers — one direction, no cycles: the layout will not fold time, and the lint flags a cycle. Every edge carries its contract: the label names what flows (the schema, the topic, the file); intents carry the finer print.",
  },
  lifecycle: {
    id: "lifecycle",
    name: "Lifecycle",
    posture: "map",
    kinds: [
      { kind: "state", shape: "ellipse" },
      { kind: "terminal", tone: "inactive", shape: "ellipse" },
    ],
    when: "one thing's states and transitions — orders, documents, jobs",
    guidance:
      "Lifecycle. Components are states; edges are transitions labelled with their trigger; a guard is logic on the transition. The first state you author is the entry, and every machine ends somewhere — give it at least one terminal state (kind terminal). Cycles are normal here — retries return; the router draws the return.",
  },
};

/** The ids, in the order the menu says them (D91). */
export const GENRE_IDS: readonly GenreId[] = ["architecture", "request", "event-flow", "data-flow", "lifecycle"];

const normalize = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

/**
 * The profile a name asks for, or null. Tolerant of what an agent types
 * (I5): case, a space or an underscore where the id has a hyphen, and the
 * genre's own name as well as its id — "Life of a request" is what the
 * menu shows, so it is what an agent may well send back.
 */
export function genreOf(id: string | null | undefined): GenreProfile | null {
  if (!id) return null;
  const wanted = normalize(id);
  if (!wanted) return null;
  for (const genreId of GENRE_IDS) {
    const profile = GENRES[genreId];
    if (wanted === genreId || wanted === normalize(profile.name)) return profile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the grammar (D88)
// ---------------------------------------------------------------------------

/**
 * What a genre says about a diagram. Structurally the lint's own finding,
 * declared here so the lint can read the genres without the genres
 * reading the lint.
 */
export interface GenreFinding {
  level: "warn" | "info";
  /** The graph id of what it is about; null when it is about the scene. */
  about: string | null;
  message: string;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * The order the components were authored in, as the diagram is read
 * (D79): left to right by centre, then top to bottom, then by id. The
 * first of them is where a machine starts.
 */
function readingOrder(nodes: readonly GraphNode[]): GraphNode[] {
  const cx = (n: GraphNode) => n.bounds.x + n.bounds.width / 2;
  const cy = (n: GraphNode) => n.bounds.y + n.bounds.height / 2;
  return [...nodes].sort((a, b) => cx(a) - cx(b) || cy(a) - cy(b) || (a.id < b.id ? -1 : 1));
}

/**
 * A scenario whose edges have gone (D89, I5): the path is stored by
 * stable id, so an edge removed out from under it leaves a step pointing
 * at nothing. Said as a warning, and said with the step number, because
 * re-pointing that step is the fix.
 */
export function scenarioFindings(graph: SceneGraph): GenreFinding[] {
  const live = new Set(graph.edges.map((e) => e.sourceId));
  const findings: GenreFinding[] = [];
  for (const scenario of graph.scenarios) {
    scenario.path.forEach((step, i) => {
      if (live.has(step)) return;
      findings.push({
        level: "warn",
        about: null,
        message: `scenario "${scenario.name}" step ${i + 1} points at an edge that is gone`,
      });
    });
  }
  return findings;
}

/**
 * What the recorded genre has to say about the diagram (D88). Every
 * finding opens with the genre's name, so a reader knows who is talking,
 * and none of them refuses anything: an author who breaks the grammar on
 * purpose keeps the edit (D60).
 *
 * The architecture map's own rule — a component with no kind — is not
 * here: the base lint already says exactly that of every component whose
 * style matches no legend rule, and one voice per fault is enough.
 */
export function genreFindings(graph: SceneGraph, profile: GenreProfile): GenreFinding[] {
  const findings: GenreFinding[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const kindOf = (node: GraphNode | null | undefined): string | null =>
    node ? applyLegend(node.style, node.shape, graph.legend, node.symbol).kind : null;
  const name = (node: GraphNode | null | undefined): string => clean(node?.label) || node?.id || "—";
  const from = (edge: GraphEdge) => (edge.from ? nodeById.get(edge.from) : null);
  const to = (edge: GraphEdge) => (edge.to ? nodeById.get(edge.to) : null);
  const say = (about: string | null, message: string) => findings.push({ level: "info" as const, about, message });

  switch (profile.id) {
    case "architecture":
    case "request":
      break;
    case "event-flow": {
      // A command or a policy causes an event, and an event may cause the
      // next one; nothing else does. An event no one caused is a fact
      // from nowhere, and a read model no event feeds is derived from
      // nothing.
      const causes = new Set(["command", "policy", "event"]);
      for (const node of graph.nodes) {
        const kind = kindOf(node);
        if (kind === "event") {
          const caused = graph.edges.some((e) => e.to === node.id && causes.has(kindOf(from(e)) ?? ""));
          if (!caused) say(node.id, `${profile.name}: event "${name(node)}" has no cause — a command or policy should feed it`);
        } else if (kind === "read model") {
          const fed = graph.edges.some((e) => e.to === node.id && kindOf(from(e)) === "event");
          if (!fed) say(node.id, `${profile.name}: read model "${name(node)}" derives from nothing — feed it an event`);
        }
      }
      break;
    }
    case "data-flow": {
      // A pipeline reads one way: an edge that closes a cycle is one the
      // layout would have to fold time to draw (D79, D90).
      const back = backEdges(graph.nodes, graph.edges);
      for (const edge of graph.edges) {
        if (!back.has(edge.id)) continue;
        say(edge.id, `${profile.name}: "${name(from(edge))} → ${name(to(edge))}" closes a cycle — pipelines read one way`);
      }
      // What flows is the edge's contract, and an edge that names neither
      // a schema nor a topic nor a file has not declared one.
      for (const edge of graph.edges) {
        if (!edge.from || !edge.to || clean(edge.label) || edge.intents.length) continue;
        say(edge.id, `${profile.name}: "${name(from(edge))} → ${name(to(edge))}" carries no contract — name what flows`);
      }
      break;
    }
    case "lifecycle": {
      // The first state authored is the entry; every other one is reached
      // by a transition or it is not part of the machine.
      const states = readingOrder(graph.nodes);
      for (const state of states.slice(1)) {
        if (!graph.edges.some((e) => e.to === state.id)) say(state.id, `${profile.name}: state "${name(state)}" is unreachable`);
      }
      if (states.length && !states.some((s) => !graph.edges.some((e) => e.from === s.id))) {
        say(null, `${profile.name}: no state is terminal — every machine ends somewhere`);
      }
      break;
    }
  }
  return [...findings, ...scenarioFindings(graph)];
}
