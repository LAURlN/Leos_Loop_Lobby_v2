<!--
  One track inside a section block of the song view: its loop's waveform,
  repeated across the section (a ½× loop shows twice in a 1× section).
  Redrawn only when the mix, size or mute state changes.
-->
<script lang="ts">
  import { CANONICAL_RATE } from '@lll/shared';
  import type { TrackState } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import { trackColor } from '../palette';

  let {
    track,
    width,
    height,
    pxPerSec,
    audible,
  }: { track: TrackState; width: number; height: number; pxPerSec: number; audible: boolean } = $props();

  let canvas: HTMLCanvasElement;
  const color = $derived(trackColor(track.color));
  const peaks = $derived(lobby.visuals[track.id]?.peaks ?? null);

  $effect(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const loopPx = ((track.length48 ?? 0) / CANONICAL_RATE) * pxPerSec * dpr;
    ctx.globalAlpha = audible ? 0.9 : 0.3;
    ctx.fillStyle = color;
    if (!peaks || loopPx <= 0) {
      ctx.fillRect(0, mid - dpr / 2, w, dpr);
      return;
    }
    const usable = h / 2 - 4 * dpr;
    for (let x = 0; x < w; x++) {
      const bin = Math.floor(((x % loopPx) / loopPx) * peaks.length);
      const half = Math.max(dpr / 2, (peaks[bin] ?? 0) * usable);
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    // Faint marks where the loop starts again.
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#f2f6ff';
    for (let x = loopPx; x < w - 1; x += loopPx) ctx.fillRect(Math.round(x), 0, 1, h);
  });
</script>

<div class="lane" style:height="{height}px" style:--track={color} class:muted={!audible}>
  <canvas bind:this={canvas}></canvas>
  <span class="name">{track.name}</span>
</div>

<style>
  .lane {
    position: relative;
    border-top: 1px solid rgb(255 255 255 / 0.05);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .name {
    position: absolute;
    left: 6px;
    top: 3px;
    font-size: 11px;
    font-weight: 650;
    color: var(--track);
    white-space: nowrap;
    max-width: calc(100% - 12px);
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
    pointer-events: none;
  }
  .muted .name {
    opacity: 0.5;
  }
</style>
