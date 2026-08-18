/**
 * Portfolio scene thumbnails (S12): fetch the scene, scope it to Layer 1
 * when it's tiered (detail bands live ≥20k units away — rendering them
 * would shrink the overview to dots), and rasterize via the adapter.
 * Thumbnails are ephemeral — computed from the `.excalidraw` files, never
 * stored (D17) — and cached per scene revision for the session.
 */
import { renderSceneThumbnail, snapshotFromSceneJSON } from "../adapter";
import { computeTiers } from "../scene/tiers";
import { loadScene } from "../portfolio/client";

const cache = new Map<string, Promise<string>>();

export function portfolioThumbnail(
  project: string,
  scene: string,
  updatedAt: string,
): Promise<string> {
  const key = `${project}/${scene}@${updatedAt}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const json = await loadScene(project, scene);
    const snapshot = snapshotFromSceneJSON(json);
    const tiers = computeTiers(snapshot);
    let include: Set<string> | null = null;
    if (tiers.maxTier > 1) {
      include = new Set();
      for (const el of snapshot.elements) {
        const tier =
          el.type === "frame"
            ? (tiers.frameTier.get(el.id) ?? 1)
            : el.frameId
              ? (tiers.frameTier.get(el.frameId) ?? 1)
              : 1;
        if (tier <= 1) include.add(el.id);
      }
    }
    return renderSceneThumbnail(json, include);
  })();
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}
