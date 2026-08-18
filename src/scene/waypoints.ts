/**
 * Waypoint ordering for presentations (S2): frames sort by their declared
 * order (`customData.docent.order`) when present, then by natural name
 * comparison ("02 Core" < "10 Edge"), then by id for determinism.
 */
import type { FrameInfo } from "../adapter";

/** Sentinel waypoint index: fit the whole current tier. */
export const OVERVIEW = -1;

/**
 * Clamp a requested waypoint index. A scene with no waypoints (e.g. no
 * frames at all) always resolves to OVERVIEW — indexing an empty list from
 * the arrow keys must never throw.
 */
export function resolveWaypointTarget(target: number, count: number): number {
  if (target === OVERVIEW || count === 0) return OVERVIEW;
  return Math.max(0, Math.min(count - 1, target));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function orderWaypoints(frames: readonly FrameInfo[]): FrameInfo[] {
  return [...frames].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
