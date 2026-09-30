# ADR 0011: Loop studio (waveform editing)

- Status: accepted (2026-09-30)

## Context
Loops come out of a performance, so they carry the usual human imperfections: a
bum note, an uneven level, a click at the seam, a bar of silence at the end.
Roadmap item 7 ("loop editing: trim/extend, shift, per-layer gain") asked for
this from the start, and v1 users asked for something like a very small
Audacity. The architecture makes the obvious implementation impossible on
purpose: layer audio is immutable, only `session/actions.ts` writes the
document, and every device must end up with the same result — including the
audio, which travels as whole layers over the blob exchange.

## Decision
1. **A working copy, not the takes.** `Lobby.studioSource(trackId)` mixes the
   track's audible takes into one buffer (canonical rate, mono) — the same
   thing `AudioSync` sends to the track worklet. The studio edits only that
   copy; nothing in the session changes until the user saves. Missing audio
   (still downloading) is reported and blocks saving, so an edit can never
   silently drop a take that had not arrived yet.
2. **Pure edit operations.** `session/studio.ts` is a pure buffer model: every
   operation takes a `Float32Array` and returns a new one (cut, paste as
   insert/replace, delete, silence, duplicate, reverse, insert/replace range,
   fade in/out/in-out, gain, normalize, resize, double, silence bounds,
   zero-crossing snap). The component keeps a bounded undo history
   (`MAX_HISTORY`); keeping buffers around is cheap and trivially correct.
   `ui/studioView.ts` holds the view maths (min/max envelope per pixel column,
   ruler steps, zoom/pan, time formatting).
3. **Saving is a flatten.** `actions.replaceTrackAudio` creates one new layer
   that spans the whole loop (`offset` 0, `gain` 1) and hides the takes it
   replaces. Those ids are stored on the new layer as `replaced`, so
   `undoLayer` shows them again and `redoLayer` hides them again: the panel's
   undo still works, and no audio was rewritten. The new layer is a normal
   take — the blob exchange ships it to peers, the effects chain processes it,
   the project file exports it.
4. **The loop length follows the edit.** Deleting time or trimming silence
   makes the loop shorter; `Double` makes it longer. Saving writes the new
   `length48` on the track. Edits that should not change the grid use
   *Silence* instead of *Delete*. The footer names the old and new length
   before saving; the section reference length is deliberately left alone, so
   other tracks keep their own loops untouched.
5. **Preview is a separate, dry path.** `AudioEngine.startPreview` plays the
   working buffer through source → gain → pan → loops bus (master volume
   applies, track effects do not). While the studio is open the section
   transport pauses (`App.openStudio`), so the loop is never heard twice, and
   `Cancel`/`Save` resume playback if it was playing before. Selection edges
   snap to the nearest zero crossing (±256 frames) so cuts do not click.
6. **Forward compatible.** `replaced` is a new, optional layer field: older
   clients ignore it (their undo simply leaves the replaced takes hidden), the
   project file carries it, `withFreshIds` remaps the ids on import, and
   `importProject` validates it (strings, capped at 64 ids).

## Consequences
- Saving merges every audible take of the loop — including other players'
  takes — into one take by the editing player. Everyone in the room sees the
  flatten; the replaced takes remain in the document (hidden) and in an
  exported project, so nothing is lost.
- Editing is not per-take yet (per-layer gain, shifting one take, trimming the
  audio of a single take). Those need layer-level edits and stay on the
  roadmap.
- A save uploads one new layer to peers (~96 kB/s of loop, PCM16) and keeps the
  replaced audio in memory; a long loop edited many times costs memory until
  the session is reloaded.
- Undo of a flattened take restores the takes, but not a loop length that the
  edit changed.
- The studio needs a finished loop: metronome tracks and tracks without a
  length or without takes cannot be opened.
