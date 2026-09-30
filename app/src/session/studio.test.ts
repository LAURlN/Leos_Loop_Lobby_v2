import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY,
  clampRange,
  dbToFactor,
  deleteRange,
  doubleLoop,
  factorToDb,
  fadeRange,
  gainRange,
  insertFrames,
  loudBounds,
  mixToLoop,
  normalizeRange,
  peakOf,
  rangeOrAll,
  replaceRange,
  resizeFrames,
  reverseRange,
  rmsOf,
  silenceRange,
  sliceRange,
  snapToZeroCrossing,
} from './studio';

/** A ramp so every index is identifiable: data[i] === i / length. */
function ramp(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i / length;
  return out;
}

/** Float32 rounds, so compare at 4 decimals where the exact value is awkward. */
const list = (data: Float32Array) => Array.from(data).map((v) => Number(v.toFixed(4)));

describe('studio buffer operations', () => {
  it('mixes takes around the loop, like playback does', () => {
    const loop = mixToLoop(8, [
      { offset: 0, gain: 1, data: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]) },
      { offset: 6, gain: 0.5, data: new Float32Array([2, 2, 2, 2]) },
    ]);
    // The second take wraps around the loop end: 6, 7, 0, 1.
    expect(list(loop)).toEqual([2, 2, 1, 1, 1, 1, 2, 2]);
  });

  it('cuts and closes the gap (Delete)', () => {
    expect(list(deleteRange(ramp(10), { start: 3, end: 5 }))).toEqual([0, 0.1, 0.2, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(list(deleteRange(ramp(4), { start: 0, end: 2 }))).toEqual([0.5, 0.75]);
  });

  it('deleting a whole loop leaves nothing', () => {
    expect(deleteRange(ramp(4), { start: 0, end: 4 }).length).toBe(0);
  });

  it('silences a range but keeps the length', () => {
    const out = silenceRange(ramp(6), { start: 2, end: 4 });
    expect(out.length).toBe(6);
    expect(list(out)).toEqual([0, 1 / 6, 0, 0, 4 / 6, 5 / 6].map((v) => Number(v.toFixed(4))));
  });

  it('replaces a range with a clip, shrinking or growing the loop', () => {
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(list(replaceRange(data, { start: 2, end: 4 }, new Float32Array([9])))).toEqual([1, 2, 9, 5, 6]);
    expect(list(replaceRange(data, { start: 2, end: 3 }, new Float32Array([8, 8, 8])))).toEqual([1, 2, 8, 8, 8, 4, 5, 6]);
    // A clip that is exactly as long as the range keeps everything in place.
    expect(list(replaceRange(data, { start: 1, end: 3 }, new Float32Array([7, 7])))).toEqual([1, 7, 7, 4, 5, 6]);
  });

  it('inserts at the ends without dropping audio', () => {
    expect(list(insertFrames(new Float32Array([1, 2]), 0, new Float32Array([9])))).toEqual([9, 1, 2]);
    expect(list(insertFrames(new Float32Array([1, 2]), 2, new Float32Array([9])))).toEqual([1, 2, 9]);
  });

  it('gains and normalizes within a range only', () => {
    const data = new Float32Array([0.25, -0.5, 0.75, 0.1]);
    expect(list(gainRange(data, { start: 0, end: 2 }, 2))).toEqual([0.5, -1, 0.75, 0.1]);
    // ...and the input buffer is untouched.
    expect(list(data)).toEqual([0.25, -0.5, 0.75, 0.1]);
    // Clipping stops at full scale.
    expect(list(gainRange(data, null, 4))).toEqual([1, -1, 1, 0.4]);
    const normalized = normalizeRange(data, { start: 2, end: 4 });
    expect(peakOf(normalized, { start: 2, end: 4 })).toBeCloseTo(0.98, 4);
    // Samples outside the selection keep their level.
    expect(normalized[0]).toBeCloseTo(0.25, 6);
    // Already silent: nothing to normalize.
    expect(list(normalizeRange(new Float32Array(4).fill(0)))).toEqual([0, 0, 0, 0]);
  });

  it('reports peak and rms of a range', () => {
    const data = new Float32Array([0.5, -0.25, 0, 0, 0, 0]);
    expect(peakOf(data)).toBe(0.5);
    expect(peakOf(data, { start: 1, end: 3 })).toBe(0.25);
    expect(rmsOf(data, { start: 0, end: 2 })).toBeCloseTo(Math.sqrt((0.25 + 0.0625) / 2), 6);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it('fades in, out and in-out over a range', () => {
    const flat = new Float32Array(5).fill(1);
    expect(list(fadeRange(flat, { start: 0, end: 5 }, 'in'))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(list(fadeRange(flat, { start: 0, end: 5 }, 'out'))).toEqual([1, 0.75, 0.5, 0.25, 0]);
    expect(list(fadeRange(flat, { start: 0, end: 5 }, 'inout'))).toEqual([0, 0.5, 1, 0.5, 0]);
    // Outside the range nothing changes.
    expect(list(fadeRange(flat, { start: 1, end: 3 }, 'in'))).toEqual([1, 0, 1, 1, 1]);
  });

  it('reverses a range in place', () => {
    const data = new Float32Array([1, 2, 3, 4, 5]);
    expect(list(reverseRange(data, { start: 1, end: 4 }))).toEqual([1, 4, 3, 2, 5]);
    expect(list(reverseRange(data, { start: 0, end: 5 }))).toEqual([5, 4, 3, 2, 1]);
  });

  it('resizes with silence and never mutates the input', () => {
    const data = ramp(4);
    const copy = data.slice();
    expect(list(resizeFrames(data, 2))).toEqual(list(data.subarray(0, 2)));
    expect(list(resizeFrames(data, 6))).toEqual([0, 0.25, 0.5, 0.75, 0, 0]);
    expect(list(data)).toEqual(list(copy));
  });

  it('doubles the loop by appending a copy', () => {
    expect(list(doubleLoop(new Float32Array([1, 2, 3])))).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('finds the loud part and trims silence', () => {
    const data = new Float32Array([0, 0, 0.5, -0.4, 0, 0.02, 0]);
    const bounds = loudBounds(data);
    expect(bounds).toEqual({ start: 2, end: 6 });
    expect(list(sliceRange(data, bounds!))).toEqual([0.5, -0.4, 0, 0.02]);
    expect(loudBounds(new Float32Array(8))).toBeNull();
    // A very quiet tail counts as silence at the default floor.
    expect(loudBounds(new Float32Array([0, 0.5, 0, 0.001, 0]))).toEqual({ start: 1, end: 2 });
  });

  it('snaps cuts to the nearest zero crossing', () => {
    const data = new Float32Array([1, 1, -1, -1, 1, 1]);
    expect(snapToZeroCrossing(data, 1)).toBe(2);
    expect(snapToZeroCrossing(data, 3)).toBe(2);
    expect(snapToZeroCrossing(data, 4)).toBe(4);
    // Nothing near a crossing: stay where we are.
    expect(snapToZeroCrossing(new Float32Array(4).fill(1), 2, 1)).toBe(2);
  });

  it('treats ranges as half-open and clamps them to the buffer', () => {
    expect(clampRange({ start: -5, end: 3 }, 10)).toEqual({ start: 0, end: 3 });
    expect(clampRange({ start: 3, end: 99 }, 10)).toEqual({ start: 3, end: 10 });
    expect(clampRange({ start: 4, end: 4 }, 10)).toBeNull();
    expect(clampRange(null, 10)).toBeNull();
    expect(rangeOrAll(null, 10)).toEqual({ start: 0, end: 10 });
    expect(rangeOrAll({ start: 5, end: 99 }, 10)).toEqual({ start: 5, end: 10 });
  });

  it('converts between gain factors and decibels', () => {
    expect(dbToFactor(0)).toBeCloseTo(1, 9);
    expect(dbToFactor(6)).toBeCloseTo(1.995, 3);
    expect(factorToDb(1)).toBeCloseTo(0, 9);
    expect(factorToDb(0)).toBe(-96);
    expect(MAX_HISTORY).toBeGreaterThan(1);
  });
});
