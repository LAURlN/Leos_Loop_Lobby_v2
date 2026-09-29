import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE as S, capturePosition, mixLayerInto, renderPosition } from '@lll/shared';
import { MicCapture } from '../audio/micCapture';
import { addLayer, createTrack, initSession } from './actions';
import { LayerAudioStore } from './layerAudio';
import { Looper } from './looper';
import { readSnapshot } from './schema';
import { songPlan } from './song';

function fixture(rate: number, cycle: number, autoSnap = true, existingLongLoop = false) {
  const doc = new Y.Doc();
  initSession(doc);
  const sectionId = readSnapshot(doc).sections[0]!.id;
  const base = createTrack(doc, { sectionId, createdBy: 'u', lengthSpec: { kind: 'seconds', seconds: existingLongLoop ? 2 : 1 } });
  addLayer(doc, { id: 'base', trackId: base, author: 'u', authorName: 'Leo', offset: 0, frames: 100, length48: (existingLongLoop ? 2 : 1) * S });
  const trackId = createTrack(doc, { sectionId, createdBy: 'u', lengthSpec: { kind: 'free', autoSnap } });
  const capture = new MicCapture(rate * 3);
  const store = new LayerAudioStore();
  const engine = {
    capture, sampleRate: rate, transportOrigin: 0 as number | null,
    heardFrameAt: (at = 0) => at,
    setTransportOrigin(origin: number | null) { this.transportOrigin = origin; },
  };
  const notify = vi.fn();
  let activeSectionId: string | null = sectionId;
  const looper = new Looper({
    doc: () => doc, engine, store, activeSectionId: () => activeSectionId,
    identity: () => ({ userId: 'u', name: 'Leo' }), roundTripMs: () => 80, notify,
  });
  const start = cycle * rate;
  const input = new Float32Array((cycle + 4) * rate);
  const micStart = start + Math.round(0.08 * rate);
  input.fill(0.25, micStart, micStart + rate);
  input.fill(0.75, micStart + rate, micStart + 2 * rate);
  return { doc, sectionId, base, trackId, capture, store, engine, notify, looper, start, input,
    leaveSection: () => { activeSectionId = null; } };
}

function mix(f: ReturnType<typeof fixture>): Float32Array {
  const track = readSnapshot(f.doc).tracks.find((t) => t.id === f.trackId)!;
  const out = new Float32Array(track.length48!);
  for (const layer of track.layers) mixLayerInto(out, { offset: layer.offset, data: f.store.get(layer.id)! });
  return out;
}

describe('auto-snapped longer recordings', () => {
  for (const rate of [48000, 44100]) {
    it.each([1, 2, 3])(`plays the first recorded half first after backing cycle %i at ${rate} Hz`, async (cycle) => {
      const f = fixture(rate, cycle);
      const before = readSnapshot(f.doc).tracks.find((t) => t.id === f.base);
      await f.looper.tap(f.trackId, f.start);
      f.capture.push({ frame: 0, data: f.input });
      await f.looper.tap(f.trackId, f.start + 2 * rate);
      const plan = songPlan(readSnapshot(f.doc));
      expect(plan.total48).toBe(2 * S);
      const audio = mix(f);
      expect(audio[S / 4]).toBe(0.25);
      expect(audio[S + S / 4]).toBe(0.75);
      expect(readSnapshot(f.doc).tracks.find((t) => t.id === f.base)).toEqual(before);
      const origin = f.engine.transportOrigin!;
      // Both the original backing phase and the performance's live phase survive.
      expect(renderPosition(f.start + 2.25 * rate, origin, rate, S)).toBeCloseTo(S / 4);
      expect(audio[Math.round(renderPosition(f.start + 2.25 * rate, origin, rate, 2 * S))]).toBe(0.25);
      expect(f.notify).not.toHaveBeenCalled();

      // Later overdubs must follow the now-established two-cycle phrase.
      await f.looper.tap(f.trackId, f.start + 2.25 * rate);
      await f.looper.tap(f.trackId, f.start + 2.75 * rate);
      expect(f.engine.transportOrigin).toBe(origin);
      const layers = readSnapshot(f.doc).tracks.find((t) => t.id === f.trackId)!.layers;
      expect(layers).toHaveLength(2);
      const from = Math.floor(f.start + 2.25 * rate + 0.08 * rate - 0.1 * rate);
      expect(layers[1]!.offset).toBe(Math.round(capturePosition(from, 0.08 * rate, origin, rate, 2 * S)));
    });
  }

  it('preserves established longer backing phrases and unsnapped free takes', async () => {
    for (const [autoSnap, existingLong] of [[true, true], [false, false]] as const) {
      const f = fixture(S, 1, autoSnap, existingLong);
      await f.looper.tap(f.trackId, f.start);
      f.capture.push({ frame: 0, data: f.input });
      await f.looper.tap(f.trackId, f.start + 2 * S);
      expect(f.engine.transportOrigin).toBe(0);
      expect(mix(f)[S / 4]).toBe(0.75);
    }
  });

  it('respects a peer who establishes the phrase during the microphone-tail wait', async () => {
    const f = fixture(S, 1);
    await f.looper.tap(f.trackId, f.start);
    const stopping = f.looper.tap(f.trackId, f.start + 2 * S);
    addLayer(f.doc, { id: 'peer-take', trackId: f.trackId, author: 'peer', authorName: 'Peer', offset: 0, frames: 1, length48: 2 * S });
    f.capture.push({ frame: 0, data: f.input });
    await stopping;
    expect(f.engine.transportOrigin).toBe(0);
    const own = readSnapshot(f.doc).tracks.find((t) => t.id === f.trackId)!.layers.find((l) => l.author === 'u')!;
    expect(own.offset).toBe(S - S / 10);
  });

  it('does not rebase another playback mode if the player leaves while the take finishes', async () => {
    const f = fixture(S, 1);
    await f.looper.tap(f.trackId, f.start);
    const stopping = f.looper.tap(f.trackId, f.start + 2 * S);
    f.leaveSection();
    f.capture.push({ frame: 0, data: f.input });
    await stopping;
    expect(f.engine.transportOrigin).toBe(0);
    expect(mix(f)[S / 4]).toBe(0.25);
    expect(mix(f)[S + S / 4]).toBe(0.75);
  });
});
