/**
 * Arrowhead markers (DD-07 §6).
 *
 * One `<marker>` per distinct (arrowhead, stroke colour, size) actually used.
 * `context-stroke` is deliberately not relied on — Safari support arrived late and
 * resvg lacks it entirely — so the colour is baked into the marker and the id
 * carries a hash of it.
 */

import { shortHash } from '@sgl/core';
import { num, nums } from './num.js';
import { cssColor, hashToken } from './security.js';

export type Arrowhead = 'triangle' | 'open' | 'diamond' | 'circle' | 'none';

const ARROWHEADS: readonly string[] = ['triangle', 'open', 'diamond', 'circle', 'none'];

export function isArrowhead(v: unknown): v is Arrowhead {
  return typeof v === 'string' && ARROWHEADS.includes(v);
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
  /** The id already computed for these exact arguments (F9, execution plan
   *  §2.1): every directed edge asks, but a document uses a handful of
   *  distinct markers, and an id costs a colour validation and a hash. */
  private readonly ids = new Map<string, string>();

  /**
   * Register a marker and return its id, or `null` when nothing should be drawn.
   *
   * `start` flips the geometry rather than relying on `orient="auto-start-reverse"`
   * alone, because a reversed marker still needs its `refX` on the other side.
   */
  add(arrowhead: Arrowhead, color: string, size: number, start: boolean): string | null {
    if (arrowhead === 'none' || size <= 0) return null;

    const key = `${arrowhead}|${start ? 's' : 'e'}|${size}|${color}`;
    const known = this.ids.get(key);
    if (known !== undefined) return known;

    const fill = cssColor(color);
    const id = `m-${arrowhead}${start ? '-s' : ''}-${hashToken(shortHash(`${fill}|${num(size)}`))}`;
    if (!this.markers.has(id)) {
      this.markers.set(id, markerElement(id, arrowhead, fill, size, start));
    }
    this.ids.set(key, id);
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
  fill: string,
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
        return `<path d="M0 0L${nums(w, h / 2)}L0 ${num(h)}" fill="none" stroke="${fill}" stroke-width="${num(Math.max(1, size / 6))}" stroke-linecap="round" stroke-linejoin="round" ${flip}/>`;
      case 'diamond':
        return `<path d="M0 ${num(h / 2)}L${nums(w / 2, 0)}L${nums(w, h / 2)}L${nums(w / 2, h)}Z" fill="${fill}" ${flip}/>`;
      case 'circle':
        return `<circle cx="${num(w / 2)}" cy="${num(h / 2)}" r="${num(Math.min(w, h) / 2)}" fill="${fill}"/>`;
      case 'triangle':
      default:
        return `<path d="M0 0L${nums(w, h / 2)}L0 ${num(h)}Z" fill="${fill}" ${flip}/>`;
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
