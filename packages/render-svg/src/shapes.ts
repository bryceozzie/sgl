import { NotImplemented, type Insets, type Point, type Rect } from '@sgl/core';

/**
 * A shape is three pure functions over a frame and a corner radius (DD-07 §4).
 *
 * ⟶ C7: user shapes are parameterised path templates whose `contentInsets` and
 * `anchor` come from a declared `anchor: box | ellipse | polygon`. This interface
 * does not change.
 */
export interface Shape {
  /** SVG path data, absolute coordinates. */
  path(f: Rect, r: number): string;
  /** Extra space the shape needs beyond padding. */
  contentInsets(labelW: number, labelH: number): Insets;
  /** Boundary intersection of the ray centre→`from`. */
  anchor(f: Rect, from: Point): Point;
}

/**
 * The built-in shapes.
 *
 * | id | content insets | anchor |
 * |---|---|---|
 * | `rect`     | 0                                   | box     |
 * | `round`    | 0                                   | box     |
 * | `ellipse`  | `w·(1−1/√2)/2` each side            | ellipse |
 * | `diamond`  | `w/4`, `h/4` each side              | polygon |
 * | `hexagon`  | `i = min(h/2, 0.25w)` left/right    | polygon |
 * | `cylinder` | top `2·ry`, bottom `ry`             | box     |
 * | `package`  | top 14                              | box     |
 */
export const SHAPES: Readonly<Record<string, Shape>> = new Proxy(
  {},
  {
    get(_target, prop: string): Shape {
      throw new NotImplemented(`shape '${prop}'`, 'DD-07 §4');
    },
  },
);

export const DEFAULT_SHAPE = 'rect';
