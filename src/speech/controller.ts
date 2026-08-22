/**
 * Spoken narration (S18, D52): one controller that turns the words the
 * panel shows into speech through a `speech/1` provider. It fetches the
 * provider's streamed WAV, decodes it as it arrives, and schedules it into
 * an audio sink; a new text cancels the one playing. Off until the person
 * enables it (audio needs one gesture), silent while muted, and never in
 * the way: `speak` resolves when the speech has *finished* so a tour can
 * wait for it, but the caller decides whether to wait at all.
 */
import { readable } from "./readable";
import { WavStream } from "./wav";

export interface AudioSink {
  /** Called from the enabling gesture, where a browser lets audio start. */
  unlock?(): void;
  /** Queue samples for playback, in order, at the given rate. */
  play(samples: Float32Array, sampleRate: number): void;
  /** Resolves when everything queued so far has finished playing. */
  drain(): Promise<void>;
  /** Stop now and drop what is queued. */
  stop(): void;
}

/** Where speech comes from: the provider's `/tts` route and the voice to ask for. */
export interface SpeechProvider {
  ttsUrl: string;
  voice: string | null;
}

export interface SpeechState {
  /** The person has enabled audio this session. */
  enabled: boolean;
  muted: boolean;
  speaking: boolean;
  /** The last failure, shown once and cleared by the next success. */
  error: string | null;
}

type Listener = (state: SpeechState) => void;

export class SpeechController {
  private state: SpeechState = { enabled: false, muted: false, speaking: false, error: null };
  private listeners = new Set<Listener>();
  private generation = 0;
  private abort: AbortController | null = null;
  private provider: () => SpeechProvider | null = () => null;

  constructor(
    private readonly sink: AudioSink,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get(): SpeechState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Who answers `/tts` — resolved at each utterance, so a plugin toggled mid-session counts. */
  setProvider(provider: () => SpeechProvider | null): void {
    this.provider = provider;
  }

  /** The one gesture: from here on narration is spoken. */
  enable(): void {
    this.sink.unlock?.();
    this.emit({ enabled: true, error: null });
  }

  disable(): void {
    this.cancel();
    this.emit({ enabled: false });
  }

  setMuted(muted: boolean): void {
    if (muted) this.cancel();
    this.emit({ muted });
  }

  /** Stop whatever is playing. Pending `speak` promises resolve. */
  cancel(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.sink.stop();
    if (this.state.speaking) this.emit({ speaking: false });
  }

  /** Resolves when no utterance is in flight — at once when silent. */
  settled(): Promise<void> {
    if (!this.state.speaking) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe((state) => {
        if (!state.speaking) {
          off();
          resolve();
        }
      });
    });
  }

  /** Whether a call to `speak` would produce sound right now. */
  get active(): boolean {
    return this.state.enabled && !this.state.muted && this.provider() !== null;
  }

  /**
   * Speak the text, cancelling what was playing. Resolves when the speech
   * has finished — or at once when there is nothing to say, no provider,
   * audio is off, or the utterance was superseded. Never rejects: a
   * provider failure is recorded in the state and the promise resolves.
   */
  async speak(text: string | null): Promise<void> {
    this.cancel();
    const words = text ? readable(text) : "";
    if (!words || !this.state.enabled || this.state.muted) return;
    const provider = this.provider();
    if (!provider) {
      // Enabled, asked to speak, and nobody to ask: say so once, in the
      // panel, rather than stay silent without a reason.
      this.emit({ error: "no speech/1 plugin is running — switch one on in Plugins" });
      return;
    }
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ speaking: true, error: null });
    const form = new FormData();
    form.append("text", words);
    if (provider.voice) form.append("voice_url", provider.voice);
    try {
      const res = await this.fetchImpl(provider.ttsUrl, {
        method: "POST",
        body: form,
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`speech provider answered ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }
      const reader = res.body.getReader();
      const wav = new WavStream();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation !== this.generation) return;
        const samples = wav.push(value);
        if (samples.length && wav.format) this.sink.play(samples, wav.format.sampleRate);
      }
      if (generation !== this.generation) return;
      await this.sink.drain();
      if (generation === this.generation) this.emit({ speaking: false });
    } catch (err) {
      if (generation !== this.generation) return; // cancelled: not an error
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ speaking: false, error: message });
    }
  }
}

/**
 * Web Audio as the sink: each chunk becomes a buffer scheduled right after
 * the previous one, so a streamed reply plays gaplessly from its first
 * bytes. The context is created by the enabling gesture.
 */
export class WebAudioSink implements AudioSink {
  private context: AudioContext | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Called from the enabling gesture so the browser allows sound. */
  unlock(): void {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === "suspended") void this.context.resume();
  }

  play(samples: Float32Array, sampleRate: number): void {
    const ctx = this.context;
    if (!ctx || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // A small lead on the first chunk absorbs scheduling jitter; after
    // that, each chunk starts exactly where the last one ends.
    const at = Math.max(ctx.currentTime + 0.06, this.nextAt);
    source.start(at);
    this.nextAt = at + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  drain(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return Promise.resolve();
    const remaining = Math.max(0, this.nextAt - ctx.currentTime);
    return new Promise((resolve) => setTimeout(resolve, remaining * 1000 + 30));
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already ended
      }
    }
    this.sources.clear();
    this.nextAt = 0;
  }
}
