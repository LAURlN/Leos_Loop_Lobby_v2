# ADR 0010: Choose the first longer phrase's cycle

- Status: accepted (2026-09-29)

## Context
A one-cycle backing loop does not distinguish odd and even cycles. Previously,
a first two-cycle auto-snapped take starting on an odd cycle stored its first
half at position one cycle. Song playback starts at zero, so it played the
second half first, depending on how long the player waited before recording.

## Decision
When a free auto-snapped track first acquires its length, find the common
period (least common multiple) of every sounding backing loop in its section,
including muted loops. If the new length is a larger exact multiple of that
period, choose the backing downbeat nearest the start tap as phrase zero.
Subtract that whole-period shift from the new take's capture positions and
move the device's single local origin by the same amount, if still playing
that section with the same origin. Existing backing audio and offsets do not
change, and the backing sounds identical because its lengths divide the shift.

The shift is computed from the tap, not the pre-roll sample. Slightly early
taps retain their pickup; late taps retain their offset within the base cycle.
Established track lengths, overdubs, unsnapped takes and backing loops without
a compatible common period keep the original timing behavior. A peer's length
claim during microphone-tail finalization also takes precedence.

## Consequences
- Song playback and section restart begin with the new phrase's first cycle.
- No per-track clock, shared timestamp, new stored field, or audio rewrite.
- The player's continuous section playback remains aligned after committing.
- Existing saved takes are unchanged; their intended first cycle was not stored
  separately, so this change applies when recording a new auto-snapped track.
