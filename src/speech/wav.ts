/**
 * An incremental WAV reader (D52): feed it the bytes of a streamed
 * `audio/wav` reply as they arrive and take PCM out as float samples, so
 * playback starts on the first chunk. Sizes in the header are ignored — a
 * streaming writer does not know them. 16-bit and 32-bit integer PCM and
 * 32-bit float are read; anything else is refused with a reason.
 */
export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float. */
  format: number;
}

export class WavStream {
  private pending = new Uint8Array(0);
  private headerDone = false;
  private fmt: WavFormat | null = null;
  private dataOffset = -1;

  get format(): WavFormat | null {
    return this.fmt;
  }

  /** Append bytes; returns the mono samples they completed (channels mixed down). */
  push(chunk: Uint8Array): Float32Array {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    this.pending = joined;
    if (!this.headerDone && !this.parseHeader()) return new Float32Array(0);
    return this.drain();
  }

  private parseHeader(): boolean {
    const b = this.pending;
    if (b.length < 12) return false;
    const tag = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV stream");
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 12;
    while (at + 8 <= b.length) {
      const id = tag(at);
      const size = view.getUint32(at + 4, true);
      if (id === "fmt ") {
        if (at + 8 + 16 > b.length) return false;
        this.fmt = {
          format: view.getUint16(at + 8, true),
          channels: view.getUint16(at + 10, true),
          sampleRate: view.getUint32(at + 12, true),
          bitsPerSample: view.getUint16(at + 22, true),
        };
        at += 8 + size + (size % 2);
        continue;
      }
      if (id === "data") {
        if (!this.fmt) throw new Error("WAV data before fmt");
        const { format, bitsPerSample } = this.fmt;
        const ok =
          (format === 1 && (bitsPerSample === 16 || bitsPerSample === 32)) ||
          (format === 3 && bitsPerSample === 32);
        if (!ok) throw new Error(`unsupported WAV: format ${format}, ${bitsPerSample}-bit`);
        this.dataOffset = at + 8;
        this.headerDone = true;
        this.pending = this.pending.slice(this.dataOffset);
        return true;
      }
      // Some other chunk (LIST, fact): skip it whole, or wait for it.
      if (at + 8 + size > b.length) return false;
      at += 8 + size + (size % 2);
    }
    return false;
  }

  private drain(): Float32Array {
    const fmt = this.fmt!;
    const bytesPerSample = fmt.bitsPerSample / 8;
    const frameBytes = bytesPerSample * fmt.channels;
    const frames = Math.floor(this.pending.length / frameBytes);
    const out = new Float32Array(frames);
    if (frames === 0) return out;
    const view = new DataView(this.pending.buffer, this.pending.byteOffset, frames * frameBytes);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < fmt.channels; c++) {
        const at = (f * fmt.channels + c) * bytesPerSample;
        if (fmt.format === 3) sum += view.getFloat32(at, true);
        else if (fmt.bitsPerSample === 16) sum += view.getInt16(at, true) / 32768;
        else sum += view.getInt32(at, true) / 2147483648;
      }
      out[f] = sum / fmt.channels;
    }
    this.pending = this.pending.slice(frames * frameBytes);
    return out;
  }
}
