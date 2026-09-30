/**
 * View maths for the loop studio's waveform: frame -> pixel mapping, ruler tick
 * spacing, and the min/max envelope the canvas draws. Pure functions with a
 * test next to them; StudioDialog turns the results into pixels.
 */

import { CANONICAL_RATE } from '@lll/shared';

/** Tick steps the ruler may use, in seconds. */
const TICK_SECONDS = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Which part of the buffer is on screen: `span` frames starting at `start`. */
export interface StudioView {
  start: number;
  span: number;
}

export interface Envelope {
  /** Lowest sample per pixel column. */
  min: Float32Array;
  /** Highest sample per pixel column. */
  max: Float32Array;
}

/** min/max sample for each of `columns` pixel columns between `from48` and `to48`. */
export function columnEnvelope(data: Float32Array, from48: number, to48: number, columns: number): Envelope {
  const cols = Math.max(1, Math.round(columns));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const n = data.length;
  if (n === 0) return { min, max };
  const from = Math.max(0, Math.min(n, from48));
  const to = Math.max(from, Math.min(n, to48));
  const perColumn = (to - from) / cols;
  if (perColumn <= 0) return { min, max };
  for (let c = 0; c < cols; c++) {
    const start = Math.floor(from + c * perColumn);
    const end = Math.max(start + 1, Math.floor(from + (c + 1) * perColumn));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end && i < n; i++) {
      const v = data[i] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/** Ruler step in frames: the smallest nice step that fits in `maxTicks` lines. */
export function pickTickStep48(span48: number, maxTicks: number): number {
  const span = Math.max(1, span48);
  const ticks = Math.max(1, Math.floor(maxTicks));
  let step = CANONICAL_RATE * TICK_SECONDS[TICK_SECONDS.length - 1]!;
  for (const seconds of TICK_SECONDS) {
    const candidate = CANONICAL_RATE * seconds;
    if (span / candidate <= ticks) {
      step = candidate;
      break;
    }
  }
  return Math.round(step);
}

/** "1:02.345" (or "1:02" for rough ruler labels). */
export function formatFrames(frames: number, withMillis = true): string {
  const safe = Math.max(0, frames);
  const totalSeconds = safe / CANONICAL_RATE;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const padded = seconds < 10 ? `0${seconds.toFixed(withMillis ? 3 : 0)}` : seconds.toFixed(withMillis ? 3 : 0);
  return `${minutes}:${padded}`;
}

/** Keeps the point at `anchor48` where it is while the zoom changes (`factor` > 1 zooms in). */
export function zoomView(view: StudioView, anchor48: number, factor: number, total48: number): StudioView {
  const total = Math.max(1, Math.round(total48));
  const minSpan = Math.min(total, 64);
  const span = Math.max(minSpan, Math.min(total, Math.round(view.span / factor)));
  const t = view.span > 0 ? Math.max(0, Math.min(1, (anchor48 - view.start) / view.span)) : 0.5;
  const start = clampStart(anchor48 - t * span, span, total);
  return { start, span };
}

/** Moves the view by `delta48` frames, staying inside the buffer. */
export function panView(view: StudioView, delta48: number, total48: number): StudioView {
  const total = Math.max(1, Math.round(total48));
  return { start: clampStart(view.start + delta48, view.span, total), span: view.span };
}

/** Shows the whole buffer. */
export function fitView(total48: number): StudioView {
  const total = Math.max(1, Math.round(total48));
  return { start: 0, span: total };
}

function clampStart(start: number, span: number, total: number): number {
  const maxStart = Math.max(0, total - Math.min(span, total));
  return Math.max(0, Math.min(maxStart, Math.round(start)));
}
