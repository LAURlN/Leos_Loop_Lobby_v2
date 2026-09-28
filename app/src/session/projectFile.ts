/**
 * Project files: the whole session (all sections, tracks, effects, layers and
 * their audio) in one file for export/import. See docs/decisions/0006.
 *
 * Container: a zip archive (extension .lll) with
 *   project.json          header + plain JSON dump of the session document
 *   audio/<layerId>.lla   layer audio in the LLA codec (session/codec.ts)
 *   README.txt            for humans who unzip it
 *
 * Compatibility rules (never break them):
 * - `formatVersion` grows with every format change; `minReaderVersion` only
 *   grows when old readers could no longer read the file correctly.
 * - Readers ignore unknown zip entries, unknown JSON fields, unknown effect
 *   types and undecodable audio (that layer is dropped, the import goes on).
 * - Stored field names are the Yjs field names; never rename them.
 * - Every reader keeps reading every older formatVersion (see the frozen
 *   fixture in projectFile.test.ts).
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type * as Y from 'yjs';
import { randomId } from '@lll/shared';
import type { LayerAudioStore } from './layerAudio';
import { SCHEMA_VERSION, roots } from './schema';

export const PROJECT_FORMAT = 'leos-loop-lobby-project';
/** Written into new files. */
export const PROJECT_FORMAT_VERSION = 1;
/** Highest `minReaderVersion` this build can read. */
export const PROJECT_READER_VERSION = 1;
export const PROJECT_EXTENSION = '.lll';

const MANIFEST = 'project.json';
const README = `Leo's Loop Lobby project file.
Import it in the app: Settings -> Project -> Import.

project.json holds the session (sections, tracks, effects, layers).
audio/*.lla holds each layer's audio: "LLA1" magic, codec byte
(0 = PCM16, 1 = PCM16 + raw deflate), u32 LE frame count, body. 48 kHz mono.
`;

export type JsonObject = Record<string, unknown>;

/** The session part of a project, keyed by id like the Yjs document. */
export interface ProjectContent {
  meta: JsonObject;
  sections: Record<string, JsonObject>;
  tracks: Record<string, JsonObject>;
  layers: Record<string, JsonObject>;
}

export interface ProjectData extends ProjectContent {
  formatVersion: number;
  /** Encoded layer audio (LLA codec) by layer id. */
  audio: Map<string, Uint8Array>;
}

export class ProjectFileError extends Error {}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function objectsOf(v: unknown): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {};
  if (!isObject(v)) return out;
  for (const [id, entry] of Object.entries(v)) if (isObject(entry)) out[id] = entry;
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportResult {
  bytes: Uint8Array;
  /** Layers left out because their audio has not arrived on this device yet. */
  missingAudio: number;
}

/** Serializes the whole session. Reads the doc only; never writes it. */
export async function exportProject(doc: Y.Doc, store: LayerAudioStore): Promise<ExportResult> {
  const r = roots(doc);
  const layers = r.layers.toJSON() as Record<string, JsonObject>;
  const files: Zippable = {};
  const audio: Record<string, string> = {};
  let missingAudio = 0;
  for (const id of Object.keys(layers)) {
    const bytes = await store.getEncoded(id);
    if (!bytes) {
      delete layers[id];
      missingAudio++;
      continue;
    }
    const path = `audio/${id}.lla`;
    audio[id] = path;
    // Layer audio is already compressed by its codec.
    files[path] = [bytes, { level: 0 }];
  }
  const manifest = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    minReaderVersion: 1,
    exportedAt: new Date().toISOString(),
    schema: SCHEMA_VERSION,
    session: {
      meta: r.meta.toJSON(),
      sections: r.sections.toJSON(),
      tracks: r.tracks.toJSON(),
      layers,
    },
    audio,
  };
  files[MANIFEST] = [strToU8(JSON.stringify(manifest)), { level: 6 }];
  files['README.txt'] = [strToU8(README), { level: 6 }];
  return { bytes: zipSync(files), missingAudio };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Reads and checks a project file. Throws ProjectFileError with a user-facing message. */
