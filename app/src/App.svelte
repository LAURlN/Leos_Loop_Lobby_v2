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
  import SongView from './ui/components/SongView.svelte';
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

  function onWindowClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const content = target.closest('.content');
    if (!content) return;
    const card = target.closest('.card') as HTMLElement | null;
    if (card) {
      const trackId = card.dataset.trackId;
      if (trackId && lobby.selectedTrackId !== trackId) {
        lobby.selectedTrackId = trackId;
      }
      return;
    }
    if (target.closest('.side, .add, .copy-tile, button, input, select, textarea, dialog, a')) {
      return;
    }
    lobby.selectedTrackId = null;
    sheetOpen = false;
  }

  /** Desktop shortcuts: 1-9 tap a track, Space taps selected (or toggles playback if none), Z undoes. */
  function onkeydown(event: KeyboardEvent) {
    if (!lobby.started || dialog || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, select, textarea, button')) return;
    if (lobby.songView) {
      if (event.key === ' ') {
        event.preventDefault();
        lobby.togglePlayback();
      }
      return;
    }
    const n = Number(event.key);
    if (n >= 1 && n <= 9) {
      const track = lobby.activeTracks[n - 1];
      if (track) lobby.tapTrack(track.id, event.timeStamp);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (lobby.selectedTrackId) {
        lobby.tapTrack(lobby.selectedTrackId, event.timeStamp);
      } else {
        lobby.togglePlayback();
      }
    } else if (event.key.toLowerCase() === 'z' && lobby.selectedTrackId) {
      lobby.undo(lobby.selectedTrackId);
    }
  }
</script>

<svelte:window {onkeydown} onclick={onWindowClick} />

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
      <div class="topbar-row">
        <div class="topbar-tabs">
          <SectionTabs />
        </div>
        <div class="section-transport" aria-label="Section playback controls">
          <button
            type="button"
            class="transport-btn restart"
            title={lobby.songView ? 'Play the song from the start' : 'Restart playback of current section'}
            aria-label={lobby.songView ? 'Play from start' : 'Restart playback'}
            disabled={!lobby.canPlayback}
            onclick={() => lobby.restartPlayback()}
          >
            <span class="t-icon">⏮</span>
            <span class="t-label">{lobby.songView ? 'Start' : 'Restart'}</span>
          </button>
          <button
            type="button"
            class="transport-btn pause"
            class:active={lobby.playbackPaused}
            title={lobby.songView ? 'Pause the song' : 'Pause playback of current section'}
            aria-label="Pause playback"
            disabled={!lobby.canPlayback || lobby.playbackPaused}
            onclick={() => lobby.pausePlayback()}
          >
            <span class="t-icon">⏸</span>
            <span class="t-label">Pause</span>
          </button>
          <button
            type="button"
            class="transport-btn resume"
            class:highlight={lobby.playbackPaused && lobby.canPlayback}
            title={lobby.songView ? 'Play the song' : 'Resume playback of current section'}
            aria-label={lobby.songView ? 'Play song' : 'Resume playback'}
            disabled={!lobby.canPlayback || !lobby.playbackPaused}
            onclick={() => lobby.resumePlayback()}
          >
            <span class="t-icon">▶</span>
            <span class="t-label">{lobby.songView ? 'Play' : 'Resume'}</span>
          </button>
        </div>
      </div>
    </header>

    {#if lobby.micError}
      <div class="banner">Listen-only mode: {lobby.micError}</div>
    {:else if !lobby.latencyCalibrated}
      <button class="banner" onclick={() => (dialog = 'settings')}>
        Latency not calibrated yet. Overdubs may be slightly off. <strong>Calibrate</strong>
      </button>
    {/if}

    {#if lobby.songView}
      <main class="content">
        <SongView />
      </main>
    {:else}
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
    {/if}
  </div>

  {#if !wide && sheetOpen && selected && !lobby.songView}
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
    /* Near-opaque instead of backdrop-filter: a blur over spinning discs is re-rendered every frame. */
    background: rgb(11 15 25 / 0.96);
    border-bottom: 1px solid var(--border);
  }
  .topbar-main {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .topbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
  }
  .topbar-tabs {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .section-transport {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 3px 4px;
    border-radius: var(--radius-sm);
  }
  .transport-btn {
    min-height: 32px;
    height: 32px;
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 550;
    background: transparent;
    border: 1px solid transparent;
    border-radius: calc(var(--radius-sm) - 4px);
    color: var(--muted);
    transition: all 0.15s ease;
  }
  .transport-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-2);
  }
  .transport-btn.pause.active {
    background: rgb(255 193 117 / 0.15);
    border-color: rgb(255 193 117 / 0.4);
    color: var(--warn);
  }
  .transport-btn.resume.highlight {
    background: var(--accent);
    border-color: var(--accent);
    color: #06201a;
    font-weight: 650;
    box-shadow: 0 0 12px rgb(120 239 202 / 0.35);
  }
  .transport-btn.resume.highlight:hover {
    background: #93f5d8;
  }
  .t-icon {
    font-size: 13px;
    line-height: 1;
  }
  @media (max-width: 600px) {
    .t-label {
      display: none;
    }
    .transport-btn {
      padding: 0 8px;
    }
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
