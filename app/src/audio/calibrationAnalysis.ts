/**
 * Pure analysis for the acoustic round-trip calibration (ported idea from v1):
 * play a few short sweeps through the speaker, record them with the mic, find
 * each sweep's delay by cross-correlation and accept the result only if the
 * trials agree closely.
 */
import { crossCorrelate } from './fft';

export const CALIBRATION = {
  trials: 4,
  sweepSeconds: 0.16,
  gapSeconds: 0.9,
  maxLagSeconds: 0.8,
  f0: 500,
  f1: 6000,
  /** Accept if accepted trials differ by at most this much. */
  maxSpreadMs: 3,
  /** Correlation peak must stand out this much from the background. */
  minPeakRatio: 6,
} as const;

/** Logarithmic sine sweep with short fades. */
export function makeSweep(sampleRate: number, seconds = CALIBRATION.sweepSeconds): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  const { f0, f1 } = CALIBRATION;
  const k = Math.log(f1 / f0);
  const fade = Math.round(sampleRate * 0.005);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = ((2 * Math.PI * f0 * seconds) / k) * (Math.exp((t / seconds) * k) - 1);
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = Math.sin(phase) * env * 0.8;
  }
  return out;
}

export interface LagEstimate {
  lag: number;
  /** Peak magnitude relative to the median background. */
  peakRatio: number;
}

/** Finds where `reference` occurs in `captured` (lag in frames from captured[0]). */
export function findLag(captured: Float32Array, reference: Float32Array, maxLag: number): LagEstimate {
  const corr = crossCorrelate(captured, reference, maxLag);
  let best = 0;
  let bestValue = -Infinity;
  const mags = new Float64Array(corr.length);
  for (let i = 0; i < corr.length; i++) {
    const v = Math.abs(corr[i] ?? 0);
    mags[i] = v;
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  const sorted = Array.from(mags).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return { lag: best, peakRatio: median > 0 ? bestValue / median : bestValue > 0 ? Infinity : 0 };
}

export type CalibrationFailure = 'no-signal' | 'unstable';

export interface CalibrationResult {
  ok: boolean;
  roundTripMs: number;
  spreadMs: number;
  acceptedTrials: number;
  failure?: CalibrationFailure;
}

/** Combines per-trial lags (frames) into a result. */
export function combineTrials(estimates: LagEstimate[], sampleRate: number): CalibrationResult {
  const accepted = estimates.filter((e) => e.peakRatio >= CALIBRATION.minPeakRatio).map((e) => e.lag);
  if (accepted.length < 2) {
    return { ok: false, roundTripMs: 0, spreadMs: 0, acceptedTrials: accepted.length, failure: 'no-signal' };
  }
  accepted.sort((a, b) => a - b);
  const median = accepted[Math.floor(accepted.length / 2)] ?? 0;
  // Drop one outlier if we have enough trials.
  const close = accepted.filter((l) => Math.abs(l - median) * 1000 / sampleRate <= CALIBRATION.maxSpreadMs);
  const spreadMs = close.length ? ((close[close.length - 1]! - close[0]!) * 1000) / sampleRate : Infinity;
  const ok = close.length >= Math.max(2, accepted.length - 1) && spreadMs <= CALIBRATION.maxSpreadMs;
  return {
    ok,
    roundTripMs: (median * 1000) / sampleRate,
    spreadMs,
    acceptedTrials: close.length,
    failure: ok ? undefined : 'unstable',
  };
}
