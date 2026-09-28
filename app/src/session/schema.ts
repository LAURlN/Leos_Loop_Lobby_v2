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

export const SCHEMA_VERSION = 1;
export const DEFAULT_BEATS_PER_LOOP = 4;

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
}

export interface TrackState {
  id: string;
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
  effects: EffectState[];
  /** All layers of this track including hidden ones, oldest first. */
  layers: LayerState[];
}

export interface SessionSnapshot {
  /** Length of the first recorded loop; other tracks relate to it. */
  referenceLength48: number | null;
  beatsPerLoop: number;
  tracks: TrackState[];
}

export type YTrack = Y.Map<unknown>;
export type YLayer = Y.Map<unknown>;

export function roots(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>('meta'),
    tracks: doc.getMap<YTrack>('tracks'),
    layers: doc.getMap<YLayer>('layers'),
  };
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback = false) => (typeof v === 'boolean' ? v : fallback);

function readLengthSpec(v: unknown): LengthSpec {
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
  };
}

/** Builds a plain, immutable snapshot of the whole session. Cheap enough to run on every change. */
export function readSnapshot(doc: Y.Doc): SessionSnapshot {
  const { meta, tracks, layers } = roots(doc);
  const layersByTrack = new Map<string, LayerState[]>();
  for (const [id, l] of layers.entries()) {
    const layer = readLayer(id, l);
    const list = layersByTrack.get(layer.trackId) ?? [];
    list.push(layer);
    layersByTrack.set(layer.trackId, list);
  }
  const trackList: TrackState[] = [];
  for (const [id, t] of tracks.entries()) {
    const length = t.get('length48');
    trackList.push({
      id,
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
      effects: readEffects(t.get('effects')),
      layers: (layersByTrack.get(id) ?? []).sort((a, b) => a.seq - b.seq || a.author.localeCompare(b.author)),
    });
  }
  trackList.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const ref = meta.get('referenceLength48');
  return {
    referenceLength48: typeof ref === 'number' && ref > 0 ? ref : null,
    beatsPerLoop: num(meta.get('beatsPerLoop'), DEFAULT_BEATS_PER_LOOP),
    tracks: trackList,
  };
}

export const visibleLayers = (t: TrackState) => t.layers.filter((l) => !l.hidden);
export const hasAudio = (t: TrackState) => t.layers.some((l) => !l.hidden);
