/**
 * App controller: owns the engine, the session document, the looper and the
 * optional room connection, and exposes reactive state + intent methods to the
 * Svelte UI. Components never touch Yjs or the AudioEngine directly.
 */
import * as Y from 'yjs';
import { isValidRoomCode, normalizeRoomCode, randomRoomCode, renderPosition, type LengthSpec, type PeerInfo } from '@lll/shared';
import { runAcousticCalibration } from '../audio/calibration';
import { AudioEngine } from '../audio/engine';
import { estimateRoundTripMs, loadProfile, routeKeyOf, saveProfile, type LatencyProfile } from '../audio/latency';
import { relayBaseUrl, roomLink } from '../net/config';
import { RelayTransport } from '../net/relayTransport';
import { RoomSession, type Presence } from '../net/roomSession';
import type { TransportStatus } from '../net/transport';
import * as actions from '../session/actions';
import { AudioSync, type TrackVisual } from '../session/audioSync';
import { bpmForLength, DEFAULT_CLICK, MAX_BEATS, type ClickPattern } from '../session/click';
import { LayerAudioStore } from '../session/layerAudio';
import { Looper, type LocalRecording } from '../session/looper';
import {
  ProjectFileError,
  exportProject,
  loadProjectAudio,
  parseProject,
  projectFileName,
  withFreshIds,
} from '../session/projectFile';
import { hasAudio, readSnapshot, type SectionState, type SessionSnapshot, type TrackState } from '../session/schema';
import { songPlan as planSong, type SongPlan } from '../session/song';
import { SongRecorder } from '../session/songRecording';
import { displayName, loadSettings, saveSettings, tabUserId, type Settings } from './settings';

export interface RoomState {
  code: string;
  status: TransportStatus;
  peers: PeerInfo[];
  presence: Presence[];
}

export interface Toast {
  id: number;
  message: string;
}

const EMPTY: SessionSnapshot = { sections: [], referenceLength48: null, beatsPerLoop: 4, tracks: [] };

export class Lobby {
  // ---- reactive state -----------------------------------------------------
  started = $state(false);
  starting = $state(false);
  startError = $state<string | null>(null);
  snapshot = $state.raw<SessionSnapshot>(EMPTY);
  visuals = $state.raw<Record<string, TrackVisual>>({});
  recording = $state.raw<LocalRecording | null>(null);
  finishing = $state.raw<string[]>([]);
  selectedTrackId = $state<string | null>(null);
  activeSectionId = $state<string | null>(null);
  /** Full song view: all sections in order, played back to back (local only). */
  songView = $state(false);
  songRecording = $state(false);
  songFinishing = $state(false);
  /** In the song view: true while the song is stopped or paused. */
  playbackPaused = $state(false);
  latency = $state.raw<LatencyProfile | null>(null);
  calibrating = $state(false);
  /** Null when the mic works; otherwise why we are in listen-only mode. */
  micError = $state<string | null>(null);
  settings = $state<Settings>(loadSettings());
  room = $state.raw<RoomState | null>(null);
  toasts = $state<Toast[]>([]);

  // ---- internals ----------------------------------------------------------
  readonly userId = tabUserId();
  engine: AudioEngine | null = null;
  private doc = new Y.Doc();
  private readonly store = new LayerAudioStore();
  private looper: Looper | null = null;
  private songRecorder: SongRecorder | null = null;
  private audioSync: AudioSync | null = null;
  private roomSession: RoomSession | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private toastId = 0;

  constructor() {
    this.attachDoc(this.doc);
    actions.initSession(this.doc);
    const snap = readSnapshot(this.doc);
    this.activeSectionId = snap.sections[0]?.id ?? null;
    const initialTrackId = actions.createTrack(this.doc, {
      lengthSpec: { kind: 'free', autoSnap: true },
      createdBy: this.userId,
      sectionId: this.activeSectionId ?? undefined,
    });
    this.selectedTrackId = initialTrackId;
  }

  get name(): string {
    return displayName(this.settings);
  }

  get sections(): SectionState[] {
    return this.snapshot.sections;
  }

