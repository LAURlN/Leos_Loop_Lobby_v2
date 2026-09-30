<!--
  Dialog that is a bottom sheet on phones and a centered card on desktops.
  `wide` gives room for canvas work (the loop studio).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    onclose,
    children,
    footer,
    wide = false,
  }: { title: string; onclose: () => void; children: Snippet; footer?: Snippet; wide?: boolean } = $props();

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose();
  }
</script>

<svelte:window {onkeydown} />

<div class="backdrop" role="presentation" onclick={onclose}></div>
<div class="modal" class:wide role="dialog" aria-modal="true" aria-label={title}>
  <header>
    <h2>{title}</h2>
    <button class="icon ghost" aria-label="Close" onclick={onclose}>✕</button>
  </header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    /* No backdrop-filter: blurring the animated discs behind costs a full-screen pass per frame. */
    background: rgb(4 6 12 / 0.68);
    z-index: 40;
  }
  .modal {
    position: fixed;
    z-index: 41;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, calc(100vw - 32px));
    max-height: min(86vh, 820px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 30px 80px rgb(0 0 0 / 0.5);
  }
  .modal.wide {
    width: min(1080px, calc(100vw - 32px));
    max-height: min(92vh, 900px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 10px 6px 20px;
  }
  h2 {
    font-size: 18px;
  }
  .body {
    padding: 8px 20px 20px;
    overflow: auto;
  }
  footer {
    padding: 12px 20px calc(16px + var(--safe-bottom));
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  @media (max-width: 700px) {
    .modal.wide {
      width: 100%;
    }
    .modal {
      left: 0;
      right: 0;
      top: auto;
      bottom: 0;
      transform: none;
      width: 100%;
      max-height: 90vh;
      border-radius: var(--radius) var(--radius) 0 0;
      padding-bottom: var(--safe-bottom);
    }
  }
</style>
