# ADR 0008: Metronome tracks

- Status: accepted (2026-09-29)

## Context
The built-in click (settings) follows the first loop and is local to each
player. Musicians also want a click as part of the song: set a tempo and
rhythm up front, record against it, mix it and hear it in the full song.

## Decision
1. **A metronome track is a normal track with a `click` field**
   `{ bpm, beats, unit, subdivision }` (`session/click.ts`). Its loop is one
   bar: `beats * 60 / bpm` seconds; BPM counts the beat unit (quarter or eighth).
2. **Only the pattern is shared.** Every device renders the same clicks
   locally (`renderClick`), so no audio is sent and edits apply instantly.
   The rendered bar goes through the normal track chain: volume, pan, mute,
   solo, effects, song view.
3. **It sets the grid of an empty section**: the first sounding track of a
   section sets its reference length (one bar) and beats per loop, so free
   takes snap to whole bars. Tempo changes move the grid only while nothing
   else in the section sounds; recorded loops never change length.
4. A tempo suggested from an existing first loop is stored unrounded, so the
   click reproduces that loop's length exactly (no drift).
5. Tapping its disc toggles mute; there is nothing to record on it.

## Consequences
- Forward compatible: older clients ignore `click` and see an empty,
  fixed-length track (its `lengthSpec` is `seconds`). They could record onto
  it; newer clients would then play only the click, as the field wins.
- Project files carry the field unchanged (validated on import).
