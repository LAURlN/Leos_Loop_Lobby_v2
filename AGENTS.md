# Working on Leo's Loop Lobby

Guide for humans and AI agents continuing this project. Keep it current when
you change architecture or conventions.

## Read first

1. [docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) – the timing law. Breaking it breaks multiplayer.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – modules, data flow, networking.
3. [docs/decisions/](docs/decisions) – ADRs. Add one for every big decision.

## Commands

```bash
npm install
npm run dev:relay   # local relay (wrangler dev :8787)
npm run dev         # app (Vite :5173, proxies /room to the relay)
npm test            # Vitest: shared + app + relay
npm run check       # svelte-check + tsc for all packages
npm run build       # production build (BASE_PATH, VITE_RELAY_URL env vars)
```

Before finishing any change: `npm test && npm run check` must pass.
Browser testing without a mic: open `/?testmic`. Two tabs = two players.

## Invariants (do not break)

- **No clock sync.** Shared data stores loop positions, never times. Each
  device has one transport origin for all tracks. Latency compensation is only
  the device's own round trip. No host clock, ping offsets or drift correction.
- **Canonical audio**: 48 kHz mono, lengths in canonical frames. Convert only
  at the edges (worklet playback, recording).
- **Ids, not indexes.** Tracks, layers and effects are addressed by random ids.
- **Layer audio is immutable.** Undo hides a layer; nothing rewrites audio.
- **Only `app/src/session/actions.ts` writes the Yjs document.** Validate and
  clamp inputs there.
- **`audio/` knows nothing about sessions/network; `ui/` never imports Yjs or
  the AudioEngine.** Go through `state/lobby.svelte.ts`.
- **The worklet imports only `@lll/shared/timing`** (no DOM/TextEncoder there).
- **The relay stays dumb and stateless**: no payload parsing, no storage.
- **Project files stay readable forever** (ADR 0006): old files must keep
  importing; newer files import with unknown parts ignored.
- **Protocols are forward compatible**: unknown channels/effects/fields are
  ignored, never fatal. Never rename stored ids (`type`, param `id`, map keys).

## How to…

### Add an effect
1. Create `app/src/effects/<name>.ts` exporting an `EffectDefinition`
   (params with ranges/defaults/format, optional presets, `create()` building
   Web Audio nodes; `set()` must be cheap and smooth).
2. Append it to `EFFECTS` in `app/src/effects/registry.ts`.
That's all: editor UI, disc sticker, validation and sync derive from it.

### Add a shared setting
Add the field to `schema.ts` (read with a default in `readSnapshot`), write it
only via a new function in `actions.ts`, expose an intent on `Lobby`, then use
it in the UI. Old clients ignore unknown fields.

### Add a network message type
Add a channel constant in `net/roomSession.ts` and handle it in `receive`.
Never reuse a channel number. Keep messages small (<60 kB) for WebRTC later.

### Change the project file format
Read ADR 0006 first. Bump `PROJECT_FORMAT_VERSION` in
`session/projectFile.ts`, add a new frozen fixture test (never edit the old
ones), and bump `minReaderVersion` only if older apps would misread the file.
New shared fields need nothing: they are exported and preserved automatically;
validate them in `actions.importProject`.

### Add a transport (e.g. WebRTC)
Implement `Transport` from `net/transport.ts`; see ARCHITECTURE.md "Planned".

## Code style

- TypeScript strict, `noUncheckedIndexedAccess`. No `any`.
- Svelte 5 runes (`$state`, `$derived`, `$props`), callback props for events.
- Comment the *why* at module tops and for non-obvious logic; keep it short.
- Pure logic goes into testable modules with a `*.test.ts` next to it.
- UI text is English.
