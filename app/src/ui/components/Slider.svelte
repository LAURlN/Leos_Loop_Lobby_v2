<!--
  Labelled range slider. Emits at most every `throttleMs` while dragging (so the
  shared document is not flooded) and always emits the final value.
-->
<script lang="ts">
  let {
    label,
    value,
    min,
    max,
    step = 0.01,
    format = (v: number) => v.toFixed(2),
    onchange,
    throttleMs = 60,
    accent = 'var(--accent)',
  }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    format?: (v: number) => string;
    onchange: (value: number) => void;
    throttleMs?: number;
    accent?: string;
  } = $props();

  let local = $state(0);
  let dragging = $state(false);
  let lastSent = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const id = `slider-${Math.random().toString(36).slice(2)}`;

  $effect(() => {
    if (!dragging) local = value;
  });

  function input(event: Event) {
    dragging = true;
    local = Number((event.target as HTMLInputElement).value);
    const now = performance.now();
    clearTimeout(trailing);
    if (now - lastSent >= throttleMs) {
      lastSent = now;
      onchange(local);
    } else {
      trailing = setTimeout(() => {
        lastSent = performance.now();
        onchange(local);
      }, throttleMs);
    }
  }

  function commit() {
    clearTimeout(trailing);
    onchange(local);
    dragging = false;
  }
</script>

<div class="slider" style:--slider-accent={accent}>
  <div class="top">
    <label for={id}>{label}</label>
    <span class="value">{format(local)}</span>
  </div>
  <input {id} type="range" {min} {max} {step} value={local} oninput={input} onchange={commit} />
</div>

<style>
  .slider {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
  }
  label {
    color: var(--muted);
  }
  .value {
    font-variant-numeric: tabular-nums;
  }
  input {
    width: 100%;
    accent-color: var(--slider-accent);
    height: 32px;
  }
</style>
