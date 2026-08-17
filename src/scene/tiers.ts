/**
 * Tier model for drill-down scenes (S11): Layer 1 is every frame nobody
 * drills into plus all frameless content; a detail frame's tier is its
 * linking element's tier + 1. Tiers are computed from the declared link
 * graph, never from positions.
 *
 * Spatial policy: lower tiers live in bands far below Layer 1 (adaptive
 * gap), so fitting any Layer-1 view can never pull Layer 2/3/4 content
 * into the viewport. Excalidraw culls offscreen elements, so distant
 * bands are free at render time.
 */
import type { SceneBounds } from "../adapter";
import type { SceneSnapshot, SnapshotElement } from "../adapter/snapshot";

const MIN_TIER_GAP = 20_000;
const MAX_DEPTH = 16;
const SIBLING_SPACING = 400;

export interface TierInfo {
  /** frameId → 1-based tier. */
  frameTier: Map<string, number>;
  /** detail frameId → the linking element and the frame that contains it. */
  detailParent: Map<string, { elementId: string; parentFrameId: string | null }>;
  /** Bounds of all tier-1 content (frames + frameless elements). */
  tier1Bounds: SceneBounds | null;
  maxTier: number;
  /** Vertical distance between tier bands for this scene. */
  tierGap: number;
}

function elementTierFrame(
  el: SnapshotElement,
  byId: Map<string, SnapshotElement>,
): string | null {
  // Bound labels belong wherever their container lives.
  if (el.containerId) {
    const container = byId.get(el.containerId);
    if (container) return container.frameId;
  }
  return el.frameId;
}

export function computeTiers(snapshot: SceneSnapshot): TierInfo {
  const byId = new Map(snapshot.elements.map((el) => [el.id, el]));
  const frames = snapshot.elements.filter((el) => el.type === "frame");
  const frameIds = new Set(frames.map((f) => f.id));

  const detailParent = new Map<
    string,
    { elementId: string; parentFrameId: string | null }
  >();
  for (const el of snapshot.elements) {
    const target = el.docent.detailFrameId;
    if (target && frameIds.has(target) && !detailParent.has(target)) {
      detailParent.set(target, {
        elementId: el.id,
        parentFrameId: elementTierFrame(el, byId),
      });
    }
  }

  const frameTier = new Map<string, number>();
  const tierOfFrame = (frameId: string, depth: number): number => {
    if (depth > MAX_DEPTH) return 1;
    const cached = frameTier.get(frameId);
    if (cached !== undefined) return cached;
    frameTier.set(frameId, 1); // cycle guard: assume 1 while resolving
    const parent = detailParent.get(frameId);
    let tier = 1;
    if (parent) {
      tier = parent.parentFrameId
        ? tierOfFrame(parent.parentFrameId, depth + 1) + 1
        : 2;
    }
    frameTier.set(frameId, tier);
    return tier;
  };
  for (const frame of frames) tierOfFrame(frame.id, 0);

  let maxTier = 1;
  for (const tier of frameTier.values()) maxTier = Math.max(maxTier, tier);

  // Tier-1 bounds: tier-1 frames + every element living outside detail tiers.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (el: SnapshotElement) => {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  };
  for (const el of snapshot.elements) {
    const frameId = el.type === "frame" ? el.id : elementTierFrame(el, byId);
    const tier = frameId ? (frameTier.get(frameId) ?? 1) : 1;
    if (tier === 1) include(el);
  }
  const tier1Bounds =
    minX === Infinity
      ? null
      : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  const span = tier1Bounds
    ? Math.max(tier1Bounds.width, tier1Bounds.height)
    : 0;
  const tierGap = Math.max(MIN_TIER_GAP, span * 5);

  return { frameTier, detailParent, tier1Bounds, maxTier, tierGap };
}

/** Tier of the context an element sits in (its containing frame's tier). */
export function tierOfElement(
  info: TierInfo,
  snapshot: SceneSnapshot,
  elementId: string,
): number {
  const byId = new Map(snapshot.elements.map((el) => [el.id, el]));
  const el = byId.get(elementId);
  if (!el) return 1;
  const frameId = el.type === "frame" ? el.id : elementTierFrame(el, byId);
  return frameId ? (info.frameTier.get(frameId) ?? 1) : 1;
}

