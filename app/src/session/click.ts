/**
 * Metronome tracks: a track whose loop is a click pattern (tempo + rhythm)
 * instead of recorded takes. Only the pattern is shared; every device renders
 * the same clicks locally, so no audio travels over the network. The loop is
 * one bar long and plays through the normal track chain (volume, pan, mute,
 * solo, effects), in sections and in the full song.
 */
import { CANONICAL_RATE, clampLength } from '@lll/shared';

export interface ClickPattern {
  /** Beats per minute, counting the beat unit (quarter or eighth notes). */
  bpm: number;
  /** Beats per bar (the loop is one bar). */
  beats: number;
  /** Note value of one beat: 4 = quarter, 8 = eighth (6/8, 7/8 …). */
  unit: 4 | 8;
  /** Clicks per beat: 1 = beats only, 2 = eighths, 3 = triplets, 4 = sixteenths. */
  subdivision: 1 | 2 | 3 | 4;
}

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MAX_BEATS = 16;
export const DEFAULT_CLICK: ClickPattern = { bpm: 120, beats: 4, unit: 4, subdivision: 1 };

export const TIME_SIGNATURES: ReadonlyArray<{ beats: number; unit: 4 | 8 }> = [
  { beats: 2, unit: 4 },
  { beats: 3, unit: 4 },
  { beats: 4, unit: 4 },
  { beats: 5, unit: 4 },
  { beats: 6, unit: 4 },
  { beats: 7, unit: 4 },
  { beats: 5, unit: 8 },
  { beats: 6, unit: 8 },
  { beats: 7, unit: 8 },
  { beats: 9, unit: 8 },
  { beats: 12, unit: 8 },
];

export const SUBDIVISIONS: ReadonlyArray<{ value: ClickPattern['subdivision']; label: string }> = [
  { value: 1, label: 'Beats' },
  { value: 2, label: 'Eighths' },
  { value: 3, label: 'Triplets' },
  { value: 4, label: 'Sixteenths' },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Validates and clamps a (possibly partial or foreign) pattern. */
export function normalizeClick(raw: Partial<ClickPattern> | Record<string, unknown>): ClickPattern {
  const r = raw as Record<string, unknown>;
  const sub = Math.round(finite(r.subdivision, 1));
  return {
    // Not rounded: a tempo matched to an existing loop must reproduce its length exactly.
    bpm: clamp(finite(r.bpm, DEFAULT_CLICK.bpm), MIN_BPM, MAX_BPM),
    beats: clamp(Math.round(finite(r.beats, DEFAULT_CLICK.beats)), 1, MAX_BEATS),
    unit: r.unit === 8 ? 8 : 4,
    subdivision: (clamp(sub, 1, 4) as ClickPattern['subdivision']),
  };
}

/** Reads a stored pattern; anything that is not an object means "no metronome track". */
export function readClick(v: unknown): ClickPattern | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return normalizeClick(v as Record<string, unknown>);
}

/** Loop length (canonical frames) of one bar. */
export function clickLength48(p: ClickPattern): number {
  return clampLength(Math.round((p.beats * 60 * CANONICAL_RATE) / p.bpm));
}

/** The tempo at which `beats` beats fill `length48` exactly. */
export function bpmForLength(length48: number, beats: number): number {
  return clamp((beats * 60 * CANONICAL_RATE) / length48, MIN_BPM, MAX_BPM);
}

export const formatBpm = (bpm: number) => (Math.abs(bpm - Math.round(bpm)) < 0.05 ? String(Math.round(bpm)) : bpm.toFixed(1));

export function describeClick(p: ClickPattern): string {
  const sub = p.subdivision === 1 ? '' : ` · ${SUBDIVISIONS.find((s) => s.value === p.subdivision)?.label.toLowerCase()}`;
  return `${formatBpm(p.bpm)} BPM · ${p.beats}/${p.unit}${sub}`;
}

/**
 * How strongly a beat is accented: 2 = first beat of the bar, 1 = start of a
 * group in compound meters (6/8, 9/8, 12/8 count in threes), 0 = plain beat.
 */
export function beatAccent(p: ClickPattern, beat: number): 0 | 1 | 2 {
  if (beat === 0) return 2;
  if (p.unit === 8 && p.beats % 3 === 0 && beat % 3 === 0) return 1;
  return 0;
}

const CLICK_SECONDS = 0.025;
const VOICES = [
  { freq: 880, gain: 0.3 }, // subdivision
  { freq: 1175, gain: 0.6 }, // beat
  { freq: 1480, gain: 0.75 }, // group accent
  { freq: 1760, gain: 0.9 }, // bar
];

/** Renders one bar of clicks at the canonical rate. */
export function renderClick(p: ClickPattern, length48 = clickLength48(p)): Float32Array {
  const out = new Float32Array(length48);
  const ticks = p.beats * p.subdivision;
  const tickLength = length48 / ticks;
  const clickFrames = Math.min(Math.round(CANONICAL_RATE * CLICK_SECONDS), Math.floor(tickLength));
  for (let tick = 0; tick < ticks; tick++) {
    const onBeat = tick % p.subdivision === 0;
    const voice = VOICES[onBeat ? 1 + beatAccent(p, tick / p.subdivision) : 0]!;
    const start = Math.round(tick * tickLength);
    for (let i = 0; i < clickFrames; i++) {
      const env = 1 - i / clickFrames;
      out[(start + i) % length48] = Math.sin((2 * Math.PI * voice.freq * i) / CANONICAL_RATE) * env * env * voice.gain;
    }
  }
  return out;
}
