/**
 * Layout of the shared session document (a Yjs CRDT) and a typed, immutable
 * snapshot of it for the UI and the audio engine.
 *
 *   doc.getMap('meta')    referenceLength48, beatsPerLoop, schema
 *   doc.getMap('tracks')  trackId -> Y.Map (fields of TrackState, effects: Y.Map)
 *   doc.getMap('layers')  layerId -> Y.Map (fields of LayerState)
 *
 * Rules (see docs/SYNC_MODEL.md):
 * - Everything is keyed by random ids, never by index.
 * - Layer audio is immutable and lives outside the doc (LayerAudioStore);
 *   the doc only holds metadata. Undo hides a layer, it never mutates audio.
 * - Only session/actions.ts writes to the doc.
 */
import * as Y from 'yjs';
import type { LengthSpec } from '@lll/shared';
import { readClick, type ClickPattern } from './click';

export const SCHEMA_VERSION = 1;
export const DEFAULT_BEATS_PER_LOOP = 4;

export interface SectionState {
  id: string;
  name: string;
  order: number;
  referenceLength48: number | null;
  beatsPerLoop: number;
  createdBy: string;
}

export interface EffectState {
  id: string;
  type: string;
  enabled: boolean;
  order: number;
  params: Record<string, number>;
}

export interface LayerState {
  id: string;
  trackId: string;
  /** User id of the recording player (for per-player undo). */
  author: string;
  authorName: string;
  /** Per-author increasing counter, orders the author's own takes. */
  seq: number;
  /** Loop position (canonical frames) of data[0]. */
  offset: number;
  frames: number;
  gain: number;
  hidden: boolean;
  /**
   * Set on a take that was flattened by the loop studio: the takes it hides.
   * Undoing the flattened take shows them again (actions.undoLayer), so
   * "Save to loop" stays undoable.
   */
  replaced: string[];
}

export interface TrackState {
  id: string;
  sectionId: string;
  name: string;
  color: number;
  order: number;
  lengthSpec: LengthSpec;
  /** Loop length in canonical frames; null until the first take (free tracks). */
  length48: number | null;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  createdBy: string;
  /** Set for metronome tracks: the loop is this click pattern, not takes (session/click.ts). */
  click: ClickPattern | null;
  /** A section slice of a continuous song take; no extra play-window fades. */
  songTake?: boolean;
  effects: EffectState[];
  /** All layers of this track including hidden ones, oldest first. */
  layers: LayerState[];
}

export interface SessionSnapshot {
  sections: SectionState[];
  /** Length of the first recorded loop; other tracks relate to it. */
  referenceLength48: number | null;
  beatsPerLoop: number;
  tracks: TrackState[];
}

export type YTrack = Y.Map<unknown>;
export type YLayer = Y.Map<unknown>;
export type YSection = Y.Map<unknown>;

export function roots(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>('meta'),
    tracks: doc.getMap<YTrack>('tracks'),
    layers: doc.getMap<YLayer>('layers'),
    sections: doc.getMap<YSection>('sections'),
  };
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback = false) => (typeof v === 'boolean' ? v : fallback);

export function readLengthSpec(v: unknown): LengthSpec {
  const o = v as Partial<LengthSpec> | undefined;
  if (o?.kind === 'ratio' && typeof o.num === 'number' && typeof o.den === 'number') {
    return { kind: 'ratio', num: o.num, den: o.den };
  }
  if (o?.kind === 'seconds' && typeof o.seconds === 'number') return { kind: 'seconds', seconds: o.seconds };
  return { kind: 'free', autoSnap: o?.kind === 'free' ? o.autoSnap !== false : true };
}