/** Canonical y of a tier's band. Tier 1 is wherever the author drew it. */
export function bandY(info: TierInfo, tier: number): number {
  const base = info.tier1Bounds
    ? info.tier1Bounds.y + info.tier1Bounds.height
    : 0;
  return base + info.tierGap * (tier - 1);
}

/** Placement for a NEW detail frame in a band: right of existing siblings. */
export function bandPlacement(
  info: TierInfo,
  snapshot: SceneSnapshot,
  tier: number,
): { x: number; y: number } {
  const y = bandY(info, tier);
  let x = info.tier1Bounds?.x ?? 0;
  for (const el of snapshot.elements) {
    if (el.type !== "frame") continue;
    if ((info.frameTier.get(el.id) ?? 1) !== tier) continue;
    x = Math.max(x, el.x + el.width + SIBLING_SPACING);
  }
  return { x, y };
}

export interface Crumb {
  frameId: string;
  name: string;
  /** The shape whose detail this frame is. */
  linkingElementId: string;
  parentFrameId: string | null;
}

/** Structural breadcrumb trail for a scene point: tier 2 first, deepest last. */
export function trailAt(
  info: TierInfo,
  snapshot: SceneSnapshot,
  point: { x: number; y: number },
): Crumb[] {
  const frames = snapshot.elements.filter((el) => el.type === "frame");
  // Deepest detail frame containing the point.
  let current: SnapshotElement | null = null;
  let currentTier = 1;
  for (const frame of frames) {
    const tier = info.frameTier.get(frame.id) ?? 1;
    if (tier <= currentTier) continue;
    if (
      point.x >= frame.x &&
      point.x <= frame.x + frame.width &&
      point.y >= frame.y &&
      point.y <= frame.y + frame.height
    ) {
      current = frame;
      currentTier = tier;
    }
  }
  const trail: Crumb[] = [];
  let guard = 0;
  while (current && guard < MAX_DEPTH) {
    guard += 1;
    const parent = info.detailParent.get(current.id);
    if (!parent) break;
    trail.unshift({
      frameId: current.id,
      name: current.name ?? "",
      linkingElementId: parent.elementId,
      parentFrameId: parent.parentFrameId,
    });
    current = parent.parentFrameId
      ? (snapshot.elements.find((el) => el.id === parent.parentFrameId) ?? null)
      : null;
  }
  return trail;
}

export interface FrameMove {
  frameId: string;
  dx: number;
  dy: number;
  /** Every element that must move with the frame (children + their labels). */
  memberIds: string[];
}

/** Reflow all detail frames into their tier bands (for "Arrange tiers"). */
export function arrangeMoves(info: TierInfo, snapshot: SceneSnapshot): FrameMove[] {
  const moves: FrameMove[] = [];
  const frames = snapshot.elements
    .filter((el) => el.type === "frame")
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Frames already near their slot stay put (tolerance keeps arrange
  // idempotent for hand-placed-but-sane scenes); the x cursor advances from
  // wherever the frame actually is.
  const TOLERANCE = SIBLING_SPACING / 2;
  for (let tier = 2; tier <= info.maxTier; tier++) {
    const y = bandY(info, tier);
    let x = info.tier1Bounds?.x ?? 0;
    for (const frame of frames) {
      if ((info.frameTier.get(frame.id) ?? 1) !== tier) continue;
      const dx = x - frame.x;
      const dy = y - frame.y;
      if (Math.abs(dx) < TOLERANCE && Math.abs(dy) < TOLERANCE) {
        x = Math.max(x, frame.x + frame.width + SIBLING_SPACING);
        continue;
      }
      x += frame.width + SIBLING_SPACING;
      const memberIds: string[] = [];
      const moving = new Set<string>();
      for (const el of snapshot.elements) {
        if (el.frameId === frame.id) {
          memberIds.push(el.id);
          moving.add(el.id);
        }
      }
      // Bound labels whose container moves must move too, wherever they live.
      for (const el of snapshot.elements) {
        if (el.containerId && moving.has(el.containerId) && !moving.has(el.id)) {
          memberIds.push(el.id);
        }
      }
      moves.push({ frameId: frame.id, dx, dy, memberIds });
    }
  }
  return moves;
}
