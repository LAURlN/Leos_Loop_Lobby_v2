/**
 * The timing law of Leo's Loop Lobby. Read docs/SYNC_MODEL.md first.
 *
 * Devices never synchronise clocks. All shared audio data is expressed as
 * *positions inside a track loop* at the canonical sample rate. Each device
 * renders every track at `(localFrame - origin) mod length`, using one local
 * origin for all tracks. Different devices therefore hear a rotated, but
 * musically identical, version of the same loop set.
 *
 * Everything in this file is pure and unit-tested; keep it that way.
 */

/** All stored/shared audio and lengths use this rate, regardless of device rate. */
export const CANONICAL_RATE = 48000;

/** Shortest loop we accept (100 ms), in canonical frames. */
export const MIN_LOOP_FRAMES = CANONICAL_RATE / 10;

/** Longest loop we accept (10 minutes), in canonical frames. */
export const MAX_LOOP_FRAMES = CANONICAL_RATE * 600;

/** Always-positive modulo that also works for fractional values. */
export function mod(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

/** Converts a frame count between sample rates (fractional result). */
export function convertFrames(frames: number, fromRate: number, toRate: number): number {
  return (frames * toRate) / fromRate;
}

/**
 * Canonical loop position rendered at `localFrame` (the audio-graph frame
 * counter of this device). Fractional; callers interpolate when reading.
 */
export function renderPosition(
  localFrame: number,
  originLocalFrame: number,
  localRate: number,
  length48: number,
): number {
  return mod(convertFrames(localFrame - originLocalFrame, localRate, CANONICAL_RATE), length48);
}

/**
 * Canonical loop position that a microphone sample captured at local frame
 * `micFrame` belongs to. The sample was played along to audio rendered
 * `roundTripLocalFrames` earlier (output latency + input latency).
 */
export function capturePosition(
  micFrame: number,
  roundTripLocalFrames: number,
  originLocalFrame: number,
  localRate: number,
  length48: number,
): number {
  return renderPosition(micFrame - roundTripLocalFrames, originLocalFrame, localRate, length48);
}

/**
 * A layer is a contiguous run of samples starting at loop position `offset`
 * and wrapping around the loop end. `data.length <= loop length` always.
 */
export interface LayerData {
  offset: number;
  data: Float32Array;
}

/**
 * Folds a recorded take (canonical rate) that starts at loop position
 * `startPosition` into a layer. Takes longer than one loop cycle are summed
 * onto themselves, exactly like overdubbing multiple passes.
 */
export function foldTake(samples: Float32Array, startPosition: number, length48: number): LayerData {
  const length = Math.round(length48);
  const offset = mod(Math.round(startPosition), length);
  if (samples.length <= length) {
    return { offset, data: samples.slice() };
  }
  const data = new Float32Array(length);
  for (let i = 0; i < samples.length; i++) {
    const idx = i % length;
    data[idx] = (data[idx] ?? 0) + (samples[i] ?? 0);
  }
  return { offset, data };
}

/** Adds `layer * gain` into `out` (one full loop, canonical frames). */
export function mixLayerInto(out: Float32Array, layer: LayerData, gain = 1): void {
  const length = out.length;
  if (length === 0) return;
  let pos = mod(layer.offset, length);
  const src = layer.data;
  for (let i = 0; i < src.length; i++) {
    out[pos] = (out[pos] ?? 0) + (src[i] ?? 0) * gain;
    pos++;
    if (pos === length) pos = 0;
  }
}

/** Linear ramps at the start/end of a buffer to avoid clicks (in place). */
export function applyFades(samples: Float32Array, fadeInFrames: number, fadeOutFrames: number): void {
  const n = samples.length;
  const fin = Math.min(fadeInFrames, n);
  for (let i = 0; i < fin; i++) samples[i] = (samples[i] ?? 0) * (i / fin);
  const fout = Math.min(fadeOutFrames, n);
  for (let i = 0; i < fout; i++) {
    const idx = n - 1 - i;
    samples[idx] = (samples[idx] ?? 0) * (i / fout);
  }
}

/** Linear-interpolation resampler. Good enough for v0; see docs/ROADMAP.md. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const outLength = Math.max(0, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track lengths
// ---------------------------------------------------------------------------

/**
 * How a track decides its loop length.
 * - `free`: the first take decides; with `autoSnap` it snaps to a musically
 *   related multiple/fraction of the reference loop (if one exists).
 * - `ratio`: exactly `num/den` × reference length.
 * - `seconds`: a fixed duration.
 */
export type LengthSpec =
  | { kind: 'free'; autoSnap: boolean }
  | { kind: 'ratio'; num: number; den: number }
  | { kind: 'seconds'; seconds: number };

/** Length known before recording, or `null` if the first take decides. */
export function predefinedLength(spec: LengthSpec, reference48: number | null): number | null {
  switch (spec.kind) {
    case 'free':
      return null;
    case 'ratio':
      if (reference48 === null || spec.den <= 0 || spec.num <= 0) return null;
      return clampLength(Math.round((reference48 * spec.num) / spec.den));
    case 'seconds':
      return clampLength(Math.round(spec.seconds * CANONICAL_RATE));
  }
}

export function clampLength(length48: number): number {
  return Math.min(MAX_LOOP_FRAMES, Math.max(MIN_LOOP_FRAMES, Math.round(length48)));
}

/**
 * Picks the musically closest loop length for a free take relative to the
 * reference loop: 1/8, 1/4, 1/2, 1× and integer multiples (ported from v1).
 * For short references the multiple step doubles until it is >= 1 s so that
 * small start/stop timing errors cannot select the wrong multiple.
 */
export function autoSnapLength(captured48: number, reference48: number): number {
  const candidates: number[] = [];
  for (let power = 1; power <= 3; power++) {
    const sub = Math.round(reference48 / 2 ** power);
    if (sub >= MIN_LOOP_FRAMES) candidates.push(sub);
  }
  let step = reference48;
  while (step < CANONICAL_RATE && step * 2 <= MAX_LOOP_FRAMES) step *= 2;
  for (let m = reference48; m <= MAX_LOOP_FRAMES; m *= 2) candidates.push(m);
  for (let m = step; m <= MAX_LOOP_FRAMES; m += step) candidates.push(m);

  let best = clampLength(captured48);
  let bestDistance = Infinity;
  for (const c of candidates) {
    if (c < MIN_LOOP_FRAMES || c > MAX_LOOP_FRAMES) continue;
    const d = Math.abs(c - captured48);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

/** Human readable relation of a length to the reference, e.g. "2×", "½×", "1.37 s". */
export function describeLength(length48: number, reference48: number | null): string {
  if (reference48 !== null && reference48 > 0) {
    const ratio = length48 / reference48;
    const known: Array<[number, string]> = [
      [1 / 8, '⅛×'], [1 / 4, '¼×'], [1 / 2, '½×'], [3 / 4, '¾×'], [3 / 2, '1½×'],
    ];
    for (const [r, label] of known) if (Math.abs(ratio - r) < 1e-3) return label;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-3) return `${Math.round(ratio)}×`;
  }
  return `${(length48 / CANONICAL_RATE).toFixed(2)} s`;
}

/** Parses user input like "3/2", "2", "2.5 s", "2.5s" into a LengthSpec. */
export function parseLengthInput(text: string): LengthSpec | null {
  const t = text.trim().toLowerCase();
  const seconds = /^(\d+(?:[.,]\d+)?)\s*(s|sec|secs|seconds?)$/.exec(t);
  if (seconds?.[1]) {
    const value = Number(seconds[1].replace(',', '.'));
    return value > 0 ? { kind: 'seconds', seconds: value } : null;
  }
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (fraction?.[1] && fraction[2]) {
    const num = Number(fraction[1]);
    const den = Number(fraction[2]);
    return num > 0 && den > 0 ? { kind: 'ratio', num, den } : null;
  }
  const multiple = /^(\d+(?:[.,]\d+)?)\s*x?$/.exec(t);
  if (multiple?.[1]) {
    const value = Number(multiple[1].replace(',', '.'));
    if (!(value > 0)) return null;
    // Express decimals as a fraction with denominator 1000 to stay exact enough.
    const den = Number.isInteger(value) ? 1 : 1000;
    return { kind: 'ratio', num: Math.round(value * den), den };
  }
  return null;
}
