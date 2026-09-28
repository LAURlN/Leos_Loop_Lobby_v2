/**
 * Compact loudness envelope of a loop for waveform views (song timeline):
 * `bins` peak values (max |sample|) around the loop, normalised to 0..1.
 */
export function computePeaks(loop: Float32Array, bins = 512): Float32Array {
  const out = new Float32Array(bins);
  const n = loop.length;
  if (n === 0) return out;
  let max = 1e-6;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor((b * n) / bins);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / bins));
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(loop[i] ?? 0);
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  // Normalise per loop but keep quiet loops visibly quieter than loud ones.
  const scale = 1 / Math.max(max, 0.25);
  for (let b = 0; b < bins; b++) out[b] = Math.min(1, out[b]! * scale);
  return out;
}
