import { describe, expect, it } from 'vitest';
import { CANONICAL_RATE } from '@lll/shared';
import { columnEnvelope, fitView, formatFrames, panView, pickTickStep48, zoomView } from './studioView';

describe('studio view maths', () => {
  it('builds a min/max envelope per column', () => {
    const data = new Float32Array([0, 1, -1, 0.5, -0.25, 0, 0, 0]);
    const { min, max } = columnEnvelope(data, 0, 8, 2);
    expect(Array.from(max)).toEqual([1, 0]);
    expect(Array.from(min)).toEqual([-1, -0.25]);
    const whole = columnEnvelope(data, 0, 8, 1);
    expect(whole.max[0]).toBe(1);
    expect(whole.min[0]).toBe(-1);
  });

  it('handles empty buffers and out-of-range views', () => {
    const empty = columnEnvelope(new Float32Array(0), 0, 100, 4);
    expect(Array.from(empty.max)).toEqual([0, 0, 0, 0]);
    const data = new Float32Array([0.5, -0.5]);
    const outside = columnEnvelope(data, 10, 20, 2);
    expect(Array.from(outside.max)).toEqual([0, 0]);
  });

  it('picks ruler steps that fit the width', () => {
    expect(pickTickStep48(CANONICAL_RATE * 2, 10)).toBe(CANONICAL_RATE / 5);
    expect(pickTickStep48(CANONICAL_RATE * 0.1, 4)).toBe(CANONICAL_RATE * 0.05);
    // Very wide views fall back to the largest step.
    expect(pickTickStep48(CANONICAL_RATE * 60 * 60, 2)).toBe(CANONICAL_RATE * 600);
  });

  it('formats times like a transport display', () => {
    expect(formatFrames(0)).toBe('0:00.000');
    expect(formatFrames(CANONICAL_RATE)).toBe('0:01.000');
    expect(formatFrames(CANONICAL_RATE * 90 + 1200, false)).toBe('1:30');
    expect(formatFrames(-5)).toBe('0:00.000');
  });

  it('zooms around an anchor and stays inside the buffer', () => {
    const total = CANONICAL_RATE * 4;
    const zoomed = zoomView({ start: 0, span: total }, total / 2, 2, total);
    expect(zoomed.span).toBe(total / 2);
    expect(zoomed.start).toBe(total / 4); // centre stays centre
    // Never past the ends.
    const left = zoomView({ start: 0, span: total / 2 }, 0, 0.5, total);
    expect(left.start).toBe(0);
    expect(left.span).toBe(total);
    const right = zoomView({ start: total - total / 4, span: total / 4 }, total, 4, total);
    expect(right.start).toBe(total - right.span);
    // A minimum span keeps the view usable when zoomed all the way in.
    expect(zoomView({ start: 0, span: 128 }, 0, 100, total).span).toBe(64);
  });

  it('pans without leaving the buffer', () => {
    const total = CANONICAL_RATE * 2;
    const view = { start: 100, span: 1000 };
    expect(panView(view, 500, total)).toEqual({ start: 600, span: 1000 });
    expect(panView(view, -5000, total).start).toBe(0);
    expect(panView(view, total, total).start).toBe(total - 1000);
    expect(fitView(total)).toEqual({ start: 0, span: total });
  });
});
