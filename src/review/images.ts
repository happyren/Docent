/**
 * The review pictures (D48, D49): before and after, rendered through the
 * adapter at the crop's one rectangle. The only module here that touches
 * a canvas.
 */
import { renderSceneCrop, type CropMark } from "../adapter";
import type { ReviewCrop } from "./plan";
import type { SceneReview } from "./session";

export interface CropPictures {
  before: string | null;
  after: string | null;
}

/** Render one crop's two pictures as PNG data URLs. */
export async function renderCrop(review: SceneReview, crop: ReviewCrop): Promise<CropPictures> {
  const beforeMarks: CropMark[] = crop.marks
    .filter((m) => m.kind === "removed")
    .map((m) => ({ rect: m.rect, kind: m.kind }));
  const afterMarks: CropMark[] = crop.marks
    .filter((m) => m.kind !== "removed")
    .map((m) => ({ rect: m.rect, kind: m.kind }));
  const [before, after] = await Promise.all([
    review.before ? renderSceneCrop(review.before, crop.rect, crop.frameId, beforeMarks) : Promise.resolve(null),
    review.after ? renderSceneCrop(review.after, crop.rect, crop.frameId, afterMarks) : Promise.resolve(null),
  ]);
  return { before, after };
}

/** The base64 payload of a PNG data URL — what the store's review-images route takes. */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
