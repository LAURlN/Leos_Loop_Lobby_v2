/**
 * The loop studio: one editable audio buffer (48 kHz mono) per open loop, with
 * the small, Audacity-style operations the editor offers.
 *
 * Everything here is pure: an operation takes a buffer and returns a *new* one,
 * so the UI can offer undo/redo by keeping old buffers around, and so the
 * interesting parts are unit-tested without audio hardware.
 *
 * Takes are never modified (layer audio is immutable, see schema.ts). The Lobby
 * mixes a track's audible takes into one working copy, the user edits that
 * copy, and "Save to loop" commits it as a single new layer
 * (actions.replaceTrackAudio). Positions, lengths and buffers are always in
 * canonical frames — see docs/SYNC_MODEL.md.
 */
import { CANONICAL_RATE, mixLayerInto } from '@lll/shared';

/** A range of frames; `end` is exclusive (half-open, like Array.slice). */
export interface FrameRange {
  start: number;
  end: number;
}

/** One audible take, mixed into the studio's working buffer. */
export interface StudioLayer {
  offset: number;
  gain: number;
  data: Float32Array;
}

/** Peak a normalize aims for: a little below full scale, so nothing clips. */
export const NORMALIZE_PEAK = 0.98;
/** Below this a sample counts as silence (about -50 dBFS). */
export const SILENCE_FLOOR = 0.003;
/** How many steps the studio can undo. */
export const MAX_HISTORY = 24;
/** Longest gain change a single "Apply" may make. */
const MAX_GAIN_FACTOR = 16;

export const framesToSeconds = (frames: number): number => frames / CANONICAL_RATE;
export const secondsToFrames = (seconds: number): number => Math.round(seconds * CANONICAL_RATE);

const clampIndex = (frame: number, length: number): number => Math.max(0, Math.min(length, Math.round(frame)));
const clampSample = (v: number): number => Math.max(-1, Math.min(1, v));

/** Mixes the audible takes of a track into one loop buffer of `length48` frames. */
export function mixToLoop(length48: number, layers: StudioLayer[]): Float32Array {
  const length = Math.max(1, Math.round(length48));
  const out = new Float32Array(length);
  for (const layer of layers) mixLayerInto(out, { offset: layer.offset, data: layer.data }, layer.gain);
  return out;
}

/** Clamps a range to `[0, length]`; null when it is empty or missing. */
export function clampRange(range: FrameRange | null | undefined, length: number): FrameRange | null {
  if (!range) return null;
  const start = clampIndex(Math.min(range.start, range.end), length);
  const end = clampIndex(Math.max(range.start, range.end), length);
  return end > start ? { start, end } : null;
}

/** The range itself, or the whole buffer when there is no (valid) selection. */
export function rangeOrAll(range: FrameRange | null | undefined, length: number): FrameRange {
  return clampRange(range, length) ?? { start: 0, end: length };
}

/** Copies frames [start, end). */
export function sliceRange(data: Float32Array, range: FrameRange): Float32Array {
  const r = clampRange(range, data.length);
  return r ? data.slice(r.start, r.end) : new Float32Array(0);
}

/** Removes frames [start, end) and closes the gap, so the loop gets shorter. */
export function deleteRange(data: Float32Array, range: FrameRange): Float32Array {
  const r = clampRange(range, data.length);
  if (!r) return data.slice();
  const out = new Float32Array(data.length - (r.end - r.start));
  out.set(data.subarray(0, r.start), 0);
  out.set(data.subarray(r.end), r.start);
  return out;
}

/** Replaces frames [start, end) with `clip` (an insert when the range is empty). */
export function replaceRange(data: Float32Array, range: FrameRange, clip: Float32Array): Float32Array {
  const r = clampRange(range, data.length) ?? { start: clampIndex(range.start, data.length), end: clampIndex(range.start, data.length) };
  const out = new Float32Array(data.length - (r.end - r.start) + clip.length);
  out.set(data.subarray(0, r.start), 0);
  out.set(clip, r.start);
  out.set(data.subarray(r.end), r.start + clip.length);
  return out;
}

/** Inserts `clip` at `at` without removing anything (paste, duplicate, double). */
export function insertFrames(data: Float32Array, at: number, clip: Float32Array): Float32Array {
  const pos = clampIndex(at, data.length);
  const out = new Float32Array(data.length + clip.length);
  out.set(data.subarray(0, pos), 0);
  out.set(clip, pos);
  out.set(data.subarray(pos), pos + clip.length);
  return out;
}

/** Writes silence over frames [start, end); the loop length stays the same. */
export function silenceRange(data: Float32Array, range: FrameRange): Float32Array {
  const out = data.slice();
  const r = clampRange(range, data.length);
  if (r) out.fill(0, r.start, r.end);
  return out;
}

