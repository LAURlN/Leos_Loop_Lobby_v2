/**
 * All available effects. To add one: create `<name>.ts` exporting an
 * EffectDefinition and append it here. Nothing else needs to change.
 */
import { delay } from './delay';
import { eq } from './eq';
import { overdrive } from './overdrive';
import { reverb } from './reverb';
import type { EffectDefinition } from './types';

export const EFFECTS: readonly EffectDefinition[] = [eq, reverb, delay, overdrive];

const byType = new Map(EFFECTS.map((e) => [e.type, e]));

export function getEffect(type: string): EffectDefinition | undefined {
  return byType.get(type);
}

export function defaultParams(def: EffectDefinition): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.id, p.default]));
}

/** Returns a finite, in-range value (or null for unknown params). */
export function clampParam(def: EffectDefinition, paramId: string, value: number): number | null {
  const p = def.params.find((x) => x.id === paramId);
  if (!p) return null;
  if (!Number.isFinite(value)) return p.default;
  return Math.min(p.max, Math.max(p.min, value));
}

/** Fills missing params with defaults and clamps the rest. */
export function normalizeParams(def: EffectDefinition, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.id] = clampParam(def, p.id, params[p.id] ?? p.default) ?? p.default;
  return out;
}
