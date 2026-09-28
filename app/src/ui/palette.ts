/** Track accent colours (from v1). Tracks store an index, so the palette can change freely. */
export const TRACK_COLORS = ['#78efca', '#7eafff', '#b794ff', '#ffc175', '#5bdae8', '#ff7089', '#c6f27a', '#f59ee0'];

export const RECORD_COLOR = '#ff5c70';

export function trackColor(index: number): string {
  return TRACK_COLORS[((index % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]!;
}
