# ADR 0004: Cloudflare Durable Object relay, app on GitHub Pages

- Status: accepted (2026-09-28)

## Context
No paid servers. Browsers cannot do LAN discovery or raw UDP; pure public
signaling for WebRTC is unreliable and mobile NATs often block P2P.

## Decision
- App: static build on GitHub Pages (GitHub Actions workflow).
- Rooms: one Cloudflare Durable Object per room code on the Workers free plan,
  acting as a dumb WebSocket relay with hibernation; it stores nothing, so
  rooms end when the last player leaves. No R2 (would require a card).
- An optional origin allow-list protects the free quota.

## Consequences
- Free tier: 100k requests/day (WebSocket messages count 20:1),
  13,000 GB-s/day of room time (~29 room-hours), errors (not bills) above it.
- Moving heavy traffic to WebRTC P2P later lets rooms hibernate most of the time.
