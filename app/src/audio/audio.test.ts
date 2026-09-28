import { describe, expect, it } from 'vitest';
import { CALIBRATION, combineTrials, findLag, makeSweep } from './calibrationAnalysis';
import { crossCorrelate } from './fft';
import { MicCapture } from './micCapture';

describe('crossCorrelate', () => {
  it('finds a delayed copy', () => {
    const y = new Float32Array([1, -2, 3, 0.5]);
    const x = new Float32Array(20);
    x.set(y, 7);
    const r = crossCorrelate(x, y, 15);
    let best = 0;
    for (let i = 0; i < r.length; i++) if (r[i]! > r[best]!) best = i;
    expect(best).toBe(7);
  });
});

describe('acoustic calibration analysis', () => {
  const rate = 48000;
  const sweep = makeSweep(rate);

  function captureWithDelay(delayFrames: number, gain: number, noise: number) {
    const maxLag = Math.round(CALIBRATION.maxLagSeconds * rate);
    const captured = new Float32Array(maxLag + sweep.length);
    for (let i = 0; i < captured.length; i++) captured[i] = (Math.random() * 2 - 1) * noise;
    for (let i = 0; i < sweep.length; i++) captured[delayFrames + i]! += sweep[i]! * gain;
    return { captured, maxLag };
  }

  it('measures the round trip through a quiet, noisy channel', () => {
    const delay = 4321;
    const estimates = [0, 1, 2, 3].map(() => {
      const { captured, maxLag } = captureWithDelay(delay, 0.05, 0.02);
      return findLag(captured, sweep, maxLag);
    });
    const result = combineTrials(estimates, rate);
    expect(result.ok).toBe(true);
    expect(Math.abs(result.roundTripMs - (delay * 1000) / rate)).toBeLessThan(0.1);
  });

  it('fails without signal', () => {
    const estimates = [0, 1, 2].map(() => {
      const { captured, maxLag } = captureWithDelay(1000, 0, 0.02);
      return findLag(captured, sweep, maxLag);
    });
    expect(combineTrials(estimates, rate).ok).toBe(false);
  });

  it('rejects inconsistent trials', () => {
    const result = combineTrials(
      [
        { lag: 1000, peakRatio: 50 },
        { lag: 3000, peakRatio: 50 },
        { lag: 6000, peakRatio: 50 },
      ],
      rate,
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unstable');
  });
});

describe('MicCapture', () => {
  it('reads ranges across chunks and pads missing audio with silence', () => {
    const cap = new MicCapture(10);
    cap.push({ frame: 100, data: new Float32Array([1, 2, 3, 4]) });
    cap.push({ frame: 104, data: new Float32Array([5, 6, 7, 8]) });
    expect(Array.from(cap.read(102, 106))).toEqual([3, 4, 5, 6]);
    expect(Array.from(cap.read(98, 101))).toEqual([0, 0, 1]);
  });

  it('keeps held audio and drops the rest', () => {
    const cap = new MicCapture(4);
    const hold = cap.hold(0);
    for (let f = 0; f < 40; f += 4) cap.push({ frame: f, data: new Float32Array(4).fill(f) });
    expect(cap.read(0, 1)[0]).toBe(0);
    cap.release(hold);
    expect(cap.read(0, 1)[0]).toBe(0); // dropped -> silence
    expect(cap.read(36, 37)[0]).toBe(36);
  });

  it('waits for future audio', async () => {
    const cap = new MicCapture(100);
    const p = cap.waitUntil(8);
    cap.push({ frame: 0, data: new Float32Array(8) });
    await expect(p).resolves.toBeUndefined();
  });
});
