# ADR 0009: Continuous recording in the song view

- Status: accepted (2026-09-29)

## Context
Players want to perform across sections and hear the same performance when
the full song plays back. Folding the performance into shorter backing loops
would repeat or overlap phrases; fading every split would create audible dips.

## Decision
1. Record from the local song playhead, starting playback if paused. Capture
   against the song's local origin with the device's round-trip compensation
   fixed for the take. No shared timestamps or clock synchronization.
2. Resample the take once to 48 kHz, then split at canonical section boundaries.
   Each crossed section receives a new fixed-length track as long as that
   section, with one immutable layer at the section-relative offset. Partial
   sections retain silence before/after the take. Skip empty sections just as
   playback does. Existing loops are untouched; all slices commit in one action.
3. Apply 5 ms fades only at the whole take's outer edges. The optional boolean
   track field `songTake` disables additional worklet play-window fades on these
   tracks. Old clients ignore the field and still play the ordinary loops.
   Import validates it; copies preserve it. No project container format change.
4. Stop recording or pause to save early; leaving the song view also saves.
   Seeking/restarting is disabled during capture/finalization. A timer independent
   of the UI stops at the exact song end, capped at the existing ten-minute take
   limit. A delayed timer cannot capture beyond that endpoint.
5. Changing section order/lengths cancels a take rather than saving it against
   a different arrangement. Replacing/clearing the session, calibration and mic
   changes cancel too, including pending microphone-tail waits. Mix/name edits
   are allowed. The normal layer undo, audio exchange and project file paths apply.

## Consequences
- Song takes consume one section-length mixed loop per crossed section.
- Recording requires an existing arrangement (loops or metronome tracks).
- The record button and `R` shortcut start/stop; Space pauses and saves.
- This supersedes ADR 0007's restriction on recording in the song view.
