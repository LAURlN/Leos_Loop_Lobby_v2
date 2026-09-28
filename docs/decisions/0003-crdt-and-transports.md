# ADR 0003: Yjs CRDT over pluggable transports

- Status: accepted (2026-09-28)

## Context
v1 had a hand-written last-writer-wins manifest protocol with tombstones, wall
clock timestamps and index-based track addressing, which produced bugs like
settings moving to the wrong track after a delete.

## Decision
The session is a Yjs document. Messages are delivered by a `Transport`
(relay today, WebRTC P2P next). Layer audio is immutable and transferred
separately by id.

## Consequences
- Any delivery order, duplicates and reconnects converge automatically.
- No peer is special; anyone can leave at any time.
- P2P and relay can be mixed per peer without touching the data model.
