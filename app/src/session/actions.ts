/**
 * The only place that writes to the shared session document.
 * Every function is one Yjs transaction, validates its input and is safe to
 * call concurrently on many devices (the CRDT merges the results).
 */
import * as Y from 'yjs';
import { clampLength, predefinedLength, randomId, type LengthSpec } from '@lll/shared';
import { clampParam, defaultParams, getEffect, normalizeParams } from '../effects/registry';
import { DEFAULT_BEATS_PER_LOOP, SCHEMA_VERSION, readLayer, roots, type YLayer, type YTrack } from './schema';

/** Transaction origin for local edits (the network layer forwards these). */
export const LOCAL = 'local';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function initSession(doc: Y.Doc): void {
  doc.transact(() => {
    const { meta } = roots(doc);
    meta.set('schema', SCHEMA_VERSION);
    if (!meta.has('beatsPerLoop')) meta.set('beatsPerLoop', DEFAULT_BEATS_PER_LOOP);
  }, LOCAL);
}

export interface CreateTrackOptions {
  lengthSpec: LengthSpec;
  createdBy: string;
  name?: string;
}

export function createTrack(doc: Y.Doc, options: CreateTrackOptions): string {
  const id = randomId();
  doc.transact(() => {
    const { meta, tracks } = roots(doc);
    let maxOrder = -1;
    for (const t of tracks.values()) maxOrder = Math.max(maxOrder, Number(t.get('order') ?? 0));
    const order = maxOrder + 1;
    const ref = meta.get('referenceLength48');
    const length = predefinedLength(options.lengthSpec, typeof ref === 'number' ? ref : null);
    const track: YTrack = new Y.Map();
    track.set('name', options.name?.trim() || `Track ${tracks.size + 1}`);
    track.set('color', order);
    track.set('order', order);
    track.set('lengthSpec', options.lengthSpec);
    track.set('length48', length);
    track.set('volume', 1);
    track.set('pan', 0);
    track.set('mute', false);
    track.set('solo', false);
    track.set('createdBy', options.createdBy);
    track.set('effects', new Y.Map());
    tracks.set(id, track);
  }, LOCAL);
  return id;
}

export function deleteTrack(doc: Y.Doc, trackId: string): void {
  doc.transact(() => {
    const { tracks, layers } = roots(doc);
    tracks.delete(trackId);
    for (const [id, l] of [...layers.entries()]) if (l.get('trackId') === trackId) layers.delete(id);
    resetReferenceIfUnused(doc);
  }, LOCAL);
}

export function renameTrack(doc: Y.Doc, trackId: string, name: string): void {
  const t = roots(doc).tracks.get(trackId);
  const clean = name.trim().slice(0, 40);
  if (t && clean) doc.transact(() => t.set('name', clean), LOCAL);
}

export interface TrackMix {
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
}

export function setTrackMix(doc: Y.Doc, trackId: string, mix: TrackMix): void {
  const t = roots(doc).tracks.get(trackId);
  if (!t) return;
  doc.transact(() => {
    if (mix.volume !== undefined && Number.isFinite(mix.volume)) t.set('volume', clamp(mix.volume, 0, 2));
    if (mix.pan !== undefined && Number.isFinite(mix.pan)) t.set('pan', clamp(mix.pan, -1, 1));
    if (mix.mute !== undefined) t.set('mute', mix.mute);
    if (mix.solo !== undefined) t.set('solo', mix.solo);
  }, LOCAL);
}

export interface NewLayer {
  id: string;
  trackId: string;
  author: string;
  authorName: string;
  offset: number;
  frames: number;
  /** Loop length decided by this take (only used if the track has none yet). */
  length48: number;
}

/**
 * Commits a recorded take. Sets the track length (first take) and the session
 * reference length (first take ever) if they are still unset.
 * Returns false if the track was deleted in the meantime.
 */
export function addLayer(doc: Y.Doc, layer: NewLayer): boolean {
  let ok = false;
  doc.transact(() => {
    const { meta, tracks, layers } = roots(doc);
    const track = tracks.get(layer.trackId);
    if (!track) return;
    const length = clampLength(layer.length48);
    if (typeof track.get('length48') !== 'number') track.set('length48', length);
    if (typeof meta.get('referenceLength48') !== 'number') meta.set('referenceLength48', length);
    let seq = 0;
    for (const [id, l] of layers.entries()) {
      const s = readLayer(id, l);
      if (s.author === layer.author) seq = Math.max(seq, s.seq);
    }
    const y: YLayer = new Y.Map();
    y.set('trackId', layer.trackId);
    y.set('author', layer.author);
    y.set('authorName', layer.authorName);
    y.set('seq', seq + 1);
    y.set('offset', Math.round(layer.offset));
    y.set('frames', Math.round(layer.frames));
    y.set('gain', 1);
    y.set('hidden', false);
    layers.set(layer.id, y);
    ok = true;
  }, LOCAL);
  return ok;
}

function ownLayers(doc: Y.Doc, trackId: string, author: string) {
  return [...roots(doc).layers.entries()]
    .map(([id, l]) => ({ y: l, s: readLayer(id, l) }))
    .filter(({ s }) => s.trackId === trackId && s.author === author)
    .sort((a, b) => a.s.seq - b.s.seq);
}

