/**
 * Mermaid emitter (S4, D5) — the primary AI-facing export. Pure function of
 * scene graph + legend (B5); deterministic: stable ordering by id, no
 * timestamps, no randomness (I3).
 */
import type { Scenario, SceneLink } from "../adapter/snapshot";
import { genreOf } from "../authoring/genre";
import type { GraphFrame, SceneGraph } from "../scene/graph";
import { applyLegend } from "./legend";

/**
 * What the export knows about where it is being made from (D95): a link
 * that names no project means the scene's own, and only the caller knows
 * which project that is. Without it such a link keeps an empty authority —
 * "whatever project this drawing lives in" — rather than naming a wrong one.
 */
export interface ExportContext {
  project?: string;
}

/** A scene link as a URL (D95): `docent://<project>/<path>#<component>`. */
export function sceneLinkUrl(link: SceneLink, context?: ExportContext): string {
  const at = link.at ? `#${link.at}` : "";
  return `docent://${link.project ?? context?.project ?? ""}/${link.scene}${at}`;
}

/** The same target as a reader says it — no scheme, no empty authority. */
function linkText(link: SceneLink, context?: ExportContext): string {
  const project = link.project ?? context?.project;
  return `${project ? `${project}/` : ""}${link.scene}${link.at ? `#${link.at}` : ""}`;
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

function nodeSyntax(id: string, label: string, shape: string, kind: string | null): string {
  const text = `"${escapeLabel(label)}"`;
  if (kind === "datastore") return `${id}[(${text})]`;
  switch (shape) {
    case "diamond":
      return `${id}{${text}}`;
    case "ellipse":
      return `${id}([${text}])`;
    default:
      return `${id}[${text}]`;
  }
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function orderFrames(frames: readonly GraphFrame[]): GraphFrame[] {
  return [...frames].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * A scenario's steps in the author's own words (D89, I4): the components'
 * labels and the edge's, in the order the story runs — "1. Checkout page →
 * Orders (place order)". A step the export cannot see — removed, or outside
 * a frame-scoped copy — is said as such and keeps its number: the hole in
 * the story is the news (I5).
 */
export function scenarioSteps(graph: SceneGraph, scenario: Scenario): string[] {
  const endName = (id: string | null): string => {
    const node = id ? graph.nodes.find((n) => n.id === id) : undefined;
    return node ? escapeLabel(node.label ?? node.id) : "nothing";
  };
  return scenario.path.map((step, i) => {
    const edge = graph.edges.find((e) => e.sourceId === step);
    if (!edge) return `${i + 1}. an edge this view does not hold`;
    const label = escapeLabel(edge.label ?? "");
    return `${i + 1}. ${endName(edge.from)} → ${endName(edge.to)}${label ? ` (${label})` : ""}`;
  });
}

export function exportMermaid(graph: SceneGraph, context?: ExportContext): string {
  const lines: string[] = ["flowchart LR"];

  // The conventions the diagram was drawn under (D87, D89) — the author's
  // declarations, so they travel with the drawing (I4). Mermaid has no
  // place for them but its comments: every reader gets them, no renderer
  // draws them.
  const profile = genreOf(graph.genre);
  if (profile) lines.push(`  %% genre (declared): ${profile.name}`);
  for (const scenario of graph.scenarios) {
    const description = scenario.description ? ` — ${escapeLabel(scenario.description)}` : "";
    lines.push(`  %% scenario (declared): ${escapeLabel(scenario.name)}${description}`);
    for (const step of scenarioSteps(graph, scenario)) lines.push(`  %%   ${step}`);
  }
  if (graph.proposal) {
    const against = graph.proposal.against ? ` — against ${escapeLabel(graph.proposal.against)}` : "";
    lines.push(`  %% proposal (declared): ${escapeLabel(graph.proposal.title)}${against}`);
    for (const win of graph.proposal.wins) lines.push(`  %%   win: ${escapeLabel(win)}`);
    for (const cost of graph.proposal.costs) lines.push(`  %%   cost: ${escapeLabel(cost)}`);
  }

  const nodeLine = (nodeId: string): string => {
    const node = graph.nodes.find((n) => n.id === nodeId)!;
    // Mermaid draws no icon, but the kind a symbol rule gives still reads (D84).
    const facts = applyLegend(node.style, node.shape, graph.legend, node.symbol);
    return nodeSyntax(node.id, node.label ?? node.id, node.shape, facts.kind);
  };

  for (const frame of orderFrames(graph.frames)) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    if (!members.length) continue;
    lines.push(`  subgraph ${frame.id}["${escapeLabel(frame.name || frame.id)}"]`);
    // A frame's own scene link (D95): Mermaid clicks nodes, not subgraphs,
    // so the declaration travels as a comment, the way the conventions do.
    if (frame.link) lines.push(`    %% link (declared): ${sceneLinkUrl(frame.link, context)}`);
    for (const node of members) {
      lines.push(`    ${nodeLine(node.id)}`);
    }
    lines.push("  end");
  }
  for (const node of graph.nodes.filter((n) => n.frameId === null)) {
    lines.push(`  ${nodeLine(node.id)}`);
  }

  // A scene link is meaning Mermaid has a place of its own for (D95, I4):
  // its native click directive, so the rendered diagram goes where the
  // author said it goes. A scene that declares none emits none.
  for (const node of graph.nodes) {
    if (!node.link) continue;
    lines.push(
      `  click ${node.id} "${escapeLabel(sceneLinkUrl(node.link, context))}" "scene link (declared): ${escapeLabel(linkText(node.link, context))}"`,
    );
  }

  for (const edge of graph.edges) {
    if (!edge.from || !edge.to) continue;
    const label = edge.label ? `|"${escapeLabel(edge.label)}"|` : "";
    lines.push(`  ${edge.from} -->${label} ${edge.to}`);
    // Declared cross-tier refinement (D21): the same edge at detail
    // resolution, dotted — "Service A lands on Adapter A inside Broker".
    if (edge.toRefined || edge.fromRefined) {
      lines.push(
        `  ${edge.fromRefined ?? edge.from} -.->${label} ${edge.toRefined ?? edge.to}`,
      );
    }
    // An edge has no click either — its link rides beside it (D95).
    if (edge.link) lines.push(`  %% link (declared): ${sceneLinkUrl(edge.link, context)}`);
  }

  return `${lines.join("\n")}\n`;
}
