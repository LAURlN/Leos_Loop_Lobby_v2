<!--
  Modal dialog to copy loops from an existing section into the current section.
-->
<script lang="ts">
  import { CANONICAL_RATE, describeLength } from '@lll/shared';
  import { hasAudio, visibleLayers } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import { trackColor } from '../palette';
  import Modal from './Modal.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const currentSection = $derived(lobby.activeSection);
  const otherSections = $derived(lobby.snapshot.sections.filter((s) => s.id !== currentSection?.id));

  let sourceSectionId = $state<string>('');
  let selectedTrackIds = $state<Set<string>>(new Set());

  // Default to the first other section that actually has tracks, or just the first other section
  $effect(() => {
    if (!sourceSectionId && otherSections.length > 0) {
      const withTracks = otherSections.find((s) => lobby.snapshot.tracks.some((t) => t.sectionId === s.id));
      sourceSectionId = withTracks?.id ?? otherSections[0]?.id ?? '';
    }
  });

  const sourceTracks = $derived(lobby.snapshot.tracks.filter((t) => t.sectionId === sourceSectionId));

  function toggleTrack(id: string) {
    const next = new Set(selectedTrackIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedTrackIds = next;
  }

  function toggleAll() {
    if (selectedTrackIds.size === sourceTracks.length) {
      selectedTrackIds = new Set();
    } else {
      selectedTrackIds = new Set(sourceTracks.map((t) => t.id));
    }
  }

  function copy() {
    if (!currentSection || selectedTrackIds.size === 0) return;
    lobby.copyTracksToSection([...selectedTrackIds], currentSection.id);
    onclose();
  }
</script>

<Modal title={`Copy loops to Section ${currentSection?.name ?? ''}`} {onclose}>
  <div class="stack">
    {#if otherSections.length === 0}
      <p class="muted">There are no other sections to copy loops from.</p>
    {:else}
      <label class="field">
        <span class="label">Source Section</span>
        <select bind:value={sourceSectionId} onchange={() => (selectedTrackIds = new Set())}>
          {#each otherSections as sec (sec.id)}
            {@const count = lobby.snapshot.tracks.filter((t) => t.sectionId === sec.id).length}
            <option value={sec.id}>Section {sec.name} ({count} loop{count === 1 ? '' : 's'})</option>
          {/each}
        </select>
      </label>

      {#if sourceTracks.length === 0}
        <p class="muted empty-hint">This source section has no loops yet.</p>
      {:else}
        <div class="header-row">
          <span class="label">Available Loops ({sourceTracks.length})</span>
          <button class="ghost small-btn" onclick={toggleAll}>
            {selectedTrackIds.size === sourceTracks.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        <div class="tracks-list" role="group" aria-label="Loops to copy">
          {#each sourceTracks as track (track.id)}
            {@const isChecked = selectedTrackIds.has(track.id)}
            {@const takes = visibleLayers(track).length}
            <button
              type="button"
              class="track-item"
              class:checked={isChecked}
              style:--track={trackColor(track.color)}
              onclick={() => toggleTrack(track.id)}
            >
              <input
                type="checkbox"
                checked={isChecked}
                tabindex="-1"
                aria-hidden="true"
                onclick={(e) => e.stopPropagation()}
                onchange={() => toggleTrack(track.id)}
              />
              <span class="dot"></span>
              <div class="track-info">
                <span class="track-name">{track.name}</span>
                <span class="track-sub muted">
                  {#if track.length48 !== null}
                    {describeLength(track.length48, lobby.snapshot.referenceLength48)} · {(track.length48 / CANONICAL_RATE).toFixed(1)}s
                  {:else}
                    Empty track
                  {/if}
                  {#if takes > 0}
                    · {takes} take{takes === 1 ? '' : 's'}
                  {/if}
                </span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <button onclick={onclose}>Cancel</button>
    <button class="primary" onclick={copy} disabled={selectedTrackIds.size === 0}>
      Copy {selectedTrackIds.size > 0 ? `(${selectedTrackIds.size})` : ''}
    </button>
  {/snippet}
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 4px;
  }
  .small-btn {
    min-height: 28px;
    padding: 0 8px;
    font-size: 13px;
    color: var(--accent);
  }
  .empty-hint {
    padding: 16px 0;
    text-align: center;
  }
  .tracks-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 280px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .track-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
    width: 100%;
  }
  .track-item:hover {
    background: var(--surface-3);
  }
  .track-item.checked {
    border-color: var(--accent);
    background: rgb(120 239 202 / 0.08);
  }
  .track-item input[type='checkbox'] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
    cursor: pointer;
    margin: 0;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--track);
    flex: none;
  }
  .track-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
  }
  .track-name {
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
  }
  .track-sub {
    font-size: 13px;
  }
</style>
