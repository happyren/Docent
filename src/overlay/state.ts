/**
 * Overlay effect state (B3): commands write this store; the overlay
 * renderer is its only consumer. Nothing here touches the scene — effects
 * are ephemeral by design (I2, D2).
 */

export type HighlightStyle = "glow" | "spotlight" | "outline";

export interface HighlightState {
  /** Every source element lit, flat and sorted — the idempotence key. */
  ids: string[];
  /**
   * The same elements grouped by *target* (D39): a composite or group is
   * one target made of many members, a plain shape a target of one. The
   * renderer draws one effect per target, never one per stroke.
   */
  targets: string[][];
  style: HighlightStyle;
}

export interface FlowState {
  /** Ordered edge ids the pulse travels, one after another. */
  path: string[];
  /** 1.0 ≈ 500 scene-units per second. */
  speed: number;
  loop: boolean;
  /** Bumped per flow() call so the renderer restarts its animation. */
  generation: number;
}

/**
 * One numbered step of a scenario replay (D89): the step's number at the
 * middle of the edge it travels, in scene coordinates. Badges live on the
 * overlay and only while the replay runs (I2) — the diagram itself stays
 * clean, which is how one map carries as many stories as it has.
 */
export interface StepBadge {
  x: number;
  y: number;
  n: number;
}

/**
 * A removed entity drawn where it used to be (D48): the review's "before"
 * laid over the live scene as a dashed, labelled ghost. Comes from the
 * base copy, never from the scene — nothing is written (I2).
 */
export interface GhostState {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface OverlayState {
  highlight: HighlightState | null;
  flow: FlowState | null;
  /** The numbered steps of the flow in force, empty for a plain pulse. */
  steps: StepBadge[];
  ghosts: GhostState[];
}

type Listener = (state: OverlayState) => void;

export class OverlayStore {
  private state: OverlayState = { highlight: null, flow: null, steps: [], ghosts: [] };
  private listeners = new Set<Listener>();
  private generation = 0;

  get(): OverlayState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(next: OverlayState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * Idempotent: same ids + style is a no-op; empty clears (S6). Accepts
   * flat element ids (each its own target) or targets of member ids.
   */
  setHighlight(ids: string[] | string[][], style: HighlightStyle): void {
    const targets: string[][] = ids
      .map((entry) => (Array.isArray(entry) ? [...entry] : [entry]))
      .filter((members) => members.length > 0);
    if (!targets.length) {
      if (this.state.highlight !== null) {
        this.emit({ ...this.state, highlight: null });
      }
      return;
    }
    const sorted = targets.flat().sort();
    const current = this.state.highlight;
    if (
      current &&
      current.style === style &&
      current.ids.length === sorted.length &&
      current.ids.every((id, i) => id === sorted[i])
    ) {
      return;
    }
    this.emit({ ...this.state, highlight: { ids: sorted, targets, style } });
  }

  /**
   * The step badges belong to the flow that raised them (D89): a pulse
   * that replaces or clears this one takes its numbers with it, so a stale
   * "3" can never sit over a diagram nothing is replaying.
   */
  setFlow(path: string[], speed: number, loop: boolean, steps: StepBadge[] = []): void {
    this.generation += 1;
    this.emit({
      ...this.state,
      flow: path.length
        ? { path, speed, loop, generation: this.generation }
        : null,
      steps: path.length ? steps.map((s) => ({ ...s })) : [],
    });
  }

  /** Replace the ghosts (D48). Empty clears them; same ids is a no-op. */
  setGhosts(ghosts: GhostState[]): void {
    const current = this.state.ghosts;
    if (
      current.length === ghosts.length &&
      current.every((g, i) => g.id === ghosts[i].id)
    ) {
      return;
    }
    this.emit({ ...this.state, ghosts: ghosts.map((g) => ({ ...g, bounds: { ...g.bounds } })) });
  }

  clear(): void {
    this.emit({ highlight: null, flow: null, steps: [], ghosts: [] });
  }
}
