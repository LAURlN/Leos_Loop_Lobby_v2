<!--
  The loop studio: a small waveform editor for one loop (Audacity, but only the
  parts a looper needs). Opened from a track's options ("⋯") -> Open in Studio.

  The session plays nothing here — the editor has its own preview and pausing
  the transport avoids hearing the loop twice. Edits happen on a working copy
  (session/studio.ts is pure), undo/redo keeps old copies, and "Save to loop"
  commits the result as one new take through the Lobby. Cancel leaves the loop
  untouched.
-->
<script lang="ts">
  import { MAX_LOOP_FRAMES, MIN_LOOP_FRAMES, describeLength } from '@lll/shared';
  import { onMount, untrack } from 'svelte';
  import {
    MAX_HISTORY,
    clampRange,
    dbToFactor,
    deleteRange,
    doubleLoop,
    factorToDb,
    fadeRange,
    gainRange,
    insertFrames,
    loudBounds,
    normalizeRange,
    peakOf,
    rangeOrAll,
    replaceRange,
    reverseRange,
    silenceRange,
    sliceRange,
    snapToZeroCrossing,
    type FadeKind,
    type FrameRange,
  } from '../../session/studio';
  import type { TrackState } from '../../session/schema';
  import { lobby } from '../../state/lobby.svelte';
  import { onFrame } from '../frameLoop';
  import { trackColor } from '../palette';
  import { fitView, formatFrames, panView, pickTickStep48, zoomView, columnEnvelope } from '../studioView';
  import Modal from './Modal.svelte';
  import Slider from './Slider.svelte';

  let { track, onclose }: { track: TrackState; onclose: () => void } = $props();

  // The working copy is built once, when the studio opens: the studio edits a
  // snapshot, never the live session, until "Save to loop". Scalar copies keep
  // the template free of null checks.
  const { src, color } = untrack(() => ({ src: lobby.studioSource(track.id), color: trackColor(track.color) }));
  const gain = src?.gain ?? 1;
  const pan = src?.pan ?? 0;
  const takes = src?.takes ?? 0;
  const authors = src?.authors ?? [];
  const missing = src?.missing ?? 0;

  let data = $state.raw<Float32Array>(src?.data ?? new Float32Array(0));
  let history = $state.raw<Float32Array[]>([]);
  let future = $state.raw<Float32Array[]>([]);
  let selection = $state.raw<FrameRange | null>(null);
  let clipboard = $state.raw<Float32Array | null>(null);
  let playhead48 = $state(0);
  let playing = $state(false);
  let loopPlayback = $state(true);
  let viewStart = $state(0);
  let viewSpan = $state(Math.max(1, src?.length48 ?? 1));
  let gainDb = $state(0);
  let hint = $state('');
  let width = $state(720);
  let height = $state(240);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let ctx: CanvasRenderingContext2D | null = null;

  /** Height of the time ruler at the top of the canvas. */
  const RULER = 20;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);

  const range = $derived(clampRange(selection, data.length));
  const envelope = $derived(columnEnvelope(data, viewStart, viewStart + viewSpan, Math.max(1, Math.round(width))));
  const level = $derived(range ? peakOf(data, range) : peakOf(data));
  const selectionSeconds = $derived(range ? (range.end - range.start) / 48000 : 0);
  const lengthChanged = $derived(!!src && data.length !== src.length48);
  const tooShort = $derived(data.length < MIN_LOOP_FRAMES || data.length > MAX_LOOP_FRAMES);
  const canSave = $derived(!!src && missing === 0 && !tooShort);
  const canUndo = $derived(history.length > 0);
  const canRedo = $derived(future.length > 0);
  const canDouble = $derived(data.length * 2 <= MAX_LOOP_FRAMES);

  // ---- buffer edits ---------------------------------------------------------

  function commit(next: Float32Array, options: { keepSelection?: boolean } = {}): void {
    if (!src || next === data || next.length === 0) return;
    history = [...history, data].slice(-MAX_HISTORY);
    future = [];
    data = next;
    selection = options.keepSelection ? clampRange(selection, next.length) : null;
    if (playhead48 > next.length - 1) playhead48 = 0;
    clampView();
    hint = '';
    if (playing) startPreview(playhead48);
  }

  function undo(): void {
    const previous = history[history.length - 1];
    if (!previous) return;
    future = [data, ...future].slice(0, MAX_HISTORY);
    history = history.slice(0, -1);
    data = previous;
    afterHistoryMove();
  }

  function redo(): void {
    const next = future[0];
    if (!next) return;
    history = [...history, data].slice(-MAX_HISTORY);
    future = future.slice(1);
    data = next;
    afterHistoryMove();
  }

  function afterHistoryMove(): void {
    selection = clampRange(selection, data.length);
    if (playhead48 > data.length - 1) playhead48 = 0;
    clampView();
    if (playing) startPreview(playhead48);
  }

  function clampView(): void {
    const span = Math.max(64, Math.min(data.length, viewSpan));
    viewSpan = span;
    viewStart = Math.max(0, Math.min(Math.max(0, data.length - span), viewStart));
  }

  function cut(): void {
    if (!range) return;
    clipboard = sliceRange(data, range);
    commit(deleteRange(data, range));
  }

  function copy(): void {
    if (!range) return;
    clipboard = sliceRange(data, range);
    hint = `Copied ${formatFrames(range.end - range.start)}.`;
  }

  function paste(): void {
    if (!clipboard) return;
    if (range) commit(replaceRange(data, range, clipboard));
    else commit(insertFrames(data, Math.round(playhead48), clipboard));
  }

  function duplicate(): void {
    if (!range) return;
    commit(insertFrames(data, range.end, sliceRange(data, range)), { keepSelection: true });
  }

  function trimToSelection(): void {
    if (!range) return;
    commit(sliceRange(data, range));
  }

  /** Removes leading and trailing silence: a loop often gets shorter this way. */
  function trimSilence(): void {
    const bounds = loudBounds(data);
    if (!bounds) return;
    if (bounds.start === 0 && bounds.end === data.length) {
      hint = 'No silence at the edges.';
      return;
    }
    commit(sliceRange(data, bounds));
  }

  function normalize(): void {
    const before = peakOf(data, range);
    if (before < 1e-5) {
      hint = 'Nothing to normalize here.';
      return;
    }
    const next = normalizeRange(data, range);
    commit(next, { keepSelection: true });
    hint = `Normalized from ${factorToDb(before).toFixed(1)} dB to ${factorToDb(peakOf(next, range)).toFixed(1)} dB.`;
  }

  function amplify(): void {
    const factor = dbToFactor(gainDb);
    if (factor === 1) return;
    hint = '';
    commit(gainRange(data, range, factor), { keepSelection: true });
    gainDb = 0;
  }

  function clearAll(): void {
    commit(new Float32Array(data.length));
  }

  // ---- preview --------------------------------------------------------------

  function startPreview(from48: number): void {
    if (!src) return;
    lobby.startStudioPreview({ gain, pan }, data, Math.max(0, Math.min(from48, data.length - 1)), loopPlayback);
    playing = true;
  }

  function stopPreview(): void {
    playing = false;
    lobby.stopStudioPreview();
  }

  function togglePlay(): void {
    if (playing) {
      stopPreview();
      return;
    }
    startPreview(playhead48 >= data.length - 1 ? 0 : playhead48);
  }

  function toggleLoop(): void {
    loopPlayback = !loopPlayback;
    if (playing) startPreview(playhead48);
  }

  function seek(frame48: number): void {
    playhead48 = Math.max(0, Math.min(data.length, Math.round(frame48)));
    if (playing) startPreview(playhead48);
  }

  /** Called every frame while the preview plays: move the playhead and scroll along. */
  function tick(): void {
    if (!playing) return;
    const position = lobby.studioPreviewPosition48();
    if (position === null) {
      // The buffer ran out (loop off).
      playing = false;
      playhead48 = data.length;
      return;
    }
    const clamped = Math.max(0, Math.min(data.length, position));
    if (Math.abs(clamped - playhead48) < 0.5) return;
    playhead48 = clamped;
    const px = ((clamped - viewStart) / Math.max(1, viewSpan)) * width;
    if (px > width * 0.9 || px < 0) {
      const span = Math.min(viewSpan, data.length);
      viewStart = Math.max(0, Math.min(Math.max(0, data.length - span), clamped - span / 2));
    }
  }

  // ---- canvas ---------------------------------------------------------------

  // Never leave the preview running when the studio closes.
  onMount(() => () => lobby.stopStudioPreview());

  $effect(() => {
    if (!canvas) return;
    const element = canvas;
    const stop = onFrame(element, tick);
    return () => {
      stop();
    };
  });

  $effect(() => {
    if (!canvas) return;
    const element = canvas;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0) width = rect.width;
      if (rect.height > 0) height = rect.height;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!canvas) return;
    // Wheel zoom/pan needs a non-passive listener, so it is attached by hand.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      const anchor = viewStart + ((event.clientX - rect.left) / Math.max(1, rect.width)) * viewSpan;
      if (event.shiftKey) {
        const next = panView({ start: viewStart, span: viewSpan }, event.deltaY * 4, data.length);
        viewStart = next.start;
        return;
      }
      const factor = Math.exp(-event.deltaY / 400);
      const next = zoomView({ start: viewStart, span: viewSpan }, anchor, factor, data.length);
      viewStart = next.start;
      viewSpan = next.span;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas?.removeEventListener('wheel', onWheel);
  });

  // Redraws on every relevant change; reading the playhead is deliberate, so
  // the moving cursor repaints too.
  $effect(() => {
    void data;
    void envelope;
    void selection;
    void viewStart;
    void viewSpan;
    void playing;
    void playhead48;
    draw();
  });

  function draw(): void {
    const element = canvas;
    if (!element) return;
    ctx ??= element.getContext('2d');
    const c = ctx;
    if (!c) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (element.width !== Math.round(w * dpr) || element.height !== Math.round(h * dpr)) {
      element.width = Math.round(w * dpr);
      element.height = Math.round(h * dpr);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#101728';
    c.fillRect(0, 0, w, h);

    const span = Math.max(1, viewSpan);
    const toX = (frame: number) => ((frame - viewStart) / span) * w;
    const top = RULER;
    const bottom = h - 14;
    const mid = (top + bottom) / 2;
    const half = Math.max(6, (bottom - top) / 2);

    // Ruler: a line every nice step, with its time where there is room.
    const step = pickTickStep48(span, Math.max(2, Math.floor(w / 84)));
    c.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    c.textBaseline = 'middle';
    c.fillStyle = '#151b2a';
    c.fillRect(0, 0, w, RULER);
    for (let frame = Math.ceil(viewStart / step) * step; frame <= viewStart + span; frame += step) {
      const x = Math.round(toX(frame)) + 0.5;
      c.strokeStyle = '#232c40';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
      c.fillStyle = '#8b94aa';
      c.fillText(formatFrames(frame, step < 48000), x + 4, RULER / 2);
    }
    c.strokeStyle = '#2b3449';
    c.beginPath();
    c.moveTo(0, RULER + 0.5);
    c.lineTo(w, RULER + 0.5);
    c.stroke();

    // Selection behind the wave.
    if (range) {
      const x1 = toX(range.start);
      const x2 = toX(range.end);
      c.fillStyle = 'rgb(183 148 255 / 0.16)';
      c.fillRect(x1, RULER, Math.max(1, x2 - x1), bottom - RULER);
      c.strokeStyle = 'rgb(183 148 255 / 0.75)';
      c.lineWidth = 1;
      for (const x of [x1, x2]) {
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, RULER);
        c.lineTo(Math.round(x) + 0.5, bottom);
        c.stroke();
      }
    }

    // The wave itself: one min/max ribbon per pixel column.
    c.strokeStyle = '#2b3449';
    c.beginPath();
    c.moveTo(0, Math.round(mid) + 0.5);
    c.lineTo(w, Math.round(mid) + 0.5);
    c.stroke();
    const env = envelope;
    const columns = env.max.length;
    c.beginPath();
    for (let i = 0; i < columns; i++) {
      const x = i + 0.5;
      const y = mid - (env.max[i] ?? 0) * half;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    for (let i = columns - 1; i >= 0; i--) c.lineTo(i + 0.5, mid - (env.min[i] ?? 0) * half);
    c.closePath();
    c.fillStyle = color;
    c.globalAlpha = 0.42;
    c.fill();
    c.globalAlpha = 0.95;
    c.lineWidth = 1;
    c.stroke();
    c.globalAlpha = 1;

    // Playhead on top.
    const px = Math.round(toX(playhead48)) + 0.5;
    c.strokeStyle = playing ? '#78efca' : '#cfd6e6';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px, RULER - 6);
    c.lineTo(px, bottom);
    c.stroke();
    c.fillStyle = c.strokeStyle;
    c.beginPath();
    c.moveTo(px - 4, RULER - 7);
    c.lineTo(px + 4, RULER - 7);
    c.lineTo(px, RULER - 1);
    c.closePath();
    c.fill();
  }

  type Drag = {
    kind: 'select' | 'pan';
    anchor: number;
    startX: number;
    moved: boolean;
    viewStart: number;
    pointerId: number;
  };

  let drag: Drag | null = null;

  function frameAt(clientX: number): number {
    const element = canvas;
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return viewStart + (x / Math.max(1, rect.width)) * viewSpan;
  }

  function pointerdown(event: PointerEvent): void {
    const element = canvas;
    if (!element || event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
    const y = event.clientY - element.getBoundingClientRect().top;
    drag = {
      kind: y < RULER ? 'pan' : 'select',
      anchor: frameAt(event.clientX),
      startX: event.clientX,
      moved: false,
      viewStart,
      pointerId: event.pointerId,
    };
  }

  function pointermove(event: PointerEvent): void {
    const element = canvas;
    if (!drag || !element) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    if (drag.kind === 'pan') {
      const perPixel = viewSpan / Math.max(1, element.getBoundingClientRect().width);
      viewStart = panView({ start: drag.viewStart, span: viewSpan }, -dx * perPixel, data.length).start;
      return;
    }
    const a = snapToZeroCrossing(data, drag.anchor);
    const b = snapToZeroCrossing(data, frameAt(event.clientX));
    selection = clampRange({ start: Math.min(a, b), end: Math.max(a, b) }, data.length);
  }

  function pointerup(event: PointerEvent): void {
    const element = canvas;
    const current = drag;
    drag = null;
    if (!current || !element) return;
    try {
      element.releasePointerCapture(current.pointerId);
    } catch {
      // Pointer already released.
    }
    if (current.moved) return;
    // A tap seeks; on the ruler it just moves, in the wave it also drops the selection.
    if (current.kind === 'select') selection = null;
    seek(frameAt(event.clientX));
  }

  function zoom(factor: number): void {
    const anchor = range ? (range.start + range.end) / 2 : playhead48;
    const next = zoomView({ start: viewStart, span: viewSpan }, anchor, factor, data.length);
    viewStart = next.start;
    viewSpan = next.span;
  }

  function fit(): void {
    const next = fitView(data.length);
    viewStart = next.start;
    viewSpan = next.span;
  }

  // ---- save / close ---------------------------------------------------------

  function save(): void {
    if (!canSave) return;
    stopPreview();
    if (lobby.saveStudioEdit(track.id, data)) onclose();
  }

  function cancel(): void {
    stopPreview();
    onclose();
  }

  function onkeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing =
      !!target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    if (event.key === 'Escape') return; // Modal closes
    if (event.key === ' ') {
      if (typing) return;
      event.preventDefault();
      togglePlay();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      seek(0);
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && key === 'c') {
      event.preventDefault();
      copy();
      return;
    }
    if (mod && key === 'x') {
      event.preventDefault();
      cut();
      return;
    }
    if (mod && key === 'v') {
      event.preventDefault();
      paste();
      return;
    }
    if (mod && key === 'a') {
      event.preventDefault();
      selection = { start: 0, end: data.length };
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
      event.preventDefault();
      if (range) commit(deleteRange(data, range));
      return;
    }
    if (key === 'd' && !typing) {
      event.preventDefault();
      duplicate();
    }
  }
