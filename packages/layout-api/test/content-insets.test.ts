import { describe, expect, it } from 'vitest';
import { contentInsets } from '../src/content-insets.js';

describe('contentInsets (DD-07 §4)', () => {
  it('rect and round get no extra inset', () => {
    expect(contentInsets('rect', 40, 20)).toEqual([0, 0, 0, 0]);
    expect(contentInsets('round', 40, 20)).toEqual([0, 0, 0, 0]);
  });

  it('an unrecognised shape falls back to no inset, same as rect', () => {
    expect(contentInsets('made-up-shape', 40, 20)).toEqual([0, 0, 0, 0]);
  });

  it('ellipse insets each side by w/h · (1 − 1/√2) / 2', () => {
    const [t, r, b, l] = contentInsets('ellipse', 100, 50);
    const x = 100 * (1 - 1 / Math.SQRT2) * 0.5;
    const y = 50 * (1 - 1 / Math.SQRT2) * 0.5;
    expect(r).toBeCloseTo(x, 10);
    expect(l).toBeCloseTo(x, 10);
    expect(t).toBeCloseTo(y, 10);
    expect(b).toBeCloseTo(y, 10);
  });

  it('diamond insets each side by w/4, h/4', () => {
    expect(contentInsets('diamond', 100, 40)).toEqual([10, 25, 10, 25]);
  });

  it('hexagon insets left/right only, by min(h/2, 0.25w)', () => {
    expect(contentInsets('hexagon', 100, 40)).toEqual([0, 20, 0, 20]);
    // h/2 is the binding constraint when the label is tall relative to its width.
    expect(contentInsets('hexagon', 100, 10)).toEqual([0, 5, 0, 5]);
  });

  it('cylinder insets top by 2·ry, bottom by ry, ry = min(8, h/6)', () => {
    expect(contentInsets('cylinder', 100, 100)).toEqual([16, 0, 8, 0]);
    expect(contentInsets('cylinder', 100, 12)).toEqual([4, 0, 2, 0]);
  });

  it('package insets the top by 14, nothing else', () => {
    expect(contentInsets('package', 100, 40)).toEqual([14, 0, 0, 0]);
  });

  it('every shape returns finite insets for a zero-sized label', () => {
    for (const shape of ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package']) {
      for (const v of contentInsets(shape, 0, 0)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
