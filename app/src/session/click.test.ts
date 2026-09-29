import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE } from '@lll/shared';
import { addLayer, copyTrackToSection, createSection, createTrack, importProject, initSession, setTrackClick } from './actions';
import { beatAccent, bpmForLength, clickLength48, normalizeClick, readClick, renderClick } from './click';
import { hasAudio, readSnapshot } from './schema';
import { songPlan } from './song';

const S = CANONICAL_RATE;
const free = { kind: 'free', autoSnap: true } as const;

/** Frames where a click starts (silence before, sound after). */
function onsets(loop: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < loop.length; i++) {
    if (loop[i] !== 0 && (i === 0 || loop[i - 1] === 0) && (i < 2 || loop[i - 2] === 0)) out.push(i);
  }
  return out;
}

describe('click patterns', () => {
  it('is one bar long', () => {
    expect(clickLength48({ bpm: 120, beats: 4, unit: 4, subdivision: 1 })).toBe(2 * S);
    expect(clickLength48({ bpm: 90, beats: 3, unit: 4, subdivision: 1 })).toBe(2 * S);
    expect(clickLength48({ bpm: 180, beats: 6, unit: 8, subdivision: 1 })).toBe(2 * S);
  });

  it('reproduces a loop length exactly from its tempo', () => {
    const ref = 101_234;
    expect(clickLength48({ bpm: bpmForLength(ref, 4), beats: 4, unit: 4, subdivision: 1 })).toBe(ref);
  });

  it('validates stored patterns', () => {
    expect(readClick(undefined)).toBeNull();
    expect(readClick('x')).toBeNull();
    expect(readClick({})).toEqual({ bpm: 120, beats: 4, unit: 4, subdivision: 1 });
    expect(normalizeClick({ bpm: 9999, beats: 0, unit: 3 as 4, subdivision: 7 as 4 })).toEqual({
      bpm: 300,
      beats: 1,
      unit: 4,
      subdivision: 4,
    });
  });

  it('clicks on every beat and subdivision, loudest on the downbeat', () => {
    const p = { bpm: 120, beats: 4, unit: 4, subdivision: 2 } as const;
    const loop = renderClick(p);
    expect(onsets(loop)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * (S / 4)).map((f) => f + 1));
    const peak = (from: number) => Math.max(...loop.subarray(from, from + 1200).map(Math.abs));
    expect(peak(0)).toBeGreaterThan(peak(S / 2)); // bar > beat
    expect(peak(S / 2)).toBeGreaterThan(peak(S / 4)); // beat > subdivision
  });

  it('groups compound meters in threes', () => {
    const p = normalizeClick({ beats: 6, unit: 8 });
    expect([0, 1, 2, 3, 4, 5].map((b) => beatAccent(p, b))).toEqual([2, 0, 0, 1, 0, 0]);
    expect(beatAccent(normalizeClick({ beats: 7, unit: 8 }), 3)).toBe(0);
  });
});

describe('metronome tracks', () => {
  function session() {
    const doc = new Y.Doc();
    initSession(doc);
    return { doc, section: readSnapshot(doc).sections[0]!.id };
  }

  it('set the grid of an empty section and sound without takes', () => {
    const { doc, section } = session();
    const id = createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section, click: normalizeClick({ bpm: 90, beats: 3 }) });
    const snap = readSnapshot(doc);
    const track = snap.tracks.find((t) => t.id === id)!;
    expect(track.name).toBe('Metronome');
    expect(track.length48).toBe(2 * S);
    expect(track.lengthSpec).toEqual({ kind: 'seconds', seconds: 2 });
    expect(hasAudio(track)).toBe(true);
    expect(snap.sections[0]).toMatchObject({ referenceLength48: 2 * S, beatsPerLoop: 3 });
    expect(songPlan(snap).segments[0]).toMatchObject({ sectionId: section, length48: 2 * S });
  });

  it('keep an existing grid', () => {
    const { doc, section } = session();
    const t = createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section });
    addLayer(doc, { id: 'l', trackId: t, author: 'u', authorName: 'U', offset: 0, frames: 10, length48: 3 * S });
    createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section, click: normalizeClick({ bpm: 120 }) });
    expect(readSnapshot(doc).sections[0]).toMatchObject({ referenceLength48: 3 * S, beatsPerLoop: 4 });
  });

  it('move the grid on tempo changes only while nothing else sounds', () => {
    const { doc, section } = session();
    const click = createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section, click: normalizeClick({ bpm: 120 }) });
    setTrackClick(doc, click, { bpm: 60, beats: 3 });
    let snap = readSnapshot(doc);
    expect(snap.tracks[0]!.length48).toBe(3 * S);
    expect(snap.sections[0]).toMatchObject({ referenceLength48: 3 * S, beatsPerLoop: 3 });

    const t = createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section });
    addLayer(doc, { id: 'l', trackId: t, author: 'u', authorName: 'U', offset: 0, frames: 10, length48: 3 * S });
    setTrackClick(doc, click, { bpm: 120 });
    snap = readSnapshot(doc);
    expect(snap.tracks.find((x) => x.id === click)!.length48).toBe(1.5 * S);
    expect(snap.sections[0]).toMatchObject({ referenceLength48: 3 * S, beatsPerLoop: 3 });
  });

  it('survive copying and project import', () => {
    const { doc, section } = session();
    const click = normalizeClick({ bpm: 100, beats: 7, unit: 8, subdivision: 2 });
    const id = createTrack(doc, { lengthSpec: free, createdBy: 'u', sectionId: section, click });
    const other = createSection(doc, { createdBy: 'u' });
    const copy = copyTrackToSection(doc, id, other, 'u')!;
    expect(readSnapshot(doc).tracks.find((t) => t.id === copy)!.click).toEqual(click);

    const target = new Y.Doc();
    initSession(target);
    importProject(
      target,
      {
        meta: {},
        sections: { s: { name: 'A', order: 0 } },
        tracks: { t: { sectionId: 's', name: 'Click', click: { ...click, extra: 1 }, length48: 5 } },
        layers: {},
      },
      'replace',
    );
    const imported = readSnapshot(target).tracks[0]!;
    expect(imported.click).toEqual(click);
    expect(imported.length48).toBe(clickLength48(click));
  });
});
