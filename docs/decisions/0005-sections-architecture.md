# ADR 0005: Sections architecture and loop isolation

- Status: accepted (2026-09-28)

## Context
Musicians often structure jams into distinct musical sections (e.g. verse, chorus, bridge)
and need the ability to work independently or together in different sections, copy
existing loops into a new section as a foundation, and develop them further without
modifying the original loops.

## Decision
1. **Sections in CRDT**: Sections are stored as top-level CRDT maps (`doc.getMap('sections')`)
   keyed by random IDs, each with `name`, `order`, `referenceLength48`, `beatsPerLoop`,
   and `createdBy`.
2. **Tracks scoped to section**: Every track stores a `sectionId`. If omitted, it falls
   back to the session's first section for backward compatibility.
3. **Local active section**: Each device/player maintains their own local active section.
   The audio engine (`AudioSync`) strictly renders and loops only tracks belonging to the
   player's active section.
4. **Loop copying with deep isolation**: When copying a loop from one section to another,
   a new track is created in the target section with a new random ID. Its effects are deep-cloned
   with new effect IDs, and all layers are duplicated with new layer IDs while pointing to
   the immutable PCM data in `LayerAudioStore`. Subsequent edits (mix, effects, overdubs,
   undo, delete) to the copied track in the new section remain completely isolated from the source loop.
5. **Presence by section**: Presence awareness broadcasts each peer's active `sectionId`,
   allowing players in multiplayer rooms to see which section each person is currently jamming in.

## Consequences
- Players can work on the same or different sections concurrently without audio cross-talk.
- Copying loops is instantaneous and memory-efficient because audio buffers are immutable.
- Sections can be reordered via drag-and-drop or accessible controls, renamed, and deleted.
