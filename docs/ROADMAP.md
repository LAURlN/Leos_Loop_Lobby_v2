# Roadmap

Status as of the first v2 milestone. Items carried over from v1's
`roadmap.txt` are marked (v1).

## Done

- Solo looper: tracks with free / auto-snap / ratio / fixed-seconds lengths,
  overdub layers, per-player undo/redo, clear, delete, rename (v1: name loops)
- Pre-roll (100 ms) and round-trip latency compensation
- Acoustic latency calibration + manual fine-tune + "not calibrated" warning (v1)
- Effects: EQ, reverb (with presets), delay, overdrive; declarative registry
- Mix: volume (default 1.0, v1), pan, mute, solo
- Metronome following the first loop (shared beats per loop)
- Multiplayer rooms via Cloudflare relay: codes, invite links, presence
  ("X is recording on track 2", v1), late join with audio transfer
- Listen-only mode without microphone; `?testmic` synthetic input
- One responsive UI for phone and desktop; keyboard shortcuts on desktop
- GitHub Pages deployment workflow

## Next

1. **WebRTC P2P transport** with relay fallback (see ARCHITECTURE.md).
2. **Save / load sessions locally** (IndexedDB) and **export** as WAV (per track
   and mixdown) (v1: save projects, mp3 export). Opus/MP3 via WebCodecs later.
3. **Beat-match refinement** from v1: correlate the newest take's onsets with
   the rest of the track and offer to shift it (updates `layer.offset`) and to
   adjust the latency profile.
4. **PWA offline support** (service worker) so solo mode works without network.
5. **Quantized start/stop** for ratio/seconds tracks (start at the next cycle).
6. **Compressed layer codec** (Opus via WebCodecs, codec id 2 in `codec.ts`).
7. **Loop editing**: trim/extend, shift, per-layer gain (v1: edit loops,
   lengthen/shorten).
8. **Input effects** (monitor chain) (v1).
9. **Song sections** / scenes (v1).
10. **Plugin effects**: load EffectDefinitions from URLs (v1: modding).
11. Better resampling (windowed sinc) for 44.1 kHz devices.

## Known limitations

- Browsers expose little about audio routes; latency profiles are keyed by
  mic label + output sink and may not notice e.g. switching speakers on phones.
- iOS: the mute switch is ignored while the mic is active; Bluetooth headsets
  switch to low-quality mic mode — prefer wired headphones.
- Rooms hold at most 8 players (mesh-friendly limit for the P2P phase).
- Layer audio is kept in memory only; very long sessions use a lot of RAM.
