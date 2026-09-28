/**
 * Draws a track as a spinning "record": the loop's spectrogram is a ring that
 * rotates backwards under a fixed playhead at twelve o'clock, so the slice
 * playing right now is always on top (design from v1).
 */
import { RECORD_COLOR } from './palette';
import type { Spectrogram } from './spectrogram';

export type DiscMode = 'empty' | 'recording' | 'overdub' | 'finishing' | 'playing' | 'waiting';

export interface DiscState {
  color: string;
  mode: DiscMode;
  spectrogram: Spectrogram | null;
  revision: number;
  /** 0..1 audible loop position, null if not playing. */
  playhead: number | null;
  /** 0..1 progress ring while recording, null if unknown. */
  recordProgress: number | null;
  stickers: Array<{ label: string; color: string; enabled: boolean }>;
  remoteRecording: boolean;
  muted: boolean;
  /** performance.now() in ms, for pulsing. */
  time: number;
}

const STICKER_ANGLES = [-38, 128, 208, 38, 250, 160];

export class DiscRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private ring: HTMLCanvasElement | null = null;
  private ringKey = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(s: DiscState): void {
    const { canvas, ctx } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssSize = canvas.clientWidth;
    const size = Math.round(cssSize * dpr);
    if (size <= 0) return;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.scale(dpr, dpr);
    const c = cssSize / 2;
    const r = c - 10;
    const recordingLike = s.mode === 'recording' || s.mode === 'overdub';
    const pulse = 0.5 + 0.5 * Math.sin(s.time / 180);

    // Base disc
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0c111d';
    ctx.fill();

    // Spectrogram ring or empty grooves
    if (s.spectrogram) {
      const ring = this.ringImage(s, r, dpr);
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(-(s.playhead ?? 0) * Math.PI * 2);
      ctx.globalAlpha = s.muted ? 0.35 : 1;
      ctx.drawImage(ring, -r, -r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      for (let g = 1; g <= 6; g++) {
        ctx.beginPath();
        ctx.arc(c, c, r * (0.32 + g * 0.1), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Outer ring
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = recordingLike ? RECORD_COLOR : s.mode === 'empty' ? '#2b3449' : s.color;
    ctx.globalAlpha = recordingLike ? 0.6 + 0.4 * pulse : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Progress arc (recording) or playhead sweep
    if (recordingLike && s.recordProgress !== null) {
      ctx.beginPath();
      ctx.arc(c, c, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, s.recordProgress));
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = RECORD_COLOR;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Someone else is recording here
    if (s.remoteRecording) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -s.time / 40;
      ctx.beginPath();
      ctx.arc(c, c, r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = RECORD_COLOR;
      ctx.stroke();
      ctx.restore();
    }

    // Fixed playhead at twelve o'clock
    if (s.playhead !== null) {
      ctx.beginPath();
      ctx.moveTo(c, c - r + 2);
      ctx.lineTo(c, c - r * 0.3);
      ctx.strokeStyle = 'rgba(242,246,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c, c - r + 6, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#f2f6ff';
      ctx.fill();
    }

    // Label in the middle with the action icon
    const hub = r * 0.24;
    ctx.beginPath();
    ctx.arc(c, c, hub, 0, Math.PI * 2);
    ctx.fillStyle = '#090c13';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();
    this.drawIcon(s, c, hub, pulse);

    // Effect stickers
    s.stickers.forEach((st, i) => {
      const angle = ((STICKER_ANGLES[i % STICKER_ANGLES.length]! - 90) * Math.PI) / 180;
      const x = c + Math.cos(angle) * r * 0.78;
      const y = c + Math.sin(angle) * r * 0.78;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2);
      ctx.globalAlpha = st.enabled ? 1 : 0.35;
      ctx.fillStyle = st.color;
      roundRect(ctx, -13, -8, 26, 16, 5);
      ctx.fill();
      ctx.fillStyle = '#0b0f19';
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(st.label, 0, 0.5);
      ctx.restore();
    });
  }

  private drawIcon(s: DiscState, c: number, hub: number, pulse: number): void {
    const { ctx } = this;
    const k = hub * 0.42;
    if (s.mode === 'recording' || s.mode === 'overdub') {
      ctx.fillStyle = RECORD_COLOR;
      roundRect(ctx, c - k * 0.75, c - k * 0.75, k * 1.5, k * 1.5, 3);
      ctx.fill();
    } else if (s.mode === 'finishing' || s.mode === 'waiting') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const start = (s.time / 150) % (Math.PI * 2);
      ctx.arc(c, c, k, start, start + Math.PI * 1.3);
      ctx.stroke();
    } else if (s.mode === 'empty') {
      ctx.beginPath();
      ctx.arc(c, c, k * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = RECORD_COLOR;
      ctx.globalAlpha = 0.75 + 0.25 * pulse;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // Playing: "+" = tap to overdub
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c - k * 0.7, c);
      ctx.lineTo(c + k * 0.7, c);
      ctx.moveTo(c, c - k * 0.7);
      ctx.lineTo(c, c + k * 0.7);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  /** Pre-renders the polar spectrogram once per mix revision. */
  private ringImage(s: DiscState, r: number, dpr: number): HTMLCanvasElement {
    const key = `${s.revision}|${Math.round(r * dpr)}|${s.color}`;
    if (this.ring && this.ringKey === key) return this.ring;
    const spec = s.spectrogram!;
    const px = Math.round(r * 2 * dpr);
    const canvas = this.ring ?? document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, px, px);
    const c = px / 2;
    const inner = c * 0.3;
    const outer = c * 0.95;
    const band = (outer - inner) / spec.freqBins;
    const [cr, cg, cb] = hexToRgb(s.color);
    for (let t = 0; t < spec.timeBins; t++) {
      const a0 = (t / spec.timeBins) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((t + 1) / spec.timeBins) * Math.PI * 2 - Math.PI / 2 + 0.01;
      for (let f = 0; f < spec.freqBins; f++) {
        const v = spec.data[t * spec.freqBins + f] ?? 0;
        if (v < 0.04) continue;
        // Low frequencies outside, highs towards the label, like grooves.
        const rOuter = outer - f * band;
        g.beginPath();
        g.arc(c, c, rOuter, a0, a1);
        g.arc(c, c, rOuter - band + 0.5, a1, a0, true);
        g.closePath();
        g.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1, v * 1.1).toFixed(3)})`;
        g.fill();
      }
    }
    this.ring = canvas;
    this.ringKey = key;
    return canvas;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
