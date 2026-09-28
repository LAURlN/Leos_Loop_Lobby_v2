import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE } from '@lll/shared';
import {
  addEffect,
  addLayer,
  canRedo,
  clearTrack,
  copyTrackToSection,
  copyTracksToSection,
  createSection,
  createTrack,
  deleteSection,
  deleteTrack,
  initSession,
  moveSection,
  redoLayer,
  renameSection,
  reorderSection,
  setEffectParams,
  setTrackMix,
  undoLayer,
} from './actions';
import { decodeLayerAudio, encodeLayerAudio } from './codec';
import { LayerAudioStore } from './layerAudio';
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

describe('sections feature', () => {
  it('initSession creates default section 1', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const snap = readSnapshot(doc);
    expect(snap.sections).toHaveLength(1);
    expect(snap.sections[0]?.name).toBe('1');
    expect(snap.sections[0]?.order).toBe(0);
  });

  it('creates numbered sections by default (1, 2, 3...) or custom name', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const s2 = createSection(doc, { createdBy: 'u1' });
    const s3 = createSection(doc, { createdBy: 'u1' });
    const sCustom = createSection(doc, { name: 'Bridge', createdBy: 'u1' });
    const snap = readSnapshot(doc);
    expect(snap.sections.map((s) => s.name)).toEqual(['1', '2', '3', 'Bridge']);
    expect(snap.sections.find((s) => s.id === s2)?.name).toBe('2');
    expect(snap.sections.find((s) => s.id === s3)?.name).toBe('3');
    expect(snap.sections.find((s) => s.id === sCustom)?.name).toBe('Bridge');
  });

  it('renames a section', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const s1 = readSnapshot(doc).sections[0]!.id;
    renameSection(doc, s1, 'Verse 1');
    expect(readSnapshot(doc).sections[0]?.name).toBe('Verse 1');
  });

  it('moves and reorders sections', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const s2 = createSection(doc, { createdBy: 'u1' });
    const s3 = createSection(doc, { createdBy: 'u1' });
    expect(readSnapshot(doc).sections.map((s) => s.name)).toEqual(['1', '2', '3']);

    // Move section 3 left
    moveSection(doc, s3, 'left');
    expect(readSnapshot(doc).sections.map((s) => s.name)).toEqual(['1', '3', '2']);

    // Reorder section 1 to end
    const s1 = readSnapshot(doc).sections[0]!.id;
    reorderSection(doc, s1, 2);
    expect(readSnapshot(doc).sections.map((s) => s.name)).toEqual(['3', '2', '1']);
  });

  it('deleting a section removes its tracks and layers, but cannot delete the last section', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const s1 = readSnapshot(doc).sections[0]!.id;
    const t1 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1', sectionId: s1 });
    addLayer(doc, layer(t1, 'u1', 'l1'));

    // Try deleting the only section -> should fail / be rejected
    expect(deleteSection(doc, s1)).toBe(false);
    expect(readSnapshot(doc).sections).toHaveLength(1);

    // Create section 2 with track
    const s2 = createSection(doc, { createdBy: 'u1' });
    const t2 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1', sectionId: s2 });
    addLayer(doc, layer(t2, 'u1', 'l2'));

    // Delete section 1
    expect(deleteSection(doc, s1)).toBe(true);
    const snap = readSnapshot(doc);
    expect(snap.sections).toHaveLength(1);
    expect(snap.sections[0]?.id).toBe(s2);
    expect(snap.tracks.map((t) => t.id)).toEqual([t2]);
    expect(snap.tracks[0]?.layers.map((l) => l.id)).toEqual(['l2']);
  });

  it('copies loops from section 1 to section 2 and edits in section 2 stay completely isolated', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const store = new LayerAudioStore();
    const s1 = readSnapshot(doc).sections[0]!.id;
    const s2 = createSection(doc, { createdBy: 'u1' });

    // Create track in Section 1 with mix, effect, and audio layer
    const t1 = createTrack(doc, {
      lengthSpec: { kind: 'free', autoSnap: true },
      createdBy: 'u1',
      sectionId: s1,
      name: 'Bassline',
    });
    setTrackMix(doc, t1, { volume: 0.8, pan: -0.5 });
    const fx1 = addEffect(doc, t1, 'delay')!;
    setEffectParams(doc, t1, fx1, { time: 250 });

    const pcm = new Float32Array(48000);
    pcm.fill(0.5);
    store.put('layer-audio-1', pcm);
    addLayer(doc, {
      id: 'layer-audio-1',
      trackId: t1,
      author: 'u1',
      authorName: 'Leo',
      offset: 0,
      frames: 48000,
      length48: 48000,
    });

    // Copy track from section 1 to section 2
    const t2 = copyTrackToSection(doc, t1, s2, 'u1', store)!;
    expect(t2).toBeTruthy();
    expect(t2).not.toBe(t1);

    const snapBeforeEdit = readSnapshot(doc);
    const track1 = snapBeforeEdit.tracks.find((t) => t.id === t1)!;
    const track2 = snapBeforeEdit.tracks.find((t) => t.id === t2)!;

    expect(track1.sectionId).toBe(s1);
    expect(track2.sectionId).toBe(s2);
    expect(track2.name).toBe('Bassline');
    expect(track2.volume).toBe(0.8);
    expect(track2.pan).toBe(-0.5);
    expect(track2.length48).toBe(48000);
    expect(track2.effects).toHaveLength(1);
    expect(track2.effects[0]?.type).toBe('delay');
    expect(track2.effects[0]?.params.time).toBe(250);
    expect(track2.effects[0]?.id).not.toBe(fx1); // New effect ID

    expect(track2.layers).toHaveLength(1);
    const newLayerId = track2.layers[0]!.id;
    expect(newLayerId).not.toBe('layer-audio-1'); // New layer ID
    expect(store.has(newLayerId)).toBe(true); // Audio was copied in store

    // Now edit track 2 in section 2:
    setTrackMix(doc, t2, { volume: 0.2, pan: 0.7, mute: true });
    setEffectParams(doc, t2, track2.effects[0]!.id, { time: 750 });
    addLayer(doc, {
      id: 'layer-audio-2',
      trackId: t2,
      author: 'u1',
      authorName: 'Leo',
      offset: 100,
      frames: 48000,
      length48: 48000,
    });

    // Verify track 1 in section 1 was completely UNTOUCHED
    const snapAfterEdit = readSnapshot(doc);
    const track1After = snapAfterEdit.tracks.find((t) => t.id === t1)!;
    const track2After = snapAfterEdit.tracks.find((t) => t.id === t2)!;

    expect(track1After.volume).toBe(0.8);
    expect(track1After.pan).toBe(-0.5);
    expect(track1After.mute).toBe(false);
    expect(track1After.effects[0]?.params.time).toBe(250);
    expect(track1After.layers).toHaveLength(1);

    // Verify track 2 in section 2 received the edits
    expect(track2After.volume).toBe(0.2);
    expect(track2After.pan).toBe(0.7);
    expect(track2After.mute).toBe(true);
    expect(track2After.effects[0]?.params.time).toBe(750);
    expect(track2After.layers).toHaveLength(2);
  });
});
