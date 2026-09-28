import { millis, percent, smooth, type EffectDefinition } from './types';

export const delay: EffectDefinition = {
  type: 'delay',
  label: 'Delay',
  sticker: 'DL',
  color: '#5bdae8',
  description: 'Echo with feedback and darkening repeats.',
  params: [
    { id: 'time', label: 'Time', min: 10, max: 2000, default: 320, step: 1, format: millis },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.45, step: 0.01, format: percent },
    { id: 'wet', label: 'Mix', min: 0, max: 1, default: 0.35, step: 0.01, format: percent },
    { id: 'damping', label: 'Damping', min: 0, max: 1, default: 0.25, step: 0.01, format: percent },
  ],
  create(ctx, params) {
    const input = new GainNode(ctx);
    const output = new GainNode(ctx);
    const dry = new GainNode(ctx);
    const wet = new GainNode(ctx);
    const line = new DelayNode(ctx, { maxDelayTime: 2.1 });
    const feedback = new GainNode(ctx);
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5 });
    input.connect(dry).connect(output);
    input.connect(line);
    line.connect(tone).connect(feedback).connect(line);
    tone.connect(wet).connect(output);

    const set = (id: string, v: number) => {
      if (id === 'time') smooth(line.delayTime, v / 1000, ctx, 0.05);
      else if (id === 'feedback') smooth(feedback.gain, v, ctx);
      else if (id === 'wet') {
        smooth(wet.gain, v, ctx);
        smooth(dry.gain, 1 - v * 0.5, ctx);
      } else if (id === 'damping') smooth(tone.frequency, 800 + 17200 * (1 - v) ** 2, ctx);
    };
    for (const [id, v] of Object.entries(params)) set(id, v);
    return {
      input,
      output,
      set,
      dispose: () => [input, output, dry, wet, line, feedback, tone].forEach((n) => n.disconnect()),
    };
  },
};
