# Leo's Loop Lobby

A multiplayer looper that runs in the browser on phones and desktops.
Record loops, overdub, add effects and jam in rooms with friends. Every
device keeps its own clock; loops still line up (see
[docs/SYNC_MODEL.md](docs/SYNC_MODEL.md)).

## Using it

1. Open the app and tap **Start looping** (allow the microphone).
2. **Calibrate latency** once per device/headphones (⚙ → Calibrate).
3. Tap a track's disc to record, tap again to close the loop. Tap again to
   overdub. `⋯` opens undo/redo, mix and effects.
4. `⋯` → **Open in Studio** edits one loop on a waveform: cut/copy/paste,
   delete or silence a selection, fades, gain, normalize, reverse, trim, double
   the length, all with undo. **Save to loop** merges the takes into one —
   undo brings them back. Esc or Cancel leaves the loop untouched.
5. **Multiplayer** → *Create a room* and share the link/code. Others join and
   hear your loops; their takes appear for you when they stop recording.

Desktop shortcuts: `1`–`9` tap a track, `Space` taps the selected track,
`Z` undoes your last take on it. In the studio: `Space` plays, `Delete` removes
a selection, `Ctrl/Cmd`+`Z`/`X`/`C`/`V`/`A` work as usual, `Home` returns to
the start.

In **Song**, use **Record** (or `R`) to play and record from the playhead.
Your take becomes a new loop in each section it crosses, preserving the
performance across section boundaries. **Stop recording** or **Pause** saves
early; otherwise it stops at the song end (up to ten minutes per take).
Open a section to mix or undo its recorded loop as usual.

## Development

Requirements: Node.js 22+.

```bash
npm install
npm run dev:relay     # terminal 1: local room relay (wrangler dev, port 8787)
npm run dev           # terminal 2: app on http://localhost:5173
```

- Phones on your LAN need https for the microphone:
  `HTTPS=1 npm run dev`, then open `https://<your-pc-ip>:5173` and accept the
  self-signed certificate.
- No microphone (or automated tests)? Open `http://localhost:5173/?testmic`.
- Two players on one machine: open two tabs (each tab is its own player).

Checks:

```bash
npm test          # unit + multi-client sync tests (Vitest)
npm run check     # type checks (svelte-check + tsc)
npm run build     # production build into app/dist
```

## Deploy (free)

### 1. Relay on Cloudflare (free Workers plan, no credit card)

```bash
npx wrangler login
npm run deploy -w relay
```

Note the URL, e.g. `https://leos-loop-lobby-relay.<you>.workers.dev`.
Optionally set `ALLOWED_ORIGINS` in `relay/wrangler.jsonc` to your Pages
origin (e.g. `https://<user>.github.io`) and deploy again, so nobody else can
use your free quota.

### 2. App on GitHub Pages

1. Push this repository to GitHub.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **Variables** → add
   `RELAY_URL` = `wss://leos-loop-lobby-relay.<you>.workers.dev`.
4. Push to `main` (or run the "Deploy to GitHub Pages" workflow manually).

The app is served at `https://<user>.github.io/<repo>/`.

## Project docs

- [AGENTS.md](AGENTS.md) – start here if you want to change the code
- [docs/SYNC_MODEL.md](docs/SYNC_MODEL.md) – the timing law (no clock sync)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – modules and data flow
- [docs/ROADMAP.md](docs/ROADMAP.md) – what's next
- [docs/decisions/](docs/decisions) – why things are the way they are
