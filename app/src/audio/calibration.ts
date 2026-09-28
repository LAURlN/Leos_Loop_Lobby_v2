/** Runs the acoustic round-trip measurement on a live engine. */
import { CALIBRATION, combineTrials, findLag, makeSweep, type CalibrationResult } from './calibrationAnalysis';
import type { AudioEngine } from './engine';

export async function runAcousticCalibration(engine: AudioEngine): Promise<CalibrationResult> {
  const rate = engine.sampleRate;
  const sweep = makeSweep(rate);
  const maxLag = Math.round(CALIBRATION.maxLagSeconds * rate);
  const spacing = sweep.length + Math.round(CALIBRATION.gapSeconds * rate);
  const first = Math.ceil(engine.renderFrameNow() + rate * 0.4);
  const starts = Array.from({ length: CALIBRATION.trials }, (_, i) => first + i * spacing);

  const previousMaster = engine.master.gain.value;
  engine.master.gain.value = 0;
  const hold = engine.capture.hold(first);
  try {
    for (const at of starts) engine.playAt(sweep, at);
    const end = starts[starts.length - 1]! + maxLag + sweep.length;
    const waitMs = ((end - engine.renderFrameNow()) / rate) * 1000 + 3000;
    await engine.capture.waitUntil(end, waitMs);
    const estimates = starts.map((at) => findLag(engine.capture.read(at, at + maxLag + sweep.length), sweep, maxLag));
    return combineTrials(estimates, rate);
  } finally {
    engine.capture.release(hold);
    engine.master.gain.value = previousMaster;
  }
}
