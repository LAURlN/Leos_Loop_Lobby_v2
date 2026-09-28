/**
 * Compact spectrogram of a loop for the track disc (ported from v1):
 * `timeBins` windows around the loop, `freqBins` log-spaced bands (30 Hz - 8 kHz),
 * log-compressed and normalised to 0..1. Output is row-major [time][freq].
 */
import { CANONICAL_RATE } from '@lll/shared';

export interface Spectrogram {
  timeBins: number;
  freqBins: number;
  data: Float32Array;
}

const WINDOW = 256;
const hann = Float32Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
const tableCache = new Map<number, { cos: Float32Array; sin: Float32Array }>();

function tables(freqBins: number) {
  let t = tableCache.get(freqBins);
  if (t) return t;
  const cos = new Float32Array(freqBins * WINDOW);
  const sin = new Float32Array(freqBins * WINDOW);
  const fMin = 30;
  const fMax = 8000;
  for (let b = 0; b < freqBins; b++) {
    const f = fMin * Math.pow(fMax / fMin, b / Math.max(1, freqBins - 1));
    const w = (2 * Math.PI * f) / CANONICAL_RATE;
    for (let s = 0; s < WINDOW; s++) {
      cos[b * WINDOW + s] = Math.cos(w * s);
      sin[b * WINDOW + s] = Math.sin(w * s);
    }
  }
  t = { cos, sin };
  tableCache.set(freqBins, t);
  return t;
}

export function computeSpectrogram(loop: Float32Array, timeBins = 96, freqBins = 20): Spectrogram {
  const data = new Float32Array(timeBins * freqBins);
  const n = loop.length;
  if (n === 0) return { timeBins, freqBins, data };
  const { cos, sin } = tables(freqBins);
  const windowed = new Float32Array(WINDOW);
  let max = 1e-6;
  for (let t = 0; t < timeBins; t++) {
    const center = Math.floor((t * n) / timeBins);
    for (let s = 0; s < WINDOW; s++) {
      let pos = (center + s - WINDOW / 2) % n;
      if (pos < 0) pos += n;
      windowed[s] = (loop[pos] ?? 0) * hann[s]!;
    }
    for (let b = 0; b < freqBins; b++) {
      let re = 0;
      let im = 0;
      const base = b * WINDOW;
      for (let s = 0; s < WINDOW; s++) {
        const v = windowed[s]!;
        re += v * cos[base + s]!;
        im -= v * sin[base + s]!;
      }
      const mag = Math.sqrt(re * re + im * im) / WINDOW;
      data[t * freqBins + b] = mag;
      if (mag > max) max = mag;
    }
  }
  const norm = 1 / Math.log1p(max * 40);
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, Math.log1p(data[i]! * 40) * norm);
  return { timeBins, freqBins, data };
}
