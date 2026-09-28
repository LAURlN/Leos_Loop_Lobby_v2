import { describe, expect, it } from 'vitest';
import {
  CANONICAL_RATE,
  autoSnapLength,
  capturePosition,
  describeLength,
  foldTake,
  mixLayerInto,
  mod,
  parseLengthInput,
  predefinedLength,
  renderPosition,
} from './timing';

describe('mod', () => {
  it('is always positive', () => {
    expect(mod(-1, 10)).toBe(9);
    expect(mod(10, 10)).toBe(0);
    expect(mod(-0.5, 4)).toBeCloseTo(3.5);
  });
});

describe('the timing law (no clock sync)', () => {
  // A device hears render frame f; a player playing exactly along is captured
  // at mic frame f + roundTrip. The capture position must equal what they heard.
  const cases = [
    { name: '48k device', rate: 48000, origin: 0, roundTrip: 960 },
    { name: '44.1k device with odd origin', rate: 44100, origin: 123457.25, roundTrip: 5000 },
    { name: 'huge frame counters', rate: 48000, origin: 9e9, roundTrip: 1234 },
  ];
  const length48 = CANONICAL_RATE * 2;

  for (const c of cases) {
    it(`capture lands where the player heard it (${c.name})`, () => {
      for (const heardFrame of [c.origin, c.origin + 777, c.origin + 5 * c.rate + 3]) {
        const heard = renderPosition(heardFrame, c.origin, c.rate, length48);
        const captured = capturePosition(heardFrame + c.roundTrip, c.roundTrip, c.origin, c.rate, length48);
        expect(captured).toBeCloseTo(heard, 6);
      }
    });
  }

  it('two devices with different origins agree on every layer position', () => {
    // Device A records a hit at loop position 1000. Device B (different origin
    // and sample rate) overdubs exactly along with what it hears. B's layer
    // must be stored at position 1000 as well, so A hears both in sync.
    const hitPosition = 1000;
    const bRate = 44100;
    const bOrigin = 987654;
    const bRoundTrip = 3000;
    // Find a local frame on B where the hit is rendered.
    const frameOnB = bOrigin + (hitPosition * bRate) / CANONICAL_RATE + 3 * (length48 * bRate) / CANONICAL_RATE;
    expect(renderPosition(frameOnB, bOrigin, bRate, length48)).toBeCloseTo(hitPosition, 6);
    const storedByB = capturePosition(frameOnB + bRoundTrip, bRoundTrip, bOrigin, bRate, length48);
    expect(storedByB).toBeCloseTo(hitPosition, 6);
  });
});

describe('foldTake / mixLayerInto', () => {
  it('keeps short takes as-is and wraps on mix', () => {
    const layer = foldTake(new Float32Array([1, 2, 3]), 9, 10);
    expect(layer.offset).toBe(9);
    const out = new Float32Array(10);
    mixLayerInto(out, layer);
    expect(Array.from(out)).toEqual([2, 3, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('sums takes longer than one cycle like overdub passes', () => {
    const layer = foldTake(new Float32Array([1, 1, 1, 1, 1]), 0, 3);
    expect(Array.from(layer.data)).toEqual([2, 2, 1]);
  });

  it('applies gain', () => {
    const out = new Float32Array(2);
    mixLayerInto(out, { offset: 0, data: new Float32Array([1, 1]) }, 0.5);
    expect(Array.from(out)).toEqual([0.5, 0.5]);
  });
});

describe('lengths', () => {
  const ref = CANONICAL_RATE * 2; // 2 s reference

  it('auto-snaps to related lengths', () => {
    expect(autoSnapLength(ref * 2 + 3000, ref)).toBe(ref * 2);
    expect(autoSnapLength(ref / 2 - 2000, ref)).toBe(ref / 2);
    expect(autoSnapLength(ref * 3 + 1000, ref)).toBe(ref * 3);
  });

  it('resolves predefined lengths', () => {
    expect(predefinedLength({ kind: 'ratio', num: 3, den: 2 }, ref)).toBe(ref * 1.5);
    expect(predefinedLength({ kind: 'ratio', num: 1, den: 1 }, null)).toBeNull();
    expect(predefinedLength({ kind: 'seconds', seconds: 2.5 }, null)).toBe(CANONICAL_RATE * 2.5);
    expect(predefinedLength({ kind: 'free', autoSnap: true }, ref)).toBeNull();
  });

  it('parses user input', () => {
    expect(parseLengthInput('3/2')).toEqual({ kind: 'ratio', num: 3, den: 2 });
    expect(parseLengthInput('2.5 s')).toEqual({ kind: 'seconds', seconds: 2.5 });
    expect(parseLengthInput('2,5s')).toEqual({ kind: 'seconds', seconds: 2.5 });
    expect(parseLengthInput('4x')).toEqual({ kind: 'ratio', num: 4, den: 1 });
    expect(parseLengthInput('nope')).toBeNull();
    expect(parseLengthInput('0/2')).toBeNull();
  });

  it('describes lengths', () => {
    expect(describeLength(ref * 2, ref)).toBe('2×');
    expect(describeLength(ref / 2, ref)).toBe('½×');
    expect(describeLength(CANONICAL_RATE * 1.5, null)).toBe('1.50 s');
  });
});
