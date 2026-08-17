/**
 * Overlay effect state (B3): commands write this store; the overlay
 * renderer is its only consumer. Nothing here touches the scene — effects
 * are ephemeral by design (I2, D2).
 */

export type HighlightStyle = "glow" | "spotlight" | "outline";

export interface HighlightState {
  ids: string[];
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

export interface OverlayState {
  highlight: HighlightState | null;
  flow: FlowState | null;
}

type Listener = (state: OverlayState) => void;

export class OverlayStore {
  private state: OverlayState = { highlight: null, flow: null };
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

  /** Idempotent: same ids + style is a no-op; empty ids clears (S6). */
  setHighlight(ids: string[], style: HighlightStyle): void {
    if (!ids.length) {
      if (this.state.highlight !== null) {
        this.emit({ ...this.state, highlight: null });
      }
      return;
    }
    const sorted = [...ids].sort();
    const current = this.state.highlight;
    if (
      current &&
      current.style === style &&
      current.ids.length === sorted.length &&
      current.ids.every((id, i) => id === sorted[i])
    ) {
      return;
    }
    this.emit({ ...this.state, highlight: { ids: sorted, style } });
  }

  setFlow(path: string[], speed: number, loop: boolean): void {
    this.generation += 1;
    this.emit({
      ...this.state,
      flow: path.length
        ? { path, speed, loop, generation: this.generation }
        : null,
    });
  }

  clear(): void {
    this.emit({ highlight: null, flow: null });
  }
}
