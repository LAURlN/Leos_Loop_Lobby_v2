# ADR 0007: Full song view and song playback

- Status: accepted (2026-09-28)

## Context
Sections (ADR 0005) hold the parts of a song, but there was no way to hear
them in order. Musicians want an arrangement overview (Audacity-like) and to
play the whole song through.

## Decision
1. **A "Song" tab left of the section tabs** switches the main area to a
   timeline (`ui/components/SongView.svelte`): sections in tab order as blocks,
   one waveform lane per sounding track, loops repeated across the block, a
   ruler, a playhead, click-to-seek. The top bar transport becomes
   Start / Pause / Play. The view stays open while playing; opening a section
   (tab or "Open") leaves it.
2. **Arrangement rule** (`session/song.ts`, pure and tested): each section
   plays once for as long as its longest loop that has audible takes;
   sections without one are skipped. Nothing new is stored in the document,
   so the song follows every edit, and old/new clients stay compatible.
3. **Song playback is local**, like the section transport. No clock sync, no
   shared playhead (SYNC_MODEL.md still holds): within a section all tracks
   share one origin, the section start, so their relative alignment is exactly
   what players recorded against.
4. **Sample-accurate section changes in the worklet**: the track player accepts
   an optional play window `[start, end)` (5 ms edge fades); the metronome
   accepts a list of per-section segments. The main thread only sends windows,
   never switches sections on a timer.
5. **Song mode in `AudioSync`**: chains for all sounding tracks of all sections
   (mixes/effects as usual, solo scoped per section); leaving restores the
   section transport. Recording is not possible in the song view.

## Consequences
- Effects tails (reverb, delay) ring into the next section naturally.
- Longer songs keep one mixed buffer per sounding track in memory while the
  song view is open.
- Later: per-section repeat counts or a stored arrangement order would be new
  optional fields on sections (old clients ignore them); export of the song as
  WAV can reuse `songPlan`.
