<!--
  Pick how a new track decides its loop length (modes from v1), or add a
  metronome track with its own tempo and rhythm.
-->
<script lang="ts">
  import { parseLengthInput, type LengthSpec } from '@lll/shared';
  import { describeClick, type ClickPattern } from '../../session/click';
  import { lobby } from '../../state/lobby.svelte';
  import ClickEditor from './ClickEditor.svelte';
  import Modal from './Modal.svelte';

  let { onclose }: { onclose: () => void } = $props();

  const hasReference = $derived(lobby.snapshot.referenceLength48 !== null);
  let custom = $state('');
  let error = $state('');
  let metronome = $state(false);
  let click = $state<ClickPattern>(lobby.suggestedClick);

  const ratios: Array<{ label: string; num: number; den: number }> = [
    { label: '¼×', num: 1, den: 4 },
    { label: '½×', num: 1, den: 2 },
    { label: '1×', num: 1, den: 1 },
    { label: '2×', num: 2, den: 1 },
    { label: '4×', num: 4, den: 1 },
  ];

  function add(spec: LengthSpec) {
    lobby.addTrack(spec);
    onclose();
  }

  function addCustom(event: SubmitEvent) {
    event.preventDefault();
    const spec = parseLengthInput(custom);
    if (!spec) {
      error = 'Try something like 3/2, 3x or 2.5 s';
      return;
    }
    if (spec.kind === 'ratio' && !hasReference) {
      error = 'Ratios need a first recorded loop. Use seconds, e.g. 2.5 s';
      return;
    }
    add(spec);
  }

  function addMetronome() {
    lobby.addClickTrack(click);
    onclose();
  }
</script>

<Modal title="New track" {onclose}>
  <div class="stack">
    <button class="option recommended" onclick={() => add({ kind: 'free', autoSnap: true })}>
      <strong>Free · Auto snap</strong>
      <span>Recommended. Your take decides the length and snaps to ½×, 1×, 2×, 3×… of the first loop.</span>
    </button>
    <button class="option" onclick={() => add({ kind: 'free', autoSnap: false })}>
      <strong>Free</strong>
      <span>The length is exactly what you record.</span>
    </button>

    <div>
      <p class="label">Relative to the first loop</p>
      <div class="ratios">
        {#each ratios as r (r.label)}
          <button disabled={!hasReference} onclick={() => add({ kind: 'ratio', num: r.num, den: r.den })}>{r.label}</button>
        {/each}
      </div>
      {#if !hasReference}<p class="muted hint">Record a first loop to unlock these.</p>{/if}
    </div>

    <form onsubmit={addCustom}>
      <p class="label">Custom</p>
      <div class="row">
        <input type="text" bind:value={custom} placeholder="3/2, 3x or 2.5 s" aria-label="Custom length" />
        <button type="submit">Add</button>
      </div>
      {#if error}<p class="error">{error}</p>{/if}
    </form>

    <div class="metronome">
      <p class="label">Metronome</p>
      {#if metronome}
        <ClickEditor value={click} onchange={(patch) => (click = { ...click, ...patch })} />
        <button class="primary" onclick={addMetronome}>Add metronome · {describeClick(click)}</button>
        {#if !hasReference}
          <p class="muted hint">Its bar becomes the first loop: free takes snap to whole bars.</p>
        {/if}
      {:else}
        <button class="option" onclick={() => (metronome = true)}>
          <strong>♩ Metronome track</strong>
          <span>A click with your tempo and rhythm. Mix it, add effects, and hear it in the full song.</span>
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    text-align: left;
    padding: 12px 14px;
    height: auto;
  }
  .option span {
    color: var(--muted);
    font-size: 13px;
  }
  .recommended {
    border-color: var(--accent);
  }
  .ratios {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
  }
  .hint {
    font-size: 12px;
    margin: 6px 0 0;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 6px 0 0;
  }
  p.label {
    margin: 0 0 6px;
  }
  .metronome {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .metronome p.label {
    margin: 0;
  }
</style>
