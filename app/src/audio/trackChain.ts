/**
 * Audio graph of one track:
 *   TrackPlayer (worklet) -> [enabled effects in order] -> volume -> pan -> destination
 * Effects are created from the declarative registry and kept alive across
 * reorders/toggles so that e.g. reverb impulses are not regenerated.
 */
import { getEffect, normalizeParams } from '../effects/registry';
import type { EffectInstance } from '../effects/types';
import type { EffectState } from '../session/schema';
import { PROCESSOR, type TrackPlayerMessage } from './messages';

interface LiveEffect {
  id: string;
  type: string;
  enabled: boolean;
  instance: EffectInstance;
  params: Record<string, number>;
}

export class TrackChain {
  readonly player: AudioWorkletNode;
  private readonly volume: GainNode;
  private readonly panner: StereoPannerNode;
  private effects: LiveEffect[] = [];
  private structureKey = '';

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    origin: number | null,
  ) {
    this.player = new AudioWorkletNode(ctx, PROCESSOR.trackPlayer, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.volume = new GainNode(ctx);
    this.panner = new StereoPannerNode(ctx);
    this.volume.connect(this.panner).connect(destination);
    this.player.connect(this.volume);
    this.setTransport(origin);
  }

  private post(msg: TrackPlayerMessage, transfer: Transferable[] = []): void {
    this.player.port.postMessage(msg, transfer);
  }

  setTransport(origin: number | null): void {
    this.post({ type: 'transport', origin });
  }

  /** Sends a new mixed loop. The array is transferred; do not reuse it. */
  setBuffer(data: Float32Array | null): void {
    this.post({ type: 'buffer', data }, data ? [data.buffer] : []);
  }

  setMix(volume: number, pan: number, audible: boolean): void {
    const t = this.ctx.currentTime;
    this.volume.gain.setTargetAtTime(audible ? volume : 0, t, 0.01);
    this.panner.pan.setTargetAtTime(pan, t, 0.01);
  }

  syncEffects(states: EffectState[]): void {
    const key = states.map((e) => `${e.id}:${e.type}:${e.enabled ? 1 : 0}`).join('|');
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.rebuild(states);
    }
    for (const state of states) {
      const live = this.effects.find((e) => e.id === state.id);
      const def = getEffect(state.type);
      if (!live || !def) continue;
      const params = normalizeParams(def, state.params);
      for (const [k, v] of Object.entries(params)) {
        if (live.params[k] !== v) {
          live.params[k] = v;
          live.instance.set(k, v);
        }
      }
    }
  }

  private rebuild(states: EffectState[]): void {
    const keep: LiveEffect[] = [];
    for (const state of states) {
      const def = getEffect(state.type);
      if (!def) continue; // unknown effect from a newer client: skip, stay compatible
      let live = this.effects.find((e) => e.id === state.id && e.type === state.type);
      if (!live) {
        const params = normalizeParams(def, state.params);
        live = { id: state.id, type: state.type, enabled: state.enabled, instance: def.create(this.ctx, params), params };
      }
      live.enabled = state.enabled;
      keep.push(live);
    }
    for (const old of this.effects) if (!keep.includes(old)) old.instance.dispose();
    this.effects = keep;

    this.player.disconnect();
    for (const e of this.effects) e.instance.output.disconnect();
    let node: AudioNode = this.player;
    for (const e of this.effects) {
      if (!e.enabled) continue;
      node.connect(e.instance.input);
      node = e.instance.output;
    }
    node.connect(this.volume);
  }

  dispose(): void {
    this.setBuffer(null);
    this.player.disconnect();
    for (const e of this.effects) e.instance.dispose();
    this.volume.disconnect();
    this.panner.disconnect();
  }
}
