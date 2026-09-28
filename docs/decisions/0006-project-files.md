# ADR 0006: Project files (export / import)

- Status: accepted (2026-09-28)

## Context
Sessions live only in memory and in the Yjs document of the players in a room.
Musicians want to keep a jam, move it to another device and continue it later,
possibly in a much newer version of the app.

## Decision
1. **One file, `.lll`**: a zip archive (via `fflate`) containing
   `project.json`, one `audio/<layerId>.lla` per layer (the existing LLA codec
   from `session/codec.ts`, stored uncompressed in the zip because the codec
   already deflates) and a `README.txt`. A custom extension instead of `.zip`
   stops browsers from auto-extracting it. Code: `session/projectFile.ts`.
2. **The session is a plain JSON dump of the Yjs roots** (`meta`, `sections`,
   `tracks`, `layers`), keyed by id with the Yjs field names. No Yjs binary
   update: JSON stays readable by any future version (or by hand), whatever
   happens to Yjs, and does not carry CRDT history into a room.
3. **Versioning**: `formatVersion` (grows with every format change) and
   `minReaderVersion` (grows only for changes that old readers would
   misread). A reader refuses a file only when `minReaderVersion` is higher
   than what it supports, and says "update the app".
4. **Forward compatible reading**: unknown zip entries, JSON fields, effect
   types and effect params are ignored for playback, but unknown *fields* are
   carried into the doc so a round trip through an older app does not lose
   them. Layers with missing or undecodable audio (e.g. a future codec) are
   dropped with a notice; the rest of the project still imports.
5. **Backward compatible reading**: every version must keep reading every older
   format. `projectFile.test.ts` contains a frozen format-1 file that must
   never be edited.
6. **Import goes through `actions.importProject`** (the only doc writer),
   which validates and clamps every known field. All ids are replaced by fresh
   random ids first (`withFreshIds`) so imports never collide with ids that
   exist or existed in the session, and the audio is put into the
   `LayerAudioStore` before the doc changes. Two modes: *replace* (like
   "Delete all tracks", applies to everyone in a room) and *append* (adds the
   project's sections after the current ones). In a room, peers fetch the
   imported audio from the importer through the normal blob exchange.
7. **Export includes hidden (undone) takes** so redo keeps working, and skips
   layers whose audio has not arrived on this device yet (with a notice).

## Consequences
- Files are small (compressed PCM16) and inspectable with any unzip tool.
- Changing the format means: bump `PROJECT_FORMAT_VERSION`, add a frozen test
  fixture for the new version, and bump `minReaderVersion` only if old readers
  would silently get it wrong.
- Per-device settings (latency, name, metronome volume) are not part of a
  project.
