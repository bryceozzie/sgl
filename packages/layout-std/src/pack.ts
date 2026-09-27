import type { Point, Size } from '@sgl/core';

/**
 * Row/column packing (DD-06 §7, DD-12 N10): `grid`'s arithmetic, written once
 * and shared by `grid` (every container's children) and `fixed` (the nodes
 * that have no `@pin`, below the pinned ones).
 *
 * Cell `k` goes in column `k % cols`, row `floor(k / cols)`. Each column is as
 * wide as its widest cell and each row as tall as its tallest; columns and
 * rows are `gap` apart. With `align: 'center'` a cell is centred in its
 * column and row, otherwise it sits at the cell's top-left.
 *
 * The first column starts at `x0` and the first row at `y0`, and the sums run
 * from there, in the same order `grid` always added them: `grid`'s goldens
 * are byte-identical after the move, because floating-point addition is not
 * associative and so the origin is not added afterwards.
 *
 * `w` and `h` are the extent of the columns and rows themselves, gaps
 * between them included, without the origin. Nothing packs to `0 × 0`.
 */
export interface PackedCells {
  readonly positions: readonly Point[];
  readonly w: number;
  readonly h: number;
}

export function packCells(sizes: readonly Size[], cols: number, gap: number, align: 'start' | 'center', x0: number, y0: number): PackedCells {
  const n = sizes.length;
  if (n === 0) return { positions: [], w: 0, h: 0 };
  const rows = Math.ceil(n / cols);

  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  for (let k = 0; k < n; k += 1) {
    const col = k % cols;
    const row = Math.floor(k / cols);
    const size = sizes[k];
    if (size === undefined) continue;
    if (size.w > (colW[col] ?? 0)) colW[col] = size.w;
    if (size.h > (rowH[row] ?? 0)) rowH[row] = size.h;
  }

  const colX = new Array<number>(cols);
  let x = x0;
  for (let j = 0; j < cols; j += 1) {
    colX[j] = x;
    x += (colW[j] ?? 0) + gap;
  }
  const rowY = new Array<number>(rows);
  let y = y0;
  for (let i = 0; i < rows; i += 1) {
    rowY[i] = y;
    y += (rowH[i] ?? 0) + gap;
  }

  const positions: Point[] = [];
  for (let k = 0; k < n; k += 1) {
    const size = sizes[k] ?? { w: 0, h: 0 };
    const col = k % cols;
    const row = Math.floor(k / cols);
    const cellW = colW[col] ?? 0;
    const cellH = rowH[row] ?? 0;
    const cellX = colX[col] ?? x0;
    const cellY = rowY[row] ?? y0;
    positions.push(align === 'center' ? { x: cellX + (cellW - size.w) / 2, y: cellY + (cellH - size.h) / 2 } : { x: cellX, y: cellY });
  }

  const sumColW = colW.reduce((a, b) => a + b, 0);
  const sumRowH = rowH.reduce((a, b) => a + b, 0);
  return { positions, w: sumColW + gap * (cols - 1), h: sumRowH + gap * (rows - 1) };
}
