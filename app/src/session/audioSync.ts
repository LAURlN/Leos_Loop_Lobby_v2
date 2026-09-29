/**
 * Makes the audio engine match the session snapshot: one chain per track,
 * mix/effects parameters, and a freshly mixed loop buffer whenever the set of
 * audible layers changes. Also owns the local transport origin.
 *
 * Two modes:
 * - section (default): the active section's tracks loop on the shared transport;
 * - song: every section plays once, in order (session/song.ts). Each section's
 *   tracks get their own origin at the section start and a play window, so the
 *   worklets switch sections sample-accurately.
 */
import { CANONICAL_RATE } from '@lll/shared';
import type { AudioEngine } from '../audio/engine';
import type { MetronomeSegment } from '../audio/messages';
import { computeSpectrogram, type Spectrogram } from '../ui/spectrogram';
import { computePeaks } from '../ui/waveform';
import { clickLength48, renderClick } from './click';
import type { LayerAudioStore } from './layerAudio';
import { LoopMixer, type MixLayer } from './loopMix';
import { visibleLayers, type SectionState, type SessionSnapshot, type TrackState } from './schema';
import { songPlan, type SongPlan } from './song';

/** Lead time when starting the song, so its first milliseconds are not lost. */
const SONG_START_LEAD_SECONDS = 0.03;

interface SongTransport {
  /** Local frame of song position 0 while playing; null when stopped/paused. */
  origin: number | null;
  /** Song position (canonical frames) to continue from when not playing. */
  pausedAt48: number;
}

export interface TrackVisual {
  spectrogram: Spectrogram | null;
  /** Loudness envelope of the loop (0..1 per bin), for waveform views. */
  peaks: Float32Array | null;
  /** Visible layers whose audio has not arrived yet. */
  missingLayers: number;
  /** Increments whenever the mix changes (for redraw caching). */
  revision: number;
}

export interface LocalPlayback {
  metronomeEnabled: boolean;
  metronomeVolume: number;
  masterVolume: number;
}

export class AudioSync {
  private mixKeys = new Map<string, string>();
  private readonly mixer = new LoopMixer();
  private revision = 0;
  private last: SessionSnapshot | null = null;
  private lastSectionId: string | null = null;
  private local: LocalPlayback = { metronomeEnabled: false, metronomeVolume: 0.5, masterVolume: 1 };
  private pending = false;
  private paused = false;
  private pausedOffsetLocalFrames: number | null = null;
  /** Layer ids present in the previous snapshot (to free audio of removed ones). */
  private knownLayers = new Set<string>();
  private song: SongTransport | null = null;
  private plan: SongPlan | null = null;
  private metronomeKey = '';

