<!--
  Full song view: every section in tab order as a block on one timeline, as
  long as its longest loop, with one waveform lane per sounding track.
  Click the timeline to jump; the playhead follows the song while it plays.
  Playback is local and driven by the top bar transport (session/song.ts).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { CANONICAL_RATE } from '@lll/shared';
  import { segmentAt } from '../../session/song';
  import { lobby } from '../../state/lobby.svelte';
  import { onFrame } from '../frameLoop';
  import SongLane from './SongLane.svelte';

  const RULER = 22;
  const HEADER = 34;
  const LANE = 44;
  /** Below this the song scrolls horizontally instead of squeezing. */
  const MIN_PX_PER_SEC = 24;
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120];

  let scroller: HTMLDivElement;
  let playhead: HTMLDivElement;
  let viewWidth = $state(0);
  let current = $state(-1);

  const plan = $derived(lobby.songPlan);
  const totalSec = $derived(plan.total48 / CANONICAL_RATE);
  const pxPerSec = $derived(totalSec > 0 ? Math.max(MIN_PX_PER_SEC, (viewWidth - 2) / totalSec) : MIN_PX_PER_SEC);
  const width = $derived(totalSec * pxPerSec);
  const lanes = $derived(Math.max(1, ...plan.segments.map((s) => s.tracks.length)));
  const height = $derived(RULER + HEADER + lanes * LANE);
  const ticks = $derived.by(() => {
    const step = TICK_STEPS.find((s) => s * pxPerSec >= 56) ?? 300;
    const out: number[] = [];
    // Leave room for the label, so the last tick never widens the timeline.
    for (let t = 0; t * pxPerSec <= width - 30; t += step) out.push(t);
    return out;
  });
  const skipped = $derived(
    plan.skipped.map((id) => lobby.snapshot.sections.find((s) => s.id === id)?.name ?? '').filter(Boolean),
  );

  const sectionName = (id: string) => lobby.snapshot.sections.find((s) => s.id === id)?.name ?? '';
  const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  onMount(() =>
    onFrame(scroller, (now) => {
      lobby.tickSong(now);
      const pos = lobby.songPosition48(now);
      const x = (pos / CANONICAL_RATE) * pxPerSec;
      playhead.style.transform = `translateX(${x}px)`;
      const index = lobby.playbackPaused ? -1 : segmentAt(plan, pos);
      if (index !== current) current = index;
      // Keep the playhead in view while playing.
      if (!lobby.playbackPaused && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 24)) {
        scroller.scrollLeft = Math.max(0, x - 24);
      }
    }),
  );

  function seek(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const sec = (event.clientX - rect.left) / pxPerSec;
    lobby.seekSong(sec * CANONICAL_RATE);
  }
</script>

<section class="song" aria-label="Full song">
  <header class="summary">
    <h2>Full song</h2>
    <span class="muted">
      {plan.segments.length} section{plan.segments.length === 1 ? '' : 's'} · {clock(totalSec)}
    </span>
  </header>

  <div class="scroller" bind:this={scroller} bind:clientWidth={viewWidth}>
    {#if plan.segments.length === 0}
      <p class="empty muted">Record loops in a section to hear it here. Each section plays as long as its longest loop.</p>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="timeline"
      class:hidden={plan.segments.length === 0}
      style:width="{width}px"
      style:height="{height}px"
      role="presentation"
      onclick={seek}
    >
      <div class="ruler" style:height="{RULER}px">
        {#each ticks as t (t)}
          <span class="tick" style:left="{t * pxPerSec}px">{clock(t)}</span>
        {/each}
      </div>
      {#each plan.segments as seg, i (seg.sectionId)}
        {@const left = (seg.start48 / CANONICAL_RATE) * pxPerSec}
        {@const blockWidth = (seg.length48 / CANONICAL_RATE) * pxPerSec}
        {@const anySolo = seg.tracks.some((t) => t.solo)}
        <div class="block" class:current={i === current} style:left="{left}px" style:width="{blockWidth}px" style:top="{RULER}px">
          <div class="block-header" style:height="{HEADER}px">
            <span class="block-name">{sectionName(seg.sectionId)}</span>
            <span class="block-len">{(seg.length48 / CANONICAL_RATE).toFixed(1)} s</span>
            <button
              class="open"
              title="Open this section"
              onclick={(e) => {
                e.stopPropagation();
                lobby.selectSection(seg.sectionId);
              }}>Open</button
            >
          </div>
          {#each seg.tracks as track (track.id)}
            <SongLane
              {track}
              width={blockWidth}
              height={LANE}
              {pxPerSec}
              audible={!track.mute && (!anySolo || track.solo)}
            />
          {/each}
        </div>
      {/each}
      <div class="playhead" bind:this={playhead} style:height="{height}px"></div>
    </div>
  </div>

  {#if skipped.length > 0}
    <p class="muted small">Skipped (no loops yet): {skipped.join(', ')}</p>
  {/if}
</section>

<style>
  .song {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .summary h2 {
    font-size: 16px;
    margin: 0;
  }
  .scroller {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 0 10px;
  }
  .empty {
    margin: 24px 16px;
    text-align: center;
  }
  .timeline {
    position: relative;
    cursor: pointer;
    user-select: none;
  }
  .timeline.hidden {
    display: none;
  }
  .ruler {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
  }
  .tick {
    position: absolute;
    top: 2px;
    padding-left: 4px;
    border-left: 1px solid var(--border);
    font-size: 11px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
    line-height: 16px;
  }
  .block {
    position: absolute;
    bottom: 0;
    box-sizing: border-box;
    background: var(--surface-2);
    box-shadow: inset 1px 0 0 var(--border), inset -1px 0 0 var(--border);
    overflow: hidden;
  }
  .block.current {
    background: var(--surface-3);
    box-shadow: inset 0 2px 0 var(--accent), inset 1px 0 0 var(--border), inset -1px 0 0 var(--border);
  }
  .block-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 8px;
    min-width: 0;
  }
  .block-name {
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .block-len {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .open {
    margin-left: auto;
    min-height: 24px;
    height: 24px;
    padding: 0 8px;
    font-size: 11px;
    flex: none;
  }
  .playhead {
    position: absolute;
    left: 0;
    top: 0;
    width: 2px;
    margin-left: -1px;
    background: #f2f6ff;
    box-shadow: 0 0 6px rgb(242 246 255 / 0.6);
    pointer-events: none;
    will-change: transform;
  }
  .small {
    font-size: 13px;
    margin: 0;
  }
</style>
