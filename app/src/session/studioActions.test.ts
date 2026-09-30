import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE, MAX_LOOP_FRAMES, MIN_LOOP_FRAMES } from '@lll/shared';
import {
  addLayer,
  canRedo,
  createTrack,
  importProject,
  initSession,
  redoLayer,
  replaceTrackAudio,
  undoLayer,
} from './actions';
import { LayerAudioStore } from './layerAudio';
import { exportProject, loadProjectAudio, parseProject, withFreshIds } from './projectFile';
import { readSnapshot } from './schema';

const LEN = CANONICAL_RATE * 2;

function setup() {
  const doc = new Y.Doc();
  initSession(doc);
  const track = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
  addLayer(doc, { id: 'l1', trackId: track, author: 'u1', authorName: 'Leo', offset: 0, frames: LEN, length48: LEN });
  addLayer(doc, { id: 'l2', trackId: track, author: 'u2', authorName: 'Mia', offset: 100, frames: LEN / 2, length48: LEN });
  return { doc, track };
}

const trackOf = (doc: Y.Doc) => readSnapshot(doc).tracks[0]!;
const visibleIds = (doc: Y.Doc) => trackOf(doc).layers.filter((l) => !l.hidden).map((l) => l.id);

describe('replaceTrackAudio (loop studio save)', () => {
  it('hides the takes it replaces and adds one flattened take', () => {
    const { doc, track } = setup();
    const ok = replaceTrackAudio(doc, {
      layerId: 'flat',
      trackId: track,
      author: 'u1',
      authorName: 'Leo',
      frames: LEN,
      replaced: ['l1', 'l2'],
    });
    expect(ok).toBe(true);
    expect(visibleIds(doc)).toEqual(['flat']);
    const flat = trackOf(doc).layers.find((l) => l.id === 'flat')!;
    expect(flat.offset).toBe(0);
    expect(flat.frames).toBe(LEN);
    expect(flat.gain).toBe(1);
    expect(flat.author).toBe('u1');
    expect(flat.replaced).toEqual(['l1', 'l2']);
    expect(trackOf(doc).length48).toBe(LEN);
  });

  it('follows the edited length, so trims and doubles stick', () => {
    const { doc, track } = setup();
    const shorter = LEN / 2;
    replaceTrackAudio(doc, { layerId: 'flat', trackId: track, author: 'u1', authorName: 'Leo', frames: shorter, replaced: [] });
    expect(trackOf(doc).length48).toBe(shorter);
    // Longer loops are fine as well (up to the maximum).
    replaceTrackAudio(doc, { layerId: 'flat2', trackId: track, author: 'u1', authorName: 'Leo', frames: LEN * 2, replaced: ['flat'] });
    expect(trackOf(doc).length48).toBe(LEN * 2);
    // `flat` is replaced by `flat2`; l1 and l2 were never part of that edit.
    expect(visibleIds(doc)).toEqual(['l1', 'l2', 'flat2']);
  });

  it('refuses impossible edits', () => {
    const { doc, track } = setup();
    const base = { trackId: track, author: 'u1', authorName: 'Leo', replaced: [] };
    expect(replaceTrackAudio(doc, { ...base, layerId: 'a', frames: MIN_LOOP_FRAMES - 1 })).toBe(false);
    expect(replaceTrackAudio(doc, { ...base, layerId: 'b', frames: MAX_LOOP_FRAMES + 1 })).toBe(false);
    expect(replaceTrackAudio(doc, { ...base, layerId: 'c', frames: Number.NaN })).toBe(false);
    expect(replaceTrackAudio(doc, { ...base, layerId: 'd', frames: LEN })).toBe(true);
    // The same layer id twice is a mistake, not an overwrite.
    expect(replaceTrackAudio(doc, { ...base, layerId: 'd', frames: LEN })).toBe(false);
    expect(replaceTrackAudio(doc, { ...base, trackId: 'nope', layerId: 'e', frames: LEN })).toBe(false);
    expect(visibleIds(doc)).toEqual(['l1', 'l2', 'd']);
  });

  it('leaves metronome tracks alone', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const click = createTrack(doc, {
      lengthSpec: { kind: 'free', autoSnap: false },
      createdBy: 'u1',
      click: { bpm: 120, beats: 4, unit: 4, subdivision: 1 },
    });
    expect(
      replaceTrackAudio(doc, { layerId: 'x', trackId: click, author: 'u1', authorName: 'Leo', frames: LEN, replaced: [] }),
    ).toBe(false);
  });

  it('undo brings the replaced takes back without redoing the audio work', () => {
    const { doc, track } = setup();
    replaceTrackAudio(doc, {
      layerId: 'flat',
      trackId: track,
      author: 'u1',
      authorName: 'Leo',
      frames: LEN,
      replaced: ['l1', 'l2'],
    });
    expect(undoLayer(doc, track, 'u1')).toBe('flat');
    expect(visibleIds(doc)).toEqual(['l1', 'l2']);
    expect(canRedo(doc, track, 'u1')).toBe(true);
    expect(redoLayer(doc, track, 'u1')).toBe('flat');
    expect(visibleIds(doc)).toEqual(['flat']);
  });

  it('keeps another player from redoing a take the flatten hid', () => {
    const { doc, track } = setup();
    replaceTrackAudio(doc, {
      layerId: 'flat',
      trackId: track,
      author: 'u1',
      authorName: 'Leo',
      frames: LEN,
      replaced: ['l1', 'l2'],
    });
    // Mia's take (l2) is hidden by Leo's flatten: her redo has nothing to bring back.
    expect(canRedo(doc, track, 'u2')).toBe(false);
    expect(redoLayer(doc, track, 'u2')).toBeNull();
    expect(visibleIds(doc)).toEqual(['flat']);
    // Once the flatten itself is undone, redo works for her again.
    undoLayer(doc, track, 'u1');
    expect(canRedo(doc, track, 'u2')).toBe(false); // l2 is visible again, nothing hidden left
    expect(visibleIds(doc)).toEqual(['l1', 'l2']);
  });

  it('reaches a peer through the document alone', () => {
    const { doc, track } = setup();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    replaceTrackAudio(doc, {
      layerId: 'flat',
      trackId: track,
      author: 'u1',
      authorName: 'Leo',
      frames: LEN,
      replaced: ['l1', 'l2'],
    });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(readSnapshot(peer).tracks[0]!.layers.find((l) => l.id === 'flat')!.replaced).toEqual(['l1', 'l2']);
    expect(readSnapshot(peer).tracks[0]!.layers.filter((l) => !l.hidden).map((l) => l.id)).toEqual(['flat']);
  });

  it('keeps the take links through a project export and import', async () => {
    const doc = new Y.Doc();
    const store = new LayerAudioStore();
    initSession(doc);
    const track = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1' });
    for (const id of ['t1', 't2']) {
      store.put(id, new Float32Array([0.5, -0.5]));
      addLayer(doc, { id, trackId: track, author: 'u1', authorName: 'Leo', offset: 0, frames: LEN, length48: LEN });
    }
    store.put('flat', new Float32Array([0.25, -0.25]));
    replaceTrackAudio(doc, { layerId: 'flat', trackId: track, author: 'u1', authorName: 'Leo', frames: LEN, replaced: ['t1', 't2'] });

    const { bytes } = await exportProject(doc, store);
    const data = withFreshIds(parseProject(bytes));
    const target = new Y.Doc();
    const targetStore = new LayerAudioStore();
    initSession(target);
    const { content, droppedLayers } = await loadProjectAudio(data, targetStore);
    expect(droppedLayers).toBe(0);
    importProject(target, content, 'replace');

    const imported = readSnapshot(target).tracks[0]!;
    const flat = imported.layers.find((l) => !l.hidden)!;
    expect(imported.layers.filter((l) => l.hidden)).toHaveLength(2);
    // The replaced ids were remapped to the imported takes, so undo works there too.
    expect(flat.replaced).toHaveLength(2);
    expect(flat.replaced.every((id) => imported.layers.some((l) => l.id === id))).toBe(true);
    undoLayer(target, imported.id, 'u1');
    expect(readSnapshot(target).tracks[0]!.layers.filter((l) => !l.hidden)).toHaveLength(2);
  });
});