  constructor(
    private readonly engine: AudioEngine,
    private readonly store: LayerAudioStore,
    private readonly onVisual: (trackId: string, visual: TrackVisual | null) => void,
  ) {
    // New layer audio (recorded or downloaded) -> remix affected tracks.
    store.onAdded(() => this.scheduleReapply());
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get pausedOffset(): number | null {
    return this.pausedOffsetLocalFrames;
  }

  pause(): void {
    if (this.paused) return;
    if (this.engine.transportOrigin !== null) {
      this.pausedOffsetLocalFrames = Math.max(0, this.engine.renderFrameNow() - this.engine.transportOrigin);
    } else {
      this.pausedOffsetLocalFrames = 0;
    }
    this.paused = true;
    this.engine.setTransportOrigin(null);
  }

  resume(): void {
    if (!this.paused && this.engine.transportOrigin !== null) return;
    this.paused = false;
    const now = this.engine.renderFrameNow();
    const offset = this.pausedOffsetLocalFrames ?? 0;
    this.engine.setTransportOrigin(now - offset);
    this.pausedOffsetLocalFrames = null;
  }

  restart(): void {
    this.paused = false;
    this.pausedOffsetLocalFrames = null;
    this.engine.setTransportOrigin(this.engine.renderFrameNow());
  }

  pauseAtZero(): void {
    this.paused = true;
    this.pausedOffsetLocalFrames = 0;
    this.engine.setTransportOrigin(null);
  }

  // ---- song playback -----------------------------------------------------

  get inSong(): boolean {
    return this.song !== null;
  }

  get songPlaying(): boolean {
    return this.song !== null && this.song.origin !== null;
  }

  /** Switches to song playback, stopped at the start. */
  enterSong(): void {
    this.song = { origin: null, pausedAt48: 0 };
    this.paused = false;
    this.pausedOffsetLocalFrames = null;
    this.engine.setTransportOrigin(null);
    if (this.last) this.apply(this.last, this.lastSectionId);
  }

  /** Back to looping a section (starts from loop position 0). */
  leaveSong(activeSectionId: string | null): void {
    if (!this.song) return;
    this.song = null;
    this.plan = null;
    this.metronomeKey = '';
    this.engine.setMetronomeSegments(null);
    this.engine.setTransportOrigin(null);
    if (this.last) this.apply(this.last, activeSectionId);
  }

  /** Plays the song from `from48` (default: where it was paused). */
  playSong(from48?: number): void {
    if (!this.song) return;
    const start = Math.max(0, from48 ?? this.song.pausedAt48);
    const lead = SONG_START_LEAD_SECONDS * this.engine.sampleRate;
    const origin = this.engine.renderFrameNow() + lead - start * this.localPerCanonical();
    this.song = { origin, pausedAt48: start };
    this.applySongTransport();
  }

  pauseSong(): void {
    if (!this.song) return;
    this.song = { origin: null, pausedAt48: this.songPosition48(this.engine.renderFrameNow()) };
    this.applySongTransport();
  }

  /** Jumps to a song position, keeping play/pause as it is. */
  seekSong(pos48: number): void {
    if (!this.song) return;
    const clamped = Math.max(0, Math.min(pos48, this.plan?.total48 ?? 0));
    if (this.songPlaying) this.playSong(clamped);
    else this.song = { origin: null, pausedAt48: clamped };
  }

  /** Song position (canonical frames) at local frame `frame`. */
  songPosition48(frame: number): number {
    const song = this.song;
    if (!song) return 0;
    if (song.origin === null) return song.pausedAt48;
    return Math.max(0, (frame - song.origin) / this.localPerCanonical());
  }

  private localPerCanonical(): number {
    return this.engine.sampleRate / CANONICAL_RATE;
  }

  private applySong(snapshot: SessionSnapshot): void {
    const plan = songPlan(snapshot);
    this.plan = plan;
    this.removeChainsExcept(new Set(plan.segments.flatMap((s) => s.tracks.map((t) => t.id))));
    // Solo applies within a section, as in the section view.
    for (const segment of plan.segments) this.syncTracks(segment.tracks);
    this.applyMetronome(snapshot, null);
    this.applySongTransport();
  }

  private applySongTransport(): void {
    const song = this.song;
    const plan = this.plan;
    const snapshot = this.last;
    if (!song || !plan || !snapshot) return;
    const k = this.localPerCanonical();
    const segments: MetronomeSegment[] = [];
    for (const segment of plan.segments) {
      if (song.origin === null) {
        for (const t of segment.tracks) this.engine.setTrackTransport(t.id, null);
        continue;
      }
      const start = song.origin + segment.start48 * k;
      const end = start + segment.length48 * k;
      for (const t of segment.tracks) this.engine.setTrackTransport(t.id, start, { start, end });
      const section = snapshot.sections.find((s) => s.id === segment.sectionId);
      segments.push({
        start,
        end,
        origin: start,
        loopLength48: section?.referenceLength48 ?? segment.length48,
        beatsPerLoop: section?.beatsPerLoop ?? snapshot.beatsPerLoop,
      });
    }
    const key = JSON.stringify(segments);
    if (key !== this.metronomeKey) {
      this.metronomeKey = key;
      this.engine.setMetronomeSegments(segments);
    }
  }

  setLocalPlayback(local: LocalPlayback): void {
    this.local = local;
    this.engine.setMasterVolume(local.masterVolume);
    if (this.last) {
      const currentSection = this.lastSectionId
        ? this.last.sections.find((s) => s.id === this.lastSectionId)
        : this.last.sections[0];
      this.applyMetronome(this.last, currentSection);
    }
  }

  /** Forgets cached mixes, e.g. after switching to another session. */
  reset(): void {
    for (const id of this.engine.trackIds()) this.engine.removeTrack(id);
    for (const id of this.mixKeys.keys()) this.onVisual(id, null);
    this.mixKeys.clear();
    this.mixer.clear();
    this.knownLayers.clear();
    this.last = null;
    this.lastSectionId = null;
    if (this.song) this.engine.setMetronomeSegments(null);
    this.song = null;
    this.plan = null;
    this.metronomeKey = '';
    this.paused = false;
    this.pausedOffsetLocalFrames = null;
    this.engine.setTransportOrigin(null);
  }

  apply(snapshot: SessionSnapshot, activeSectionId?: string | null): void {
    this.last = snapshot;
    this.lastSectionId = activeSectionId ?? null;
    if (this.song) {
      this.applySong(snapshot);
      this.forgetRemovedLayers(snapshot);
      return;
    }

    const currentSectionId = activeSectionId ?? snapshot.sections[0]?.id ?? null;
    const currentTracks = currentSectionId
      ? snapshot.tracks.filter((t) => t.sectionId === currentSectionId)
      : snapshot.tracks;
    const currentSection = snapshot.sections.find((s) => s.id === currentSectionId) ?? null;

    this.removeChainsExcept(new Set(currentTracks.map((t) => t.id)));

    // A device that joins a running session (or loads one) simply starts its
    // own transport now. Any origin is valid; see docs/SYNC_MODEL.md.
    const anyLength = currentTracks.some((t) => t.length48 !== null);
    if (!this.paused) {
      if (anyLength && this.engine.transportOrigin === null) {
        this.engine.setTransportOrigin(this.engine.renderFrameNow());
      } else if (!anyLength && this.engine.transportOrigin !== null) {
        this.engine.setTransportOrigin(null);
      }
    } else if (!anyLength) {
      this.paused = false;
      this.pausedOffsetLocalFrames = null;
      this.engine.setTransportOrigin(null);
    }

    this.syncTracks(currentTracks);
    this.applyMetronome(snapshot, currentSection);
    this.forgetRemovedLayers(snapshot);
  }

  private removeChainsExcept(ids: Set<string>): void {
    for (const id of this.engine.trackIds()) {
      if (!ids.has(id)) {
        this.engine.removeTrack(id);
        this.mixKeys.delete(id);
        this.mixer.forget(id);
        this.onVisual(id, null);
      }
    }
  }

  /** Mix, effects and audio of one group of tracks (solo is scoped to the group). */
  private syncTracks(tracks: TrackState[]): void {
    const anySolo = tracks.some((t) => t.solo);
    for (const track of tracks) {
      const chain = this.engine.track(track.id);
      chain.setMix(track.volume, track.pan, !track.mute && (!anySolo || track.solo));
      chain.syncEffects(track.effects);
      this.syncMix(track);
    }
  }

  private forgetRemovedLayers(snapshot: SessionSnapshot): void {
    // Only free audio of layers that existed and are gone now. Audio can arrive
    // *before* its layer metadata (own takes, early downloads), so never drop
    // audio merely because the snapshot does not know it yet.
    const current = new Set(snapshot.tracks.flatMap((t) => t.layers.map((l) => l.id)));
    this.store.forget([...this.knownLayers].filter((id) => !current.has(id)));
    this.knownLayers = current;
  }

  private applyMetronome(snapshot: SessionSnapshot, section?: SectionState | null): void {
    this.engine.setMetronome({
      enabled: this.local.metronomeEnabled,
      loopLength48: section?.referenceLength48 ?? snapshot.referenceLength48,
      beatsPerLoop: section?.beatsPerLoop ?? snapshot.beatsPerLoop,
      volume: this.local.metronomeVolume,
    });
  }

  private syncMix(track: TrackState): void {
    if (track.click) {
      this.syncClick(track);
      return;
    }
    const layers = visibleLayers(track);
    const available = layers.filter((l) => this.store.has(l.id));
    const key = `${track.length48}|${available.map((l) => `${l.id}:${l.offset}:${l.gain}`).join(',')}`;
    const missing = layers.length - available.length;
    if (this.mixKeys.get(track.id) === key) {
      return;
    }
    this.mixKeys.set(track.id, key);
    const chain = this.engine.track(track.id);
    if (track.length48 === null || available.length === 0) {
      this.mixer.forget(track.id);
      chain.setBuffer(null);
      this.onVisual(track.id, { spectrogram: null, peaks: null, missingLayers: missing, revision: ++this.revision });
      return;
    }
    const parts: MixLayer[] = [];
    for (const layer of available) {
      const data = this.store.get(layer.id);
      if (data) parts.push({ id: layer.id, offset: layer.offset, gain: layer.gain, data });
    }
    const mix = this.mixer.mix(track.id, track.length48, parts);
    const spectrogram = computeSpectrogram(mix);
    const peaks = computePeaks(mix);
    chain.setBuffer(mix); // transfers `mix`
    this.onVisual(track.id, { spectrogram, peaks, missingLayers: missing, revision: ++this.revision });
  }

  /** Metronome tracks: the loop is rendered locally from the shared pattern. */
  private syncClick(track: TrackState): void {
    const click = track.click!;
    const length = track.length48 ?? clickLength48(click);
    const key = `click|${length}|${click.bpm}|${click.beats}|${click.unit}|${click.subdivision}`;
    if (this.mixKeys.get(track.id) === key) return;
    this.mixKeys.set(track.id, key);
    this.mixer.forget(track.id);
    const loop = renderClick(click, length);
    const spectrogram = computeSpectrogram(loop);
    const peaks = computePeaks(loop);
    this.engine.track(track.id).setBuffer(loop); // transfers `loop`
    this.onVisual(track.id, { spectrogram, peaks, missingLayers: 0, revision: ++this.revision });
  }

  private scheduleReapply(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.last) this.apply(this.last, this.lastSectionId);
    });
  }
}
