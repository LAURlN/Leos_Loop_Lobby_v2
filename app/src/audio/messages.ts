/**
 * Typed messages between the main thread and the AudioWorklet processors.
 * Keep processors dumb: they render/capture, all decisions happen on the main thread.
 */

/** Processor names registered in worklet/processors.ts. */
export const PROCESSOR = {
  trackPlayer: 'lll-track-player',
  recorder: 'lll-recorder',
  metronome: 'lll-metronome',
} as const;

/**
 * Shared by all transport-following processors. `origin` is a local frame
 * (null = stopped). Optional play window [start, end) in local frames, with
 * short fades at its edges (song playback plays each section once).
 */
export interface TransportMessage {
  type: 'transport';
  origin: number | null;
  start?: number;
  end?: number;
}

/** One stretch of the song for the metronome: its own origin and loop. */
export interface MetronomeSegment {
  start: number;
  end: number;
  origin: number;
  loopLength48: number;
  beatsPerLoop: number;
}

export type TrackPlayerMessage =
  | TransportMessage
  /** Full mixed loop at the canonical rate. `null` clears the track. */
  | { type: 'buffer'; data: Float32Array | null };

export type MetronomeMessage =
  | TransportMessage
  | { type: 'config'; enabled: boolean; loopLength48: number | null; beatsPerLoop: number; volume: number }
  /** Song playback: follow these segments instead of origin/loopLength (null = back to normal). */
  | { type: 'segments'; segments: MetronomeSegment[] | null };

/** Recorder -> main thread: a block of mic samples starting at local frame `frame`. */
export interface RecorderChunk {
  frame: number;
  data: Float32Array;
}
