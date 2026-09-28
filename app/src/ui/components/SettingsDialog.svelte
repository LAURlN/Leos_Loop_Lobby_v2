<!--
  Latency calibration, audio devices, metronome and session reset.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { lobby } from '../../state/lobby.svelte';
  import Modal from './Modal.svelte';
  import Slider from './Slider.svelte';
  import Toggle from './Toggle.svelte';

  let { onclose }: { onclose: () => void } = $props();

  let result = $state<{ ok: boolean; message: string } | null>(null);
  let inputs = $state<MediaDeviceInfo[]>([]);
  let confirmClear = $state(false);

  const latency = $derived(lobby.latency);
  const sourceText = $derived(
    latency?.source === 'acoustic'
      ? 'measured acoustically'
      : latency?.source === 'manual'
        ? 'set manually'
        : 'rough estimate — please calibrate',
  );

  onMount(async () => {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  });

  async function calibrate() {
    result = null;
    result = await lobby.calibrate();
  }
</script>

<Modal title="Settings" {onclose}>
  <div class="stack sections">
    <section class="stack">
      <h3 class="label">Latency</h3>
      <div class="latency" class:uncalibrated={!lobby.latencyCalibrated}>
        <span class="ms">{latency ? latency.roundTripMs.toFixed(1) : '–'} ms</span>
        <span class="muted">round trip, {sourceText}</span>
      </div>
      <p class="muted small">
        Measures how long sound takes from the speaker back into the microphone, so your overdubs land exactly on the
        beat. Use the speaker and mic you will play with; recalibrate when you switch to headphones or Bluetooth. It will
        be loud for two seconds.
      </p>
      <button class="primary" onclick={calibrate} disabled={lobby.calibrating}>
        {lobby.calibrating ? 'Listening…' : 'Calibrate latency'}
      </button>
      {#if result}
        <p class={result.ok ? 'ok small' : 'error small'}>{result.message}</p>
      {/if}
      {#if latency}
        <Slider
          label="Fine-tune (if overdubs feel early/late)"
          value={latency.roundTripMs}
          min={0}
          max={600}
          step={0.5}
          format={(v) => `${v.toFixed(1)} ms`}
          onchange={(v) => lobby.setLatencyMs(v)}
        />
      {/if}
    </section>

    <section class="stack">
      <h3 class="label">Audio</h3>
      {#if inputs.length > 1}
        <label class="stack field">
          <span class="muted small">Microphone</span>
          <select
            value={lobby.settings.inputDeviceId}
            onchange={(e) => lobby.updateSettings({ inputDeviceId: (e.target as HTMLSelectElement).value })}
          >
            <option value="">System default</option>
            {#each inputs as d (d.deviceId)}
              <option value={d.deviceId}>{d.label || 'Microphone'}</option>
            {/each}
          </select>
        </label>
      {/if}
      <Toggle
        label="Hear my microphone"
        hint="Only with headphones, otherwise it will feed back."
        checked={lobby.settings.monitoring}
        onchange={(v) => lobby.updateSettings({ monitoring: v })}
      />
      <Slider
        label="Loop volume"
        value={lobby.settings.masterVolume}
        min={0}
        max={1.5}
        format={(v) => `${Math.round(v * 100)}%`}
        onchange={(v) => lobby.updateSettings({ masterVolume: v })}
      />
    </section>

    <section class="stack">
      <h3 class="label">Metronome</h3>
      <Toggle
        label="Click"
        hint="Follows the first loop."
        checked={lobby.settings.metronomeEnabled}
        onchange={(v) => lobby.updateSettings({ metronomeEnabled: v })}
      />
      <Slider
        label="Beats per loop (shared)"
        value={lobby.snapshot.beatsPerLoop}
        min={1}
        max={32}
        step={1}
        format={(v) => String(Math.round(v))}
        onchange={(v) => lobby.setBeatsPerLoop(v)}
      />
      <Slider
        label="Click volume"
        value={lobby.settings.metronomeVolume}
        min={0}
        max={1}
        format={(v) => `${Math.round(v * 100)}%`}
        onchange={(v) => lobby.updateSettings({ metronomeVolume: v })}
      />
    </section>

    <section class="stack">
      <h3 class="label">Session</h3>
      {#if confirmClear}
        <button
          class="danger"
          onclick={() => {
            lobby.clearSession();
            confirmClear = false;
          }}>Really delete all tracks{lobby.room ? ' for everyone' : ''}?</button
        >
      {:else}
        <button class="danger" onclick={() => (confirmClear = true)}>Delete all tracks</button>
      {/if}
    </section>
  </div>
</Modal>

<style>
  .sections {
    gap: 26px;
  }
  .latency {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .latency.uncalibrated {
    border-color: var(--warn);
  }
  .ms {
    font-size: 24px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }
  .small {
    font-size: 13px;
    margin: 0;
  }
  .ok {
    color: var(--accent);
  }
  .error {
    color: var(--danger);
  }
  .field {
    gap: 4px;
  }
</style>
