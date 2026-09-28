/**
 * Declarative effect definitions. One file per effect; register it in registry.ts.
 * The UI (sliders, presets, stickers), the shared session model (validation,
 * defaults) and the audio graph are all derived from this description.
 * See AGENTS.md "How to add an effect".
 */

export interface ParamDef {
  /** Stable id, stored in the shared session. Never rename once released. */
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  /** Display helper, e.g. v => `${Math.round(v)} ms`. */
  format?: (value: number) => string;
}

export interface EffectPreset {
  name: string;
  values: Record<string, number>;
}

/** A live instance inside one track's audio chain. */
export interface EffectInstance {
  input: AudioNode;
  output: AudioNode;
  /** Apply a (validated) parameter value. Called often while dragging sliders. */
  set(paramId: string, value: number): void;
  dispose(): void;
}

export interface EffectDefinition {
  /** Stable id, stored in the shared session. Never rename once released. */
  type: string;
  label: string;
  /** Two-letter label drawn on the track disc. */
  sticker: string;
  /** Accent colour for sticker and editor. */
  color: string;
  description: string;
  params: ParamDef[];
  presets?: EffectPreset[];
  create(ctx: BaseAudioContext, params: Record<string, number>): EffectInstance;
}

export const percent = (v: number) => `${Math.round(v * 100)}%`;
export const decibel = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
export const millis = (v: number) => `${Math.round(v)} ms`;

/** Smoothly moves an AudioParam to avoid zipper noise. */
export function smooth(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant = 0.015): void {
  param.setTargetAtTime(value, ctx.currentTime, timeConstant);
}
