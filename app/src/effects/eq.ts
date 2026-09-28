import { decibel, smooth, type EffectDefinition } from './types';

export const eq: EffectDefinition = {
  type: 'eq',
  label: 'EQ',
  sticker: 'EQ',
  color: '#e583ff',
  description: 'Three-band equalizer: lows up to 250 Hz, mids, highs from 3 kHz.',
  params: [
    { id: 'low', label: 'Low', min: -12, max: 12, default: 0, step: 0.5, format: decibel },
    { id: 'mid', label: 'Mid', min: -12, max: 12, default: 0, step: 0.5, format: decibel },
    { id: 'high', label: 'High', min: -12, max: 12, default: 0, step: 0.5, format: decibel },
  ],
  presets: [
    { name: 'Flat', values: { low: 0, mid: 0, high: 0 } },
    { name: 'Bass boost', values: { low: 6, mid: 0, high: -1 } },
    { name: 'Vocal clear', values: { low: -4, mid: 2, high: 4 } },
    { name: 'Warm', values: { low: 3, mid: 1, high: -4 } },
    { name: 'Telephone', values: { low: -12, mid: 6, high: -12 } },
  ],
  create(ctx, params) {
    const low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 });
    const mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.8 });
    const high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3000 });
    low.connect(mid).connect(high);
    const bands: Record<string, BiquadFilterNode> = { low, mid, high };
    const set = (id: string, value: number) => {
      const band = bands[id];
      if (band) smooth(band.gain, value, ctx);
    };
    for (const [id, v] of Object.entries(params)) bands[id]?.gain.setValueAtTime(v, ctx.currentTime);
    return {
      input: low,
      output: high,
      set,
      dispose: () => [low, mid, high].forEach((n) => n.disconnect()),
    };
  },
};