  get activeSection(): SectionState | null {
    return this.snapshot.sections.find((s) => s.id === this.activeSectionId) ?? this.snapshot.sections[0] ?? null;
  }

  get songPlan(): SongPlan {
    return planSong(this.snapshot);
  }

  get activeTracks(): TrackState[] {
    const sec = this.activeSection;
    return sec ? this.snapshot.tracks.filter((t) => t.sectionId === sec.id) : [];
  }

  // ---- startup --------------------------------------------------------------

  /** Must run inside a user gesture (tap) because of browser autoplay rules. */
  async start(): Promise<void> {
    if (this.started || this.starting) return;
    this.starting = true;
    this.startError = null;
    try {
      const engine = await AudioEngine.create();
      this.engine = engine;
      await this.openMic();
      this.audioSync = new AudioSync(engine, this.store, (id, visual) => {
        const next = { ...this.visuals };
        if (visual) next[id] = visual;
        else delete next[id];
        this.visuals = next;
      });
      this.looper = new Looper({
        doc: () => this.doc,
        activeSectionId: () => this.songView ? null : this.activeSectionId,
        engine,
        store: this.store,
        identity: () => ({ userId: this.userId, name: this.name }),
        roundTripMs: () => this.latency?.roundTripMs ?? 0,
        notify: (m) => this.notify(m),
      });
      this.looper.onChange(() => {
        this.recording = this.looper?.recording ?? null;
        this.finishing = [...(this.looper?.finishing ?? [])];
        this.publishPresence();
      });
      this.songRecorder = new SongRecorder({
        doc: () => this.doc, engine, store: this.store,
        identity: () => ({ userId: this.userId, name: this.name }),
        roundTripMs: () => this.latency?.roundTripMs ?? 0,
        changed: () => {
          this.songRecording = this.songRecorder?.recording ?? false;
          this.songFinishing = this.songRecorder?.finishing ?? false;
        },
        notify: (message) => this.notify(message),
        ended: () => this.pausePlayback(),
      });
      this.applyLocalPlayback();
      this.audioSync.apply(this.snapshot, this.activeSectionId);
      this.started = true;

      const code = new URLSearchParams(location.search).get('room');
      if (code && isValidRoomCode(normalizeRoomCode(code))) this.joinRoom(normalizeRoomCode(code));
    } catch (err) {
      this.startError = `Could not start audio: ${err instanceof Error ? err.message : String(err)}`;
      this.engine?.ctx.close();
      this.engine = null;
    } finally {
      this.starting = false;
    }
  }

  // ---- session document -------------------------------------------------------

