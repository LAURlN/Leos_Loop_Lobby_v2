/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorklet processors. Loaded once via `audioWorklet.addModule`.
 *
 * Every transport-following processor derives its loop position from the
 * global `currentFrame` and the shared `origin`, so separate nodes stay
 * sample-aligned without talking to each other (see docs/SYNC_MODEL.md).
 */
// Only the dependency-free timing module: the worklet scope has no TextEncoder, DOM, etc.
import { CANONICAL_RATE, mod } from '@lll/shared/timing';
import { PROCESSOR, type MetronomeMessage, type MetronomeSegment, type TrackPlayerMessage } from '../messages';

/** Fade at the edges of a play window, so section changes do not click. */
const WINDOW_FADE_SECONDS = 0.005;

/** Plays one track's mixed loop buffer (canonical rate) following the transport. */
class TrackPlayerProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array | null = null;
  private origin: number | null = null;
  private start = -Infinity;
  private end = Infinity;
  private fadeEdges = true;
  private readonly step = CANONICAL_RATE / sampleRate;
  private readonly fade = Math.max(1, Math.round(sampleRate * WINDOW_FADE_SECONDS));

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<TrackPlayerMessage>) => {
      const msg = event.data;
      if (msg.type === 'buffer') this.buffer = msg.data && msg.data.length > 0 ? msg.data : null;
      else if (msg.type === 'transport') {
        this.origin = msg.origin;
        this.start = msg.start ?? -Infinity;
        this.end = msg.end ?? Infinity;
        this.fadeEdges = msg.fadeEdges !== false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    const buffer = this.buffer;
    if (!out) return true;
    const blockEnd = currentFrame + out.length;
    if (!buffer || this.origin === null || blockEnd <= this.start || currentFrame >= this.end) {
      out.fill(0);
      return true;
    }
    const windowed = currentFrame < this.start + this.fade || blockEnd > this.end - this.fade;
    const length = buffer.length;
    let pos = mod((currentFrame - this.origin) * this.step, length);
    for (let i = 0; i < out.length; i++) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = buffer[i0] ?? 0;
      const b = buffer[i0 + 1 === length ? 0 : i0 + 1] ?? 0;
      out[i] = a + (b - a) * frac;
      if (windowed) {
        const frame = currentFrame + i;
        if (frame < this.start || frame >= this.end) out[i] = 0;
        else if (this.fadeEdges) {
          out[i]! *= Math.max(0, Math.min(1, (frame - this.start) / this.fade, (this.end - frame) / this.fade));
        }
      }
      pos += this.step;
      if (pos >= length) pos -= length;
    }
    return true;
  }
}

/** Streams mic samples to the main thread in blocks, tagged with their local frame. */
class RecorderProcessor extends AudioWorkletProcessor {
  private static readonly BLOCK = 2048;
  private block = new Float32Array(RecorderProcessor.BLOCK);
  private filled = 0;
  private blockFrame = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    outputs[0]?.[0]?.fill(0);
    // No input connected yet (or mic muted by the OS): still keep the frame counter honest.
    const frames = input?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      if (this.filled === 0) this.blockFrame = currentFrame + i;
      this.block[this.filled++] = input ? (input[i] ?? 0) : 0;
      if (this.filled === RecorderProcessor.BLOCK) {
        this.port.postMessage({ frame: this.blockFrame, data: this.block }, [this.block.buffer]);
        this.block = new Float32Array(RecorderProcessor.BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

/** Click track locked to the reference loop: `beatsPerLoop` clicks per reference cycle. */
class MetronomeProcessor extends AudioWorkletProcessor {
  private origin: number | null = null;
  private enabled = false;
  private loopLength48: number | null = null;
  private beatsPerLoop = 4;
  private volume = 0.5;
  private clickPhase = -1; // samples into the current click, -1 = silent
  private clickAccent = false;
  private lastBeat = -1;
  private segments: MetronomeSegment[] | null = null;
  private readonly step = CANONICAL_RATE / sampleRate;
  private readonly clickFrames = Math.round(sampleRate * 0.03);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MetronomeMessage>) => {
      const msg = event.data;
      if (msg.type === 'transport') {
        this.origin = msg.origin;
        this.lastBeat = -1;
      } else if (msg.type === 'segments') {
        this.segments = msg.segments;
        this.lastBeat = -1;
      } else {
        this.enabled = msg.enabled;
        this.loopLength48 = msg.loopLength48;
        this.beatsPerLoop = Math.max(1, Math.round(msg.beatsPerLoop));
        this.volume = msg.volume;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    if (this.segments) return this.processSegments(out, this.segments);
    const length = this.loopLength48;
    const active = this.enabled && this.origin !== null && length !== null && length > 0;
    const beatLength = active ? length / this.beatsPerLoop : 1;
    let pos = active ? mod((currentFrame - (this.origin ?? 0)) * this.step, length) : 0;
    for (let i = 0; i < out.length; i++) {
      if (active) {
        const beat = Math.floor(pos / beatLength);
        if (beat !== this.lastBeat) {
          this.lastBeat = beat;
          this.clickPhase = 0;
          this.clickAccent = beat === 0;
        }
        pos += this.step;
        if (pos >= length) pos -= length;
      }
      let sample = 0;
      if (this.clickPhase >= 0) {
        const t = this.clickPhase / sampleRate;
        const env = 1 - this.clickPhase / this.clickFrames;
        const freq = this.clickAccent ? 1760 : 1175;
        sample = Math.sin(2 * Math.PI * freq * t) * env * env * this.volume;
        this.clickPhase++;
        if (this.clickPhase >= this.clickFrames) this.clickPhase = -1;
      }
      out[i] = sample;
    }
    return true;
  }

  private processSegments(out: Float32Array, segments: MetronomeSegment[]): boolean {
    for (let i = 0; i < out.length; i++) {
      const frame = currentFrame + i;
      if (this.enabled) {
        const index = segments.findIndex((s) => frame >= s.start && frame < s.end);
        const seg = segments[index];
        if (seg) {
          const beatLength = seg.loopLength48 / Math.max(1, seg.beatsPerLoop);
          const beat = Math.floor(mod((frame - seg.origin) * this.step, seg.loopLength48) / beatLength);
          // Unique per segment, so a new section always starts with its accent.
          const key = index * 1024 + beat;
          if (key !== this.lastBeat) {
            this.lastBeat = key;
            this.clickPhase = 0;
            this.clickAccent = beat === 0;
          }
        }
      }
      out[i] = this.clickSample();
    }
    return true;
  }

  private clickSample(): number {
    if (this.clickPhase < 0) return 0;
    const t = this.clickPhase / sampleRate;
    const env = 1 - this.clickPhase / this.clickFrames;
    const freq = this.clickAccent ? 1760 : 1175;
    const sample = Math.sin(2 * Math.PI * freq * t) * env * env * this.volume;
    this.clickPhase++;
    if (this.clickPhase >= this.clickFrames) this.clickPhase = -1;
    return sample;
  }
}

registerProcessor(PROCESSOR.trackPlayer, TrackPlayerProcessor);
registerProcessor(PROCESSOR.recorder, RecorderProcessor);
registerProcessor(PROCESSOR.metronome, MetronomeProcessor);
