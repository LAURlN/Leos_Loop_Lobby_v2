import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE as S, applyFades, mixLayerInto, resampleLinear } from '@lll/shared';
import { MicCapture } from '../audio/micCapture';
import { addLayer, addSongTake, createSection, createTrack, deleteSection, initSession, setTrackMix, undoLayer } from './actions';
import { LayerAudioStore } from './layerAudio';
import { exportProject, loadProjectAudio, parseProject, withFreshIds } from './projectFile';
import { importProject } from './actions';
import { readSnapshot } from './schema';
import { songPlan } from './song';
import { SongRecorder, splitSongTake } from './songRecording';

function fixture(rate = S, latencyMs = 80) {
  const doc = new Y.Doc();
  initSession(doc);
  const first = readSnapshot(doc).sections[0]!.id;
  const empty = createSection(doc, { name: 'Empty', createdBy: 'u' });
  const second = createSection(doc, { name: 'Chorus', createdBy: 'u' });
  for (const [sectionId, seconds] of [[first, 1], [second, 2]] as const) {
    const id = createTrack(doc, { sectionId, createdBy: 'backing', lengthSpec: { kind: 'seconds', seconds } });
    addLayer(doc, { id: `backing-${id}`, trackId: id, author: 'backing', authorName: 'Backing', offset: 0, frames: 1, length48: S * seconds });
  }
  const plan = songPlan(readSnapshot(doc));
  const store = new LayerAudioStore();
  const capture = new MicCapture(rate * 3);
  let heard = rate;
  const origin = rate;
  const notify = vi.fn();
  const ended = vi.fn();
  const recorder = new SongRecorder({
    doc: () => doc, store, engine: { sampleRate: rate, capture, heardFrameAt: () => heard },
    identity: () => ({ userId: 'u', name: 'Leo' }), roundTripMs: () => latencyMs,
    notify, changed: vi.fn(), ended,
  });
  const input = Float32Array.from({ length: 5 * rate }, (_, i) => Math.sin(i * 0.013) * 0.4);
  const feed = () => capture.push({ frame: 0, data: input });
  return { doc, first, empty, second, plan, store, capture, origin, recorder, notify, ended, input, feed,
    setPosition: (pos48: number) => { heard = origin + pos48 * rate / S; } };
}

function reconstruct(f: ReturnType<typeof fixture>): Float32Array {
  const out = new Float32Array(f.plan.total48);
  const snapshot = readSnapshot(f.doc);
  for (const segment of f.plan.segments) {
    const mix = new Float32Array(segment.length48);
    for (const track of snapshot.tracks.filter((t) => t.sectionId === segment.sectionId && t.songTake)) {
      for (const layer of track.layers.filter((l) => !l.hidden)) {
        mixLayerInto(mix, { offset: layer.offset, data: f.store.get(layer.id)! });
      }
    }
    out.set(mix, segment.start48);
  }
  return out;
}

function songTracks(doc: Y.Doc) {
  const snapshot = readSnapshot(doc);
  return snapshot.sections.flatMap((section) => snapshot.tracks.filter((t) => t.songTake && t.sectionId === section.id));
}

afterEach(() => { vi.useRealTimers(); });

