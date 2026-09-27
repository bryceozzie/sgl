import { describe, expect, it } from 'vitest';
import { packCells } from '../src/pack.js';

/**
 * DD-12 N10: `grid`'s row/column packing as one helper, shared by `grid` and
 * `fixed`. `grid`'s goldens (`grid.test.ts`) prove its output did not move;
 * these pin the helper's own arithmetic, including the origin `fixed` packs
 * its loose nodes at.
 */
describe('packCells (DD-12 N10)', () => {
  const sizes = [
    { w: 10, h: 5 },
    { w: 30, h: 20 },
    { w: 20, h: 10 },
    { w: 5, h: 40 },
    { w: 7, h: 3 },
  ];

  it('places cells row by row, each column as wide as its widest cell, aligned to the start', () => {
    const packed = packCells(sizes, 2, 4, 'start', 0, 0);
    // colW = [20, 30], rowH = [20, 40, 3]
    expect(packed.positions).toEqual([
      { x: 0, y: 0 },
      { x: 24, y: 0 },
      { x: 0, y: 24 },
      { x: 24, y: 24 },
      { x: 0, y: 68 },
    ]);
    expect({ w: packed.w, h: packed.h }).toEqual({ w: 20 + 30 + 4, h: 20 + 40 + 3 + 2 * 4 });
  });

  it('centres a cell in its column and row with align center', () => {
    const packed = packCells(sizes, 2, 4, 'center', 0, 0);
    expect(packed.positions[0]).toEqual({ x: 5, y: 7.5 });
    expect(packed.positions[4]).toEqual({ x: 6.5, y: 68 });
  });

  it('starts at the origin it is given, and the extent does not include it', () => {
    const at0 = packCells(sizes, 3, 8, 'start', 0, 0);
    const moved = packCells(sizes, 3, 8, 'start', 100, -50);
    expect(moved.positions).toEqual(at0.positions.map((p) => ({ x: p.x + 100, y: p.y - 50 })));
    expect({ w: moved.w, h: moved.h }).toEqual({ w: at0.w, h: at0.h });
  });

  it('keeps an empty column when there are more columns than cells, as grid always has', () => {
    const packed = packCells([{ w: 10, h: 10 }], 3, 5, 'start', 0, 0);
    expect(packed.positions).toEqual([{ x: 0, y: 0 }]);
    expect(packed.w).toBe(10 + 2 * 5);
  });

  it('packs nothing to an empty extent', () => {
    expect(packCells([], 1, 24, 'start', 3, 4)).toEqual({ positions: [], w: 0, h: 0 });
  });
});