export function parseProject(bytes: Uint8Array): ProjectData {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ProjectFileError("This is not a Leo's Loop Lobby project file.");
  }
  const raw = entries[MANIFEST];
  let manifest: unknown;
  try {
    manifest = raw ? JSON.parse(strFromU8(raw)) : null;
  } catch {
    manifest = null;
  }
  if (!isObject(manifest) || manifest.format !== PROJECT_FORMAT) {
    throw new ProjectFileError("This is not a Leo's Loop Lobby project file.");
  }
  const minReader = typeof manifest.minReaderVersion === 'number' ? manifest.minReaderVersion : 1;
  if (minReader > PROJECT_READER_VERSION) {
    throw new ProjectFileError('This project was saved by a newer version of the app. Please update the app.');
  }
  const session = isObject(manifest.session) ? manifest.session : {};
  const audio = new Map<string, Uint8Array>();
  const audioPaths = isObject(manifest.audio) ? manifest.audio : {};
  for (const [layerId, path] of Object.entries(audioPaths)) {
    const data = typeof path === 'string' ? entries[path] : undefined;
    if (data) audio.set(layerId, data);
  }
  return {
    formatVersion: typeof manifest.formatVersion === 'number' ? manifest.formatVersion : 1,
    meta: isObject(session.meta) ? session.meta : {},
    sections: objectsOf(session.sections),
    tracks: objectsOf(session.tracks),
    layers: objectsOf(session.layers),
    audio,
  };
}

/**
 * Gives every section, track, effect and layer a new random id (and fixes the
 * references), so an import never collides with ids that exist or existed in
 * the session it goes into.
 */
export function withFreshIds(data: ProjectData): ProjectData {
  const sectionIds = new Map(Object.keys(data.sections).map((id) => [id, randomId()]));
  const trackIds = new Map(Object.keys(data.tracks).map((id) => [id, randomId()]));
  const sections: Record<string, JsonObject> = {};
  for (const [id, s] of Object.entries(data.sections)) sections[sectionIds.get(id)!] = { ...s };
  const tracks: Record<string, JsonObject> = {};
  for (const [id, t] of Object.entries(data.tracks)) {
    const effects: Record<string, JsonObject> = {};
    for (const e of Object.values(objectsOf(t.effects))) effects[randomId()] = e;
    const sectionId = typeof t.sectionId === 'string' ? sectionIds.get(t.sectionId) : undefined;
    tracks[trackIds.get(id)!] = { ...t, sectionId: sectionId ?? '', effects };
  }
  const layers: Record<string, JsonObject> = {};
  const audio = new Map<string, Uint8Array>();
  for (const [id, l] of Object.entries(data.layers)) {
    const trackId = typeof l.trackId === 'string' ? trackIds.get(l.trackId) : undefined;
    if (!trackId) continue;
    const newId = randomId();
    layers[newId] = { ...l, trackId };
    const bytes = data.audio.get(id);
    if (bytes) audio.set(newId, bytes);
  }
  return { ...data, sections, tracks, layers, audio };
}

/**
 * Decodes the layer audio into the store. Layers whose audio is missing or
 * undecodable (e.g. a codec from a newer version) are dropped; `frames` is
 * taken from the decoded audio. Returns the layers that can be imported.
 */
export async function loadProjectAudio(
  data: ProjectData,
  store: LayerAudioStore,
): Promise<{ content: ProjectContent; droppedLayers: number }> {
  const layers: Record<string, JsonObject> = {};
  let droppedLayers = 0;
  for (const [id, l] of Object.entries(data.layers)) {
    const bytes = data.audio.get(id);
    try {
      if (!bytes) throw new Error('missing');
      await store.putEncoded(id, bytes);
      const pcm = store.get(id);
      if (!pcm || pcm.length === 0) throw new Error('empty');
      layers[id] = { ...l, frames: pcm.length };
    } catch {
      droppedLayers++;
    }
  }
  return { content: { meta: data.meta, sections: data.sections, tracks: data.tracks, layers }, droppedLayers };
}

/** File name for a download, e.g. "loop-lobby-2026-09-28-1430.lll". */
export function projectFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `loop-lobby-${stamp}${PROJECT_EXTENSION}`;
}
