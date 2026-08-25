/**
 * Detail badges (D31): which components deserve a "has a detail layer"
 * marker, and where it sits. Pure derivation over the scene graph, so a
 * composite (D22) carries ONE badge on the whole glyph and a dangling
 * detail link (deleted frame) reads as no badge — the same validation the
 * drill navigation applies.
 *
 * The link marker (D96) is derived the same way, from the same machinery:
 * "goes elsewhere" is a second kind of marker, not a second mechanism.
 */
import type { SceneLink, SceneSnapshot } from "../adapter/snapshot";
import { buildSceneGraph } from "./graph";

export interface DetailBadge {
  /** Graph node id — a stable render key (I6). */
  id: string;
  /** The element whose declared link the dive goes through. */
  diveElementId: string;
  label: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  /** Chip edge length in scene units, clamped so small shapes keep theirs. */
  size: number;
}

const BADGE_SIZE = 22;
const BADGE_MIN = 12;

/** One chip's edge, clamped so small shapes keep theirs and big ones stay subtle. */
const chipSize = (bounds: DetailBadge["bounds"]): number =>
  Math.min(
    BADGE_SIZE,
    Math.max(BADGE_MIN, Math.min(bounds.width, bounds.height) * 0.4),
  );

export function detailBadges(snapshot: SceneSnapshot): DetailBadge[] {
  const graph = buildSceneGraph(snapshot);
  const byId = new Map(snapshot.elements.map((el) => [el.id, el]));
  const badges: DetailBadge[] = [];
  for (const node of graph.nodes) {
    if (node.detailFrameId === null) continue;
    // The dive API wants the element that declares the link. A plain node
    // declares it itself; a composite's link may live on any member (D22),
    // so find the carrier among the representative's own groups.
    const rep = byId.get(node.sourceId);
    let diveElementId = node.sourceId;
    if (rep && rep.docent.detailFrameId === null && node.composite) {
      const carrier = snapshot.elements.find(
        (el) =>
          el.docent.detailFrameId !== null &&
          el.groupIds.some((g) => rep.groupIds.includes(g)),
      );
      if (carrier) diveElementId = carrier.id;
    }
    badges.push({
      id: node.id,
      diveElementId,
      label: node.label,
      bounds: node.bounds,
      size: chipSize(node.bounds),
    });
  }
  return badges;
}

/**
 * Link markers (D96): "goes elsewhere", visible the way "goes deeper" is.
 * Derived exactly as the detail badge is — off the graph, so a composite
 * carries ONE marker however many members declare it — and sized by the
 * same chip. A component may wear both; they sit on opposite corners.
 */
export interface LinkBadge {
  /** Graph node id — a stable render key (I6). */
  id: string;
  /** The component the follow acts on, in the ids the shell speaks. */
  elementId: string;
  label: string | null;
  /** Where it goes, as the author declared it. */
  link: SceneLink;
  bounds: DetailBadge["bounds"];
  size: number;
}

export function linkBadges(snapshot: SceneSnapshot): LinkBadge[] {
  return buildSceneGraph(snapshot)
    .nodes.filter((node) => node.link !== null)
    .map((node) => ({
      id: node.id,
      elementId: node.sourceId,
      label: node.label,
      link: node.link!,
      bounds: node.bounds,
      size: chipSize(node.bounds),
    }));
}

/** A `{ }` mark for every component that carries logic (D42). */
export interface LogicMark {
  id: string;
  bounds: DetailBadge["bounds"];
  size: number;
  /** The first line, for the tooltip. */
  preview: string;
}

export function logicMarks(snapshot: SceneSnapshot): LogicMark[] {
  const graph = buildSceneGraph(snapshot);
  return graph.nodes
    .filter((node) => node.logic !== null)
    .map((node) => ({
      id: node.id,
      bounds: node.bounds,
      size: chipSize(node.bounds),
      preview: (node.logic ?? "").split("\n")[0].slice(0, 60),
    }));
}
