/**
 * The only place that writes to the shared session document.
 * Every function is one Yjs transaction, validates its input and is safe to
 * call concurrently on many devices (the CRDT merges the results).
 */
import * as Y from 'yjs';
import { clampLength, predefinedLength, randomId, type LengthSpec } from '@lll/shared';
import { clampParam, defaultParams, getEffect, normalizeParams } from '../effects/registry';
import type { LayerAudioStore } from './layerAudio';
import {
  DEFAULT_BEATS_PER_LOOP,
  SCHEMA_VERSION,
  readLayer,
  readLengthSpec,
  roots,
  type YLayer,
  type YSection,
  type YTrack,
} from './schema';

/** Transaction origin for local edits (the network layer forwards these). */
export const LOCAL = 'local';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function initSession(doc: Y.Doc): void {
  doc.transact(() => {
    const { meta, sections } = roots(doc);
    meta.set('schema', SCHEMA_VERSION);
    if (!meta.has('beatsPerLoop')) meta.set('beatsPerLoop', DEFAULT_BEATS_PER_LOOP);
    if (sections.size === 0) {
      createSection(doc, { name: '1', createdBy: '' });
    }
  }, LOCAL);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface CreateSectionOptions {
  name?: string;
  createdBy: string;
}

export function createSection(doc: Y.Doc, options: CreateSectionOptions): string {
  const id = randomId();
  doc.transact(() => {
    const { sections, meta } = roots(doc);
    let maxOrder = -1;
    const existingNumbers: number[] = [];
    for (const s of sections.values()) {
      maxOrder = Math.max(maxOrder, Number(s.get('order') ?? 0));
      const n = parseInt(String(s.get('name') ?? ''), 10);
      if (Number.isFinite(n)) existingNumbers.push(n);
    }
    const order = maxOrder + 1;
    let name = options.name?.trim();
    if (!name) {
      let num = 1;
      while (existingNumbers.includes(num)) num++;
      name = String(num);
    }
    const sec: YSection = new Y.Map();
    sec.set('name', name.slice(0, 40));
    sec.set('order', order);
    sec.set('beatsPerLoop', Number(meta.get('beatsPerLoop') ?? DEFAULT_BEATS_PER_LOOP));
    sec.set('createdBy', options.createdBy);
    sections.set(id, sec);
  }, LOCAL);
  return id;
}

function normalizeSectionOrders(doc: Y.Doc): void {
  const { sections } = roots(doc);
  const list = [...sections.entries()]
    .map(([id, s]) => ({ id, s, order: Number(s.get('order') ?? 0) }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  list.forEach(({ s }, i) => {
    if (s.get('order') !== i) s.set('order', i);
  });
}

export function deleteSection(doc: Y.Doc, sectionId: string): boolean {
  let ok = false;
  doc.transact(() => {
    const { sections, tracks, layers } = roots(doc);
    if (sections.size <= 1) return; // Keep at least one section
    if (!sections.has(sectionId)) return;

    for (const [tId, t] of [...tracks.entries()]) {
      if (t.get('sectionId') === sectionId) {
        tracks.delete(tId);
        for (const [lId, l] of [...layers.entries()]) {
          if (l.get('trackId') === tId) layers.delete(lId);
        }
      }
    }

    sections.delete(sectionId);
    normalizeSectionOrders(doc);
    resetReferenceIfUnused(doc);
    ok = true;
  }, LOCAL);
  return ok;
}

export function renameSection(doc: Y.Doc, sectionId: string, name: string): void {
  const sec = roots(doc).sections.get(sectionId);
  const clean = name.trim().slice(0, 40);
  if (sec && clean) doc.transact(() => sec.set('name', clean), LOCAL);
}

export function reorderSection(doc: Y.Doc, sectionId: string, targetIndex: number): void {
  doc.transact(() => {
    const { sections } = roots(doc);
    const list = [...sections.entries()]
      .map(([id, s]) => ({ id, s, order: Number(s.get('order') ?? 0) }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const currentIndex = list.findIndex((x) => x.id === sectionId);
    if (currentIndex === -1) return;
    const clampedTarget = Math.max(0, Math.min(list.length - 1, targetIndex));
    if (currentIndex === clampedTarget) return;

    const [moved] = list.splice(currentIndex, 1);
    if (moved) list.splice(clampedTarget, 0, moved);
    list.forEach(({ s }, i) => s.set('order', i));
  }, LOCAL);
}

export function moveSection(doc: Y.Doc, sectionId: string, direction: 'left' | 'right'): void {
  const { sections } = roots(doc);
  const list = [...sections.entries()]
    .map(([id, s]) => ({ id, s, order: Number(s.get('order') ?? 0) }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const currentIndex = list.findIndex((x) => x.id === sectionId);
  if (currentIndex === -1) return;
  const targetIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
  reorderSection(doc, sectionId, targetIndex);
}

export function setSectionBeatsPerLoop(doc: Y.Doc, sectionId: string, beats: number): void {
  if (!Number.isFinite(beats)) return;
  const sec = roots(doc).sections.get(sectionId);
  if (sec) doc.transact(() => sec.set('beatsPerLoop', clamp(Math.round(beats), 1, 64)), LOCAL);
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface CreateTrackOptions {
  lengthSpec: LengthSpec;
  createdBy: string;
  name?: string;
  sectionId?: string;
}

export function createTrack(doc: Y.Doc, options: CreateTrackOptions): string {
  const id = randomId();
  doc.transact(() => {
    const { meta, tracks, sections } = roots(doc);
    let sectionId = options.sectionId;
    if (!sectionId) {
      if (sections.size === 0) {
        sectionId = createSection(doc, { name: '1', createdBy: options.createdBy });
      } else {
        const sorted = [...sections.entries()]
          .map(([sId, s]) => ({ id: sId, order: Number(s.get('order') ?? 0) }))
          .sort((a, b) => a.order - b.order);
        sectionId = sorted[0]?.id ?? createSection(doc, { name: '1', createdBy: options.createdBy });
      }
    }
    const section = sections.get(sectionId);
    let maxOrder = -1;
    for (const t of tracks.values()) {
      if (t.get('sectionId') === sectionId) {
        maxOrder = Math.max(maxOrder, Number(t.get('order') ?? 0));
      }
    }
    const order = maxOrder + 1;
    const ref = section?.get('referenceLength48') ?? meta.get('referenceLength48');
    const length = predefinedLength(options.lengthSpec, typeof ref === 'number' ? ref : null);
    const track: YTrack = new Y.Map();
    track.set('sectionId', sectionId);
    track.set('name', options.name?.trim() || `Track ${maxOrder + 2}`);
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
    const t = tracks.get(trackId);
    const sectionId = t?.get('sectionId') as string | undefined;
    tracks.delete(trackId);
    for (const [id, l] of [...layers.entries()]) if (l.get('trackId') === trackId) layers.delete(id);
    resetReferenceIfUnused(doc, sectionId);
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
 * Commits a recorded take. Sets the track length (first take), the section
 * reference length and the session reference length if they are still unset.
 * Returns false if the track was deleted in the meantime.
 */
export function addLayer(doc: Y.Doc, layer: NewLayer): boolean {
  let ok = false;
  doc.transact(() => {
    const { tracks, layers } = roots(doc);
    const track = tracks.get(layer.trackId);
    if (!track) return;
    const length = clampLength(layer.length48);
    claimLength(doc, track, length);
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
    // The loop length this take was recorded against, so redo can restore it.
    y.set('length48', length);
    layers.set(layer.id, y);
    ok = true;
  }, LOCAL);
  return ok;
}

/** Gives a track without length (and its section / the session, if unset) a loop length. */
function claimLength(doc: Y.Doc, track: YTrack, length: number): void {
  const { meta, sections } = roots(doc);
  if (typeof track.get('length48') !== 'number') track.set('length48', length);
  const sectionId = track.get('sectionId') as string | undefined;
  const section = sectionId ? sections.get(sectionId) : undefined;
  if (section && typeof section.get('referenceLength48') !== 'number') section.set('referenceLength48', length);
  if (typeof meta.get('referenceLength48') !== 'number') meta.set('referenceLength48', length);
}

/** A free track whose takes are all gone or undone forgets its length, so the next take decides again. */
function releaseLengthIfEmpty(doc: Y.Doc, trackId: string): void {
  const { tracks, layers } = roots(doc);
  const track = tracks.get(trackId);
  const spec = track?.get('lengthSpec') as LengthSpec | undefined;
  if (!track || (spec && spec.kind !== 'free')) return;
  for (const l of layers.values()) if (l.get('trackId') === trackId && l.get('hidden') !== true) return;
  track.set('length48', null);
  resetReferenceIfUnused(doc, track.get('sectionId') as string | undefined);
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
  doc.transact(() => {
    last.y.set('hidden', true);
    releaseLengthIfEmpty(doc, trackId);
  }, LOCAL);
  return last.s.id;
}

/** Re-shows the author's most recently undone take, if nothing newer was recorded since. */
export function redoLayer(doc: Y.Doc, trackId: string, author: string): string | null {
  const own = ownLayers(doc, trackId, author);
  const newestVisibleSeq = Math.max(0, ...own.filter(({ s }) => !s.hidden).map(({ s }) => s.seq));
  const candidates = own.filter(({ s }) => s.hidden && s.seq > newestVisibleSeq);
  const first = candidates[0];
  if (!first) return null;
  doc.transact(() => {
    const track = roots(doc).tracks.get(trackId);
    const stored = first.y.get('length48');
    // Takes from before the length was stored on the layer: their audio is at most one loop long.
    if (track) claimLength(doc, track, clampLength(typeof stored === 'number' ? stored : first.s.frames));
    first.y.set('hidden', false);
  }, LOCAL);
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
    const sectionId = track?.get('sectionId') as string | undefined;
    for (const [id, l] of [...layers.entries()]) if (l.get('trackId') === trackId) layers.delete(id);
    releaseLengthIfEmpty(doc, trackId);
    resetReferenceIfUnused(doc, sectionId);
  }, LOCAL);
}

/** Copies a loop (track) with all its effects and layers to another section. */
export function copyTrackToSection(
  doc: Y.Doc,
  trackId: string,
  targetSectionId: string,
  createdBy: string,
  store?: LayerAudioStore,
): string | null {
  const { tracks, layers, sections } = roots(doc);
  const srcTrack = tracks.get(trackId);
  if (!srcTrack) return null;
  const targetSection = sections.get(targetSectionId);
  if (!targetSection) return null;

  const newTrackId = randomId();
  doc.transact(() => {
    let maxOrder = -1;
    for (const t of tracks.values()) {
      if (t.get('sectionId') === targetSectionId) {
        maxOrder = Math.max(maxOrder, Number(t.get('order') ?? 0));
      }
    }
    const order = maxOrder + 1;

    const newTrack: YTrack = new Y.Map();
    newTrack.set('sectionId', targetSectionId);
    newTrack.set('name', srcTrack.get('name') ?? 'Track');
    newTrack.set('color', Number(srcTrack.get('color') ?? order));
    newTrack.set('order', order);
    newTrack.set('lengthSpec', srcTrack.get('lengthSpec'));
    const length48 = srcTrack.get('length48');
    newTrack.set('length48', length48);
    newTrack.set('volume', Number(srcTrack.get('volume') ?? 1));
    newTrack.set('pan', Number(srcTrack.get('pan') ?? 0));
    newTrack.set('mute', Boolean(srcTrack.get('mute')));
    newTrack.set('solo', Boolean(srcTrack.get('solo')));
    newTrack.set('createdBy', createdBy);

    if (typeof length48 === 'number' && typeof targetSection.get('referenceLength48') !== 'number') {
      targetSection.set('referenceLength48', length48);
    }

    const newEffects = new Y.Map<Y.Map<unknown>>();
    const srcEffects = srcTrack.get('effects');
    if (srcEffects instanceof Y.Map) {
      for (const [, rawFx] of srcEffects.entries()) {
        if (!(rawFx instanceof Y.Map)) continue;
        const newFxId = randomId();
        const fxMap = new Y.Map<unknown>();
        fxMap.set('type', rawFx.get('type'));
        fxMap.set('enabled', rawFx.get('enabled'));
        fxMap.set('order', rawFx.get('order'));
        const srcParams = rawFx.get('params');
        const paramsMap = new Y.Map<number>();
        if (srcParams instanceof Y.Map) {
          for (const [k, v] of srcParams.entries()) {
            paramsMap.set(k, v);
          }
        }
        fxMap.set('params', paramsMap);
        newEffects.set(newFxId, fxMap);
      }
    }
    newTrack.set('effects', newEffects);
    tracks.set(newTrackId, newTrack);

    for (const [srcLayerId, l] of layers.entries()) {
      if (l.get('trackId') === trackId) {
        const newLayerId = randomId();
        const newLayer: YLayer = new Y.Map();
        newLayer.set('trackId', newTrackId);
        newLayer.set('author', l.get('author'));
        newLayer.set('authorName', l.get('authorName'));
        newLayer.set('seq', l.get('seq'));
        newLayer.set('offset', l.get('offset'));
        newLayer.set('frames', l.get('frames'));
        newLayer.set('gain', l.get('gain'));
        newLayer.set('hidden', l.get('hidden'));
        if (typeof l.get('length48') === 'number') newLayer.set('length48', l.get('length48'));
        layers.set(newLayerId, newLayer);

        if (store) {
          const pcm = store.get(srcLayerId);
          if (pcm) store.put(newLayerId, pcm);
          const encoded = store.getEncoded(srcLayerId);
          if (encoded) {
            encoded.then((bytes) => store.putEncoded(newLayerId, bytes));
          }
        }
      }
    }
  }, LOCAL);

  return newTrackId;
}

export function copyTracksToSection(
  doc: Y.Doc,
  trackIds: string[],
  targetSectionId: string,
  createdBy: string,
  store?: LayerAudioStore,
): string[] {
  const created: string[] = [];
  for (const tId of trackIds) {
    const newId = copyTrackToSection(doc, tId, targetSectionId, createdBy, store);
    if (newId) created.push(newId);
  }
  return created;
}

/** Deletes everything and starts over with one empty section and track. */
export function clearSession(doc: Y.Doc, createdBy: string): void {
  doc.transact(() => {
    const { meta, tracks, layers, sections } = roots(doc);
    for (const id of [...layers.keys()]) layers.delete(id);
    for (const id of [...tracks.keys()]) tracks.delete(id);
    for (const id of [...sections.keys()]) sections.delete(id);
    meta.delete('referenceLength48');
    const firstSectionId = createSection(doc, { name: '1', createdBy });
    createTrack(doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy, sectionId: firstSectionId });
  }, LOCAL);
}

// ---------------------------------------------------------------------------
// Project import
// ---------------------------------------------------------------------------

const SECTION_FIELDS = new Set(['name', 'order', 'referenceLength48', 'beatsPerLoop', 'createdBy']);
const TRACK_FIELDS = new Set([
  'sectionId', 'name', 'color', 'order', 'lengthSpec', 'length48', 'volume', 'pan', 'mute', 'solo', 'createdBy', 'effects',
]);
const LAYER_FIELDS = new Set(['trackId', 'author', 'authorName', 'seq', 'offset', 'frames', 'gain', 'hidden', 'length48']);
const EFFECT_FIELDS = new Set(['type', 'enabled', 'order', 'params']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const text = (v: unknown, fallback: string, max = 40) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback);
const lengthOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? clampLength(v) : null);

/** Keeps fields a newer version wrote, so re-exporting does not lose them. */
function copyUnknownFields(target: Y.Map<unknown>, source: Record<string, unknown>, known: Set<string>): void {
  for (const [k, v] of Object.entries(source)) {
    if (known.has(k) || v === undefined) continue;
    const json = JSON.stringify(v);
    if (json !== undefined) target.set(k, JSON.parse(json) as unknown);
  }
}

function importEffects(raw: unknown): Y.Map<Y.Map<unknown>> {
  const effects = new Y.Map<Y.Map<unknown>>();
  if (!isRecord(raw)) return effects;
  for (const [id, e] of Object.entries(raw)) {
    if (!isRecord(e) || typeof e.type !== 'string' || !e.type) continue;
    const def = getEffect(e.type);
    const y = new Y.Map<unknown>();
    copyUnknownFields(y, e, EFFECT_FIELDS);
    y.set('type', e.type);
    y.set('enabled', typeof e.enabled === 'boolean' ? e.enabled : true);
    y.set('order', finite(e.order, 0));
    // Unknown effect types and params stay untouched; a newer version knows them.
    const values: Record<string, number> = def ? defaultParams(def) : {};
    for (const [k, v] of Object.entries(isRecord(e.params) ? e.params : {})) {
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = def ? (clampParam(def, k, v) ?? v) : v;
    }
    const params = new Y.Map<number>();
    for (const [k, v] of Object.entries(values)) params.set(k, v);
    y.set('params', params);
    effects.set(id, y);
  }
  return effects;
}

export interface ImportedProject {
  meta: Record<string, unknown>;
  sections: Record<string, Record<string, unknown>>;
  tracks: Record<string, Record<string, unknown>>;
  layers: Record<string, Record<string, unknown>>;
}

/**
 * Writes an imported project (session/projectFile.ts) into the session.
 * The ids must be fresh (`withFreshIds`) and the layer audio already in the
 * store. `replace` swaps out the whole session (for everyone in a room);
 * `append` adds the project's sections after the existing ones.
 * Returns the ids of the imported sections in order.
 */
export function importProject(doc: Y.Doc, project: ImportedProject, mode: 'replace' | 'append'): string[] {
  const sectionOrder: string[] = [];
  doc.transact(() => {
    const { meta, tracks, layers, sections } = roots(doc);
    if (mode === 'replace') {
      for (const id of [...layers.keys()]) layers.delete(id);
      for (const id of [...tracks.keys()]) tracks.delete(id);
      for (const id of [...sections.keys()]) sections.delete(id);
      meta.delete('referenceLength48');
      const beats = finite(project.meta.beatsPerLoop, DEFAULT_BEATS_PER_LOOP);
      meta.set('beatsPerLoop', clamp(Math.round(beats), 1, 64));
    }
    meta.set('schema', SCHEMA_VERSION);
    let nextOrder = 0;
    for (const s of sections.values()) nextOrder = Math.max(nextOrder, finite(s.get('order'), 0) + 1);

    // Sections, in their saved order. A project without sections (older
    // format) gets one, like readSnapshot's fallback.
    const sourceSections = Object.entries(project.sections).sort(
      ([a, x], [b, y]) => finite(x.order, 0) - finite(y.order, 0) || a.localeCompare(b),
    );
    if (sourceSections.length === 0) {
      sourceSections.push([
        randomId(),
        {
          name: '1',
          referenceLength48: project.meta.referenceLength48,
          beatsPerLoop: project.meta.beatsPerLoop,
        },
      ]);
    }
    for (const [id, s] of sourceSections) {
      const y: YSection = new Y.Map();
      copyUnknownFields(y, s, SECTION_FIELDS);
      y.set('name', text(s.name, String(sectionOrder.length + 1)));
      y.set('order', nextOrder++);
      const ref = lengthOrNull(s.referenceLength48);
      if (ref !== null) y.set('referenceLength48', ref);
      y.set('beatsPerLoop', clamp(Math.round(finite(s.beatsPerLoop, DEFAULT_BEATS_PER_LOOP)), 1, 64));
      y.set('createdBy', typeof s.createdBy === 'string' ? s.createdBy : '');
      sections.set(id, y);
      sectionOrder.push(id);
    }
    const sectionIds = new Set(sectionOrder);

    for (const [id, t] of Object.entries(project.tracks)) {
      const y: YTrack = new Y.Map();
      copyUnknownFields(y, t, TRACK_FIELDS);
      const sectionId = typeof t.sectionId === 'string' && sectionIds.has(t.sectionId) ? t.sectionId : sectionOrder[0]!;
      y.set('sectionId', sectionId);
      y.set('name', text(t.name, 'Track'));
      y.set('color', Math.round(finite(t.color, 0)));
      y.set('order', finite(t.order, 0));
      y.set('lengthSpec', readLengthSpec(t.lengthSpec));
      y.set('length48', lengthOrNull(t.length48));
      y.set('volume', clamp(finite(t.volume, 1), 0, 2));
      y.set('pan', clamp(finite(t.pan, 0), -1, 1));
      y.set('mute', t.mute === true);
      y.set('solo', t.solo === true);
      y.set('createdBy', typeof t.createdBy === 'string' ? t.createdBy : '');
      y.set('effects', importEffects(t.effects));
      tracks.set(id, y);
    }

    for (const [id, l] of Object.entries(project.layers)) {
      const trackId = typeof l.trackId === 'string' ? l.trackId : '';
      const frames = Math.round(finite(l.frames, 0));
      if (!tracks.has(trackId) || frames <= 0) continue;
      const y: YLayer = new Y.Map();
      copyUnknownFields(y, l, LAYER_FIELDS);
      y.set('trackId', trackId);
      y.set('author', typeof l.author === 'string' ? l.author : '');
      y.set('authorName', text(l.authorName, 'Player'));
      y.set('seq', Math.round(finite(l.seq, 0)));
      y.set('offset', Math.round(finite(l.offset, 0)));
      y.set('frames', frames);
      y.set('gain', clamp(finite(l.gain, 1), 0, 4));
      y.set('hidden', l.hidden === true);
      const loop = lengthOrNull(l.length48);
      if (loop !== null) y.set('length48', loop);
      layers.set(id, y);
    }

    // A track with audio but no length cannot play; give it its longest layer's length.
    for (const [trackId, t] of tracks.entries()) {
      if (typeof t.get('length48') === 'number') continue;
      let longest = 0;
      for (const l of layers.values()) {
        if (l.get('trackId') === trackId && l.get('hidden') !== true) longest = Math.max(longest, Number(l.get('frames')));
      }
      if (longest > 0) t.set('length48', clampLength(longest));
    }
    for (const sectionId of sectionOrder) {
      const sec = sections.get(sectionId);
      if (!sec || typeof sec.get('referenceLength48') === 'number') continue;
      const first = [...tracks.values()].find(
        (t) => t.get('sectionId') === sectionId && typeof t.get('length48') === 'number',
      );
      if (first) sec.set('referenceLength48', first.get('length48'));
    }
    if (typeof meta.get('referenceLength48') !== 'number') {
      const ref = lengthOrNull(project.meta.referenceLength48) ?? sections.get(sectionOrder[0]!)?.get('referenceLength48');
      if (typeof ref === 'number') meta.set('referenceLength48', ref);
    }
    resetReferenceIfUnused(doc);
  }, LOCAL);
  return sectionOrder;
}

/** Once no track in a section or in the session has a length anymore, reset reference. */
function resetReferenceIfUnused(doc: Y.Doc, sectionId?: string): void {
  const { meta, tracks, sections } = roots(doc);
  const checkSection = (secId: string) => {
    const sec = sections.get(secId);
    if (!sec) return;
    const anyInSection = [...tracks.values()].some(
      (t) => t.get('sectionId') === secId && typeof t.get('length48') === 'number',
    );
    if (!anyInSection) sec.delete('referenceLength48');
  };
  if (sectionId) {
    checkSection(sectionId);
  } else {
    for (const secId of sections.keys()) checkSection(secId);
  }
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

