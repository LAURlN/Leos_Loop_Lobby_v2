/**
 * A song take follows the local song origin, then becomes one ordinary loop
 * per crossed section. Cut once on the canonical grid: no folding or fades
 * at internal boundaries, so a sustained phrase survives the split intact.
 */
import * as Y from 'yjs';
import { CANONICAL_RATE, MAX_LOOP_FRAMES, applyFades, randomId, resampleLinear } from '@lll/shared';
import type { MicCapture, CaptureHold } from '../audio/micCapture';
import { addSongTake } from './actions';
import type { LayerAudioStore } from './layerAudio';
import { readSnapshot } from './schema';
import { songPlan, type SongPlan } from './song';

export interface SongSlice {
  sectionId: string;
  length48: number;
  offset: number;
  data: Float32Array;
}

export function splitSongTake(plan: SongPlan, start48: number, samples: Float32Array): SongSlice[] {
  const slices: SongSlice[] = [];
  const end48 = start48 + samples.length;
  for (const segment of plan.segments) {
    const from = Math.max(start48, segment.start48);
    const to = Math.min(end48, segment.start48 + segment.length48);
    if (to <= from) continue;
    slices.push({
      sectionId: segment.sectionId,
      length48: segment.length48,
      offset: from - segment.start48,
      data: samples.slice(from - start48, to - start48),
    });
  }
  return slices;
}

/** Mix and name edits are fine; timing edits invalidate the take's destinations. */
export function songLayoutKey(plan: SongPlan): string {
  return JSON.stringify(plan.segments.map((s) => [s.sectionId, s.start48, s.length48]));
}

interface CaptureEngine {
  sampleRate: number;
  capture: MicCapture;
  heardFrameAt(eventTime?: number): number;
}

interface Take {
  doc: Y.Doc;
  plan: SongPlan;
  origin: number;
  start48: number;
  end48: number;
  from: number;
  hold: CaptureHold;
  author: string;
  authorName: string;
}

export interface SongRecorderDeps {
  engine: CaptureEngine;
  doc: () => Y.Doc;
  store: LayerAudioStore;
  identity: () => { userId: string; name: string };
  roundTripMs: () => number;
  changed: () => void;
  notify: (message: string) => void;
  ended: () => void;
}

export class SongRecorder {
  private take: Take | null = null;
  private pending: Take | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SongRecorderDeps) {}

  get recording(): boolean { return this.take !== null; }
  get finishing(): boolean { return this.pending !== null; }
  get busy(): boolean { return this.recording || this.finishing; }

  start(plan: SongPlan, origin: number, start48: number): void {
    if (this.busy) return;
    const { engine } = this.deps;
    start48 = Math.max(0, Math.ceil(start48));
    if (start48 >= plan.total48) return;
    const roundTrip = this.deps.roundTripMs() * engine.sampleRate / 1000;
    const from = Math.round(origin + start48 * engine.sampleRate / CANONICAL_RATE + roundTrip);
    const me = this.deps.identity();
    this.take = {
      doc: this.deps.doc(), plan, origin, start48, from,
      end48: Math.min(plan.total48, start48 + MAX_LOOP_FRAMES),
      hold: engine.capture.hold(from), author: me.userId, authorName: me.name,
    };
    // Independent of rendering: a hidden tab must still close at the exact end.
    this.timer = setInterval(() => {
      const take = this.take;
      if (take && this.position(take, engine.heardFrameAt()) >= take.end48) {
        void this.stop();
        if (take.end48 < take.plan.total48) this.deps.notify('Reached the 10-minute recording limit. Continue with another take.');
        this.deps.ended();
      }
    }, 100);
    this.deps.changed();
  }

  validate(plan: SongPlan): void {
    const take = this.take ?? this.pending;
    if (take && songLayoutKey(take.plan) !== songLayoutKey(plan)) {
      this.cancel();
      this.deps.notify('Song recording cancelled because the section order or lengths changed.');
    }
  }

  cancel(): void {
    clearInterval(this.timer);
    if (this.take) this.deps.engine.capture.release(this.take.hold);
    if (this.pending) this.deps.engine.capture.release(this.pending.hold);
    this.take = this.pending = null;
    this.deps.changed();
  }

  async stop(eventTime?: number): Promise<void> {
    const take = this.take;
    if (!take) return;
    const { engine, store } = this.deps;
    const end48 = Math.min(take.end48, Math.max(take.start48, Math.round(this.position(take, engine.heardFrameAt(eventTime)))));
    clearInterval(this.timer);
    this.take = null;
    this.pending = take;
    this.deps.changed();
    try {
      const count = end48 - take.start48;
      if (count <= 0) return;
      const to = take.from + Math.ceil(count * engine.sampleRate / CANONICAL_RATE);
      await engine.capture.waitUntil(to);
      if (this.pending !== take || this.deps.doc() !== take.doc) return;
      this.validate(songPlan(readSnapshot(take.doc)));
      if (this.pending !== take) return;
      const samples = resampleLinear(engine.capture.read(take.from, to), engine.sampleRate, CANONICAL_RATE).slice(0, count);
      applyFades(samples, 240, 240); // Only the outside edges of the entire take.
      const slices = splitSongTake(take.plan, take.start48, samples);
      const parts = slices.map(({ data, ...slice }) => {
        const id = randomId();
        store.put(id, data);
        return { ...slice, id, frames: data.length };
      });
      const tracks = addSongTake(take.doc, parts, take.author, take.authorName);
      if (tracks.length === 0) store.forget(parts.map((p) => p.id));
      else this.deps.notify(`Recorded into ${tracks.length} section${tracks.length === 1 ? '' : 's'}.`);
    } catch (error) {
      if (this.pending === take) this.deps.notify(`Recording failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      engine.capture.release(take.hold);
      if (this.pending === take) this.pending = null;
      this.deps.changed();
    }
  }

  private position(take: Take, frame: number): number {
    return (frame - take.origin) * CANONICAL_RATE / this.deps.engine.sampleRate;
  }
}
