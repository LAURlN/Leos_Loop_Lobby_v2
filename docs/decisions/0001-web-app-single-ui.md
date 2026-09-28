# ADR 0001: One web app for all devices

- Status: accepted (2026-09-28)

## Context
v1 had a native Android app (Java + C++/Oboe) and a separate Win32 desktop app
with a different UI and feature set. Keeping both in sync was a major cost.

## Decision
Build a single web app (TypeScript, Vite, Svelte 5, Web Audio + AudioWorklet)
with one responsive UI. Host it statically on GitHub Pages. English UI.

## Consequences
- Runs on any modern phone or desktop browser, no installs (installable as PWA).
- Audio latency is somewhat higher than native; we compensate by measuring the
  round trip precisely instead of trying to minimize it.
- DSP uses native Web Audio nodes where possible; custom processing lives in
  AudioWorklets.
