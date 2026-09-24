/**
 * Arrowhead markers (DD-07 §6).
 *
 * One `<marker>` per distinct (arrowhead, start/end, size, edge paint class)
 * actually used, with the id built from exactly those:
 * `m-{arrowhead}[-s]-{size}-{token}`, where `token` is the edge's own
 * theme-invariant paint-class token (`cascadeSignature`, `style.ts`). The id
 * never names a colour (F7): the marker's shape carries a class,
 * `mf-{token}` (filled) or `ms-{token}` (`open`, stroked), and its colour is a
 * rule in the `<style>` element (`ClassTable.markerPaint`), so a theme switch
 * changes a rule body and never a marker id, a `marker-end`/`marker-start`
 * reference or the `<defs>` text. `context-stroke` is deliberately not relied
 * on — Safari support arrived late and resvg lacks it entirely. A class rule
 * inside `<marker>` is honoured by Chromium, Inkscape 1.2.2 and resvg
 * (checked when this landed; `test/browser/markers.browser.test.ts` holds
 * Chromium to it).
 */

import { num, nums } from './num.js';

export type Arrowhead = 'triangle' | 'open' | 'diamond' | 'circle' | 'none';

const ARROWHEADS: readonly string[] = ['triangle', 'open', 'diamond', 'circle', 'none'];

export function isArrowhead(v: unknown): v is Arrowhead {
  return typeof v === 'string' && ARROWHEADS.includes(v);
}

/** The class on a marker's shape that its paint rule targets: `open` is
 *  stroked, every other arrowhead filled. */
export function markerPaintClass(arrowhead: Arrowhead, token: string): string {
  return `${arrowhead === 'open' ? 'ms' : 'mf'}-${token}`;
}

/** The marker id for these arguments (DD-07 §6), or `null` when nothing is
 *  drawn. `token` is the edge's paint-class token. */
export function markerId(arrowhead: Arrowhead, size: number, start: boolean, token: string): string | null {
  if (arrowhead === 'none' || !(size > 0)) return null;
  return `m-${arrowhead}${start ? '-s' : ''}-${num(size)}-${token}`;
}

/**
 * Collects the markers a document needs, deduplicating by id.
 *
 * Like `ClassTable`, this sorts on emit rather than preserving discovery order, so
 * two renders that meet the same edges in a different order still produce the same
 * bytes (DD-00 §3).
 */
export class MarkerTable {
  private readonly markers = new Map<string, string>();

  /**
   * Register a marker and return its id, or `null` when nothing should be drawn.
   * The id is a pure function of the arguments, and so is the element, so
   * registering the same id again is a map lookup.
   *
   * `start` flips the geometry rather than relying on `orient="auto-start-reverse"`
   * alone, because a reversed marker still needs its `refX` on the other side.
   */
  add(arrowhead: Arrowhead, size: number, start: boolean, token: string): string | null {
    const id = markerId(arrowhead, size, start, token);
    if (id === null) return null;
    if (!this.markers.has(id)) {
      this.markers.set(id, markerElement(id, arrowhead, markerPaintClass(arrowhead, token), size, start));
    }
    return id;
  }

  /** Every marker, sorted by id. */
  emit(): string {
    return [...this.markers.keys()]
      .sort()
      .map((id) => this.markers.get(id) as string)
      .join('');
  }
}