</script>

<svelte:window {onkeydown} />

<Modal title={`Studio · ${track.name}`} onclose={cancel} wide>
  {#if !src}
    <p class="muted">This loop has no takes to edit yet. Record one first.</p>
  {:else}
    <div class="studio" style:--track={color}>
      <div class="toolbar">
        <button class="tool play" class:playing onclick={togglePlay} aria-label={playing ? 'Pause preview' : 'Play preview'}>
          {playing ? '⏸' : '▶'} {playing ? 'Pause' : 'Play'}
        </button>
        <button class="tool" class:on={loopPlayback} onclick={toggleLoop} aria-pressed={loopPlayback} title="Repeat the loop while previewing">
          ⟲ Loop
        </button>
        <span class="time">{formatFrames(playhead48)} <span class="muted">/ {formatFrames(data.length)}</span></span>
        <div class="zoom">
          <button class="tool" onclick={() => zoom(1.7)} aria-label="Zoom in">＋</button>
          <button class="tool" onclick={() => zoom(1 / 1.7)} aria-label="Zoom out">−</button>
          <button class="tool" onclick={fit}>Fit</button>
        </div>
      </div>

      <div class="stage">
        <canvas
          bind:this={canvas}
          onpointerdown={pointerdown}
          onpointermove={pointermove}
          onpointerup={pointerup}
          onpointercancel={() => (drag = null)}
          aria-label="Loop waveform. Drag to select, drag the ruler to scroll, tap to move the playhead."
        ></canvas>
      </div>

      <p class="status">
        {#if range}
          Selection {formatFrames(range.start)} – {formatFrames(range.end)}
          ({formatFrames(range.end - range.start)}, {selectionSeconds.toFixed(3)} s)
        {:else}
          Drag across the waveform to select · tap to move the playhead
        {/if}
        <span class="muted"> · peak {factorToDb(level).toFixed(1)} dB</span>
        {#if takes > 1 || authors.some((a) => a !== 'you')}
          <span class="muted"> · {takes} takes by {authors.join(', ')}</span>
        {/if}
      </p>

      {#if missing > 0}
        <p class="warn">
          {missing} take{missing === 1 ? '' : 's'} still loading — saving is disabled until the audio arrives.
        </p>
      {/if}

      <div class="groups">
        <div class="group">
          <span class="label">Clipboard</span>
          <button class="tool" onclick={cut} disabled={!range}>Cut</button>
          <button class="tool" onclick={copy} disabled={!range}>Copy</button>
          <button class="tool" onclick={paste} disabled={!clipboard} title="Paste at the playhead">Paste</button>
          <button class="tool" onclick={duplicate} disabled={!range}>Duplicate</button>
        </div>
        <div class="group">
          <span class="label">Edit</span>
          <button class="tool" onclick={() => range && commit(deleteRange(data, range))} disabled={!range} title="Remove and close the gap (shortens the loop)">
            Delete
          </button>
          <button class="tool" onclick={() => range && commit(silenceRange(data, range), { keepSelection: true })} disabled={!range} title="Replace with silence (keeps the loop length)">
            Silence
          </button>
          <button class="tool" onclick={() => commit(reverseRange(data, rangeOrAll(range, data.length)), { keepSelection: true })}>Reverse</button>
          <button class="tool" onclick={() => commit(fadeRange(data, rangeOrAll(range, data.length), 'in' as FadeKind), { keepSelection: true })}>Fade in</button>
          <button class="tool" onclick={() => commit(fadeRange(data, rangeOrAll(range, data.length), 'out' as FadeKind), { keepSelection: true })}>Fade out</button>
        </div>
        <div class="group">
          <span class="label">Level</span>
          <div class="gain">
            <Slider
              label={range ? 'Amplify selection' : 'Amplify loop'}
              value={gainDb}
              min={-24}
              max={24}
              step={0.5}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
              onchange={(v) => (gainDb = v)}
              accent={color}
            />
            <button class="tool" onclick={amplify} disabled={gainDb === 0}>Apply</button>
          </div>
          <button class="tool" onclick={normalize} title="Raise the loudest sample to −0.2 dB">Normalize</button>
        </div>
        <div class="group">
          <span class="label">Loop</span>
          <button class="tool" onclick={trimToSelection} disabled={!range} title="The loop becomes the selection">Trim to</button>
          <button class="tool" onclick={trimSilence} title="Drop leading and trailing silence">Trim silence</button>
          <button class="tool" onclick={() => commit(doubleLoop(data))} disabled={!canDouble} title="Append a copy: the loop gets twice as long">Double</button>
          <button class="tool" onclick={clearAll} disabled={level === 0}>Clear</button>
        </div>
        <div class="group">
          <span class="label">History</span>
          <button class="tool" onclick={undo} disabled={!canUndo}>↶ Undo</button>
          <button class="tool" onclick={redo} disabled={!canRedo}>↷ Redo</button>
          {#if hint}<span class="hint">{hint}</span>{/if}
        </div>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <div class="foot-note">
      {#if src}
        {#if tooShort}
          <span class="warn">The loop must stay between 0.1 s and 10 minutes.</span>
        {:else if lengthChanged}
          <span class="warn">
            Loop length {describeLength(src.length48, lobby.snapshot.referenceLength48)} →
            {describeLength(data.length, lobby.snapshot.referenceLength48)} — saving changes how this loop lines up.
          </span>
        {:else if takes > 1 || authors.some((a) => a !== 'you')}
          <span class="muted">Saving merges the takes into one.</span>
        {/if}
      {/if}
    </div>
    <button onclick={cancel}>Cancel</button>
    <button class="primary" onclick={save} disabled={!canSave}>Save to loop</button>
  {/snippet}
</Modal>

<style>
  .studio {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .time {
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    margin-left: 4px;
  }
  .zoom {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
  .tool {
    min-height: 36px;
    padding: 0 10px;
    font-size: 13px;
    font-weight: 550;
  }
  .tool.play {
    border-color: var(--accent);
    color: var(--accent);
  }
  .tool.on {
    background: var(--track);
    border-color: var(--track);
    color: #0b0f19;
    font-weight: 700;
  }
  .stage {
    position: relative;
    width: 100%;
    height: clamp(180px, 34vh, 320px);
    background: #101728;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: crosshair;
  }
  .status {
    margin: 0;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
  .warn {
    margin: 0;
    font-size: 12.5px;
    color: var(--warn);
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .group .label {
    width: 76px;
    flex: none;
  }
  .gain {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex: 1;
    min-width: 220px;
    max-width: 320px;
  }
  .gain button {
    margin-bottom: 4px;
  }
  .hint {
    font-size: 12.5px;
    color: var(--accent);
  }
  .foot-note {
    flex: 1;
    text-align: left;
    font-size: 12.5px;
    align-self: center;
  }
</style>
