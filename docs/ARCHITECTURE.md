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
| `session/` | Yjs schema, actions, the looper state machine, audio sync, layer audio store & codec | Only `actions.ts` writes the doc. |
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

## Testing

- `npm test` runs Vitest over `shared`, `app` and `relay`.
- Pure logic is tested directly (timing law, lengths, codec, calibration
  analysis, mic capture, CRDT convergence incl. v1 regressions).
- `net/memoryTransport.ts` simulates the relay in-process;
  `net/roomSession.test.ts` runs full multi-client sessions over it.
- Manual/automated browser testing without a microphone: open the app with
  `?testmic` to replace the mic by a synthetic pulse signal.