function markerElement(
  id: string,
  arrowhead: Arrowhead,
  paintClass: string,
  size: number,
  start: boolean,
): string {
  const w = size;
  const h = size * 0.75;
  // The marker box is drawn pointing right (+x) and `orient="auto"` turns it to
  // follow the route. A start marker points back down the route instead.
  const flip = start ? `transform="rotate(180 ${nums(w / 2, h / 2)})"` : '';

  const shape = ((): string => {
    switch (arrowhead) {
      case 'open':
        // Stroked, not filled, so its rendered ink bulges slightly past the
        // `x = w` tip vertex: the outer corner uses a round line-join, whose
        // arc is centred *at* that vertex with radius `strokeWidth / 2` and
        // bulges outward (here, further in +x) by that same amount. `farX`
        // below still targets the vertex, not the ink, for the same reason
        // `triangle`'s solid fill is targeted at its vertex rather than at
        // some outer bound — it is the one point the path (and so the DD-06
        // §4.4 reserve, which reasons about the path's own geometry) knows
        // about, and the sub-pixel round-join overshoot is a pre-existing,
        // separate cosmetic rounding this fix does not change.
        return `<path class="${paintClass}" d="M0 0L${nums(w, h / 2)}L0 ${num(h)}" fill="none" stroke-width="${num(Math.max(1, size / 6))}" stroke-linecap="round" stroke-linejoin="round" ${flip}/>`;
      case 'diamond':
        return `<path class="${paintClass}" d="M0 ${num(h / 2)}L${nums(w / 2, 0)}L${nums(w, h / 2)}L${nums(w / 2, h)}Z" ${flip}/>`;
      case 'circle':
        return `<circle class="${paintClass}" cx="${num(w / 2)}" cy="${num(h / 2)}" r="${num(Math.min(w, h) / 2)}"/>`;
      case 'triangle':
      default:
        return `<path class="${paintClass}" d="M0 0L${nums(w, h / 2)}L0 ${num(h)}Z" ${flip}/>`;
    }
  })();

  // `markerUnits="userSpaceOnUse"` so `arrowSize` is in diagram units rather than
  // multiples of the stroke width — an edge does not get a bigger head for being
  // thicker (DD-07 §6).
  //
  // `refX`/`refY` say which point of this (unrotated) marker box lands on the
  // path vertex — the same vertex `orient="auto"` anchors the marker's local
  // +x axis to (the direction of travel there). DD-06 §4.4 already shortens the path's head
  // (and, for `both`, tail) end by `arrowSize` along that same direction, so
  // the marker's own *tip* — not its base — must sit `arrowSize` beyond the
  // vertex, i.e. beyond `refX`, for the tip to land back on the node
  // boundary the reserve pulled away from. `refX` therefore anchors the
  // **base** (the tip minus `arrowSize`), not the tip: anchoring the tip
  // itself (the previous `refX = start ? 0 : w`) put the tip AT the already-
  // shortened vertex — still `arrowSize` short of the boundary — which was
  // the bug (DD-06 §4.4's own reserve was correct; only the marker's anchor
  // was wrong).
  //
  // `farX` is where each shape's own far (tip) extent actually falls, in the
  // unrotated `0..w` box: `triangle`, `open` and `diamond` all draw their
  // point exactly at `x = w` (see the vertices above), so their base is at
  // `x = 0` and a start marker (drawn flipped 180° below, swapping tip and
  // base) needs its base at `x = w` instead — `refX = start ? w : 0`.
  // `circle` is the one shape whose point isn't at `x = w`: it is radially
  // symmetric, so it is drawn centred and capped to `r = min(w, h) / 2`
  // (`h < w` always, since `h = 0.75 * w`) to stay inside `markerHeight`
  // instead of reaching `x = w` the way the others do — its far edge is at
  // `x = w/2 + r`, short of `w` by `(w - h) / 2`. Folding that into `refX`
  // (rather than special-casing the circle's own draw) keeps the same
  // "anchor the base, `arrowSize` behind the tip" rule for every kind.
  const farX = arrowhead === 'circle' ? w / 2 + Math.min(w, h) / 2 : w;
  const refX = start ? 2 * w - farX : farX - w;
  return (
    `<marker id="${id}" markerUnits="userSpaceOnUse"` +
    ` markerWidth="${num(w)}" markerHeight="${num(h)}"` +
    ` refX="${num(refX)}" refY="${num(h / 2)}" orient="auto">` +
    `${shape}</marker>`
  );
}
