<!--
  Everything about the selected track: name, takes (undo/redo/clear), mix and effects.
-->
<script lang="ts">
  import { CANONICAL_RATE, describeLength } from '@lll/shared';
  import { EFFECTS } from '../../effects/registry';
  import { decibel, percent } from '../../effects/types';
  import { visibleLayers, type TrackState } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import { trackColor } from '../palette';
  import EffectEditor from './EffectEditor.svelte';
  import Slider from './Slider.svelte';

  let { track, onclose }: { track: TrackState; onclose?: () => void } = $props();

  const layers = $derived(visibleLayers(track));
  const authors = $derived([...new Set(layers.map((l) => (l.author === lobby.userId ? 'you' : l.authorName)))]);
  let confirmDelete = $state(false);
  const otherSections = $derived(lobby.snapshot.sections.filter((s) => s.id !== track.sectionId));
  let copyTargetSectionId = $state<string>('');

  $effect(() => {
    if ((!copyTargetSectionId || !otherSections.some((s) => s.id === copyTargetSectionId)) && otherSections[0]) {
      copyTargetSectionId = otherSections[0].id;
    }
  });

  $effect(() => {
    void track.id;
    confirmDelete = false;
  });

  function volumeToDb(v: number) {
    return v <= 0.0001 ? '−∞ dB' : decibel(20 * Math.log10(v));
  }

  function rename(event: Event) {
    lobby.renameTrack(track.id, (event.target as HTMLInputElement).value);
  }
</script>

<div class="panel" style:--track={trackColor(track.color)}>
  <header>
    <span class="dot"></span>
    <input class="name" type="text" value={track.name} aria-label="Track name" onchange={rename} maxlength="40" />
    {#if onclose}<button class="icon ghost" aria-label="Close" onclick={onclose}>✕</button>{/if}
  </header>

  <p class="info muted">
    {#if track.length48 !== null}
      {describeLength(track.length48, lobby.snapshot.referenceLength48)} · {(track.length48 / CANONICAL_RATE).toFixed(2)} s
    {:else}
      Length is set by the first take
    {/if}
    {#if layers.length}· {layers.length} take{layers.length === 1 ? '' : 's'} by {authors.join(', ')}{/if}
  </p>

  <div class="actions">
    <button onclick={() => lobby.undo(track.id)} disabled={!lobby.canUndo(track.id)}>↶ Undo</button>
    <button onclick={() => lobby.redo(track.id)} disabled={!lobby.canRedo(track.id)}>↷ Redo</button>
    <button onclick={() => lobby.clearTrack(track.id)} disabled={!track.layers.length}>Clear</button>
    {#if confirmDelete}
      <button class="danger" onclick={() => lobby.deleteTrack(track.id)}>Sure?</button>
    {:else}
      <button class="danger" onclick={() => (confirmDelete = true)}>Delete</button>
    {/if}
  </div>

  {#if otherSections.length > 0}
    <div class="copy-box">
      <span class="label">Copy loop to</span>
      <div class="row">
        <select bind:value={copyTargetSectionId} class="copy-select" aria-label="Target section">
          {#each otherSections as sec (sec.id)}
            <option value={sec.id}>Section {sec.name}</option>
          {/each}
        </select>
        <button
          type="button"
          class="copy-btn"
          disabled={!copyTargetSectionId}
          onclick={() => {
            if (copyTargetSectionId) lobby.copyTrackToSection(track.id, copyTargetSectionId);
          }}
        >
          Copy
        </button>
      </div>
    </div>
  {/if}

  <section class="stack">
    <h3 class="label">Mix</h3>
    <Slider
      label="Volume"
      value={track.volume}
      min={0}
      max={2}
      step={0.01}
      format={volumeToDb}
      onchange={(v) => lobby.setTrackMix(track.id, { volume: v })}
    />
    <Slider
      label="Pan"
      value={track.pan}
      min={-1}
      max={1}
      step={0.01}
      format={(v) => (Math.abs(v) < 0.02 ? 'Center' : v < 0 ? `L ${percent(-v)}` : `R ${percent(v)}`)}
      onchange={(v) => lobby.setTrackMix(track.id, { pan: v })}
    />
    <div class="row">
      <button class="toggle" class:on={track.mute} aria-pressed={track.mute} onclick={() => lobby.setTrackMix(track.id, { mute: !track.mute })}>
        Mute
      </button>
      <button class="toggle" class:on={track.solo} aria-pressed={track.solo} onclick={() => lobby.setTrackMix(track.id, { solo: !track.solo })}>
        Solo
      </button>
    </div>
  </section>

  <section class="stack">
    <h3 class="label">Effects</h3>
    {#each track.effects as effect (effect.id)}
      <EffectEditor trackId={track.id} {effect} />
    {:else}
      <p class="muted small">No effects yet.</p>
    {/each}
    <div class="add-fx">
      {#each EFFECTS as def (def.type)}
        <button onclick={() => lobby.addEffect(track.id, def.type)} title={def.description} style:--fx={def.color}>
          <span class="plus">+</span>{def.label}
        </button>
      {/each}
    </div>
  </section>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--track);
    flex: none;
  }
  .name {
    font-size: 18px;
    font-weight: 700;
    background: transparent;
    border-color: transparent;
    padding: 0 6px;
  }
  .name:hover,
  .name:focus {
    border-color: var(--border);
    background: var(--surface-2);
  }
  .info {
    margin: -8px 0 0;
    font-size: 13px;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .actions button {
    padding: 0 6px;
    font-size: 14px;
  }
  .toggle {
    flex: 1;
  }
  .toggle.on {
    background: var(--track);
    color: #0b0f19;
    border-color: var(--track);
    font-weight: 700;
  }
  .add-fx {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .add-fx button {
    border-color: var(--fx);
    font-size: 14px;
  }
  .plus {
    color: var(--fx);
    margin-right: 6px;
    font-weight: 800;
  }
  .small {
    font-size: 13px;
    margin: 0;
  }
  .copy-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .copy-select {
    flex: 1;
    min-height: 36px;
    font-size: 14px;
  }
  .copy-btn {
    min-height: 36px;
    padding: 0 16px;
    font-size: 14px;
    font-weight: 600;
  }
</style>
