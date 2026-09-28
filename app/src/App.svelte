<!--
  Root layout. One UI for all devices:
  - wide screens: track grid + fixed side panel for the selected track
  - narrow screens: track grid + bottom sheet opened with a track's "⋯" button
-->
<script lang="ts">
  import AddTrackDialog from './ui/components/AddTrackDialog.svelte';
  import CopyLoopsDialog from './ui/components/CopyLoopsDialog.svelte';
  import RoomDialog from './ui/components/RoomDialog.svelte';
  import SectionTabs from './ui/components/SectionTabs.svelte';
  import SettingsDialog from './ui/components/SettingsDialog.svelte';
  import TrackCard from './ui/components/TrackCard.svelte';
  import TrackPanel from './ui/components/TrackPanel.svelte';
  import { lobby } from './state/lobby.svelte';

  type Dialog = 'add' | 'room' | 'settings' | 'copy' | null;
  let dialog = $state<Dialog>(null);
  let sheetOpen = $state(false);
  let wide = $state(true);

  const selected = $derived(lobby.snapshot.tracks.find((t) => t.id === lobby.selectedTrackId) ?? null);
  const invitedTo = new URLSearchParams(location.search).get('room');
  const otherSectionsWithTracks = $derived(
    lobby.snapshot.sections.filter(
      (s) => s.id !== lobby.activeSection?.id && lobby.snapshot.tracks.some((t) => t.sectionId === s.id),
    ),
  );

  const roomBadge = $derived.by(() => {
    const room = lobby.room;
    if (!room) return null;
    const ok = room.status.state === 'connected';
    return { text: `${room.code} · ${room.peers.length + 1}`, ok };
  });

  $effect(() => {
    const mq = matchMedia('(min-width: 900px)');
    const update = () => (wide = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  function edit(trackId: string) {
    lobby.selectedTrackId = trackId;
    sheetOpen = true;
  }

  /** Desktop shortcuts: 1-9 tap a track, Space taps the selected one, Z undoes. */
  function onkeydown(event: KeyboardEvent) {
    if (!lobby.started || dialog || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, button')) return;
    const n = Number(event.key);
    if (n >= 1 && n <= 9) {
      const track = lobby.activeTracks[n - 1];
      if (track) lobby.tapTrack(track.id, event.timeStamp);
    } else if (event.key === ' ' && lobby.selectedTrackId) {
      event.preventDefault();
      lobby.tapTrack(lobby.selectedTrackId, event.timeStamp);
    } else if (event.key.toLowerCase() === 'z' && lobby.selectedTrackId) {
      lobby.undo(lobby.selectedTrackId);
    }
  }
</script>

<svelte:window {onkeydown} />

{#if !lobby.started}
  <main class="start">
    <div class="logo" aria-hidden="true"><img src="./icon.svg" alt="" /></div>
    <h1>Leo's Loop Lobby</h1>
    <p class="muted">Loop together, on any phone or computer.</p>
    {#if invitedTo}<p class="invite">You were invited to room <strong>{invitedTo.toUpperCase()}</strong></p>{/if}
    <button class="primary big" onclick={() => lobby.start()} disabled={lobby.starting}>
      {lobby.starting ? 'Starting…' : invitedTo ? 'Join the jam' : 'Start looping'}
    </button>
    <p class="muted small">Needs microphone access. Headphones give the cleanest overdubs.</p>
    {#if lobby.startError}<p class="error">{lobby.startError}</p>{/if}
  </main>
{:else}
  <div class="app" class:wide>
    <header class="topbar">
      <div class="topbar-main">
        <h1>Loop Lobby</h1>
        <div class="spacer"></div>
        <button class="room" class:online={roomBadge?.ok} onclick={() => (dialog = 'room')}>
          {#if roomBadge}<span class="led"></span>{roomBadge.text}{:else}Multiplayer{/if}
        </button>
        <button class="icon" aria-label="Settings" onclick={() => (dialog = 'settings')}>⚙</button>
      </div>
      <div class="topbar-tabs">
        <SectionTabs />
      </div>
    </header>

    {#if lobby.micError}
      <div class="banner">Listen-only mode: {lobby.micError}</div>
    {:else if !lobby.latencyCalibrated}
      <button class="banner" onclick={() => (dialog = 'settings')}>
        Latency not calibrated yet. Overdubs may be slightly off. <strong>Calibrate</strong>
      </button>
    {/if}

    <main class="content">
      <section class="grid" aria-label="Tracks">
        {#each lobby.activeTracks as track (track.id)}
          <TrackCard {track} selected={track.id === lobby.selectedTrackId} onedit={() => edit(track.id)} />
        {/each}
        <button class="add" onclick={() => (dialog = 'add')}>
          <span class="plus">+</span>
          Add track
        </button>
        {#if otherSectionsWithTracks.length > 0}
          <button class="add copy-tile" onclick={() => (dialog = 'copy')}>
            <span class="copy-icon">📥</span>
            Copy loops
          </button>
        {/if}
      </section>

      {#if wide && selected}
        <aside class="side">
          <TrackPanel track={selected} />
        </aside>
      {/if}
    </main>
  </div>

  {#if !wide && sheetOpen && selected}
    <div class="sheet-backdrop" role="presentation" onclick={() => (sheetOpen = false)}></div>
    <aside class="sheet" aria-label="Track settings">
      <div class="grabber"></div>
      <TrackPanel track={selected} onclose={() => (sheetOpen = false)} />
    </aside>
  {/if}

  {#if dialog === 'add'}<AddTrackDialog onclose={() => (dialog = null)} />{/if}
  {#if dialog === 'copy'}<CopyLoopsDialog onclose={() => (dialog = null)} />{/if}
  {#if dialog === 'room'}<RoomDialog onclose={() => (dialog = null)} />{/if}
  {#if dialog === 'settings'}<SettingsDialog onclose={() => (dialog = null)} />{/if}
{/if}

<div class="toasts" aria-live="polite">
  {#each lobby.toasts as toast (toast.id)}
    <div class="toast">{toast.message}</div>
  {/each}
</div>

<style>
  .start {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }
  .logo img {
    width: 96px;
    height: 96px;
  }
  .start h1 {
    font-size: 30px;
  }
  .big {
    min-height: 56px;
    padding: 0 32px;
    font-size: 17px;
    margin-top: 12px;
  }
  .small {
    font-size: 13px;
  }
  .invite {
    background: var(--surface-2);
    padding: 8px 14px;
    border-radius: var(--radius-sm);
  }
  .error {
    color: var(--danger);
    max-width: 420px;
  }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: calc(8px + env(safe-area-inset-top, 0px)) 16px 8px;
    background: rgb(11 15 25 / 0.85);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .topbar-main {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .topbar-tabs {
    width: 100%;
  }
  .topbar h1 {
    font-size: 18px;
  }
  .spacer {
    flex: 1;
  }
  .room {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn);
  }
  .room.online .led {
    background: var(--accent);
  }
  .banner {
    margin: 10px 16px 0;
    min-height: 0;
    padding: 10px 14px;
    text-align: left;
    background: rgb(255 193 117 / 0.1);
    border-color: rgb(255 193 117 / 0.4);
    color: var(--warn);
    font-size: 14px;
  }
  .content {
    flex: 1;
    display: flex;
    gap: 16px;
    padding: 16px;
    align-items: flex-start;
  }
  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
  .wide .grid {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }
  .add {
    min-height: 200px;
    border: 2px dashed var(--border);
    background: transparent;
    border-radius: 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--muted);
  }
  .add .plus {
    font-size: 40px;
    line-height: 1;
    color: var(--accent);
  }
  .copy-tile {
    border-color: rgb(183 148 255 / 0.35);
  }
  .copy-tile:hover {
    border-color: var(--accent-2);
    color: var(--text);
  }
  .copy-tile .copy-icon {
    font-size: 32px;
    line-height: 1;
  }
  .side {
    width: var(--panel-width);
    flex: none;
    position: sticky;
    top: 80px;
    max-height: calc(100vh - 96px);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgb(4 6 12 / 0.5);
  }
  .sheet {
    position: fixed;
    z-index: 31;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 85vh;
    overflow: auto;
    background: var(--surface);
    border-top: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    padding: 8px 16px calc(24px + var(--safe-bottom));
  }
  .grabber {
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    margin: 0 auto 10px;
  }
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(20px + var(--safe-bottom));
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(460px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    background: var(--surface-3);
    border: 1px solid var(--border);
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
    font-size: 14px;
  }
</style>
