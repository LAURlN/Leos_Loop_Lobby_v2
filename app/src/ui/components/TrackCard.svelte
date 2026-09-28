<!--
  One track: the spinning disc (tap = record / stop / overdub) plus its status.
  Taps use `pointerdown` and the event timestamp, so the recorded loop starts
  where the finger landed, not when the browser got around to a click.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { CANONICAL_RATE, describeLength } from '@lll/shared';
  import { getEffect } from '../../effects/registry';
  import { hasAudio, visibleLayers, type TrackState } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import { DiscRenderer, type DiscMode } from '../discRenderer';
  import { trackColor } from '../palette';

  let { track, selected, onedit }: { track: TrackState; selected: boolean; onedit: () => void } = $props();

  let canvas: HTMLCanvasElement;
  let seconds = $state(0);

  const color = $derived(trackColor(track.color));
  const recording = $derived(lobby.isRecording(track.id));
  const finishing = $derived(lobby.isFinishing(track.id));
  const visual = $derived(lobby.visuals[track.id]);
  const remote = $derived(lobby.remoteRecorders(track.id));
  const layers = $derived(visibleLayers(track));
  const mode: DiscMode = $derived(
    recording
      ? track.length48 === null
        ? 'recording'
        : 'overdub'
      : finishing
        ? 'finishing'
        : hasAudio(track)
          ? visual?.spectrogram
            ? 'playing'
            : 'waiting'
          : 'empty',
  );
  const lengthText = $derived(
    track.length48 !== null ? describeLength(track.length48, lobby.snapshot.referenceLength48) : null,
  );
  const status = $derived.by(() => {
    switch (mode) {
      case 'recording':
        return `Recording ${seconds.toFixed(1)} s · tap to loop`;
      case 'overdub':
        return `Overdub ${seconds.toFixed(1)} s · tap to stop`;
      case 'finishing':
        return 'Saving take…';
      case 'waiting':
        return 'Receiving audio…';
      case 'empty':
        return lengthText ? `Empty · ${lengthText} · tap to record` : 'Tap to record';
      case 'playing': {
        const takes = `${layers.length} take${layers.length === 1 ? '' : 's'}`;
        const missing = visual?.missingLayers ? ` · ${visual.missingLayers} loading` : '';
        return `${lengthText} · ${takes}${missing}`;
      }
    }
  });

  onMount(() => {
    const renderer = new DiscRenderer(canvas);
    let frame = 0;
    const loop = (time: number) => {
      const secs = lobby.isRecording(track.id) ? lobby.recordingSeconds() : 0;
      if (Math.abs(secs - seconds) >= 0.1 || (secs === 0 && seconds !== 0)) seconds = secs;
      const ref = track.length48 ?? lobby.snapshot.referenceLength48;
      renderer.draw({
        color,
        mode,
        spectrogram: visual?.spectrogram ?? null,
        revision: visual?.revision ?? 0,
        playhead: hasAudio(track) || track.length48 !== null ? lobby.playheadFraction(track.length48) : null,
        recordProgress: mode === 'recording' || mode === 'overdub' ? (secs / ((ref ?? CANONICAL_RATE * 8) / CANONICAL_RATE)) % 1 : null,
        stickers: track.effects.flatMap((e) => {
          const def = getEffect(e.type);
          return def ? [{ label: def.sticker, color: def.color, enabled: e.enabled }] : [];
        }),
        remoteRecording: remote.length > 0,
        muted: track.mute,
        time,
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  });

  function pointerdown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    lobby.tapTrack(track.id, event.timeStamp);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      lobby.tapTrack(track.id, event.timeStamp);
    }
  }
</script>

<article class="card" class:selected class:rec={mode === 'recording' || mode === 'overdub'} style:--track={color}>
  <header>
    <span class="dot"></span>
    <h3 title={track.name}>{track.name}</h3>
    <button class="icon ghost edit" aria-label="Edit {track.name}" onclick={onedit}>⋯</button>
  </header>
  <button
    class="disc"
    aria-label="{track.name}: {status}"
    onpointerdown={pointerdown}
    onkeydown={keydown}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <canvas bind:this={canvas}></canvas>
  </button>
  <p class="status">{status}</p>
  {#if remote.length}
    <p class="remote">● {remote.join(', ')} recording</p>
  {/if}
</article>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 22px;
    padding: 8px 10px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    transition: border-color 0.15s, background 0.15s;
  }
  .card.selected {
    border-color: var(--track);
    background: var(--surface-2);
  }
  .card.rec {
    border-color: var(--danger);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding-left: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--track);
    flex: none;
  }
  h3 {
    font-size: 14px;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .edit {
    font-size: 20px;
    color: var(--muted);
  }
  .disc {
    all: unset;
    width: 100%;
    aspect-ratio: 1;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    border-radius: 50%;
  }
  .disc:focus-visible {
    outline: 2px solid var(--accent-2);
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .status {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--muted);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .remote {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--danger);
  }
</style>
