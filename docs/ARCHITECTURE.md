# Architecture

```
┌──────────────────────────── browser (one per player) ─────────────────────────────┐
│                                                                                   │
│  Svelte UI (app/src/App.svelte, ui/components)                                    │
│        │ reads reactive state, calls intents                                      │
│        ▼                                                                          │
│  Lobby controller (state/lobby.svelte.ts)                                         │
│        │                    │                        │                            │
│        ▼                    ▼                        ▼                            │
│  session/actions.ts   session/looper.ts        net/roomSession.ts                 │
│  (only writer of      (tap → take → layer)     (Yjs sync, presence, audio         │
│   the Yjs doc)              │                   exchange over a Transport)        │
│        │                    │                        │                            │
│        ▼                    ▼                        ▼                            │
│  Y.Doc ──snapshot──► session/audioSync.ts      net/relayTransport.ts (WebSocket)  │
│                             │                   [next: WebRTC P2P transport]      │
│                             ▼                                                     │
│                      audio/engine.ts ── AudioWorklets (audio/worklet/processors)  │
│                      track chains + effects (effects/*)                           │
└───────────────────────────────────────────────────────────────────────────────────┘
                                   │ wss
                                   ▼
               Cloudflare Worker + Durable Object per room (relay/)
               dumb router: peers, broadcast / direct, join/leave events
```

## Packages

| Path | What | Depends on |
|---|---|---|
| `shared/` | Pure TS: timing law, relay wire protocol, ids. No DOM, no deps. | – |
| `app/` | The web app (Vite + Svelte 5). | shared, yjs, y-protocols |
| `relay/` | Cloudflare Worker + Durable Object room relay. | shared |

`shared/src/timing.ts` is also imported by the AudioWorklet, which has no
`TextEncoder`/DOM; import it via `@lll/shared/timing` there, never the index.

## app/src layout

| Folder | Responsibility | Rules |
|---|---|---|
| `audio/` | AudioContext, worklets, mic capture, track chains, calibration | Knows nothing about sessions or the network. |
| `effects/` | Declarative effect definitions + registry | One file per effect. UI and sync derive from it. |
| `session/` | Yjs schema, actions, the looper state machine, audio sync, layer audio store & codec, project files | Only `actions.ts` writes the doc. |
| `net/` | Transport interface, relay transport, room session, blob exchange | Speaks only through `Transport`. |
| `state/` | App controller (`Lobby`) with Svelte runes, device settings | The only bridge between UI and everything else. |
| `ui/` | Components, canvas disc renderer, spectrogram, palette | No Yjs, no AudioEngine imports. |

## Data flow of a take

1. `TrackCard` `pointerdown` → `lobby.tapTrack(id, event.timeStamp)`.
2. `Looper.tap` converts the timestamp to the heard frame, holds mic audio in
   `MicCapture` (with 100 ms pre-roll).
3. Second tap → wait until mic audio up to `stop + roundTrip` has arrived,
   cut it, resample to 48 kHz, map to loop positions (`capturePosition`),
   fold (`foldTake`), store audio in `LayerAudioStore`, `addLayer` in the doc.
4. Doc update → `Lobby.refreshSnapshot` → `AudioSync.apply` remixes the track
   and posts the new buffer to its `TrackPlayer` worklet; the UI gets a new
   spectrogram.
5. In a room, `RoomSession` broadcasts the Yjs update. Peers see the layer,
   miss its audio, and `BlobExchange` fetches it (author first, then anyone).

For the first longer free auto-snapped take, `session/phraseAlignment.ts`
chooses phrase zero by whole common periods of the backing loops (ADR 0010).
`Looper` moves the one local origin along with the take's capture mapping,
preserving live alignment while avoiding reversed halves on song playback.

## Networking

- **Relay protocol** (`shared/src/protocol.ts`): binary frames
  `[version][addrLen][addr][payload]`; the relay replaces the address with the
  sender id. JSON text frames for `welcome`/`peer-joined`/`peer-left`/`error`.
  The relay never parses payloads, so the app protocol can evolve freely.
- **App protocol** (`net/roomSession.ts`): `[varuint channel][data]`;
  channel 0 = y-protocols sync, 1 = awareness, 2 = blob exchange. Unknown
  channels are ignored (forward compatible).
- **Reconnects**: `RelayTransport` retries with backoff; on `welcome` the
  session re-syncs with every peer (Yjs state vectors make this cheap).
- **Rooms are ephemeral**: the Durable Object stores nothing. State lives in
  the clients; a room ends when the last player leaves. Everyone keeps their
  local copy after leaving.
- **Free-tier friendly**: WebSocket hibernation + auto-response pings, no
  storage, messages throttled at the source (sliders ~16/s).

### Planned: WebRTC peer-to-peer (see ROADMAP)

Add `net/p2pTransport.ts` implementing `Transport` with one `RTCDataChannel`
per peer, using the relay for signaling (a new channel number), and a
`CompositeTransport` that prefers P2P per peer and falls back to the relay.
Because the CRDT tolerates duplicates and any delivery order, no other code
needs to change.

## Full song view

The "Song" tab (`ui/components/SongView.svelte`) shows all sections in order
on a timeline and plays them back to back. `session/song.ts` decides the
arrangement (each section as long as its longest loop, silent ones skipped);
`AudioSync` has a song mode that gives each section's tracks a play window in
the worklet, so section changes are sample-accurate. See ADR 0007.

Song recording (`session/songRecording.ts`, ADR 0009) captures against that
same local song origin and splits one resampled take at section boundaries.
`actions.addSongTake` atomically creates ordinary section-length tracks and
layers. Their optional `songTake` flag disables extra play-window fades, so
internal splits do not dip in volume. Stop/pause saves; arrangement timing
changes or replacing the session cancel capture and any pending finalization.

## Metronome tracks

A track with a `click` field (`session/click.ts`: bpm, beats, unit,
subdivision) is a metronome track. Only the pattern is shared; `AudioSync`
renders one bar of clicks locally and feeds it to the track chain like a
mixed loop, so mix, effects, solo and the song view work unchanged. Its disc
toggles mute instead of recording. See ADR 0008.

## Performance notes

- Discs (`ui/discRenderer.ts`): the spectrogram ring is painted once per mix
  and spun with a CSS transform; the overlay canvas repaints only on change or
  while it animates. All discs share one frame loop (`ui/frameLoop.ts`) that
  skips off-screen cards and reads the audio clock once per frame.
- `session/loopMix.ts` adds a new take onto the previous mix instead of
  re-summing every take.
- Avoid `backdrop-filter` over the track grid: it re-renders every frame the
  discs move.

## Project files

Settings -> Project exports the whole session as a `.lll` file (zip with a JSON
dump of the doc plus layer audio) and imports it, replacing the session or
adding its sections. Format and compatibility rules: `session/projectFile.ts`
and ADR 0006.

## Testing

- `npm test` runs Vitest over `shared`, `app` and `relay`.
- Pure logic is tested directly (timing law, lengths, codec, calibration
  analysis, mic capture, CRDT convergence incl. v1 regressions).
- `net/memoryTransport.ts` simulates the relay in-process;
  `net/roomSession.test.ts` runs full multi-client sessions over it.
- Manual/automated browser testing without a microphone: open the app with
  `?testmic` to replace the mic by a synthetic pulse signal.
