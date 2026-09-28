/**
 * Makes the audio engine match the session snapshot: one chain per track,
 * mix/effects parameters, and a freshly mixed loop buffer whenever the set of
 * audible layers changes. Also owns the local transport origin.
 */
import type { AudioEngine } from '../audio/engine';
import { computeSpectrogram, type Spectrogram } from '../ui/spectrogram';
import type { LayerAudioStore } from './layerAudio';
import { LoopMixer, type MixLayer } from './loopMix';
import { visibleLayers, type SectionState, type SessionSnapshot, type TrackState } from './schema';

export interface TrackVisual {
  spectrogram: Spectrogram | null;
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
    this.paused = false;
    this.pausedOffsetLocalFrames = null;
    this.engine.setTransportOrigin(null);
  }

  apply(snapshot: SessionSnapshot, activeSectionId?: string | null): void {
    this.last = snapshot;
    this.lastSectionId = activeSectionId ?? null;

    const currentSectionId = activeSectionId ?? snapshot.sections[0]?.id ?? null;
    const currentTracks = currentSectionId
      ? snapshot.tracks.filter((t) => t.sectionId === currentSectionId)
      : snapshot.tracks;
    const currentSection = snapshot.sections.find((s) => s.id === currentSectionId) ?? null;

    const ids = new Set(currentTracks.map((t) => t.id));
    for (const id of this.engine.trackIds()) {
      if (!ids.has(id)) {
        this.engine.removeTrack(id);
        this.mixKeys.delete(id);
        this.mixer.forget(id);
        this.onVisual(id, null);
      }
    }

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

    const anySolo = currentTracks.some((t) => t.solo);
    for (const track of currentTracks) {
      const chain = this.engine.track(track.id);
      chain.setMix(track.volume, track.pan, !track.mute && (!anySolo || track.solo));
      chain.syncEffects(track.effects);
      this.syncMix(track);
    }
    this.applyMetronome(snapshot, currentSection);
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
      this.onVisual(track.id, { spectrogram: null, missingLayers: missing, revision: ++this.revision });
      return;
    }
    const parts: MixLayer[] = [];
    for (const layer of available) {
      const data = this.store.get(layer.id);
      if (data) parts.push({ id: layer.id, offset: layer.offset, gain: layer.gain, data });
    }
    const mix = this.mixer.mix(track.id, track.length48, parts);
    const spectrogram = computeSpectrogram(mix);
    chain.setBuffer(mix); // transfers `mix`
    this.onVisual(track.id, { spectrogram, missingLayers: missing, revision: ++this.revision });
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