function readEffects(v: unknown): EffectState[] {
  if (!(v instanceof Y.Map)) return [];
  const out: EffectState[] = [];
  for (const [id, raw] of (v as Y.Map<unknown>).entries()) {
    if (!(raw instanceof Y.Map)) continue;
    const e = raw as Y.Map<unknown>;
    const params = e.get('params');
    out.push({
      id,
      type: str(e.get('type')),
      enabled: bool(e.get('enabled'), true),
      order: num(e.get('order'), 0),
      params: params instanceof Y.Map ? (params.toJSON() as Record<string, number>) : {},
    });
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function readLayer(id: string, l: YLayer): LayerState {
  const replaced = l.get('replaced');
  return {
    id,
    trackId: str(l.get('trackId')),
    author: str(l.get('author')),
    authorName: str(l.get('authorName'), 'Player'),
    seq: num(l.get('seq'), 0),
    offset: num(l.get('offset'), 0),
    frames: num(l.get('frames'), 0),
    gain: num(l.get('gain'), 1),
    hidden: bool(l.get('hidden')),
    replaced: Array.isArray(replaced) ? replaced.filter((v): v is string => typeof v === 'string') : [],
  };
}

/** Builds a plain, immutable snapshot of the whole session. Cheap enough to run on every change. */
export function readSnapshot(doc: Y.Doc): SessionSnapshot {
  const { meta, tracks, layers, sections } = roots(doc);
  const layersByTrack = new Map<string, LayerState[]>();
  for (const [id, l] of layers.entries()) {
    const layer = readLayer(id, l);
    const list = layersByTrack.get(layer.trackId) ?? [];
    list.push(layer);
    layersByTrack.set(layer.trackId, list);
  }

  const sectionList: SectionState[] = [];
  for (const [id, s] of sections.entries()) {
    const ref = s.get('referenceLength48');
    sectionList.push({
      id,
      name: str(s.get('name'), '1'),
      order: num(s.get('order'), 0),
      referenceLength48: typeof ref === 'number' && ref > 0 ? ref : null,
      beatsPerLoop: num(s.get('beatsPerLoop'), DEFAULT_BEATS_PER_LOOP),
      createdBy: str(s.get('createdBy')),
    });
  }
  sectionList.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // If no sections exist yet (e.g. uninitialized doc), provide a default section
  const fallbackSectionId = sectionList[0]?.id ?? 'default';
  if (sectionList.length === 0) {
    const ref = meta.get('referenceLength48');
    sectionList.push({
      id: fallbackSectionId,
      name: '1',
      order: 0,
      referenceLength48: typeof ref === 'number' && ref > 0 ? ref : null,
      beatsPerLoop: num(meta.get('beatsPerLoop'), DEFAULT_BEATS_PER_LOOP),
      createdBy: '',
    });
  }

  const validSectionIds = new Set(sectionList.map((s) => s.id));
  const trackList: TrackState[] = [];
  for (const [id, t] of tracks.entries()) {
    const length = t.get('length48');
    const rawSectionId = str(t.get('sectionId'));
    const sectionId = validSectionIds.has(rawSectionId) ? rawSectionId : fallbackSectionId;
    trackList.push({
      id,
      sectionId,
      name: str(t.get('name'), 'Track'),
      color: num(t.get('color'), 0),
      order: num(t.get('order'), 0),
      lengthSpec: readLengthSpec(t.get('lengthSpec')),
      length48: typeof length === 'number' && length > 0 ? length : null,
      volume: num(t.get('volume'), 1),
      pan: num(t.get('pan'), 0),
      mute: bool(t.get('mute')),
      solo: bool(t.get('solo')),
      createdBy: str(t.get('createdBy')),
      click: readClick(t.get('click')),
      songTake: t.get('songTake') === true,
      effects: readEffects(t.get('effects')),
      layers: (layersByTrack.get(id) ?? []).sort((a, b) => a.seq - b.seq || a.author.localeCompare(b.author)),
    });
  }
  trackList.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const ref = meta.get('referenceLength48');
  return {
    sections: sectionList,
    referenceLength48: typeof ref === 'number' && ref > 0 ? ref : null,
    beatsPerLoop: num(meta.get('beatsPerLoop'), DEFAULT_BEATS_PER_LOOP),
    tracks: trackList,
  };
}

export const visibleLayers = (t: TrackState) => t.layers.filter((l) => !l.hidden);
/** Whether the track makes sound: visible takes, or a metronome pattern. */
export const hasAudio = (t: TrackState) => t.click !== null || t.layers.some((l) => !l.hidden);
