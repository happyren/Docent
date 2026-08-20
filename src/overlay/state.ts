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
