<script lang="ts">
  let { label, checked, onchange, hint }: { label: string; checked: boolean; onchange: (v: boolean) => void; hint?: string } =
    $props();
</script>

<label class="toggle">
  <span class="text">
    {label}
    {#if hint}<small>{hint}</small>{/if}
  </span>
  <input type="checkbox" role="switch" {checked} onchange={(e) => onchange((e.target as HTMLInputElement).checked)} />
</label>

<style>
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: var(--tap);
    cursor: pointer;
  }
  .text {
    display: flex;
    flex-direction: column;
  }
  small {
    color: var(--muted);
    font-size: 12px;
  }
  input {
    appearance: none;
    width: 46px;
    height: 28px;
    border-radius: 14px;
    background: var(--surface-3);
    position: relative;
    flex: none;
    cursor: pointer;
    transition: background 0.15s;
  }
  input::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  input:checked {
    background: var(--accent);
  }
  input:checked::after {
    transform: translateX(18px);
  }
</style>
