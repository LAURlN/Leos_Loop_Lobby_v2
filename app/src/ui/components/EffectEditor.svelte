<!--
  Editor for one effect instance, generated entirely from its EffectDefinition.
-->
<script lang="ts">
  import { getEffect, normalizeParams } from '../../effects/registry';
  import type { EffectState } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import Slider from './Slider.svelte';

  let { trackId, effect }: { trackId: string; effect: EffectState } = $props();

  const def = $derived(getEffect(effect.type));
  const params = $derived(def ? normalizeParams(def, effect.params) : {});
  let open = $state(true);
</script>

{#if def}
  <section class="effect" class:off={!effect.enabled} style:--fx={def.color}>
    <header>
      <button class="ghost name" onclick={() => (open = !open)} aria-expanded={open}>
        <span class="sticker">{def.sticker}</span>
        {def.label}
        <span class="chev">{open ? '▾' : '▸'}</span>
      </button>
      <input
        type="checkbox"
        role="switch"
        aria-label="{def.label} on/off"
        checked={effect.enabled}
        onchange={(e) => lobby.setEffectEnabled(trackId, effect.id, (e.target as HTMLInputElement).checked)}
      />
      <button class="icon ghost" aria-label="Remove {def.label}" onclick={() => lobby.removeEffect(trackId, effect.id)}>✕</button>
    </header>
    {#if open}
      <div class="body">
        {#if def.presets?.length}
          <div class="presets">
            {#each def.presets as preset (preset.name)}
              <button class="chip" onclick={() => lobby.applyEffectPreset(trackId, effect.id, preset.name)}>{preset.name}</button>
            {/each}
          </div>
        {/if}
        {#each def.params as p (p.id)}
          <Slider
            label={p.label}
            value={params[p.id] ?? p.default}
            min={p.min}
            max={p.max}
            step={p.step ?? (p.max - p.min) / 100}
            format={p.format}
            accent={def.color}
            onchange={(v) => lobby.setEffectParam(trackId, effect.id, p.id, v)}
          />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .effect {
    border: 1px solid var(--border);
    border-left: 3px solid var(--fx);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .effect.off .body,
  .effect.off .name {
    opacity: 0.5;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 4px;
  }
  .name {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    font-weight: 600;
  }
  .chev {
    margin-left: auto;
    color: var(--muted);
  }
  .sticker {
    background: var(--fx);
    color: #0b0f19;
    font-size: 10px;
    font-weight: 800;
    border-radius: 5px;
    padding: 2px 5px;
  }
  input[type='checkbox'] {
    accent-color: var(--fx);
    width: 20px;
    height: 20px;
  }
  .body {
    padding: 4px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    min-height: 30px;
    font-size: 12px;
    border-radius: 15px;
    padding: 0 10px;
  }
</style>
