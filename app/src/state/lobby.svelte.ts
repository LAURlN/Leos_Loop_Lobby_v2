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
import { LayerAudioStore } from '../session/layerAudio';
import { Looper, type LocalRecording } from '../session/looper';
import { hasAudio, readSnapshot, type SessionSnapshot } from '../session/schema';
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

const EMPTY: SessionSnapshot = { referenceLength48: null, beatsPerLoop: 4, tracks: [] };

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
  private audioSync: AudioSync | null = null;
  private roomSession: RoomSession | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private toastId = 0;

  constructor() {
    this.attachDoc(this.doc);
    actions.initSession(this.doc);
    actions.createTrack(this.doc, { lengthSpec: { kind: 'free', autoSnap: true }, createdBy: this.userId });
  }

  get name(): string {
    return displayName(this.settings);
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
      this.applyLocalPlayback();
      this.audioSync.apply(this.snapshot);
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
    this.snapshot = snap;
    if (this.selectedTrackId && !snap.tracks.some((t) => t.id === this.selectedTrackId)) this.selectedTrackId = null;
    if (!this.selectedTrackId && snap.tracks[0]) this.selectedTrackId = snap.tracks[0].id;
    if (this.recording && !snap.tracks.some((t) => t.id === this.recording?.trackId)) this.looper?.cancel();
    this.audioSync?.apply(snap);
  }

  /** Replaces the whole session (joining a room starts from the room's state). */
  private replaceDoc(doc: Y.Doc): void {
    this.looper?.cancel();
    this.audioSync?.reset();
    this.store.clear();
    this.visuals = {};
    this.attachDoc(doc);
  }

  get hasContent(): boolean {
    return this.snapshot.tracks.some(hasAudio);
  }

  // ---- looping ------------------------------------------------------------------

  tapTrack(trackId: string, eventTime?: number): void {
    this.selectedTrackId = trackId;
    if (this.micError) {
      this.notify(`Can't record: ${this.micError}`);
      return;
    }
    void this.looper?.tap(trackId, eventTime);
  }

  isRecording(trackId: string): boolean {
    return this.recording?.trackId === trackId;
  }

  isFinishing(trackId: string): boolean {
    return this.finishing.includes(trackId);
  }

  /** 0..1 position of the audible playhead in a loop of `length48`, or null when stopped. */
  playheadFraction(length48: number | null): number | null {
    const engine = this.engine;
    if (!engine || length48 === null || engine.transportOrigin === null) return null;
    return renderPosition(engine.heardFrameAt(), engine.transportOrigin, engine.sampleRate, length48) / length48;
  }

  /** Seconds since the current local recording started. */
  recordingSeconds(): number {
    return this.recording ? (performance.now() - this.recording.startedAt) / 1000 : 0;
  }

  addTrack(lengthSpec: LengthSpec, name?: string): void {
    const id = actions.createTrack(this.doc, { lengthSpec, createdBy: this.userId, name });
    this.selectedTrackId = id;
  }

  deleteTrack(trackId: string): void {
    actions.deleteTrack(this.doc, trackId);
  }

  clearTrack(trackId: string): void {
    actions.clearTrack(this.doc, trackId);
  }

  clearSession(): void {
    this.looper?.cancel();
    actions.clearSession(this.doc, this.userId);
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
