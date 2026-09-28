import { millis, percent, smooth, type EffectDefinition } from './types';

/**
 * Algorithmic-looking reverb built from a generated impulse response
 * (decaying stereo noise with frequency-dependent damping) and a ConvolverNode.
 */
export const reverb: EffectDefinition = {
  type: 'reverb',
  label: 'Reverb',
  sticker: 'RV',
  color: '#ffae5c',
  description: 'Room and hall reverb.',
  params: [
    { id: 'wet', label: 'Mix', min: 0, max: 1, default: 0.3, step: 0.01, format: percent },
    { id: 'decay', label: 'Size / decay', min: 0, max: 1, default: 0.5, step: 0.01, format: (v) => `${decaySeconds(v).toFixed(1)} s` },
    { id: 'damping', label: 'Damping', min: 0, max: 1, default: 0.5, step: 0.01, format: percent },
    { id: 'preDelay', label: 'Pre-delay', min: 0, max: 200, default: 20, step: 1, format: millis },
    { id: 'width', label: 'Stereo width', min: 0, max: 1, default: 1, step: 0.01, format: percent },
  ],
  presets: [
    { name: 'Vocal plate', values: { wet: 0.28, decay: 0.45, damping: 0.35, preDelay: 12, width: 0.9 } },
    { name: 'Tight booth', values: { wet: 0.18, decay: 0.12, damping: 0.6, preDelay: 2, width: 0.5 } },
    { name: 'Warm room', values: { wet: 0.25, decay: 0.3, damping: 0.75, preDelay: 8, width: 0.8 } },
    { name: 'Concert hall', values: { wet: 0.35, decay: 0.7, damping: 0.45, preDelay: 35, width: 1 } },
    { name: 'Cathedral', values: { wet: 0.45, decay: 0.95, damping: 0.4, preDelay: 60, width: 1 } },
    { name: 'Ambient space', values: { wet: 0.6, decay: 1, damping: 0.25, preDelay: 90, width: 1 } },
  ],
  create(ctx, params) {
    const input = new GainNode(ctx);
    const output = new GainNode(ctx);
    const dry = new GainNode(ctx);
    const wet = new GainNode(ctx);
    const preDelay = new DelayNode(ctx, { maxDelayTime: 0.25 });
    const convolver = new ConvolverNode(ctx, { disableNormalization: false });
    input.connect(dry).connect(output);
    input.connect(preDelay).connect(convolver).connect(wet).connect(output);

    const current = { ...params };
    let rebuild: ReturnType<typeof setTimeout> | undefined;
    const buildImpulse = () => {
      convolver.buffer = makeImpulse(ctx, current.decay ?? 0.5, current.damping ?? 0.5, current.width ?? 1);
    };
    const applyMix = () => {
      const w = current.wet ?? 0.3;
      // Equal-power crossfade keeps loudness roughly constant.
      smooth(wet.gain, Math.sin((w * Math.PI) / 2), ctx);
      smooth(dry.gain, Math.cos((w * Math.PI) / 2), ctx);
    };
    buildImpulse();
    applyMix();
    preDelay.delayTime.value = (current.preDelay ?? 20) / 1000;

    return {
      input,
      output,
      set(id, value) {
        current[id] = value;
        if (id === 'wet') applyMix();
        else if (id === 'preDelay') smooth(preDelay.delayTime, value / 1000, ctx);
        else {
          clearTimeout(rebuild);
          rebuild = setTimeout(buildImpulse, 120);
        }
      },
      dispose() {
        clearTimeout(rebuild);
        [input, output, dry, wet, preDelay, convolver].forEach((n) => n.disconnect());
      },
    };
  },
};

function decaySeconds(decay: number): number {
  return 0.3 + decay * decay * 6;
}

function makeImpulse(ctx: BaseAudioContext, decay: number, damping: number, width: number): AudioBuffer {
  const seconds = decaySeconds(decay);
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const envelope = Math.pow(1 - t, 2.2 + decay) * Math.exp(-3 * t);
    // Damping: the one-pole low-pass closes over time, so tails get darker.
    const coefficient = Math.min(0.98, 0.05 + damping * 0.9 * t + damping * 0.2);
    const nL = Math.random() * 2 - 1;
    const nR = Math.random() * 2 - 1;
    lpL += (nL - lpL) * (1 - coefficient);
    lpR += (nR - lpR) * (1 - coefficient);
    const mid = (lpL + lpR) / 2;
    left[i] = (mid + (lpL - mid) * width) * envelope;
    right[i] = (mid + (lpR - mid) * width) * envelope;
  }
  return buffer;
}
