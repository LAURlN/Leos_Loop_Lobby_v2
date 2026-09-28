import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE } from '@lll/shared';
import {
  addEffect,
  addLayer,
  canRedo,
  clearTrack,
  createTrack,
  deleteTrack,
  initSession,
  redoLayer,
  setEffectParams,
  setTrackMix,
  undoLayer,
} from './actions';
import { decodeLayerAudio, encodeLayerAudio } from './codec';
import { readSnapshot } from './schema';

const LEN = CANONICAL_RATE * 2;

function layer(trackId: string, author: string, id = Math.random().toString(36).slice(2)) {
  return { id, trackId, author, authorName: author, offset: 0, frames: 100, length48: LEN };
}

/** Two replicas that exchange updates only when we say so (simulates the network). */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const queueAB: Uint8Array[] = [];
  const queueBA: Uint8Array[] = [];
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && queueAB.push(u));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && queueBA.push(u));
  return {
    a,
    b,
    /** Deliver queued updates, optionally shuffled and duplicated. */
    flush(opts: { reverse?: boolean; duplicate?: boolean } = {}) {
      const deliver = (queue: Uint8Array[], to: Y.Doc) => {
        const list = opts.reverse ? [...queue].reverse() : [...queue];
        if (opts.duplicate) list.push(...list);
        queue.length = 0;
        for (const u of list) Y.applyUpdate(to, u, 'remote');
      };
      deliver(queueAB, b);
      deliver(queueBA, a);
    },
  };
}

describe('session actions', () => {
  it('first take sets track and reference length', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const t = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
    expect(readSnapshot(doc).referenceLength48).toBeNull();
    addLayer(doc, layer(t, 'u1'));
    const snap = readSnapshot(doc);
    expect(snap.referenceLength48).toBe(LEN);
    expect(snap.tracks[0]?.length48).toBe(LEN);
  });

  it('ratio tracks derive their length from the reference', () => {
    const doc = new Y.Doc();
    const t = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
    addLayer(doc, layer(t, 'u1'));
    const t2 = createTrack(doc, { lengthSpec: { kind: 'ratio', num: 1, den: 2 }, createdBy: 'u1' });
    expect(readSnapshot(doc).tracks.find((x) => x.id === t2)?.length48).toBe(LEN / 2);
  });

  it('undo/redo only touch the own takes', () => {
    const doc = new Y.Doc();
    const t = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
    addLayer(doc, layer(t, 'u1', 'a1'));
    addLayer(doc, layer(t, 'u2', 'b1'));
    addLayer(doc, layer(t, 'u1', 'a2'));
    expect(undoLayer(doc, t, 'u1')).toBe('a2');
    expect(undoLayer(doc, t, 'u1')).toBe('a1');
    expect(undoLayer(doc, t, 'u1')).toBeNull();
    expect(canRedo(doc, t, 'u1')).toBe(true);
    expect(redoLayer(doc, t, 'u1')).toBe('a1');
    const visible = readSnapshot(doc).tracks[0]?.layers.filter((l) => !l.hidden).map((l) => l.id);
    expect(visible?.sort()).toEqual(['a1', 'b1']);
  });

  it('clearing the only free track resets the reference', () => {
    const doc = new Y.Doc();
    const t = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
    addLayer(doc, layer(t, 'u1'));
    clearTrack(doc, t);
    const snap = readSnapshot(doc);
    expect(snap.tracks[0]?.length48).toBeNull();
    expect(snap.referenceLength48).toBeNull();
  });
});

describe('multiplayer convergence (regressions from v1)', () => {
  it('deleting a track never shifts settings onto another track', () => {
    const { a, b, flush } = pair();
    const t1 = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    const t2 = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    const t3 = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    setTrackMix(a, t2, { volume: 0.7 });
    setTrackMix(a, t3, { volume: 0.9 });
    addEffect(a, t3, 'delay');
    flush();
    deleteTrack(b, t2);
    flush();
    for (const doc of [a, b]) {
      const snap = readSnapshot(doc);
      expect(snap.tracks.map((t) => t.id)).toEqual([t1, t3]);
      expect(snap.tracks[1]?.volume).toBe(0.9);
      expect(snap.tracks[1]?.effects.map((e) => e.type)).toEqual(['delay']);
    }
  });

  it('a late parameter change cannot resurrect a deleted track', () => {
    const { a, b, flush } = pair();
    const t = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    const fx = addEffect(a, t, 'eq')!;
    flush();
    // Concurrently: A deletes, B tweaks the EQ and volume.
    deleteTrack(a, t);
    setEffectParams(b, t, fx, { low: 6 });
    setTrackMix(b, t, { volume: 0.2 });
    flush({ reverse: true, duplicate: true });
    expect(readSnapshot(a).tracks).toHaveLength(0);
    expect(readSnapshot(b).tracks).toHaveLength(0);
  });

  it('concurrent takes from two players on the same track are both kept', () => {
    const { a, b, flush } = pair();
    const t = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    addLayer(a, layer(t, 'a', 'la'));
    flush();
    addLayer(a, layer(t, 'a', 'la2'));
    addLayer(b, layer(t, 'b', 'lb'));
    flush({ reverse: true });
    for (const doc of [a, b]) {
      expect(readSnapshot(doc).tracks[0]?.layers.map((l) => l.id).sort()).toEqual(['la', 'la2', 'lb']);
    }
  });

  it('replicas converge regardless of delivery order and duplication', () => {
    const { a, b, flush } = pair();
    const t = createTrack(a, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'a' });
    flush();
    for (let i = 0; i < 20; i++) {
      setTrackMix(a, t, { volume: i / 20 });
      setTrackMix(b, t, { pan: -i / 20 });
    }
    flush({ reverse: true, duplicate: true });
    expect(readSnapshot(a)).toEqual(readSnapshot(b));
  });
});

describe('layer audio codec', () => {
  it('round-trips within 16-bit precision', async () => {
    const pcm = new Float32Array(48000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 20) * 0.8;
    const bytes = await encodeLayerAudio(pcm);
    const back = await decodeLayerAudio(bytes);
    expect(back.length).toBe(pcm.length);
    let maxErr = 0;
    for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs((back[i] ?? 0) - (pcm[i] ?? 0)));
    expect(maxErr).toBeLessThan(1 / 16000);
  });

  it('compresses silence well', async () => {
    const bytes = await encodeLayerAudio(new Float32Array(48000));
    expect(bytes.length).toBeLessThan(2000);
  });
});
