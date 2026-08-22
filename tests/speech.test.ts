/**
 * Spoken narration (S18, D52): the reader's text, the streamed WAV decoder,
 * and the controller's contract — cancel on change, resolve when finished,
 * silent unless enabled, never in the way.
 */
import { describe, expect, it } from "vitest";
import { readable } from "../src/speech/readable";
import { WavStream } from "../src/speech/wav";
import { SpeechController, type AudioSink } from "../src/speech/controller";

describe("readable", () => {
  it("speaks notation plainly and keeps the words", () => {
    expect(readable("Orders → Payments")).toBe("Orders to Payments");
    expect(readable("API Gateway — internals")).toBe("API Gateway, internals");
    expect(readable("Catalog v2 retries `charge` **twice**")).toBe("Catalog version 2 retries charge twice");
    expect(readable("## Core\n- first\n- second")).toBe("Core. first. second");
    expect(readable("  spaced   out  ")).toBe("spaced out");
    expect(readable("A <- B <-> C")).toBe("A from B and C");
  });
});

function wavBytes(samples: number[], opts: { channels?: number; rate?: number; bits?: 16 | 32; float?: boolean } = {}): Uint8Array {
  const channels = opts.channels ?? 1;
  const rate = opts.rate ?? 24000;
  const bits = opts.bits ?? 16;
  const format = opts.float ? 3 : 1;
  const bytesPer = bits / 8;
  const data = new Uint8Array(samples.length * bytesPer);
  const view = new DataView(data.buffer);
  samples.forEach((s, i) => {
    if (format === 3) view.setFloat32(i * 4, s, true);
    else if (bits === 16) view.setInt16(i * 2, Math.round(s * 32767), true);
    else view.setInt32(i * 4, Math.round(s * 2147483647), true);
  });
  const header = new Uint8Array(44);
  const h = new DataView(header.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (header[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  h.setUint32(4, 0xffffffff, true); // a streaming writer's placeholder
  tag(8, "WAVE");
  tag(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, format, true);
  h.setUint16(22, channels, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * bytesPer, true);
  h.setUint16(32, channels * bytesPer, true);
  h.setUint16(34, bits, true);
  tag(36, "data");
  h.setUint32(40, 0xffffffff, true);
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

describe("WavStream", () => {
  it("decodes 16-bit PCM fed in arbitrary pieces, ignoring placeholder sizes", () => {
    const bytes = wavBytes([0, 0.5, -0.5, 1, -1, 0.25]);
    const stream = new WavStream();
    const out: number[] = [];
    // Split at awkward places: mid-header, mid-sample.
    for (const [a, b] of [[0, 7], [7, 30], [30, 45], [45, 49], [49, bytes.length]]) {
      out.push(...stream.push(bytes.slice(a, b)));
    }
    expect(stream.format).toEqual({ format: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16 });
    expect(out.map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1, 0.25]);
  });

  it("mixes stereo down and reads float and 32-bit", () => {
    const stereo = new WavStream().push(wavBytes([1, 0, 0.5, 0.5], { channels: 2 }));
    expect([...stereo].map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.5]);
    const float = new WavStream().push(wavBytes([0.25, -0.75], { bits: 32, float: true }));
    expect([...float]).toEqual([0.25, -0.75]);
    const wide = new WavStream().push(wavBytes([0.5], { bits: 32 }));
    expect(Math.round(wide[0] * 100) / 100).toBe(0.5);
  });

  it("refuses what it cannot play, loudly", () => {
    const bytes = wavBytes([0], { bits: 16 });
    bytes[20] = 85; // format 85 = MPEG
    expect(() => new WavStream().push(bytes)).toThrow(/unsupported WAV/);
    expect(() => new WavStream().push(new TextEncoder().encode("<html>not audio</html>"))).toThrow(/not a WAV/);
  });
});

class FakeSink implements AudioSink {
  played: number[] = [];
  stops = 0;
  play(samples: Float32Array): void {
    this.played.push(samples.length);
  }
  drain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop(): void {
    this.stops += 1;
  }
}

function streamingFetch(bytes: Uint8Array, pieces = 3, delayMs = 5): typeof fetch {
  return async (_url, init) => {
    const signal = init?.signal ?? null;
    const size = Math.ceil(bytes.length / pieces);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < pieces; i++) {
          await new Promise((r) => setTimeout(r, delayMs));
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          controller.enqueue(bytes.slice(i * size, (i + 1) * size));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "audio/wav" } });
  };
}

describe("SpeechController", () => {
  const provider = { ttsUrl: "http://127.0.0.1:1/plugins/fake/tts", voice: "alba" };

  it("is silent until enabled, and resolves at once when silent", async () => {
    const sink = new FakeSink();
    let calls = 0;
    const controller = new SpeechController(sink, async () => {
      calls += 1;
      return new Response("x");
    });
    controller.setProvider(() => provider);
    await controller.speak("Hello");
    expect(calls).toBe(0);
    controller.enable();
    controller.setMuted(true);
    await controller.speak("Hello");
    expect(calls).toBe(0);
    controller.setMuted(false);
    controller.setProvider(() => null);
    await controller.speak("Hello");
    expect(calls).toBe(0);
    expect(controller.active).toBe(false);
    expect(controller.get().error).toMatch(/no speech\/1 plugin/);
  });

  it("streams the provider's wav into the sink and resolves when played", async () => {
    const sink = new FakeSink();
    const sent: { url: string; text: string; voice: string }[] = [];
    const upstream = streamingFetch(wavBytes(new Array(240).fill(0.1)), 4);
    const controller = new SpeechController(sink, async (url, init) => {
      const form = init?.body as FormData;
      sent.push({ url: String(url), text: String(form.get("text")), voice: String(form.get("voice_url")) });
      return upstream(url, init);
    });
    controller.setProvider(() => provider);
    controller.enable();
    const states: boolean[] = [];
    controller.subscribe((s) => states.push(s.speaking));
    await controller.speak("Orders → Payments");
    expect(sent).toEqual([{ url: provider.ttsUrl, text: "Orders to Payments", voice: "alba" }]);
    expect(sink.played.reduce((a, b) => a + b, 0)).toBe(240);
    expect(sink.played.length).toBeGreaterThan(1);
    expect(states.at(-1)).toBe(false);
    expect(states).toContain(true);
    expect(controller.get().error).toBeNull();
  });

  it("cancels the utterance playing when a new one arrives, and on cancel()", async () => {
    const sink = new FakeSink();
    const controller = new SpeechController(sink, streamingFetch(wavBytes(new Array(2400).fill(0)), 6, 15));
    controller.setProvider(() => provider);
    controller.enable();
    const first = controller.speak("first");
    await new Promise((r) => setTimeout(r, 25));
    const second = controller.speak("second");
    await first; // superseded: resolves, never rejects
    await second;
    expect(sink.stops).toBeGreaterThanOrEqual(2);
    const third = controller.speak("third");
    controller.cancel();
    await third;
    expect(controller.get().speaking).toBe(false);
  });

  it("records a provider failure and keeps going", async () => {
    const sink = new FakeSink();
    const controller = new SpeechController(sink, async () => new Response("model not loaded", { status: 503 }));
    controller.setProvider(() => provider);
    controller.enable();
    await controller.speak("Hello");
    expect(controller.get().error).toMatch(/503/);
    expect(controller.get().speaking).toBe(false);
  });
});
