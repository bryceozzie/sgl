import { describe, expect, it } from 'vitest';
import { isArrowhead, MarkerTable } from '../src/markers.js';

describe('isArrowhead()', () => {
  it('accepts the five known arrowheads', () => {
    for (const a of ['triangle', 'open', 'diamond', 'circle', 'none']) expect(isArrowhead(a)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isArrowhead('square')).toBe(false);
    expect(isArrowhead(42)).toBe(false);
    expect(isArrowhead(undefined)).toBe(false);
  });
});

describe('MarkerTable', () => {
  it('add() returns null for "none" or a non-positive size — nothing to draw', () => {
    const t = new MarkerTable();
    expect(t.add('none', '#000', 8, false)).toBeNull();
    expect(t.add('triangle', '#000', 0, false)).toBeNull();
    expect(t.add('triangle', '#000', -1, false)).toBeNull();
    expect(t.emit()).toBe('');
  });

  it('the same (arrowhead, color, size) reuses one marker id', () => {
    const t = new MarkerTable();
    const a = t.add('triangle', '#000000', 8, false);
    const b = t.add('triangle', '#000000', 8, false);
    expect(a).toBe(b);
    expect(t.emit().match(/<marker/g)).toHaveLength(1);
  });

  it('a different color or size gets a different id', () => {
    const t = new MarkerTable();
    const a = t.add('triangle', '#000000', 8, false);
    const b = t.add('triangle', '#ffffff', 8, false);
    const c = t.add('triangle', '#000000', 10, false);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('start vs end markers get distinct ids even with identical color/size', () => {
    const t = new MarkerTable();
    const end = t.add('triangle', '#000', 8, false);
    const start = t.add('triangle', '#000', 8, true);
    expect(end).not.toBe(start);
    expect(start).toContain('-s-');
  });

  it('a bad color falls back to the loud magenta rather than emitting unsanitised CSS', () => {
    const t = new MarkerTable();
    t.add('triangle', 'javascript:alert(1)', 8, false);
    expect(t.emit()).toContain('#FF00FF');
  });

  it('emit() is sorted by id, independent of insertion order', () => {
    const t1 = new MarkerTable();
    t1.add('circle', '#111111', 8, false);
    t1.add('triangle', '#000000', 8, false);

    const t2 = new MarkerTable();
    t2.add('triangle', '#000000', 8, false);
    t2.add('circle', '#111111', 8, false);

    expect(t1.emit()).toBe(t2.emit());
  });

  it('markerUnits is userSpaceOnUse and refX/refY position the tip', () => {
    const t = new MarkerTable();
    t.add('triangle', '#000000', 8, false);
    const svg = t.emit();
    expect(svg).toContain('markerUnits="userSpaceOnUse"');
    expect(svg).toContain('refX="8"');
  });

  it('a start marker flips refX to 0 and rotates 180deg about its own center', () => {
    const t = new MarkerTable();
    t.add('triangle', '#000000', 8, true);
    const svg = t.emit();
    expect(svg).toContain('refX="0"');
    expect(svg).toContain('rotate(180');
  });
});
