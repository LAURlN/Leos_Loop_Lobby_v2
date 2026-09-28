import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE } from '@lll/shared';
import {
  addEffect,
  addLayer,
  createSection,
  createTrack,
  importProject,
  initSession,
  renameSection,
  setEffectParams,
  setTrackMix,
  undoLayer,
} from './actions';
import { encodeLayerAudio } from './codec';
import { LayerAudioStore } from './layerAudio';
import {
  PROJECT_FORMAT,
  ProjectFileError,
  exportProject,
  loadProjectAudio,
  parseProject,
  withFreshIds,
} from './projectFile';
import { readSnapshot, roots } from './schema';

const LEN = CANONICAL_RATE * 2;

function tone(frames: number, seed: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.round(Math.sin(i * 0.01 * seed) * 30000) / 32767;
  return out;
}

/** A session with two sections, effects, mix settings and a hidden (undone) take. */
async function sampleSession() {
  const doc = new Y.Doc();
  const store = new LayerAudioStore();
  initSession(doc);
  const verse = readSnapshot(doc).sections[0]!.id;
  renameSection(doc, verse, 'Verse');
  const chorus = createSection(doc, { name: 'Chorus', createdBy: 'u1' });
  const drums = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'u1', name: 'Drums', sectionId: verse });
  const bass = createTrack(doc, { lengthSpec: { kind: 'ratio', num: 2, den: 1 }, createdBy: 'u1', name: 'Bass', sectionId: chorus });
  setTrackMix(doc, drums, { volume: 0.5, pan: -0.25, mute: true });
  const fx = addEffect(doc, drums, 'delay')!;
  setEffectParams(doc, drums, fx, { wet: 0.3 });
  const takes = [
    { id: 'l1', trackId: drums, frames: 1000, seed: 1 },
    { id: 'l2', trackId: drums, frames: 500, seed: 2 },
    { id: 'l3', trackId: bass, frames: 800, seed: 3 },
  ];
  for (const t of takes) {
    store.put(t.id, tone(t.frames, t.seed));
    addLayer(doc, { id: t.id, trackId: t.trackId, author: 'u1', authorName: 'Leo', offset: 10, frames: t.frames, length48: LEN });
  }
  undoLayer(doc, drums, 'u1'); // hides l2
  return { doc, store };
}

async function importInto(doc: Y.Doc, bytes: Uint8Array, mode: 'replace' | 'append') {
  const store = new LayerAudioStore();
  const data = withFreshIds(parseProject(bytes));
  const { content, droppedLayers } = await loadProjectAudio(data, store);
  const sections = importProject(doc, content, mode);
  return { store, sections, droppedLayers };
}

/** Snapshot without ids, for comparing sessions across an import. */
function shape(doc: Y.Doc, store: LayerAudioStore) {
  const snap = readSnapshot(doc);
  return snap.sections.map((s) => ({
    name: s.name,
    referenceLength48: s.referenceLength48,
    beatsPerLoop: s.beatsPerLoop,
    tracks: snap.tracks
      .filter((t) => t.sectionId === s.id)
      .map(({ id: _id, sectionId: _s, effects, layers, ...t }) => ({
        ...t,
        effects: effects.map(({ id: _e, ...e }) => e),
        layers: layers.map(({ id, trackId: _t, ...l }) => ({ ...l, audio: Array.from(store.get(id) ?? []) })),
      })),
  }));
}

