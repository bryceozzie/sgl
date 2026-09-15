/** Plain geometry types shared by layout and render. JSON-compatible throughout
 *  (DD-00 §3) so every value survives `structuredClone` across the worker boundary. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Normalised to `[top, right, bottom, left]` by the theme resolver (DD-04 §3). */
export type Insets = readonly [number, number, number, number];

export type PathSeg =
  | { readonly t: 'L'; readonly to: Point }
  | { readonly t: 'Q'; readonly c: Point; readonly to: Point }
  | { readonly t: 'C'; readonly c1: Point; readonly c2: Point; readonly to: Point }
  | { readonly t: 'A'; readonly r: Size; readonly sweep: 0 | 1; readonly to: Point };
