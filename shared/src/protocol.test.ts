import { describe, expect, it } from 'vitest';
import {
  decodeIncoming,
  decodeOutgoing,
  encodeIncoming,
  encodeOutgoing,
  isValidRoomCode,
  normalizeRoomCode,
  randomRoomCode,
  sanitizePlayerName,
} from './protocol';

describe('relay framing', () => {
  it('round-trips addressed payloads', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const out = decodeOutgoing(encodeOutgoing('peer42abc', payload));
    expect(out?.to).toBe('peer42abc');
    expect(Array.from(out?.payload ?? [])).toEqual([1, 2, 3, 250]);

    const inc = decodeIncoming(encodeIncoming('', payload));
    expect(inc?.from).toBe('');
    expect(inc?.payload.length).toBe(4);
  });

  it('rejects garbage', () => {
    expect(decodeIncoming(new Uint8Array([99, 0]))).toBeNull();
    expect(decodeIncoming(new Uint8Array([1, 10, 1]))).toBeNull();
  });
});

describe('room codes', () => {
  it('generates valid codes', () => {
    for (let i = 0; i < 50; i++) expect(isValidRoomCode(randomRoomCode())).toBe(true);
  });
  it('normalizes input', () => {
    expect(normalizeRoomCode(' jam-42 ')).toBe('JAM42');
    expect(isValidRoomCode('JAM42')).toBe(true);
    expect(isValidRoomCode('JAM0O')).toBe(false);
  });
  it('sanitizes names', () => {
    expect(sanitizePlayerName('  ')).toBe('Player');
    expect(sanitizePlayerName('Leo\n')).toBe('Leo');
  });
});
