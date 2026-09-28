/**
 * Owns the AudioContext and the audio graph:
 *
 *   mic -> recorder worklet (-> MicCapture on the main thread)
 *       -> monitor gain -> output
 *   track chains -> loops bus -> master -> output
 *   metronome worklet -> master
 *
 * Knows nothing about sessions or the network; session/audioSync.ts drives it.
 */
import processorsUrl from './worklet/processors.ts?worker&url';
import { MicCapture } from './micCapture';
import { PROCESSOR, type MetronomeMessage, type RecorderChunk } from './messages';
import { TrackChain } from './trackChain';

export interface MetronomeConfig {
  enabled: boolean;
  loopLength48: number | null;
  beatsPerLoop: number;
  volume: number;
}

export class AudioEngine {
  readonly capture: MicCapture;
  /** Loops + metronome. Muted during calibration. */
  readonly master: GainNode;
  private readonly loopsBus: GainNode;
  private readonly monitor: GainNode;
  private readonly recorder: AudioWorkletNode;
  private readonly metronome: AudioWorkletNode;
  private readonly chains = new Map<string, TrackChain>();
  private micStream: MediaStream | null = null;
  private micSource: AudioNode | null = null;
  private testNodes: AudioScheduledSourceNode[] = [];
  private origin: number | null = null;

  private constructor(readonly ctx: AudioContext) {
    this.capture = new MicCapture(Math.round(ctx.sampleRate * 3));
    this.master = new GainNode(ctx);
    this.master.connect(ctx.destination);
    this.loopsBus = new GainNode(ctx);
    this.loopsBus.connect(this.master);
    this.monitor = new GainNode(ctx, { gain: 0 });
    this.monitor.connect(ctx.destination);

    this.recorder = new AudioWorkletNode(ctx, PROCESSOR.recorder, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    // Connected to the output (it only emits silence) so the browser keeps pulling it.
    this.recorder.connect(ctx.destination);
    this.recorder.port.onmessage = (e: MessageEvent<RecorderChunk>) => this.capture.push(e.data);

    this.metronome = new AudioWorkletNode(ctx, PROCESSOR.metronome, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.metronome.connect(this.master);
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  static async create(): Promise<AudioEngine> {
    // Tell iOS we record and play at the same time (ignores the silent switch).
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'play-and-record';
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await ctx.resume();
    await ctx.audioWorklet.addModule(processorsUrl);
    return new AudioEngine(ctx);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /** Local frame of the transport's loop position 0, or null when stopped. */
  get transportOrigin(): number | null {
    return this.origin;
  }

  setTransportOrigin(origin: number | null): void {
    this.origin = origin;
    for (const chain of this.chains.values()) chain.setTransport(origin);
    this.metronome.port.postMessage({ type: 'transport', origin } satisfies MetronomeMessage);
  }

  /** Frame the audio graph is about to render. */
  renderFrameNow(): number {
    return this.ctx.currentTime * this.ctx.sampleRate;
  }

  /**
   * Local frame that is audible at the speaker at `performanceTime`
   * (e.g. a pointer event's timeStamp). Used to timestamp button presses.
   */
  heardFrameAt(performanceTime: number = performance.now()): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return (ts.contextTime + (performanceTime - ts.performanceTime) / 1000) * this.ctx.sampleRate;
    }
    const outputDelay = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return (this.ctx.currentTime - outputDelay) * this.ctx.sampleRate;
  }

  // -------------------------------------------------------------------------
  // Microphone
  // -------------------------------------------------------------------------

  async openMic(deviceId?: string): Promise<void> {
    this.closeMic();
    // Browser voice processing ruins music and shifts timing: switch it all off.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.micSource = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: this.micStream });
    this.micSource.connect(this.recorder);
    this.micSource.connect(this.monitor);
  }

  /**
   * Replaces the microphone with a synthetic signal (short tone pulses, 4 per
   * second). For development and automated tests: open the app with `?testmic`.
   */
  useTestInput(): void {
    this.closeMic();
    const tone = new OscillatorNode(this.ctx, { frequency: 660 });
    const lfo = new OscillatorNode(this.ctx, { type: 'square', frequency: 4 });
    const depth = new GainNode(this.ctx, { gain: 0.25 });
    const amp = new GainNode(this.ctx, { gain: 0.25 });
    lfo.connect(depth).connect(amp.gain);
    tone.connect(amp);
    amp.connect(this.recorder);
    amp.connect(this.monitor);
    tone.start();
    lfo.start();
    this.testNodes = [tone, lfo];
    this.micSource = amp;
  }

  closeMic(): void {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    for (const n of this.testNodes) n.stop();
    this.testNodes = [];
    this.micSource = null;
    this.micStream = null;
  }

  get micTrack(): MediaStreamTrack | null {
    return this.micStream?.getAudioTracks()[0] ?? null;
  }

  get outputId(): string {
    return (this.ctx as AudioContext & { sinkId?: string }).sinkId ?? '';
  }

  setMonitoring(enabled: boolean): void {
    this.monitor.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  setMasterVolume(volume: number): void {
    this.loopsBus.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  setMetronome(config: MetronomeConfig): void {
    this.metronome.port.postMessage({ type: 'config', ...config } satisfies MetronomeMessage);
  }

  // -------------------------------------------------------------------------
  // Tracks
  // -------------------------------------------------------------------------

  track(id: string): TrackChain {
    let chain = this.chains.get(id);
    if (!chain) {
      chain = new TrackChain(this.ctx, this.loopsBus, this.origin);
      this.chains.set(id, chain);
    }
    return chain;
  }

  removeTrack(id: string): void {
    this.chains.get(id)?.dispose();
    this.chains.delete(id);
  }

  trackIds(): string[] {
    return [...this.chains.keys()];
  }

  /** Plays a mono buffer directly to the output at a given local frame (calibration). */
  playAt(samples: Float32Array, frame: number): void {
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = new AudioBufferSourceNode(this.ctx, { buffer });
    src.connect(this.ctx.destination);
    src.start(frame / this.ctx.sampleRate);
    src.onended = () => src.disconnect();
  }
}
