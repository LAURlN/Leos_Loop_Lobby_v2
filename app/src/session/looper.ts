/**
 * The local recording state machine. Turns taps into takes:
 *
 *   tap  -> remember the *heard* frame of the tap, hold mic audio from there
 *   tap  -> cut mic frames [start + roundTrip - preRoll, stop + roundTrip),
 *           map them to loop positions (timing law), store as a new layer
 *
 * The very first take also defines this device's transport origin and the
 * loop length. Everything network-related happens elsewhere; a take is just
 * an `addLayer` on the shared document.
 */
import * as Y from 'yjs';
import {
  CANONICAL_RATE,
  MAX_LOOP_FRAMES,
  MIN_LOOP_FRAMES,
  applyFades,
  autoSnapLength,
  capturePosition,
  clampLength,
  convertFrames,
  foldTake,
  randomId,
  resampleLinear,
} from '@lll/shared';
import type { AudioEngine } from '../audio/engine';
import type { CaptureHold } from '../audio/micCapture';
import { addLayer } from './actions';
import type { LayerAudioStore } from './layerAudio';
import { phraseOriginShift } from './phraseAlignment';
import { hasAudio, readSnapshot } from './schema';

/** Audio kept from just before the tap, so an early note is not cut off. */
const PRE_ROLL_SECONDS = 0.1;
const FADE_OUT_SECONDS = 0.005;

export interface LocalRecording {
  trackId: string;
  /** Local heard-frame of the start tap. */
  startFrame: number;
  /** performance.now() at start, for UI timers. */
  startedAt: number;
  /** Loop length if known before stopping (overdub or predefined length). */
  knownLength48: number | null;
}

export interface LooperDeps {
  doc: () => Y.Doc;
  engine: Pick<AudioEngine, 'sampleRate' | 'capture' | 'heardFrameAt' | 'transportOrigin' | 'setTransportOrigin'>;
  activeSectionId: () => string | null;
  store: LayerAudioStore;
  identity: () => { userId: string; name: string };
  /** Current round-trip latency in milliseconds. */
  roundTripMs: () => number;
  notify: (message: string) => void;
}

