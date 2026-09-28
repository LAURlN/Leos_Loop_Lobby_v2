/**
 * Main-thread buffer of microphone audio, addressed by local audio frame.
 * The recorder worklet feeds it blocks; recordings read ranges from it after
 * the fact. This is what makes "pre-record" and latency compensation simple:
 * a take is just a range of frames that we cut out once it has arrived.
 */
import type { RecorderChunk } from './messages';

export interface CaptureHold {
  readonly fromFrame: number;
}

export class MicCapture {
  private chunks: RecorderChunk[] = [];
  private holds = new Set<CaptureHold>();
  private waiters: Array<{ frame: number; resolve: () => void }> = [];
  /** Frame just after the newest received sample. */
  endFrame = 0;

  constructor(private readonly keepFrames: number) {}

  push(chunk: RecorderChunk): void {
    this.chunks.push(chunk);
    this.endFrame = chunk.frame + chunk.data.length;
    this.waiters = this.waiters.filter((w) => {
      if (w.frame <= this.endFrame) {
        w.resolve();
        return false;
      }
      return true;
    });
    this.trim();
  }

  /** Keeps audio from `fromFrame` on until released (e.g. while recording). */
  hold(fromFrame: number): CaptureHold {
    const h = { fromFrame };
    this.holds.add(h);
    return h;
  }

  release(hold: CaptureHold): void {
    this.holds.delete(hold);
    this.trim();
  }

  /** Resolves once audio up to (excluding) `frame` has arrived. */
  waitUntil(frame: number, timeoutMs = 3000): Promise<void> {
    if (frame <= this.endFrame) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Microphone audio did not arrive in time')), timeoutMs);
      this.waiters.push({
        frame,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Copies frames [from, to). Missing audio is returned as silence. */
  read(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, Math.round(to - from)));
    for (const c of this.chunks) {
      const start = Math.max(from, c.frame);
      const end = Math.min(to, c.frame + c.data.length);
      if (end <= start) continue;
      out.set(c.data.subarray(start - c.frame, end - c.frame), start - from);
    }
    return out;
  }

  private trim(): void {
    let keepFrom = this.endFrame - this.keepFrames;
    for (const h of this.holds) keepFrom = Math.min(keepFrom, h.fromFrame);
    while (this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (first.frame + first.data.length >= keepFrom) break;
      this.chunks.shift();
    }
  }
}
