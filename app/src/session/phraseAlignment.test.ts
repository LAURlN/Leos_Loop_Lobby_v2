import { describe, expect, it } from 'vitest';
import { CANONICAL_RATE as S, renderPosition } from '@lll/shared';
import { phraseOriginShift } from './phraseAlignment';

describe('first longer phrase alignment', () => {
  it('removes odd/even backing-cycle ambiguity without removing a late tap offset', () => {
    expect(phraseOriginShift(S, 2 * S, [S])).toBe(S);
    expect(phraseOriginShift(3 * S + 100, 2 * S, [S])).toBe(S);
    expect(phraseOriginShift(4 * S, 2 * S, [S])).toBe(0);
    expect(phraseOriginShift(S - 100, 2 * S, [S])).toBe(S);
  });

  it('uses a common period of every backing loop, preserving mixed-length phrases', () => {
    const shift = phraseOriginShift(6 * S, 12 * S, [2 * S, 3 * S]);
    expect(shift).toBe(6 * S);
    for (const rate of [44100, 48000]) {
      for (const length of [2 * S, 3 * S]) {
        expect(renderPosition(rate * 7.25, shift * rate / S, rate, length))
          .toBeCloseTo(renderPosition(rate * 7.25, 0, rate, length));
      }
    }
    expect(phraseOriginShift(S, 2 * S, [S, 2 * S])).toBe(0);
    expect(phraseOriginShift(S, 2 * S, [S, 3 * S])).toBe(0);
    expect(phraseOriginShift(S, 2 * S + 1, [S])).toBe(0);
  });

  it('does not choose an arbitrary origin without a valid backing period', () => {
    expect(phraseOriginShift(S, 2 * S, [])).toBe(0);
    expect(phraseOriginShift(S, 2 * S, [NaN])).toBe(0);
    expect(phraseOriginShift(Infinity, 2 * S, [S])).toBe(0);
    expect(phraseOriginShift(S, 2 * S, [0])).toBe(0);
  });
});
