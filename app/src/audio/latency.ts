/**
 * Round-trip latency (speaker -> ear -> instrument -> mic -> app) per audio route.
 * This is the only latency that matters musically; network latency only
 * delays when other players' takes arrive (see docs/SYNC_MODEL.md).
 */

export type LatencySource = 'estimate' | 'acoustic' | 'manual';

export interface LatencyProfile {
  routeKey: string;
  roundTripMs: number;
  source: LatencySource;
  spreadMs?: number;
  updatedAt: number;
}

const STORAGE_KEY = 'lll.latency.v1';

/** Browsers expose little about routes; mic label + output sink is the best we can do. */
export function routeKeyOf(inputLabel: string, outputId: string): string {
  return `${inputLabel || 'default-input'}|${outputId || 'default-output'}`;
}

function readAll(): Record<string, LatencyProfile> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, LatencyProfile>;
  } catch {
    return {};
  }
}

export function loadProfile(routeKey: string): LatencyProfile | null {
  return readAll()[routeKey] ?? null;
}

export function saveProfile(profile: LatencyProfile): void {
  const all = readAll();
  all[profile.routeKey] = profile;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Rough guess from what the browser reports; replaced by acoustic calibration. */
export function estimateRoundTripMs(ctx: AudioContext, mic: MediaStreamTrack | null): number {
  const output = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const settings = mic?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
  const input = settings?.latency && settings.latency > 0 ? settings.latency : 0.01;
  const ms = (output + input) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : 40;
}
