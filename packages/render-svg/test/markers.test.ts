import { describe, expect, it } from 'vitest';
import { isArrowhead, markerId, markerPaintClass, MarkerTable } from '../src/markers.js';

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
    expect(t.add('none', 8, false, 't0')).toBeNull();
    expect(t.add('triangle', 0, false, 't0')).toBeNull();
    expect(t.add('triangle', -1, false, 't0')).toBeNull();
    expect(t.emit()).toBe('');
  });

  it('the same (arrowhead, size, start, token) reuses one marker id', () => {
    const t = new MarkerTable();
    const a = t.add('triangle', 8, false, 't0');
    const b = t.add('triangle', 8, false, 't0');
    expect(a).toBe(b);
    expect(t.emit().match(/<marker/g)).toHaveLength(1);
  });

  it('a different token or size gets a different id', () => {
    const t = new MarkerTable();
    const a = t.add('triangle', 8, false, 't0');
    const b = t.add('triangle', 8, false, 't1');
    const c = t.add('triangle', 10, false, 't0');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('start vs end markers get distinct ids even with identical token/size', () => {
    const t = new MarkerTable();
    const end = t.add('triangle', 8, false, 't0');
    const start = t.add('triangle', 8, true, 't0');
    expect(end).not.toBe(start);
    expect(start).toContain('-s-');
  });

  it('the id is (arrowhead, start/end, size, token) and never a colour; the shape carries the paint class, no colour attribute (F7)', () => {
    const t = new MarkerTable();
    expect(t.add('triangle', 8, false, 'abc')).toBe('m-triangle-8-abc');
    expect(t.add('open', 12.5, true, 'abc')).toBe('m-open-s-12.5-abc');
    expect(markerId('circle', 8, false, 'abc')).toBe('m-circle-8-abc');
    const svg = t.emit();
    expect(svg).toContain('<path class="mf-abc" ');
    expect(svg).toContain('<path class="ms-abc" ');
    expect(svg).not.toMatch(/(?:fill|stroke)="#/);
    expect(svg).not.toMatch(/(?:fill|stroke)="(?!none")[^"]/);
    expect(markerPaintClass('open', 'abc')).toBe('ms-abc');
    for (const k of ['triangle', 'diamond', 'circle'] as const) expect(markerPaintClass(k, 'abc')).toBe('mf-abc');
  });

  it('emit() is sorted by id, independent of insertion order', () => {
    const t1 = new MarkerTable();
    t1.add('circle', 8, false, 't1');
    t1.add('triangle', 8, false, 't0');

    const t2 = new MarkerTable();
    t2.add('triangle', 8, false, 't0');
    t2.add('circle', 8, false, 't1');

    expect(t1.emit()).toBe(t2.emit());
  });

  it('markerUnits is userSpaceOnUse and refX/refY anchor the base, arrowSize behind the tip', () => {
    const t = new MarkerTable();
    t.add('triangle', 8, false, 't0');
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
    t.add('triangle', 8, true, 't0');
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
      end.add(arrowhead, 8, false, 't0');
      expect(end.emit(), arrowhead).toContain('refX="0"');

      const start = new MarkerTable();
      start.add(arrowhead, 8, true, 't0');
      expect(start.emit(), arrowhead).toContain('refX="8"');
    }

    // circle is radially symmetric and capped to r = min(w,h)/2 = h/2 = 3 (w=8,
    // h=6) to stay inside markerHeight, so its far edge is at w/2+r=7, short
    // of w by 1 — its refX is offset by that same 1px so the edge (not the
    // nominal markerWidth) lands `arrowSize` beyond the anchor.
    const circleEnd = new MarkerTable();
    circleEnd.add('circle', 8, false, 't0');
    expect(circleEnd.emit()).toContain('refX="-1"');

    const circleStart = new MarkerTable();
    circleStart.add('circle', 8, true, 't0');
    expect(circleStart.emit()).toContain('refX="9"');
  });
});
