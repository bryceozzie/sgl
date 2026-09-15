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

  /**
   * Register a marker and return its id, or `null` when nothing should be drawn.
   *
   * `start` flips the geometry rather than relying on `orient="auto-start-reverse"`
   * alone, because a reversed marker still needs its `refX` on the other side.
   */
  add(arrowhead: Arrowhead, color: string, size: number, start: boolean): string | null {
    if (arrowhead === 'none' || size <= 0) return null;

    const fill = cssColor(color);
    const id = `m-${arrowhead}${start ? '-s' : ''}-${hashToken(shortHash(`${fill}|${num(size)}`))}`;
    if (!this.markers.has(id)) {
      this.markers.set(id, markerElement(id, arrowhead, fill, size, start));
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
  return (
    `<marker id="${id}" markerUnits="userSpaceOnUse"` +
    ` markerWidth="${num(w)}" markerHeight="${num(h)}"` +
    ` refX="${num(start ? 0 : w)}" refY="${num(h / 2)}" orient="auto">` +
    `${shape}</marker>`
  );
}
