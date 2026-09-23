/** Pure pan/zoom/fit arithmetic for the canvas (DD-08 §6). No DOM — kept
 *  separate from `Canvas.tsx` so it is plain-Node testable. */

export interface Viewport {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

export interface Extent {
  readonly w: number;
  readonly h: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export function clampScale(k: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}

export const IDENTITY_VIEWPORT: Viewport = { k: 1, tx: 0, ty: 0 };

/** DD-08 §6: "k = min(vw / bounds.w, vh / bounds.h) × 0.94, centred." Used on
 *  document open and on the toolbar's Fit button — never on every render, so the
 *  viewport otherwise survives re-renders untouched. */
export function fitViewport(bounds: Extent, viewportSize: Extent): Viewport {
  if (bounds.w <= 0 || bounds.h <= 0 || viewportSize.w <= 0 || viewportSize.h <= 0) return IDENTITY_VIEWPORT;
  const k = clampScale(Math.min(viewportSize.w / bounds.w, viewportSize.h / bounds.h) * 0.94);
  return {
    k,
    tx: (viewportSize.w - bounds.w * k) / 2,
    ty: (viewportSize.h - bounds.h * k) / 2,
  };
}

/** Pan by `(dx, dy)` screen pixels. */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { k: v.k, tx: v.tx + dx, ty: v.ty + dy };
}

/** Zoom by `factor`, keeping the screen point `(cx, cy)` fixed in place. */
export function zoomAt(v: Viewport, cx: number, cy: number, factor: number): Viewport {
  const k = clampScale(v.k * factor);
  const ratio = k / v.k;
  return { k, tx: cx - (cx - v.tx) * ratio, ty: cy - (cy - v.ty) * ratio };
}

/** Screen-space point → diagram space, inverting the current transform. */
export function screenToDiagram(v: Viewport, x: number, y: number): { readonly x: number; readonly y: number } {
  return { x: (x - v.tx) / v.k, y: (y - v.ty) / v.k };
}

/** DD-08 §6: "When `bounds` changes size by more than 40% the chip offers
 *  'Fit'." `prev === null` (nothing rendered yet) is never a significant change —
 *  there is nothing to offer refitting relative to. */
export function boundsChangedSignificantly(prev: Extent | null, next: Extent): boolean {
  if (prev === null) return false;
  const dw = Math.abs(next.w - prev.w) / Math.max(prev.w, 1);
  const dh = Math.abs(next.h - prev.h) / Math.max(prev.h, 1);
  return dw > 0.4 || dh > 0.4;
}