/** Multiplies frames [start, end) by `factor`, clipping at full scale. */
export function gainRange(data: Float32Array, range: FrameRange | null, factor: number): Float32Array {
  const out = data.slice();
  const r = rangeOrAll(range, data.length);
  if (!Number.isFinite(factor) || factor === 1) return out;
  const f = Math.max(0, Math.min(MAX_GAIN_FACTOR, factor));
  for (let i = r.start; i < r.end; i++) out[i] = clampSample((out[i] ?? 0) * f);
  return out;
}

/** Peak level (max |sample|) of frames [start, end). */
export function peakOf(data: Float32Array, range?: FrameRange | null): number {
  const r = rangeOrAll(range, data.length);
  let peak = 0;
  for (let i = r.start; i < r.end; i++) {
    const v = Math.abs(data[i] ?? 0);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Root mean square of frames [start, end) — how loud the range feels. */
export function rmsOf(data: Float32Array, range?: FrameRange | null): number {
  const r = rangeOrAll(range, data.length);
  if (r.end <= r.start) return 0;
  let sum = 0;
  for (let i = r.start; i < r.end; i++) {
    const v = data[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / (r.end - r.start));
}

/** Scales frames [start, end) so the loudest sample sits at `target`. */
export function normalizeRange(data: Float32Array, range?: FrameRange | null, target = NORMALIZE_PEAK): Float32Array {
  const r = rangeOrAll(range, data.length);
  const peak = peakOf(data, r);
  if (peak < 1e-5) return data.slice();
  return gainRange(data, r, target / peak);
}

export type FadeKind = 'in' | 'out' | 'inout';

/** Linear fade over frames [start, end); every other frame is untouched. */
export function fadeRange(data: Float32Array, range: FrameRange, kind: FadeKind): Float32Array {
  const out = data.slice();
  const r = clampRange(range, data.length);
  if (!r) return out;
  const n = r.end - r.start;
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const gain = kind === 'in' ? t : kind === 'out' ? 1 - t : Math.min(t, 1 - t) * 2;
    out[r.start + i] = clampSample((out[r.start + i] ?? 0) * gain);
  }
  return out;
}

/** Plays frames [start, end) backwards. */
export function reverseRange(data: Float32Array, range: FrameRange): Float32Array {
  const out = data.slice();
  const r = clampRange(range, data.length);
  if (!r) return out;
  let a = r.start;
  let b = r.end - 1;
  while (a < b) {
    const tmp = out[a] ?? 0;
    out[a] = out[b] ?? 0;
    out[b] = tmp;
    a++;
    b--;
  }
  return out;
}

/** Pads with silence or truncates, so the buffer is exactly `length48` frames. */
export function resizeFrames(data: Float32Array, length48: number): Float32Array {
  const length = Math.max(0, Math.round(length48));
  const out = new Float32Array(length);
  out.set(data.subarray(0, Math.min(length, data.length)), 0);
  return out;
}

/** Appends a copy of the buffer (a loop of one bar becomes two, and so on). */
export function doubleLoop(data: Float32Array): Float32Array {
  return insertFrames(data, data.length, data);
}

/**
 * The tightest range that still contains everything louder than `threshold`,
 * or null when the whole buffer is silent. Used to trim trailing silence.
 */
export function loudBounds(data: Float32Array, threshold = SILENCE_FLOOR): FrameRange | null {
  let start = 0;
  let end = data.length;
  while (start < end && Math.abs(data[start] ?? 0) <= threshold) start++;
  while (end > start && Math.abs(data[end - 1] ?? 0) <= threshold) end--;
  return end > start ? { start, end } : null;
}

/**
 * Moves `frame` to the nearest zero crossing within `window` frames. Cuts and
 * fades that start on a zero crossing do not click (Audacity does the same).
 */
export function snapToZeroCrossing(data: Float32Array, frame: number, window = 256): number {
  const i0 = clampIndex(frame, data.length);
  const from = Math.max(1, i0 - Math.max(0, Math.round(window)));
  const to = Math.min(data.length - 1, i0 + Math.max(0, Math.round(window)));
  let best = i0;
  let bestDistance = Infinity;
  for (let i = from; i <= to; i++) {
    const a = data[i - 1] ?? 0;
    const b = data[i] ?? 0;
    if (!((a <= 0 && b >= 0) || (a >= 0 && b <= 0))) continue;
    const distance = Math.abs(i - i0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Decibel value of a linear gain factor, for the UI. */
export function factorToDb(factor: number): number {
  return factor <= 1e-4 ? -96 : 20 * Math.log10(factor);
}

export function dbToFactor(db: number): number {
  return Math.pow(10, db / 20);
}
