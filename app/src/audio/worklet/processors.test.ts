import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackPlayerMessage } from '../messages';

interface Player {
  port: { onmessage: (event: { data: TrackPlayerMessage }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

let createPlayer: () => Player;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null }; });
  vi.stubGlobal('registerProcessor', (name: string, processor: new () => Player) => {
    if (name === 'lll-track-player') createPlayer = () => new processor();
  });
  await import('./processors');
});

afterEach(() => vi.unstubAllGlobals());

function render(player: Player, frame: number, length: number): Float32Array {
  vi.stubGlobal('currentFrame', frame);
  const out = new Float32Array(length);
  player.process([], [[out]]);
  return out;
}

describe('song section play windows', () => {
  it('joins a sustained recording with no fade dip and no samples outside either section', () => {
    const first = createPlayer();
    const second = createPlayer();
    for (const player of [first, second]) {
      player.port.onmessage({ data: { type: 'buffer', data: new Float32Array(1000).fill(0.5) } });
    }
    first.port.onmessage({ data: { type: 'transport', origin: 0, start: 0, end: 1000, fadeEdges: false } });
    second.port.onmessage({ data: { type: 'transport', origin: 1000, start: 1000, end: 2000, fadeEdges: false } });
    const a = render(first, 960, 128);
    const b = render(second, 960, 128);
    expect(Array.from(a, (sample, i) => sample + b[i]!)).toEqual(new Array(128).fill(0.5));
    expect(a.slice(40).every((n) => n === 0)).toBe(true);
    expect(b.slice(0, 40).every((n) => n === 0)).toBe(true);
    expect(render(second, 2000, 128).every((n) => n === 0)).toBe(true);
  });

  it('retains default fades for existing loops and resets the option on a new transport', () => {
    const player = createPlayer();
    player.port.onmessage({ data: { type: 'buffer', data: new Float32Array(1000).fill(1) } });
    player.port.onmessage({ data: { type: 'transport', origin: 0, start: 0, end: 1000, fadeEdges: false } });
    expect(render(player, 0, 1)[0]).toBe(1);
    player.port.onmessage({ data: { type: 'transport', origin: 0, start: 0, end: 1000 } });
    expect(render(player, 0, 1)[0]).toBe(0);
    expect(render(player, 120, 1)[0]).toBeCloseTo(0.5);
    player.port.onmessage({ data: { type: 'transport', origin: 0 } });
    expect(render(player, 0, 1)[0]).toBe(1);
  });
});
