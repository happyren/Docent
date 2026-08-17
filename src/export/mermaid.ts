/**
 * Mermaid emitter (S4, D5) — the primary AI-facing export. Pure function of
 * scene graph + legend (B5); deterministic: stable ordering by id, no
 * timestamps, no randomness (I3).
 */
import type { GraphFrame, SceneGraph } from "../scene/graph";
import { applyLegend } from "./legend";

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

export function exportMermaid(graph: SceneGraph): string {
  const lines: string[] = ["flowchart LR"];

  const nodeLine = (nodeId: string): string => {
    const node = graph.nodes.find((n) => n.id === nodeId)!;
    const facts = applyLegend(node.style, node.shape, graph.legend);
    return nodeSyntax(node.id, node.label ?? node.id, node.shape, facts.kind);
  };

  for (const frame of orderFrames(graph.frames)) {
    const members = graph.nodes.filter((n) => n.frameId === frame.id);
    if (!members.length) continue;
    lines.push(`  subgraph ${frame.id}["${escapeLabel(frame.name || frame.id)}"]`);
    for (const node of members) {
      lines.push(`    ${nodeLine(node.id)}`);
    }
    lines.push("  end");
  }
  for (const node of graph.nodes.filter((n) => n.frameId === null)) {
    lines.push(`  ${nodeLine(node.id)}`);
  }

  for (const edge of graph.edges) {
    if (!edge.from || !edge.to) continue;
    const label = edge.label ? `|"${escapeLabel(edge.label)}"|` : "";
    lines.push(`  ${edge.from} -->${label} ${edge.to}`);
  }

  return `${lines.join("\n")}\n`;
}