  private attachDoc(doc: Y.Doc): void {
    this.unsubscribeDoc?.();
    this.doc = doc;
    let queued = false;
    const refresh = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        this.refreshSnapshot();
      });
    };
    doc.on('update', refresh);
    this.unsubscribeDoc = () => doc.off('update', refresh);
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    const snap = readSnapshot(this.doc);
    this.songRecorder?.validate(planSong(snap));
    this.snapshot = snap;
    if (!this.activeSectionId || !snap.sections.some((s) => s.id === this.activeSectionId)) {
      this.activeSectionId = snap.sections[0]?.id ?? null;
    }
    const currentTracks = this.activeSectionId
      ? snap.tracks.filter((t) => t.sectionId === this.activeSectionId)
      : snap.tracks;
    if (this.selectedTrackId && !currentTracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = null;
    }
    if (this.recording && !currentTracks.some((t) => t.id === this.recording?.trackId)) {
      this.looper?.cancel();
    }
    this.audioSync?.apply(snap, this.activeSectionId);
  }

  /** Replaces the whole session (joining a room starts from the room's state). */
  private replaceDoc(doc: Y.Doc): void {
    this.looper?.cancel();
    this.songRecorder?.cancel();
    this.songView = false;
    this.audioSync?.reset();
    this.store.clear();
    this.visuals = {};
    this.playbackPaused = false;
    this.attachDoc(doc);
  }

  get hasContent(): boolean {
    return this.snapshot.tracks.some(hasAudio);
  }

  // ---- looping ------------------------------------------------------------------

  tapTrack(trackId: string, eventTime?: number): void {
    if (this.songView || this.songFinishing) return;
    this.selectedTrackId = trackId;
    // Nothing to record on a metronome track: its disc toggles the click instead.
    const track = this.snapshot.tracks.find((t) => t.id === trackId);
    if (track?.click) {
      this.setTrackMix(trackId, { mute: !track.mute });
      return;
    }
    if (this.micError) {
      this.notify(`Can't record: ${this.micError}`);
      return;
    }
    if (this.playbackPaused) {
      this.resumePlayback();
    }
    void this.looper?.tap(trackId, eventTime);
  }

  isRecording(trackId: string): boolean {
    return this.recording?.trackId === trackId;
  }

  isFinishing(trackId: string): boolean {
    return this.finishing.includes(trackId);
  }

  /**
   * 0..1 position of the audible playhead in a loop of `length48`, or null when
   * stopped. Pass the frame time when drawing many discs: the audio clock is
   * then read once per frame.
   */
  playheadFraction(length48: number | null, at?: number): number | null {
    const engine = this.engine;
    if (!engine || length48 === null) return null;
    if (this.playbackPaused && this.audioSync?.pausedOffset !== null && this.audioSync?.pausedOffset !== undefined) {
      return renderPosition(this.audioSync.pausedOffset, 0, engine.sampleRate, length48) / length48;
    }
    if (engine.transportOrigin === null) return null;
    return renderPosition(this.heardFrame(engine, at), engine.transportOrigin, engine.sampleRate, length48) / length48;
  }

  private heardAt = { at: NaN, frame: 0 };

  private heardFrame(engine: AudioEngine, at?: number): number {
    if (at === undefined) return engine.heardFrameAt();
    if (this.heardAt.at !== at) this.heardAt = { at, frame: engine.heardFrameAt(at) };
    return this.heardAt.frame;
  }

  /** Seconds since the current local recording started. */
  recordingSeconds(): number {
    return this.recording ? (performance.now() - this.recording.startedAt) / 1000 : 0;
  }

  // ---- playback transport -------------------------------------------------------

  get isPlaying(): boolean {
    return !this.playbackPaused && this.engine?.transportOrigin !== null;
  }

  get canPlayback(): boolean {
    if (this.songView) return this.songPlan.total48 > 0;
    return this.activeTracks.some((t) => t.length48 !== null || hasAudio(t)) || this.settings.metronomeEnabled;
  }

  pausePlayback(): void {
    if (this.playbackPaused) return;
    if (this.songRecording) void this.songRecorder?.stop();
    if (this.songView) this.audioSync?.pauseSong();
    else this.audioSync?.pause();
    this.playbackPaused = true;
  }

  resumePlayback(): void {
    if (this.songView) {
      if (!this.canPlayback) return;
      this.audioSync?.playSong();
    } else {
      this.audioSync?.resume();
    }
    this.playbackPaused = false;
  }

  restartPlayback(): void {
    if (this.songRecording || this.songFinishing) return;
    if (this.songView) {
      if (!this.canPlayback) return;
      this.audioSync?.playSong(0);
    } else {
      this.audioSync?.restart();
    }
    this.playbackPaused = false;
  }

  // ---- full song view -------------------------------------------------------------

  /** Record a continuous pass from the playhead into new section-length loops. */
  toggleSongRecording(eventTime?: number): void {
    if (!this.songView || !this.songRecorder || !this.audioSync || !this.engine) return;
    if (this.songRecording) {
      void this.songRecorder.stop(eventTime);
      this.pausePlayback();
      return;
    }
    if (this.songFinishing || this.finishing.length > 0 || this.calibrating || !this.canPlayback) return;
    if (this.micError) {
      this.notify(`Can't record: ${this.micError}`);
      return;
    }
    let start48 = this.songPosition48(eventTime);
    if (start48 >= this.songPlan.total48) {
      this.audioSync.seekSong(0);
      start48 = 0;
    }
    if (this.playbackPaused) this.resumePlayback();
    const origin = this.audioSync.songOrigin;
    if (origin !== null) this.songRecorder.start(this.songPlan, origin, start48);
  }

  /** Opens the song view (stopped at the start). Section looping stops meanwhile. */
  openSongView(): void {
    if (this.songView) return;
    this.looper?.cancel();
    this.songView = true;
    this.playbackPaused = true;
    this.audioSync?.enterSong();
    this.publishPresence();
  }

  /** Back to the active section, which loops again from its start. */
  closeSongView(): void {
    if (!this.songView) return;
    if (this.songRecording) void this.songRecorder?.stop();
    this.songView = false;
    this.playbackPaused = false;
    this.audioSync?.leaveSong(this.activeSectionId);
    this.publishPresence();
  }

  /** Audible song position in canonical frames (pass the frame time when drawing). */
  songPosition48(at?: number): number {
    const engine = this.engine;
    if (!engine || !this.audioSync) return 0;
    return this.audioSync.songPosition48(this.heardFrame(engine, at));
  }

  seekSong(pos48: number): void {
    if (this.songRecording || this.songFinishing) return;
    this.audioSync?.seekSong(pos48);
  }

  /** Called every frame by the song view: stops at the end of the song. */
  tickSong(at: number): void {
    if (!this.songView || this.playbackPaused) return;
    if (this.songPosition48(at) >= this.songPlan.total48) {
      if (this.songRecording) void this.songRecorder?.stop();
      this.audioSync?.pauseSong();
      this.audioSync?.seekSong(0);
      this.playbackPaused = true;
    }
  }

  togglePlayback(): void {
    if (this.playbackPaused) this.resumePlayback();
    else this.pausePlayback();
  }

  // ---- sections -----------------------------------------------------------------

  createSection(name?: string): string {
    const id = actions.createSection(this.doc, { name, createdBy: this.userId });
    this.selectSection(id);
    return id;
  }

  selectSection(sectionId: string): void {
    if (this.songView) {
      this.activeSectionId = sectionId;
      this.closeSongView();
      const tracks = this.snapshot.tracks.filter((t) => t.sectionId === sectionId);
      if (!tracks.some((t) => t.id === this.selectedTrackId)) this.selectedTrackId = tracks[0]?.id ?? null;
      return;
    }
    if (this.activeSectionId === sectionId) return;
    if (this.recording) this.looper?.cancel();
    this.activeSectionId = sectionId;
    this.publishPresence();
    const currentTracks = this.snapshot.tracks.filter((t) => t.sectionId === sectionId);
    if (this.selectedTrackId !== null && !currentTracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = currentTracks[0]?.id ?? null;
    }
    if (this.playbackPaused) {
      this.audioSync?.pauseAtZero();
    }
    this.audioSync?.apply(this.snapshot, sectionId);
  }

  deleteSection(sectionId: string): void {
    if (this.snapshot.sections.length <= 1) {
      this.notify('Cannot delete the only section.');
      return;
    }
    if (this.activeSectionId === sectionId) {
      const idx = this.snapshot.sections.findIndex((s) => s.id === sectionId);
      const next = this.snapshot.sections[idx + 1] ?? this.snapshot.sections[idx - 1] ?? this.snapshot.sections[0];
      if (next) this.selectSection(next.id);
    }
    actions.deleteSection(this.doc, sectionId);
  }

  renameSection(sectionId: string, name: string): void {
    actions.renameSection(this.doc, sectionId, name);
  }

  moveSection(sectionId: string, direction: 'left' | 'right'): void {
    actions.moveSection(this.doc, sectionId, direction);
  }

  reorderSection(sectionId: string, targetIndex: number): void {
    actions.reorderSection(this.doc, sectionId, targetIndex);
  }

  copyTrackToSection(trackId: string, targetSectionId: string): string | null {
    const id = actions.copyTrackToSection(this.doc, trackId, targetSectionId, this.userId, this.store);
    if (id) {
      const targetSec = this.snapshot.sections.find((s) => s.id === targetSectionId);
      this.notify(`Loop copied to Section ${targetSec?.name ?? ''}`);
    }
    return id;
  }

  copyTracksToSection(trackIds: string[], targetSectionId: string): string[] {
    const ids = actions.copyTracksToSection(this.doc, trackIds, targetSectionId, this.userId, this.store);
    if (ids.length) {
      const targetSec = this.snapshot.sections.find((s) => s.id === targetSectionId);
      this.notify(
        ids.length === 1
          ? `1 loop copied to Section ${targetSec?.name ?? ''}`
          : `${ids.length} loops copied to Section ${targetSec?.name ?? ''}`,
      );
    }
    return ids;
  }

  peersInSection(sectionId: string): Presence[] {
    return (this.room?.presence ?? []).filter((p) => p.sectionId === sectionId);
  }

  // ---- tracks -------------------------------------------------------------------

  addTrack(lengthSpec: LengthSpec, name?: string): void {
    const sectionId = this.activeSectionId ?? this.snapshot.sections[0]?.id;
    if (!sectionId) return;
    const id = actions.createTrack(this.doc, { lengthSpec, createdBy: this.userId, name, sectionId });
    this.selectedTrackId = id;
  }

  /** Adds a metronome track to the current section. */
  addClickTrack(click: ClickPattern): void {
    const sectionId = this.activeSectionId ?? this.snapshot.sections[0]?.id;
    if (!sectionId) return;
    const lengthSpec: LengthSpec = { kind: 'free', autoSnap: false }; // replaced by the click's bar length
    this.selectedTrackId = actions.createTrack(this.doc, { lengthSpec, click, createdBy: this.userId, sectionId });
  }

  setTrackClick(trackId: string, patch: Partial<ClickPattern>): void {
    actions.setTrackClick(this.doc, trackId, patch);
  }

  /** A metronome that fits the current section: its first loop as one bar, else 120 BPM in 4/4. */
  get suggestedClick(): ClickPattern {
    const section = this.snapshot.sections.find((s) => s.id === this.activeSectionId) ?? this.snapshot.sections[0];
    const ref = section?.referenceLength48 ?? null;
    if (ref === null) return { ...DEFAULT_CLICK };
    const beats = Math.min(MAX_BEATS, section?.beatsPerLoop ?? DEFAULT_CLICK.beats);
    return { ...DEFAULT_CLICK, beats, bpm: bpmForLength(ref, beats) };
  }

  deleteTrack(trackId: string): void {
    actions.deleteTrack(this.doc, trackId);
  }

  clearTrack(trackId: string): void {
    actions.clearTrack(this.doc, trackId);
  }

  clearSession(): void {
    this.looper?.cancel();
    this.songRecorder?.cancel();
    actions.clearSession(this.doc, this.userId);
    this.activeSectionId = this.snapshot.sections[0]?.id ?? null;
  }

  // ---- project files ----------------------------------------------------------------

  /** Downloads the whole session (all sections, tracks and audio) as a project file. */
  async exportProject(): Promise<void> {
    try {
      const { bytes, missingAudio } = await exportProject(this.doc, this.store);
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = projectFileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (missingAudio > 0) {
        this.notify(`Exported. ${missingAudio} take${missingAudio === 1 ? ' was' : 's were'} left out: audio still loading.`);
      }
    } catch (err) {
      this.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Imports a project file. `replace` swaps out the session (for everyone in
   * a room); `append` adds its sections after the current ones.
   */
  async importProject(file: Blob, mode: 'replace' | 'append'): Promise<boolean> {
    try {
      const data = withFreshIds(parseProject(new Uint8Array(await file.arrayBuffer())));
      const { content, droppedLayers } = await loadProjectAudio(data, this.store);
      this.looper?.cancel();
      this.songRecorder?.cancel();
      const sections = actions.importProject(this.doc, content, mode);
      this.refreshSnapshot();
      const first = sections[0];
      if (first) this.selectSection(first);
      this.selectedTrackId = this.activeTracks[0]?.id ?? null;
      this.notify(
        droppedLayers > 0
          ? `Project imported. ${droppedLayers} take${droppedLayers === 1 ? '' : 's'} could not be read.`
          : 'Project imported.',
      );
      return true;
    } catch (err) {
      this.notify(
        err instanceof ProjectFileError
          ? err.message
          : `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  undo(trackId: string): void {
    if (!actions.undoLayer(this.doc, trackId, this.userId)) this.notify('Nothing of yours to undo on this track.');
  }

  redo(trackId: string): void {
    actions.redoLayer(this.doc, trackId, this.userId);
  }

  canUndo(trackId: string): boolean {
    const t = this.snapshot.tracks.find((x) => x.id === trackId);
    return !!t?.layers.some((l) => l.author === this.userId && !l.hidden);
  }

  canRedo(trackId: string): boolean {
    void this.snapshot; // re-evaluate when the session changes
    return actions.canRedo(this.doc, trackId, this.userId);
  }

  renameTrack(trackId: string, name: string): void {
    actions.renameTrack(this.doc, trackId, name);
  }

  setTrackMix(trackId: string, mix: actions.TrackMix): void {
    actions.setTrackMix(this.doc, trackId, mix);
  }

  addEffect(trackId: string, type: string): void {
    actions.addEffect(this.doc, trackId, type);
  }

  removeEffect(trackId: string, effectId: string): void {
    actions.removeEffect(this.doc, trackId, effectId);
  }

  setEffectEnabled(trackId: string, effectId: string, enabled: boolean): void {
    actions.setEffectEnabled(this.doc, trackId, effectId, enabled);
  }

  setEffectParam(trackId: string, effectId: string, paramId: string, value: number): void {
    actions.setEffectParams(this.doc, trackId, effectId, { [paramId]: value });
  }

  applyEffectPreset(trackId: string, effectId: string, preset: string): void {
    actions.applyEffectPreset(this.doc, trackId, effectId, preset);
  }

  setBeatsPerLoop(beats: number): void {
    actions.setBeatsPerLoop(this.doc, beats);
  }

  // ---- settings & latency ---------------------------------------------------------

  updateSettings(patch: Partial<Settings>): void {
    const micChanged = patch.inputDeviceId !== undefined && patch.inputDeviceId !== this.settings.inputDeviceId;
    Object.assign(this.settings, patch);
    saveSettings($state.snapshot(this.settings));
    this.applyLocalPlayback();
    if (patch.playerName !== undefined) this.publishPresence();
    if (micChanged) void this.openMic();
  }

  /**
   * Opens the microphone. Without one the app still works in listen-only
   * mode: you can join rooms, hear and mix, but not record.
   */
  async openMic(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (this.songRecorder?.busy) {
      this.songRecorder.cancel();
      this.notify('Song recording cancelled because the microphone changed.');
    }
    try {
      if (new URLSearchParams(location.search).has('testmic')) engine.useTestInput();
      else await engine.openMic(this.settings.inputDeviceId || undefined);
      this.micError = null;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      this.micError =
        name === 'NotAllowedError'
          ? 'microphone access was denied. Allow it in the browser settings, then reload.'
          : name === 'NotFoundError'
            ? 'no microphone was found.'
            : `the microphone could not be opened (${err instanceof Error ? err.message : String(err)}).`;
    }
    this.loadLatency();
  }

  private applyLocalPlayback(): void {
    this.engine?.setMonitoring(this.settings.monitoring);
    this.audioSync?.setLocalPlayback({
      metronomeEnabled: this.settings.metronomeEnabled,
      metronomeVolume: this.settings.metronomeVolume,
      masterVolume: this.settings.masterVolume,
    });
  }

  private routeKey(): string {
    const engine = this.engine;
    return engine ? routeKeyOf(engine.micTrack?.label ?? '', engine.outputId) : 'none';
  }

  private loadLatency(): void {
    const engine = this.engine;
    if (!engine) return;
    const routeKey = this.routeKey();
    this.latency = loadProfile(routeKey) ?? {
      routeKey,
      roundTripMs: estimateRoundTripMs(engine.ctx, engine.micTrack),
      source: 'estimate',
      updatedAt: Date.now(),
    };
  }

  get latencyCalibrated(): boolean {
    return this.latency?.source === 'acoustic' || this.latency?.source === 'manual';
  }

  setLatencyMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const profile: LatencyProfile = {
      routeKey: this.routeKey(),
      roundTripMs: Math.min(1000, Math.max(0, ms)),
      source: 'manual',
      updatedAt: Date.now(),
    };
    this.latency = profile;
    saveProfile(profile);
  }

  async calibrate(): Promise<{ ok: boolean; message: string }> {
    const engine = this.engine;
    if (!engine || this.calibrating) return { ok: false, message: 'Audio is not running.' };
    this.looper?.cancel();
    this.songRecorder?.cancel();
    this.calibrating = true;
    try {
      const wasMonitoring = this.settings.monitoring;
      engine.setMonitoring(false);
      const result = await runAcousticCalibration(engine);
      engine.setMonitoring(wasMonitoring);
      if (!result.ok) {
        return {
          ok: false,
          message:
            result.failure === 'no-signal'
              ? 'The microphone did not hear the test sound. Turn the volume up, take off headphones that isolate the mic, and try again.'
              : 'The measurements disagreed. Try again in a quieter spot and keep the device still.',
        };
      }
      const profile: LatencyProfile = {
        routeKey: this.routeKey(),
        roundTripMs: result.roundTripMs,
        source: 'acoustic',
        spreadMs: result.spreadMs,
        updatedAt: Date.now(),
      };
      this.latency = profile;
      saveProfile(profile);
      return { ok: true, message: `Round-trip latency: ${result.roundTripMs.toFixed(1)} ms` };
    } catch (err) {
      return { ok: false, message: `Calibration failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.calibrating = false;
    }
  }

  // ---- rooms ------------------------------------------------------------------------

  /** Opens a new room with the current session in it. */
  createRoom(): void {
    this.connectRoom(randomRoomCode(), this.doc);
  }

  /** Joins a room; the local session is replaced by the room's session. */
  joinRoom(code: string): void {
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) {
      this.notify('That room code does not look right.');
      return;
    }
    const doc = new Y.Doc();
    this.replaceDoc(doc);
    this.connectRoom(normalized, doc);
  }

  /** Leaves the room but keeps a local copy of everything. */
  leaveRoom(): void {
    this.roomSession?.close();
    this.roomSession = null;
    this.room = null;
    this.setUrlRoom(null);
  }

  get roomLink(): string | null {
    return this.room ? roomLink(this.room.code) : null;
  }

  private connectRoom(code: string, doc: Y.Doc): void {
    this.roomSession?.close();
    this.room = { code, status: { state: 'connecting' }, peers: [], presence: [] };
    this.roomSession = new RoomSession(
      doc,
      this.store,
      (handlers) => new RelayTransport({ baseUrl: relayBaseUrl(), roomCode: code, selfId: this.userId, name: this.name }, handlers),
      {
        status: (status) => {
          if (this.room) this.room = { ...this.room, status };
          if (status.state === 'failed') this.notify(status.reason);
        },
        peers: (peers) => {
          if (this.room) this.room = { ...this.room, peers };
        },
        presence: (presence) => {
          if (this.room) this.room = { ...this.room, presence: presence.filter((p) => p.peerId !== this.userId) };
        },
      },
    );
    this.publishPresence();
    this.setUrlRoom(code);
  }

  private publishPresence(): void {
    this.roomSession?.setPresence({
      peerId: this.userId,
      name: this.name,
      recordingTrackId: this.recording?.trackId ?? null,
      sectionId: this.songView ? null : this.activeSectionId,
    });
  }

  /** Names of other players currently recording on a track. */
  remoteRecorders(trackId: string): string[] {
    return (this.room?.presence ?? []).filter((p) => p.recordingTrackId === trackId).map((p) => p.name);
  }

  private setUrlRoom(code: string | null): void {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  // ---- misc -------------------------------------------------------------------------

  notify(message: string): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, message }];
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), 4500);
  }
}

export const lobby = new Lobby();