describe('song recording', () => {
  it('splits a partial take at exact boundaries, without wrapping or mutating samples', () => {
    const plan = { total48: 12, skipped: ['empty'], segments: [
      { sectionId: 'a', start48: 0, length48: 5, tracks: [] },
      { sectionId: 'b', start48: 5, length48: 7, tracks: [] },
    ] };
    const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const slices = splitSongTake(plan, 3, data);
    expect(slices.map((s) => [s.sectionId, s.length48, s.offset, [...s.data]])).toEqual([
      ['a', 5, 3, [1, 2]], ['b', 7, 0, [3, 4, 5, 6]],
    ]);
    expect(splitSongTake(plan, 5, new Float32Array([8]))[0]?.sectionId).toBe('b');
    expect(splitSongTake(plan, 12, data)).toEqual([]);
    slices[0]!.data[0] = 99;
    expect(data[0]).toBe(1);
  });

  it.each([48000, 44100])('replays exactly the latency-compensated take across sections at %i Hz', async (rate) => {
    const f = fixture(rate);
    const start = S / 2;
    const end = S * 2.5;
    f.setPosition(start);
    f.recorder.start(f.plan, f.origin, start);
    f.feed();
    f.setPosition(end);
    await f.recorder.stop();
    const from = Math.round(f.origin + (start / S + 0.08) * rate);
    const raw = f.input.slice(from, from + Math.ceil((end - start) * rate / S));
    const expected = resampleLinear(raw, rate, S).slice(0, end - start);
    applyFades(expected, 240, 240);
    // Mixing adds into silence, which normalizes IEEE negative zero.
    expect(reconstruct(f).slice(start, end)).toEqual(expected.map((sample) => sample + 0));
    expect(reconstruct(f).slice(0, start).every((n) => n === 0)).toBe(true);
    const tracks = songTracks(f.doc);
    expect(tracks.map((t) => [t.sectionId, t.length48, t.layers[0]!.offset])).toEqual([
      [f.first, S, S / 2], [f.second, 2 * S, 0],
    ]);
    expect(songPlan(readSnapshot(f.doc)).total48).toBe(f.plan.total48);
    expect(tracks.some((t) => t.sectionId === f.empty)).toBe(false);
    expect(f.recorder.busy).toBe(false);
  });

  it('stops at the song end independently of UI frames and clips a late timer', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.recorder.start(f.plan, f.origin, 0);
    f.feed();
    f.setPosition(f.plan.total48 + S / 4);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.ended).toHaveBeenCalledOnce();
    expect(f.recorder.busy).toBe(false);
    expect(songTracks(f.doc).map((t) => t.layers[0]!.frames)).toEqual([S, 2 * S]);
  });

  it('waits for latency audio, and cancellation while finishing cannot write a take', async () => {
    const f = fixture();
    f.recorder.start(f.plan, f.origin, 0);
    f.setPosition(S * 2);
    const stopping = f.recorder.stop();
    expect(f.recorder.finishing).toBe(true);
    expect(readSnapshot(f.doc).tracks.some((t) => t.songTake)).toBe(false);
    f.recorder.cancel();
    f.feed();
    await stopping;
    expect(readSnapshot(f.doc).tracks.some((t) => t.songTake)).toBe(false);
  });

  it('waits for the microphone tail before committing all parts in one update', async () => {
    const f = fixture();
    const update = vi.fn();
    f.doc.on('update', update);
    f.recorder.start(f.plan, f.origin, 0);
    f.setPosition(S * 2);
    const stopping = f.recorder.stop();
    expect(update).not.toHaveBeenCalled();
    f.feed();
    await stopping;
    expect(update).toHaveBeenCalledOnce();
    expect(readSnapshot(f.doc).tracks.filter((t) => t.songTake)).toHaveLength(2);
  });

  it('rejects deleted destinations and does not resurrect sections', async () => {
    const f = fixture();
    f.recorder.start(f.plan, f.origin, 0);
    f.setPosition(S * 2);
    const stopping = f.recorder.stop();
    deleteSection(f.doc, f.second);
    f.feed();
    await stopping;
    expect(readSnapshot(f.doc).tracks.some((t) => t.songTake)).toBe(false);
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('section order or lengths changed'));
  });

  it('preserves ordinary layer undo, solo audibility, peer sync and project round trips', async () => {
    const f = fixture();
    const backing = readSnapshot(f.doc).tracks.find((t) => t.sectionId === f.first)!;
    setTrackMix(f.doc, backing.id, { solo: true });
    f.recorder.start(f.plan, f.origin, 0);
    f.feed();
    f.setPosition(2 * S);
    await f.recorder.stop();
    const takes = songTracks(f.doc);
    expect(takes[0]!.solo).toBe(true);
    undoLayer(f.doc, takes[0]!.id, 'u');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc));
    expect(readSnapshot(peer)).toEqual(readSnapshot(f.doc));
    const { bytes } = await exportProject(f.doc, f.store);
    const imported = new Y.Doc();
    const importedStore = new LayerAudioStore();
    const { content } = await loadProjectAudio(withFreshIds(parseProject(bytes)), importedStore);
    importProject(imported, content, 'replace');
    const loaded = songTracks(imported);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((t) => [t.length48, t.layers[0]!.offset, t.layers[0]!.hidden]))
      .toEqual(takes.map((t, i) => [t.length48, t.layers[0]!.offset, i === 0]));
    expect(loaded.every((t) => importedStore.has(t.layers[0]!.id))).toBe(true);
  });

  it('rejects invalid parts atomically', () => {
    const f = fixture();
    const good = { id: 'new-layer', sectionId: f.first, length48: S, offset: 0, frames: 100 };
    for (const invalid of [
      { ...good, id: 'bad', offset: -1 }, { ...good, id: 'bad', frames: Infinity },
      { ...good, id: 'bad', length48: NaN }, { ...good, id: 'bad', sectionId: 'deleted' },
      { ...good, id: 'bad', offset: S - 1 }, good,
    ]) expect(addSongTake(f.doc, [good, invalid], 'u', 'Leo')).toEqual([]);
    expect(readSnapshot(f.doc).tracks).toHaveLength(2);
  });
});
