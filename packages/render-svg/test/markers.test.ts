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

  it('markerUnits is userSpaceOnUse and refX/refY anchor the base, arrowSize behind the tip', () => {
    const t = new MarkerTable();
    t.add('triangle', '#000000', 8, false);
    const svg = t.emit();
    expect(svg).toContain('markerUnits="userSpaceOnUse"');
    // The reserve (DD-06 §4.4) already pulled the path back by `arrowSize`;
    // anchoring the base (x=0) here — not the tip (x=w=8) — lets the tip
    // extend the remaining `arrowSize` back out to the boundary. `refX="8"`
    // (the old, buggy value) would anchor the tip at the shortened vertex,
    // landing `arrowSize` short of the boundary — the bug this fix corrects.
    expect(svg).toContain('refX="0"');
  });

  it('a start marker flips refX to w and rotates 180deg about its own center', () => {
    const t = new MarkerTable();
    t.add('triangle', '#000000', 8, true);
    const svg = t.emit();
    // Flipped 180°, the drawn tip moves to local x=0 and the base to x=w, so
    // the base anchor swaps accordingly (mirror of the end-marker case).
    expect(svg).toContain('refX="8"');
    expect(svg).toContain('rotate(180');
  });

  it('anchors every arrowhead kind so its own far extent lands `arrowSize` beyond refX (DD-06 §4.4)', () => {
    // triangle/open/diamond all draw their point at local x=w, so their base
    // (the anchor) is at x=0 for an end marker and x=w for a start marker —
    // the tip is then exactly `arrowSize` (=w, here 8) beyond the anchor.
    for (const arrowhead of ['triangle', 'open', 'diamond'] as const) {
      const end = new MarkerTable();
      end.add(arrowhead, '#000000', 8, false);
      expect(end.emit(), arrowhead).toContain('refX="0"');

      const start = new MarkerTable();
      start.add(arrowhead, '#000000', 8, true);
      expect(start.emit(), arrowhead).toContain('refX="8"');
    }

    // circle is radially symmetric and capped to r = min(w,h)/2 = h/2 = 3 (w=8,
    // h=6) to stay inside markerHeight, so its far edge is at w/2+r=7, short
    // of w by 1 — its refX is offset by that same 1px so the edge (not the
    // nominal markerWidth) lands `arrowSize` beyond the anchor.
    const circleEnd = new MarkerTable();
    circleEnd.add('circle', '#000000', 8, false);
    expect(circleEnd.emit()).toContain('refX="-1"');

    const circleStart = new MarkerTable();
    circleStart.add('circle', '#000000', 8, true);
    expect(circleStart.emit()).toContain('refX="9"');
  });
});
