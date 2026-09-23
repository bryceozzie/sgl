import { describe, expect, it } from 'vitest';
import { boundsChangedSignificantly, clampScale, fitViewport, MAX_SCALE, MIN_SCALE, panBy, screenToDiagram, svgExtent, zoomAt } from '../src/canvas/viewport.js';

describe('canvas viewport (DD-08 §6)', () => {
  it('clamps scale to [0.1, 8]', () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });

  it('fits and centres: k = min(vw/bw, vh/bh) * 0.94', () => {
    const v = fitViewport({ w: 200, h: 100 }, { w: 1000, h: 1000 });
    expect(v.k).toBeCloseTo(Math.min(5, 10) * 0.94, 5);
    expect(v.tx).toBeCloseTo((1000 - 200 * v.k) / 2, 5);
    expect(v.ty).toBeCloseTo((1000 - 100 * v.k) / 2, 5);
  });

  it('fit degrades to identity for a degenerate extent', () => {
    expect(fitViewport({ w: 0, h: 0 }, { w: 100, h: 100 })).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(fitViewport({ w: 10, h: 10 }, { w: 0, h: 0 })).toEqual({ k: 1, tx: 0, ty: 0 });
  });

  it('pans by screen pixels without touching scale', () => {
    const v = panBy({ k: 2, tx: 10, ty: 10 }, 5, -3);
    expect(v).toEqual({ k: 2, tx: 15, ty: 7 });
  });

  it('zoom keeps the anchor point fixed in screen space', () => {
    const v0 = { k: 1, tx: 0, ty: 0 };
    const v1 = zoomAt(v0, 50, 50, 2);
    expect(v1.k).toBe(2);
    // The diagram-space point under (50, 50) must be the same before and after.
    const before = screenToDiagram(v0, 50, 50);
    const after = screenToDiagram(v1, 50, 50);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zoom clamps at the scale bounds', () => {
    const v = zoomAt({ k: MAX_SCALE, tx: 0, ty: 0 }, 0, 0, 10);
    expect(v.k).toBe(MAX_SCALE);
  });

  it('screenToDiagram inverts the affine transform', () => {
    const v = { k: 2, tx: 10, ty: 20 };
    const p = screenToDiagram(v, 30, 40);
    expect(p).toEqual({ x: (30 - 10) / 2, y: (40 - 20) / 2 });
  });

  it('flags a bounds change over 40%, not under', () => {
    expect(boundsChangedSignificantly({ w: 100, h: 100 }, { w: 141, h: 100 })).toBe(true);
    expect(boundsChangedSignificantly({ w: 100, h: 100 }, { w: 120, h: 100 })).toBe(false);
    expect(boundsChangedSignificantly(null, { w: 999, h: 999 })).toBe(false);
  });

  it('a change of exactly 40% is not "more than 40%" (strict >)', () => {
    // DD-08 §6: "changes size by more than 40%" — the boundary itself is not
    // an offer, only what exceeds it.
    expect(boundsChangedSignificantly({ w: 100, h: 100 }, { w: 140, h: 100 })).toBe(false);
    expect(boundsChangedSignificantly({ w: 100, h: 100 }, { w: 100, h: 140 })).toBe(false);
    // One tick over the boundary does flip it.
    expect(boundsChangedSignificantly({ w: 100, h: 100 }, { w: 140.001, h: 100 })).toBe(true);
  });
});

describe('svgExtent (J6: fitting the stored boot picture)', () => {
  it("reads a render()'s root viewBox", () => {
    expect(svgExtent('<svg xmlns="http://www.w3.org/2000/svg" class="sgl" width="310" height="120" viewBox="0 0 310 120" role="img"><g viewBox="1 1 1 1"/></svg>')).toEqual({ w: 310, h: 120 });
    expect(svgExtent('<svg viewBox="-4.5 -4.5 80.25 40"></svg>')).toEqual({ w: 80.25, h: 40 });
  });

  it('null for anything without a usable root viewBox', () => {
    expect(svgExtent('')).toBeNull();
    expect(svgExtent('<svg width="10" height="10"></svg>')).toBeNull();
    expect(svgExtent('<g><svg viewBox="0 0 10 10"/></g>')).toBeNull();
    expect(svgExtent('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
    expect(svgExtent('<svg viewBox="0 0 ten 10"></svg>')).toBeNull();
  });
});