/** Hides the author's newest visible take on a track. Returns its id, or null. */
export function undoLayer(doc: Y.Doc, trackId: string, author: string): string | null {
  const visible = ownLayers(doc, trackId, author).filter(({ s }) => !s.hidden);
  const last = visible[visible.length - 1];
  if (!last) return null;
  doc.transact(() => last.y.set('hidden', true), LOCAL);
  return last.s.id;
}

/** Re-shows the author's most recently undone take, if nothing newer was recorded since. */
export function redoLayer(doc: Y.Doc, trackId: string, author: string): string | null {
  const own = ownLayers(doc, trackId, author);
  const newestVisibleSeq = Math.max(0, ...own.filter(({ s }) => !s.hidden).map(({ s }) => s.seq));
  const candidates = own.filter(({ s }) => s.hidden && s.seq > newestVisibleSeq);
  const first = candidates[0];
  if (!first) return null;
  doc.transact(() => first.y.set('hidden', false), LOCAL);
  return first.s.id;
}

export function canRedo(doc: Y.Doc, trackId: string, author: string): boolean {
  const own = ownLayers(doc, trackId, author);
  const newestVisibleSeq = Math.max(0, ...own.filter(({ s }) => !s.hidden).map(({ s }) => s.seq));
  return own.some(({ s }) => s.hidden && s.seq > newestVisibleSeq);
}

/** Removes every take on a track. Free tracks forget their length so the next take decides again. */
export function clearTrack(doc: Y.Doc, trackId: string): void {
  doc.transact(() => {
    const { tracks, layers } = roots(doc);
    const track = tracks.get(trackId);
    for (const [id, l] of [...layers.entries()]) if (l.get('trackId') === trackId) layers.delete(id);
    const spec = track?.get('lengthSpec') as LengthSpec | undefined;
    if (track && (!spec || spec.kind === 'free')) track.set('length48', null);
    resetReferenceIfUnused(doc);
  }, LOCAL);
}

/** Deletes everything and starts over with one empty track. */
export function clearSession(doc: Y.Doc, createdBy: string): void {
  doc.transact(() => {
    const { meta, tracks, layers } = roots(doc);
    for (const id of [...layers.keys()]) layers.delete(id);
    for (const id of [...tracks.keys()]) tracks.delete(id);
    meta.delete('referenceLength48');
  }, LOCAL);
  createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy });
}

/** Once no track has a length anymore, the next take becomes the new reference. */
function resetReferenceIfUnused(doc: Y.Doc): void {
  const { meta, tracks } = roots(doc);
  const anyLength = [...tracks.values()].some((t) => typeof t.get('length48') === 'number');
  if (!anyLength) meta.delete('referenceLength48');
}

export function setBeatsPerLoop(doc: Y.Doc, beats: number): void {
  if (!Number.isFinite(beats)) return;
  doc.transact(() => roots(doc).meta.set('beatsPerLoop', clamp(Math.round(beats), 1, 64)), LOCAL);
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function effectsOf(doc: Y.Doc, trackId: string): Y.Map<Y.Map<unknown>> | null {
  const effects = roots(doc).tracks.get(trackId)?.get('effects');
  return effects instanceof Y.Map ? (effects as Y.Map<Y.Map<unknown>>) : null;
}

export function addEffect(doc: Y.Doc, trackId: string, type: string): string | null {
  const def = getEffect(type);
  const effects = effectsOf(doc, trackId);
  if (!def || !effects) return null;
  const id = randomId();
  doc.transact(() => {
    let maxOrder = -1;
    for (const e of effects.values()) maxOrder = Math.max(maxOrder, Number(e.get('order') ?? 0));
    const e = new Y.Map<unknown>();
    e.set('type', type);
    e.set('enabled', true);
    e.set('order', maxOrder + 1);
    const params = new Y.Map<number>();
    for (const [k, v] of Object.entries(defaultParams(def))) params.set(k, v);
    e.set('params', params);
    effects.set(id, e);
  }, LOCAL);
  return id;
}

export function removeEffect(doc: Y.Doc, trackId: string, effectId: string): void {
  const effects = effectsOf(doc, trackId);
  if (effects) doc.transact(() => effects.delete(effectId), LOCAL);
}

export function setEffectEnabled(doc: Y.Doc, trackId: string, effectId: string, enabled: boolean): void {
  const e = effectsOf(doc, trackId)?.get(effectId);
  if (e) doc.transact(() => e.set('enabled', enabled), LOCAL);
}

export function setEffectParams(doc: Y.Doc, trackId: string, effectId: string, values: Record<string, number>): void {
  const e = effectsOf(doc, trackId)?.get(effectId);
  const def = e && getEffect(String(e.get('type')));
  const params = e?.get('params');
  if (!def || !(params instanceof Y.Map)) return;
  doc.transact(() => {
    for (const [k, v] of Object.entries(values)) {
      const clamped = clampParam(def, k, v);
      if (clamped !== null) (params as Y.Map<number>).set(k, clamped);
    }
  }, LOCAL);
}

export function applyEffectPreset(doc: Y.Doc, trackId: string, effectId: string, presetName: string): void {
  const e = effectsOf(doc, trackId)?.get(effectId);
  const def = e && getEffect(String(e.get('type')));
  const preset = def?.presets?.find((p) => p.name === presetName);
  if (def && preset) setEffectParams(doc, trackId, effectId, normalizeParams(def, preset.values));
}
