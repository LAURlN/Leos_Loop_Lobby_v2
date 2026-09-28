import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANONICAL_RATE } from '@lll/shared';
import { addLayer, createSection, createTrack, initSession, undoLayer } from './actions';
import { readSnapshot } from './schema';
import { segmentAt, songPlan } from './song';

const S = CANONICAL_RATE;

function take(doc: Y.Doc, trackId: string, length48: number, author = 'u') {
  addLayer(doc, { id: Math.random().toString(36).slice(2), trackId, author, authorName: 'U', offset: 0, frames: 10, length48 });
}

describe('songPlan', () => {
  it('plays sections in tab order, each as long as its longest loop, skipping silent ones', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const a = readSnapshot(doc).sections[0]!.id;
    const empty = createSection(doc, { name: 'Empty', createdBy: 'u' });
    const b = createSection(doc, { name: 'B', createdBy: 'u' });
    const a1 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: false }, createdBy: 'u', sectionId: a });
    const a2 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: false }, createdBy: 'u', sectionId: a });
    const b1 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: false }, createdBy: 'u', sectionId: b });
    createTrack(doc, { lengthSpec: { kind: 'seconds', seconds: 9 }, createdBy: 'u', sectionId: empty }); // length, no audio
    take(doc, a1, 2 * S);
    take(doc, a2, 4 * S);
    take(doc, b1, 3 * S);

    const plan = songPlan(readSnapshot(doc));
    expect(plan.segments.map((s) => [s.sectionId, s.start48, s.length48])).toEqual([
      [a, 0, 4 * S],
      [b, 4 * S, 3 * S],
    ]);
    expect(plan.total48).toBe(7 * S);
    expect(plan.skipped).toEqual([empty]);
    expect(plan.segments[0]!.tracks.map((t) => t.id)).toEqual([a1, a2]);
    expect(segmentAt(plan, 0)).toBe(0);
    expect(segmentAt(plan, 4 * S - 1)).toBe(0);
    expect(segmentAt(plan, 4 * S)).toBe(1);
    expect(segmentAt(plan, 7 * S)).toBe(-1);
  });

  it('ignores tracks whose takes are all undone', () => {
    const doc = new Y.Doc();
    initSession(doc);
    const a = readSnapshot(doc).sections[0]!.id;
    const t1 = createTrack(doc, { lengthSpec: { kind: 'seconds', seconds: 8 }, createdBy: 'u', sectionId: a });
    const t2 = createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: false }, createdBy: 'u', sectionId: a });
    take(doc, t1, 8 * S);
    take(doc, t2, 2 * S);
    undoLayer(doc, t1, 'u');
    expect(songPlan(readSnapshot(doc)).total48).toBe(2 * S);
  });
});
