/**
 * Mixes a track's audible layers into one loop buffer. Remembers the last mix
 * per track so the common case, a new take on top of the same takes, only adds
 * the new layer instead of re-summing every take (overdub 20 → 1 layer of work).
 * Anything else (undo, gain/offset change, new length) remixes from scratch.
 */
import { mixLayerInto } from '@lll/shared';

export interface MixLayer {
  id: string;
  offset: number;
  gain: number;
  data: Float32Array;
}

interface CachedMix {
  length: number;
  /** layer id -> "offset:gain" of the layers summed into `buffer`. */
  parts: Map<string, string>;
  buffer: Float32Array;
}

export class LoopMixer {
  private cache = new Map<string, CachedMix>();

  /** Returns a new buffer the caller may keep or transfer. */
  mix(trackId: string, length: number, layers: MixLayer[]): Float32Array {
    const parts = new Map(layers.map((l) => [l.id, `${l.offset}:${l.gain}`]));
    const cached = this.cache.get(trackId);
    let buffer: Float32Array;
    let todo = layers;
    if (cached && cached.length === length && [...cached.parts].every(([id, part]) => parts.get(id) === part)) {
      buffer = cached.buffer;
      todo = layers.filter((l) => !cached.parts.has(l.id));
    } else {
      buffer = new Float32Array(length);
    }
    for (const l of todo) mixLayerInto(buffer, { offset: l.offset, data: l.data }, l.gain);
    this.cache.set(trackId, { length, parts, buffer });
    return buffer.slice();
  }

  forget(trackId: string): void {
    this.cache.delete(trackId);
  }

  clear(): void {
    this.cache.clear();
  }
}
