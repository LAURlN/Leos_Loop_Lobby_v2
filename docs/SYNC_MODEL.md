# Sync model: loops without synchronized clocks

This is the most important document in the repo. Read it before touching
timing, recording, the audio engine or networking.

## The law

> **Shared data describes *where in the loop* audio belongs, never *when* it happened.**

- Every track has a loop length `length48` in **canonical frames** (48 kHz,
  regardless of the device's sample rate).
- Every recorded take (a *layer*) stores its audio plus `offset`: the loop
  position of its first sample. Audio longer than one cycle is folded
  (summed) into one cycle when it is recorded.
- Every device runs **its own transport**: one local `origin` frame. It
  renders every track at

  ```
  position(localFrame) = ((localFrame - origin) * 48000 / localRate) mod length48
  ```

- A microphone sample captured at local frame `g` belongs to loop position
  `position(g - roundTrip)`, where `roundTrip` is this device's measured
  output+input latency. That is the only latency compensation there is.

Code: `shared/src/timing.ts` (`renderPosition`, `capturePosition`, `foldTake`),
tested in `shared/src/timing.test.ts`.

## Why this works without clock sync

Device B starts its transport at an arbitrary moment. Compared with device A
it therefore hears the *whole set of loops rotated* by some amount. A rotated
loop is musically the same loop. When B plays along with what it hears and
records, `capturePosition` maps B's take to exactly the loop positions B heard,
which are the same positions in the data that A plays. So A hears B's take in
time, although neither device ever knew the other's clock.

This also holds for tracks with different lengths (½×, 2×, 3×, …): all tracks
on one device derive from the same `origin`, so their *relative* alignment is
the same everywhere; only the common rotation differs.

Consequences:

- Network latency is irrelevant for timing. It only affects how soon a new
  take shows up on other devices.
- Nobody hears anybody live. That is by design (see ADR 0002).
- There is no "host clock", no ping-based offset estimation, no drift
  correction. Do not add any; it is what made v1 fragile.

## Which frame is "now"?

- `AudioEngine.heardFrameAt(performanceTime)` converts a UI event timestamp to
  the local frame that was audible at that moment (via
  `AudioContext.getOutputTimestamp()`). Taps use `pointerdown` +
  `event.timeStamp` for precision.
- The **first take** of a session on a device sets `origin` to the heard frame
  of the start tap, so loop position 0 is where the player pressed.
- A device that joins a session with existing loops sets `origin` to "now".
  Any value is valid (see above).
- When no track has a length anymore, the origin is cleared.

## Sample rates

Stored audio is always 48 kHz mono. The track player worklet reads the
canonical buffer with a fractional step (`48000 / localRate`) and linear
interpolation, so a 44.1 kHz device never accumulates drift between tracks.
Recording resamples mic audio to 48 kHz before folding it into a layer.

## Latency

`roundTrip` = speaker → air/ear → instrument → mic → app. It is measured per
audio route by the acoustic calibration (`audio/calibration.ts`: sweeps,
cross-correlation, consistency check) and stored in `localStorage`. Before
calibration the app estimates it from `AudioContext.outputLatency`/`baseLatency`
and shows a warning. Users can fine-tune it manually.

Browser voice processing (`echoCancellation`, `noiseSuppression`,
`autoGainControl`) is always disabled: it destroys music and adds variable
delay.

## Shared state

The session is a Yjs CRDT (`session/schema.ts`). Rules:

1. Everything is keyed by random ids, never by array index.
2. Layer audio is immutable and addressed by layer id. Only metadata lives in
   the CRDT. Undo = `hidden: true`; nothing mutates audio.
3. All writes go through `session/actions.ts`.
4. Deleting a track deletes its map entry; concurrent edits to a deleted track
   are dropped by the CRDT (no resurrection; see tests).

Presence (who is recording where, names) is ephemeral and goes through
y-protocols awareness, not the document.
