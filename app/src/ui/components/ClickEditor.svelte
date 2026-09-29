<!--
  Tempo and rhythm of a metronome track: BPM (slider, ± and tap tempo),
  time signature and subdivision. Used when adding and when editing one.
-->
<script lang="ts">
  import {
    formatBpm,
    MAX_BPM,
    MIN_BPM,
    SUBDIVISIONS,
    TIME_SIGNATURES,
    type ClickPattern,
  } from '../../session/click';
  import Slider from './Slider.svelte';

  let { value, onchange }: { value: ClickPattern; onchange: (patch: Partial<ClickPattern>) => void } = $props();

  const signature = $derived(`${value.beats}/${value.unit}`);
  let taps: number[] = [];

  function setBpm(bpm: number) {
    onchange({ bpm: Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) });
  }

  /** Tap tempo: the average of the last few intervals; a pause starts over. */
  function tap(event: PointerEvent) {
    const now = event.timeStamp;
    if (taps.length > 0 && now - taps[taps.length - 1]! > 2000) taps = [];
    taps = [...taps.slice(-4), now];
    if (taps.length >= 2) {
      const interval = (taps[taps.length - 1]! - taps[0]!) / (taps.length - 1);
      setBpm(Math.round(60000 / interval));
    }
  }

  function setSignature(event: Event) {
    const [beats, unit] = (event.target as HTMLSelectElement).value.split('/').map(Number);
    onchange({ beats, unit: unit === 8 ? 8 : 4 });
  }
</script>

<div class="click-editor">
  <Slider
    label="Tempo"
    value={value.bpm}
    min={MIN_BPM}
    max={MAX_BPM}
    step={1}
    format={(v) => `${formatBpm(v)} BPM`}
    onchange={setBpm}
  />
  <div class="row bpm">
    <button onclick={() => setBpm(Math.round(value.bpm) - 1)} aria-label="Slower">−1</button>
    <button onclick={() => setBpm(Math.round(value.bpm) + 1)} aria-label="Faster">+1</button>
    <button class="tap" onpointerdown={tap} title="Tap a few times in tempo">Tap tempo</button>
  </div>
  <div class="row">
    <label class="field">
      <span class="label">Time signature</span>
      <select value={signature} onchange={setSignature}>
        {#each TIME_SIGNATURES as ts (`${ts.beats}/${ts.unit}`)}
          <option value="{ts.beats}/{ts.unit}">{ts.beats}/{ts.unit}</option>
        {/each}
        {#if !TIME_SIGNATURES.some((ts) => ts.beats === value.beats && ts.unit === value.unit)}
          <option value={signature}>{signature}</option>
        {/if}
      </select>
    </label>
    <label class="field">
      <span class="label">Clicks</span>
      <select
        value={value.subdivision}
        onchange={(e) => onchange({ subdivision: Number((e.target as HTMLSelectElement).value) as ClickPattern['subdivision'] })}
      >
        {#each SUBDIVISIONS as s (s.value)}
          <option value={s.value}>{s.label}</option>
        {/each}
      </select>
    </label>
  </div>
</div>

<style>
  .click-editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .bpm button {
    flex: 1;
    padding: 0 6px;
  }
  .bpm .tap {
    flex: 2;
  }
  .field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .field select {
    width: 100%;
  }
</style>
