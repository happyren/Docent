/**
 * The Review view (S16, D48): every changed scene of a bound project,
 * each changed frame as a before/after pair rendered at one rectangle,
 * the changelog beside it, and a way to see the change in place — fly
 * there, with the removed things drawn as ghosts over the live scene.
 * Pictures are rendered lazily, per crop, and never stored (D17).
 */
import { useEffect, useState } from "react";
import { renderCrop, type CropPictures } from "../review/images";
import type { ReviewCrop } from "../review/plan";
import { reviewProject, type SceneReview } from "../review/session";

export interface ReviewJump {
  scene: string;
  crop: ReviewCrop;
}

function CropCard({
  review,
  crop,
  onJump,
}: {
  review: SceneReview;
  crop: ReviewCrop;
  onJump?: (jump: ReviewJump) => void;
}) {
  const [pictures, setPictures] = useState<CropPictures | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPictures(null);
    setFailed(null);
    renderCrop(review, crop)
      .then((p) => live && setPictures(p))
      .catch((err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [review, crop]);
  const title = `${review.scene} / ${crop.frameName || "frame"}`;
  const side = (label: string, src: string | null | undefined) => (
    <figure className="docent-review-side">
      <figcaption>{label}</figcaption>
      {pictures === null && !failed ? (
        <div className="docent-review-placeholder">rendering…</div>
      ) : src ? (
        <img src={src} alt={`${title} — ${label}`} />
      ) : (
        <div className="docent-review-placeholder">
          {label === "before" ? "new scene — nothing before" : "deleted — nothing after"}
        </div>
      )}
    </figure>
  );
  return (
    <section className="docent-review-crop">
      <header>
        <strong>{title}</strong>
        <span className="docent-portfolio-meta">
          {crop.rect.width}×{crop.rect.height} at ({crop.rect.x}, {crop.rect.y})
        </span>
        {onJump && review.after && (
          <button
            title="Open the scene here and fly to this change, with removed things ghosted"
            onClick={() => onJump({ scene: review.scene, crop })}
          >
            Show in diagram
          </button>
        )}
      </header>
      {failed && <p className="docent-portfolio-github-warn">could not render: {failed}</p>}
      <div className="docent-review-pair">
        {side("before", pictures?.before)}
        {side("after", pictures?.after)}
      </div>
      <ul className="docent-review-lines">
        {crop.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export function ReviewPanel({
  project,
  onJump,
  onBack,
}: {
  project: string;
  /** Present when a canvas is behind the modal to fly in. */
  onJump?: (jump: ReviewJump) => void;
  onBack: () => void;
}) {
  const [reviews, setReviews] = useState<SceneReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setReviews(null);
    setError(null);
    reviewProject(project)
      .then((r) => live && setReviews(r))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [project]);

  const crops = (reviews ?? []).flatMap((review) =>
    review.plan.crops.map((crop) => ({ review, crop })),
  );
  return (
    <div className="docent-review">
      <div className="docent-portfolio-github-branches">
        <span className="docent-portfolio-github-label">Review</span>
        <span className="docent-portfolio-sync-summary">
          {reviews === null && !error && "comparing with the branch…"}
          {error && <span className="docent-portfolio-github-warn">{error}</span>}
          {reviews !== null &&
            (crops.length === 0
              ? "nothing changed in meaning since the last sync"
              : `${crops.length} changed ${crops.length === 1 ? "frame" : "frames"} across ${reviews.length} ${reviews.length === 1 ? "scene" : "scenes"}`)}
        </span>
        <button onClick={onBack}>Back</button>
      </div>
      {reviews !== null && reviews.length > 0 && (
        <pre className="docent-review-changelog">
          {reviews
            .map((r) => (reviews.length > 1 ? `${r.scene}\n${r.plan.changelog}` : r.plan.changelog))
            .join("\n\n")}
        </pre>
      )}
      <div className="docent-review-crops">
        {crops.map(({ review, crop }) => (
          <CropCard key={`${review.scene}/${crop.key}`} review={review} crop={crop} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}