describe('project files', () => {
  it('round-trips a whole session with audio', async () => {
    const src = await sampleSession();
    const { bytes, missingAudio } = await exportProject(src.doc, src.store);
    expect(missingAudio).toBe(0);

    const target = new Y.Doc();
    initSession(target);
    createTrack(target, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'x' });
    const { store, droppedLayers } = await importInto(target, bytes, 'replace');
    expect(droppedLayers).toBe(0);
    const imported = shape(target, store);
    expect(imported).toEqual(shape(src.doc, src.store));
    expect(imported.map((s) => s.name)).toEqual(['Verse', 'Chorus']);
    expect(imported[0]!.tracks[0]!.layers.map((l) => l.hidden)).toEqual([false, true]);
    expect(readSnapshot(target).referenceLength48).toBe(readSnapshot(src.doc).referenceLength48);
  });

  it('gives imported items fresh ids', async () => {
    const src = await sampleSession();
    const { bytes } = await exportProject(src.doc, src.store);
    const target = new Y.Doc();
    await importInto(target, bytes, 'replace');
    const before = readSnapshot(src.doc);
    const after = readSnapshot(target);
    const ids = (s: typeof before) => [
      ...s.sections.map((x) => x.id),
      ...s.tracks.flatMap((t) => [t.id, ...t.effects.map((e) => e.id), ...t.layers.map((l) => l.id)]),
    ];
    const old = new Set(ids(before));
    expect(ids(after).some((id) => old.has(id))).toBe(false);
  });

  it('appends sections after the existing ones', async () => {
    const src = await sampleSession();
    const { bytes } = await exportProject(src.doc, src.store);
    const target = new Y.Doc();
    initSession(target);
    createTrack(target, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: 'x', name: 'Mine' });
    const { sections } = await importInto(target, bytes, 'append');
    const snap = readSnapshot(target);
    expect(snap.sections.map((s) => s.name)).toEqual(['1', 'Verse', 'Chorus']);
    expect(sections).toEqual([snap.sections[1]!.id, snap.sections[2]!.id]);
    expect(snap.tracks.map((t) => t.name).sort()).toEqual(['Bass', 'Drums', 'Mine']);
  });

  it('leaves out layers whose audio has not arrived yet', async () => {
    const src = await sampleSession();
    src.store.forget(['l3']);
    const { bytes, missingAudio } = await exportProject(src.doc, src.store);
    expect(missingAudio).toBe(1);
    const target = new Y.Doc();
    await importInto(target, bytes, 'replace');
    expect(readSnapshot(target).tracks.flatMap((t) => t.layers)).toHaveLength(2);
  });

  it('rejects files that are not projects', () => {
    expect(() => parseProject(new Uint8Array([1, 2, 3]))).toThrow(ProjectFileError);
    expect(() => parseProject(zipSync({ 'project.json': strToU8('{"format":"other"}') }))).toThrow(ProjectFileError);
  });

  it('refuses files that need a newer reader', () => {
    const file = zipSync({
      'project.json': strToU8(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 9, minReaderVersion: 9 })),
    });
    expect(() => parseProject(file)).toThrow(/newer version/);
  });

  it('reads newer files that stay compatible: unknown fields, effects, codecs and entries', async () => {
    const pcm = await encodeLayerAudio(tone(300, 1));
    const futureCodec = new Uint8Array(pcm);
    futureCodec[4] = 7; // a codec this build does not know
    const manifest = {
      format: PROJECT_FORMAT,
      formatVersion: 5,
      minReaderVersion: 1,
      session: {
        meta: { beatsPerLoop: 3, tempoMap: { a: 1 } },
        sections: { s: { name: 'A', order: 0, beatsPerLoop: 3, color: 'teal' } },
        tracks: {
          t: {
            sectionId: 's',
            name: 'T',
            lengthSpec: { kind: 'free', autoSnap: true },
            length48: LEN,
            sidechain: 'x',
            effects: {
              e1: { type: 'hyperverb', enabled: true, order: 0, params: { warp: 12 } },
              e2: { type: 'delay', enabled: true, order: 1, params: { wet: 99, future: 3 } },
            },
          },
        },
        layers: {
          ok: { trackId: 't', author: 'u', authorName: 'U', seq: 1, offset: 0, frames: 300, gain: 1, stretch: 2 },
          future: { trackId: 't', author: 'u', authorName: 'U', seq: 2, offset: 0, frames: 300, gain: 1 },
        },
      },
      audio: { ok: 'audio/ok.lla', future: 'audio/future.lla' },
      arrangement: [1, 2, 3],
    };
    const file = zipSync({
      'project.json': strToU8(JSON.stringify(manifest)),
      'audio/ok.lla': pcm,
      'audio/future.lla': futureCodec,
      'video/cover.mp4': new Uint8Array([0]),
    });
    const doc = new Y.Doc();
    const { droppedLayers } = await importInto(doc, file, 'replace');
    expect(droppedLayers).toBe(1);
    const snap = readSnapshot(doc);
    const track = snap.tracks[0]!;
    expect(track.layers).toHaveLength(1);
    expect(track.effects.map((e) => e.type)).toEqual(['hyperverb', 'delay']);
    expect(track.effects[0]!.params).toEqual({ warp: 12 });
    expect(track.effects[1]!.params.wet).toBe(1); // clamped
    expect(track.effects[1]!.params.future).toBe(3); // kept for newer versions
    // Unknown fields survive, so exporting again keeps them.
    const { tracks, sections, layers } = roots(doc);
    expect(tracks.get(track.id)!.get('sidechain')).toBe('x');
    expect(sections.get(snap.sections[0]!.id)!.get('color')).toBe('teal');
    expect(layers.get(track.layers[0]!.id)!.get('stretch')).toBe(2);
  });

  // Frozen format-1 file. Never change this test; every future version must still import it.
  it('imports format version 1 files', async () => {
    const audio = new Uint8Array(9 + 4 * 2);
    audio.set([0x4c, 0x4c, 0x41, 0x31, 0], 0); // "LLA1", codec 0 = PCM16
    new DataView(audio.buffer).setUint32(5, 4, true);
    new DataView(audio.buffer).setInt16(9, 16384, true);
    const manifest = {
      format: 'leos-loop-lobby-project',
      formatVersion: 1,
      minReaderVersion: 1,
      exportedAt: '2026-09-28T12:00:00.000Z',
      schema: 1,
      session: {
        meta: { schema: 1, beatsPerLoop: 6, referenceLength48: 96000 },
        sections: {
          sec1: { name: 'Intro', order: 0, beatsPerLoop: 6, createdBy: 'u1', referenceLength48: 96000 },
          sec2: { name: 'Outro', order: 1, beatsPerLoop: 4, createdBy: 'u1' },
        },
        tracks: {
          trk1: {
            sectionId: 'sec1',
            name: 'Guitar',
            color: 2,
            order: 0,
            lengthSpec: { kind: 'free', autoSnap: true },
            length48: 96000,
            volume: 0.8,
            pan: 0.5,
            mute: false,
            solo: true,
            createdBy: 'u1',
            effects: { fx1: { type: 'reverb', enabled: false, order: 0, params: {} } },
          },
          trk2: {
            sectionId: 'sec2',
            name: 'Empty',
            color: 0,
            order: 0,
            lengthSpec: { kind: 'seconds', seconds: 1 },
            length48: 48000,
            volume: 1,
            pan: 0,
            mute: false,
            solo: false,
            createdBy: 'u1',
            effects: {},
          },
        },
        layers: {
          lay1: { trackId: 'trk1', author: 'u1', authorName: 'Leo', seq: 1, offset: 123, frames: 4, gain: 1, hidden: false },
        },
      },
      audio: { lay1: 'audio/lay1.lla' },
    };
    const file = zipSync({ 'project.json': strToU8(JSON.stringify(manifest)), 'audio/lay1.lla': audio });

    const doc = new Y.Doc();
    const { store } = await importInto(doc, file, 'replace');
    const snap = readSnapshot(doc);
    expect(snap.beatsPerLoop).toBe(6);
    expect(snap.referenceLength48).toBe(96000);
    expect(snap.sections.map((s) => [s.name, s.beatsPerLoop, s.referenceLength48])).toEqual([
      ['Intro', 6, 96000],
      ['Outro', 4, 48000],
    ]);
    const [guitar, empty] = snap.tracks.sort((a, b) => a.name.localeCompare(b.name) * -1);
    expect(guitar).toMatchObject({ name: 'Guitar', volume: 0.8, pan: 0.5, solo: true, length48: 96000 });
    expect(guitar!.effects[0]).toMatchObject({ type: 'reverb', enabled: false });
    expect(guitar!.layers).toHaveLength(1);
    expect(guitar!.layers[0]).toMatchObject({ offset: 123, frames: 4, authorName: 'Leo' });
    expect(store.get(guitar!.layers[0]!.id)?.[0]).toBeCloseTo(0.5, 3);
    expect(empty).toMatchObject({ name: 'Empty', lengthSpec: { kind: 'seconds', seconds: 1 }, layers: [] });
  });
});
