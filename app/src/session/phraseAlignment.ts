/**
 * Before a longer loop exists, repeated backing cycles have no first/second
 * identity. Choose the cycle nearest the first take's start as phrase zero,
 * but only by whole periods of EVERY backing loop, preserving their phase.
 */
import { mod } from '@lll/shared';

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function phraseOriginShift(start48: number, length48: number, backingLengths: number[]): number {
  if (!Number.isFinite(start48) || !Number.isSafeInteger(length48) || length48 <= 0 || backingLengths.length === 0) return 0;
  let period = 1;
  for (const length of backingLengths) {
    if (!Number.isSafeInteger(length) || length <= 0) return 0;
    period = (period / gcd(period, length)) * length;
    // No choice of backing cycle remains if a full phrase already exists.
    if (!Number.isSafeInteger(period) || period >= length48) return 0;
  }
  if (length48 % period !== 0) return 0;
  // Nearest, not previous, downbeat: a tap just before a boundary is a pickup.
  return mod(Math.round(start48 / period) * period, length48);
}
