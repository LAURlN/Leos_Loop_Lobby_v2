import { describe, expect, it } from 'vitest';
import { mixLayerInto } from '@lll/shared';
import { LoopMixer, type MixLayer } from './loopMix';

const layer = (id: string, offset: number, gain = 1, length = 5): MixLayer => ({
  id,
  offset,
  gain,
  data: Float32Array.from({ length }, (_, i) => (i + 1) * (id.charCodeAt(0) % 7)),
});

function fullMix(length: number, layers: MixLayer[]): Float32Array {
  const out = new Float32Array(length);
  for (const l of layers) mixLayerInto(out, l, l.gain);
  return out;
}

describe('LoopMixer', () => {
  it('matches a full remix when takes are added one by one', () => {
    const mixer = new LoopMixer();
    const layers = [layer('a', 0), layer('b', 3), layer('c', 7, 0.5)];
    for (let n = 1; n <= layers.length; n++) {
      expect(Array.from(mixer.mix('t', 8, layers.slice(0, n)))).toEqual(Array.from(fullMix(8, layers.slice(0, n))));
    }
  });

  it('remixes from scratch after undo, gain or length changes', () => {
    const mixer = new LoopMixer();
    const a = layer('a', 0);
    const b = layer('b', 2);
    mixer.mix('t', 8, [a, b]);
    expect(Array.from(mixer.mix('t', 8, [a]))).toEqual(Array.from(fullMix(8, [a])));
    const quieter = { ...a, gain: 0.25 };
    expect(Array.from(mixer.mix('t', 8, [quieter]))).toEqual(Array.from(fullMix(8, [quieter])));
    expect(Array.from(mixer.mix('t', 6, [quieter]))).toEqual(Array.from(fullMix(6, [quieter])));
  });

  it('returns buffers the caller owns', () => {
    const mixer = new LoopMixer();
    const first = mixer.mix('t', 8, [layer('a', 0)]);
    first.fill(99);
    expect(Array.from(mixer.mix('t', 8, [layer('a', 0), layer('b', 1)]))).toEqual(
      Array.from(fullMix(8, [layer('a', 0), layer('b', 1)])),
    );
  });
});