export class Looper {
  recording: LocalRecording | null = null;
  /** Tracks whose take is being finalised (waiting for mic audio). */
  readonly finishing = new Set<string>();
  private holds = new Map<LocalRecording, CaptureHold>();
  private autoStop: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: LooperDeps) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Primary action for a track: start or stop recording. */
  async tap(trackId: string, eventTime?: number): Promise<void> {
    const frame = this.deps.engine.heardFrameAt(eventTime);
    if (this.finishing.has(trackId)) return;
    const current = this.recording;
    if (current) {
      await this.stop(frame);
      if (current.trackId === trackId) return;
    }
    this.start(trackId, frame);
  }

  cancel(): void {
    if (!this.recording) return;
    clearTimeout(this.autoStop);
    this.releaseHold(this.recording);
    this.recording = null;
    this.emit();
  }

  private start(trackId: string, frame: number): void {
    const { engine } = this.deps;
    const track = readSnapshot(this.deps.doc()).tracks.find((t) => t.id === trackId);
    if (!track) return;
    const rt = this.roundTripFrames();
    const preRoll = Math.round(PRE_ROLL_SECONDS * engine.sampleRate);
    const rec: LocalRecording = { trackId, startFrame: frame, startedAt: performance.now(), knownLength48: track.length48 };
    this.holds.set(rec, engine.capture.hold(Math.floor(frame + rt - preRoll)));
    this.recording = rec;
    const maxSeconds = MAX_LOOP_FRAMES / CANONICAL_RATE;
    this.autoStop = setTimeout(() => void this.stop(this.deps.engine.heardFrameAt()), maxSeconds * 1000);
    this.emit();
  }

  private async stop(stopFrame: number): Promise<void> {
    const rec = this.recording;
    if (!rec) return;
    clearTimeout(this.autoStop);
    this.recording = null;
    this.finishing.add(rec.trackId);
    this.emit();
    try {
      await this.commit(rec, stopFrame);
    } catch (err) {
      this.deps.notify(`Recording failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.releaseHold(rec);
      this.finishing.delete(rec.trackId);
      this.emit();
    }
  }

  private async commit(rec: LocalRecording, stopFrame: number): Promise<void> {
    const { engine, store } = this.deps;
    const doc = this.deps.doc();
    const snapshot = readSnapshot(doc);
    const track = snapshot.tracks.find((t) => t.id === rec.trackId);
    if (!track) return; // deleted meanwhile (maybe by another player)

    const rate = engine.sampleRate;
    const captured48 = convertFrames(stopFrame - rec.startFrame, rate, CANONICAL_RATE);
    let length48 = track.length48;
    if (length48 === null) {
      if (captured48 < MIN_LOOP_FRAMES) {
        this.deps.notify('Too short - tap again a bit later to close the loop.');
        return;
      }
      const section = snapshot.sections.find((s) => s.id === track.sectionId);
      const ref = section?.referenceLength48 ?? snapshot.referenceLength48;
      const spec = track.lengthSpec;
      length48 =
        ref !== null && spec.kind === 'free' && spec.autoSnap ? autoSnapLength(captured48, ref) : clampLength(captured48);
    }

    // First take on this device defines where loop position 0 is.
    if (engine.transportOrigin === null) engine.setTransportOrigin(rec.startFrame);
    const origin = engine.transportOrigin!;

    const rt = this.roundTripFrames();
    const preRoll = Math.round(PRE_ROLL_SECONDS * rate);
    const from = Math.floor(rec.startFrame + rt - preRoll);
    const to = Math.ceil(stopFrame + rt);
    await engine.capture.waitUntil(to);
    if (doc !== this.deps.doc()) return;
    const latest = readSnapshot(doc);
    const currentTrack = latest.tracks.find((t) => t.id === track.id);
    if (!currentTrack) return;
    // A peer may have established the length while we waited for the mic tail.
    length48 = currentTrack.length48 ?? length48;
    let shift48 = 0;
    if (currentTrack.length48 === null && track.lengthSpec.kind === 'free' && track.lengthSpec.autoSnap) {
      const backing = latest.tracks.filter((t) => t.sectionId === track.sectionId && t.id !== track.id && hasAudio(t));
      shift48 = phraseOriginShift(
        convertFrames(rec.startFrame - origin, rate, CANONICAL_RATE),
        length48,
        backing.flatMap((t) => t.length48 === null ? [] : [t.length48]),
      );
    }
    const phraseOrigin = origin + convertFrames(shift48, CANONICAL_RATE, rate);
    const samples = resampleLinear(engine.capture.read(from, to), rate, CANONICAL_RATE);
    applyFades(samples, Math.round(PRE_ROLL_SECONDS * CANONICAL_RATE), Math.round(FADE_OUT_SECONDS * CANONICAL_RATE));

    const start = capturePosition(from, rt, phraseOrigin, rate, length48);
    const layer = foldTake(samples, start, length48);
    const id = randomId();
    store.put(id, layer.data);
    // Move the ONE local origin with the take, so live playback is unchanged.
    // Every backing length divides the shift; its sound and stored data stay put.
    if (shift48 !== 0 && engine.transportOrigin === origin && this.deps.activeSectionId() === track.sectionId) {
      engine.setTransportOrigin(phraseOrigin);
    }
    const me = this.deps.identity();
    addLayer(doc, {
      id,
      trackId: track.id,
      author: me.userId,
      authorName: me.name,
      offset: layer.offset,
      frames: layer.data.length,
      length48,
    });
  }

  private roundTripFrames(): number {
    return (this.deps.roundTripMs() / 1000) * this.deps.engine.sampleRate;
  }

  private releaseHold(rec: LocalRecording): void {
    const hold = this.holds.get(rec);
    if (hold) this.deps.engine.capture.release(hold);
    this.holds.delete(rec);
  }
}
