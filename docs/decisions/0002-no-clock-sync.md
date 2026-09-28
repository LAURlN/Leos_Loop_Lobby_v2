# ADR 0002: No clock synchronization between devices

- Status: accepted (2026-09-28)

## Context
v1 tried to align devices in time (clock pings, host transport frames,
timestamps in version tags). It never became stable.

## Decision
Devices never synchronize clocks. Shared data only stores loop positions;
every device runs its own transport. Nobody hears other players live; takes
appear when committed. See docs/SYNC_MODEL.md.

## Consequences
- Timing correctness depends only on each device's own round-trip latency.
- Network latency and jitter cannot cause timing errors.
- Live jamming across devices is out of scope.
