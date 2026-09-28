<!--
  Create / join / manage a multiplayer room. Rooms live only while someone is in them.
-->
<script lang="ts">
  import { lobby } from '../../state/lobby.svelte';
  import Modal from './Modal.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let code = $state('');
  let confirmJoin = $state(false);
  let copied = $state(false);

  const room = $derived(lobby.room);
  const statusText = $derived.by(() => {
    const s = room?.status;
    if (!s) return '';
    switch (s.state) {
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return `Connection lost, retrying (${s.attempt})…`;
      case 'failed':
        return s.reason;
      case 'closed':
        return 'Disconnected';
    }
  });

  function join(event: SubmitEvent) {
    event.preventDefault();
    if (lobby.hasContent && !confirmJoin) {
      confirmJoin = true;
      return;
    }
    lobby.joinRoom(code);
    confirmJoin = false;
  }

  async function share() {
    const link = lobby.roomLink;
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Leo's Loop Lobby", text: `Join my loop room ${room?.code}`, url: link });
        return;
      } catch {
        /* cancelled: fall back to copy */
      }
    }
    await navigator.clipboard.writeText(link);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<Modal title="Multiplayer" {onclose}>
  <div class="stack">
    <label class="stack name">
      <span class="label">Your name</span>
      <input
        type="text"
        value={lobby.settings.playerName}
        placeholder="Player"
        maxlength="24"
        onchange={(e) => lobby.updateSettings({ playerName: (e.target as HTMLInputElement).value })}
      />
    </label>

    {#if room}
      <div class="code-box">
        <span class="label">Room code</span>
        <span class="code">{room.code}</span>
        <span class="status" class:ok={room.status.state === 'connected'}>● {statusText}</span>
      </div>
      <button class="primary" onclick={share}>{copied ? 'Link copied ✓' : 'Share invite link'}</button>

      <div>
        <p class="label">In this room</p>
        <ul class="players">
          <li>{lobby.name} <span class="muted">(you)</span></li>
          {#each room.peers as peer (peer.id)}
            {@const presence = room.presence.find((p) => p.peerId === peer.id)}
            <li>
              {presence?.name ?? peer.name}
              {#if presence?.recordingTrackId}<span class="rec">● recording</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
      <p class="muted small">
        Everyone hears the same loops, each device on its own clock. New takes appear for the others as soon as you stop
        recording. The room disappears when the last player leaves; everyone keeps a local copy.
      </p>
      <button class="danger" onclick={() => lobby.leaveRoom()}>Leave room</button>
    {:else}
      <button class="primary big" onclick={() => lobby.createRoom()}>Create a room</button>
      <p class="muted small">Your current loops come with you into the new room.</p>

      <form class="stack" onsubmit={join}>
        <span class="label">Join with a code</span>
        <div class="row">
          <input
            type="text"
            bind:value={code}
            placeholder="e.g. JAM42"
            autocapitalize="characters"
            autocomplete="off"
            maxlength="8"
            aria-label="Room code"
            oninput={() => (confirmJoin = false)}
          />
          <button type="submit" disabled={code.trim().length < 5}>{confirmJoin ? 'Replace & join' : 'Join'}</button>
        </div>
        {#if confirmJoin}
          <p class="warn small">Joining replaces your current loops with the room's session.</p>
        {/if}
      </form>
    {/if}
  </div>
</Modal>

<style>
  .code-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 16px;
    background: var(--surface-2);
    border-radius: var(--radius);
  }
  .code {
    font-size: 40px;
    font-weight: 800;
    letter-spacing: 0.18em;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .status {
    font-size: 13px;
    color: var(--warn);
  }
  .status.ok {
    color: var(--accent);
  }
  .players {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .players li {
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    display: flex;
    gap: 8px;
  }
  .rec {
    color: var(--danger);
    margin-left: auto;
    font-size: 13px;
  }
  .small {
    font-size: 13px;
    margin: 0;
  }
  .warn {
    color: var(--warn);
  }
  .big {
    min-height: 52px;
    font-size: 16px;
  }
  p.label {
    margin: 0 0 6px;
  }
  .name {
    gap: 6px;
  }
</style>
