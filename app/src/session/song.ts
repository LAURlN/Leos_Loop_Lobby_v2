/**
 * Full-song playback plan: the sections in their tab order, back to back.
 * Each section plays for as long as its longest loop (tracks with audible
 * takes only); sections without any are skipped. Positions are canonical
 * frames from the start of the song. Song playback is local, like the
 * section transport: nothing about it is shared (docs/SYNC_MODEL.md).
 */
import { hasAudio, type SessionSnapshot, type TrackState } from './schema';

export interface SongSegment {
  sectionId: string;
  /** Song position (canonical frames) where the section starts. */
  start48: number;
  length48: number;
  /** Tracks that sound in this section, in display order. */
  tracks: TrackState[];
}

export interface SongPlan {
  segments: SongSegment[];
  total48: number;
  /** Sections left out because they have no audible loop. */
  skipped: string[];
}

export function songPlan(snapshot: SessionSnapshot): SongPlan {
  const segments: SongSegment[] = [];
  const skipped: string[] = [];
  let start48 = 0;
  for (const section of snapshot.sections) {
    const tracks = snapshot.tracks.filter((t) => t.sectionId === section.id && t.length48 !== null && hasAudio(t));
    const length48 = Math.max(0, ...tracks.map((t) => t.length48 ?? 0));
    if (length48 <= 0) {
      skipped.push(section.id);
      continue;
    }
    segments.push({ sectionId: section.id, start48, length48, tracks });
    start48 += length48;
  }
  return { segments, total48: start48, skipped };
}

/** Index of the segment playing at `pos48`, or -1 outside the song. */
export function segmentAt(plan: SongPlan, pos48: number): number {
  return plan.segments.findIndex((s) => pos48 >= s.start48 && pos48 < s.start48 + s.length48);
}
