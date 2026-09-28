import { percent, smooth, type EffectDefinition } from './types';

export const overdrive: EffectDefinition = {
  type: 'overdrive',
  label: 'Overdrive',
  sticker: 'OD',
  color: '#ff7089',
  description: 'Warm tube-style saturation with tone control.',
  params: [
    { id: 'drive', label: 'Drive', min: 0, max: 1, default: 0.4, step: 0.01, format: percent },
    { id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.5, step: 0.01, format: percent },
    { id: 'level', label: 'Level', min: 0, max: 2, default: 0.8, step: 0.01, format: percent },
  ],
  create(ctx, params) {
    const shaper = new WaveShaperNode(ctx, { oversample: '4x' });
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.7 });
    const level = new GainNode(ctx);
    shaper.connect(tone).connect(level);

    const set = (id: string, v: number) => {
      if (id === 'drive') shaper.curve = driveCurve(v);
      else if (id === 'tone') smooth(tone.frequency, 800 * Math.pow(15, v), ctx);
      else if (id === 'level') smooth(level.gain, v, ctx);
    };
    for (const [id, v] of Object.entries(params)) set(id, v);
    return {
      input: shaper,
      output: level,
      set,
      dispose: () => [shaper, tone, level].forEach((n) => n.disconnect()),
    };
  },
};

function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1 + drive * 40;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}
