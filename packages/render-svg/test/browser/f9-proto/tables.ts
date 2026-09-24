/**
 * F9 PHASE 1 PROTOTYPE: measurement only, not production code.
 *
 * The class/marker naming strategies `render-invariant.ts`'s fork can run
 * with, so one element-string builder serves every variant the bench times:
 *
 * - `mainTables(memo)`: production's own `ClassTable`/`MarkerTable` naming
 *   (`paintHash`-keyed classes, colour-keyed marker ids), byte-identical to
 *   `render()`; with `memo`, each distinct style's class string and each
 *   distinct marker id is computed once per render instead of once per
 *   element. `render()` on main re-runs `geometryDeclarations` and a BigInt
 *   `fnv1a64` for every element, although a 2 000-node document has ~10
 *   distinct styles.
 * - `invariantTables(memo)`: theme-invariant naming (`style-invariant.ts`,
 *   `markers-invariant.ts`), with or without the same memo.
 */

import type { ComputedStyle } from '@sgl/theme';
import type { Arrowhead } from '../../../src/markers.js';
import { MarkerTable } from '../../../src/markers.js';
import { ClassTable } from '../../../src/style.js';
import { InvariantMarkerTable } from './markers-invariant.js';
import { InvariantClassTable } from './style-invariant.js';

export interface ClassNamer {
  readonly needsSignature: boolean;
  shapeClasses(style: ComputedStyle, signature: string): string;
  textClasses(style: ComputedStyle, signature: string): string;
  plateClasses(style: ComputedStyle, signature: string): string;
  emit(): readonly string[];
}

export interface MarkerNamer {
  add(arrowhead: Arrowhead, color: string, size: number, start: boolean, signature: string): string | null;
  emit(): string;
}

export interface Tables {
  readonly classes: ClassNamer;
  readonly markers: MarkerNamer;
}

function memoize(inner: (kind: string, style: ComputedStyle, signature: string) => string, key: (kind: string, style: ComputedStyle, signature: string) => string) {
  const cache = new Map<string, string>();
  return (kind: string, style: ComputedStyle, signature: string): string => {
    const k = key(kind, style, signature);
    let hit = cache.get(k);
    if (hit === undefined) {
      hit = inner(kind, style, signature);
      cache.set(k, hit);
    }
    return hit;
  };
}

export function mainTables(memo: boolean): Tables {
  const table = new ClassTable();
  const markerTable = new MarkerTable();
  const call = (kind: string, style: ComputedStyle): string =>
    kind === 's' ? table.shapeClasses(style) : kind === 't' ? table.textClasses(style) : table.plateClasses(style);
  const get = memo ? memoize(call, (kind, style) => `${kind}|${style.paintHash}|${style.geometryHash}`) : call;
  const markerCache = new Map<string, string | null>();
  return {
    classes: {
      needsSignature: false,
      shapeClasses: (style) => get('s', style, ''),
      textClasses: (style) => get('t', style, ''),
      plateClasses: (style) => get('p', style, ''),
      emit: () => table.emit(),
    },
    markers: {
      add(arrowhead, color, size, start) {
        if (!memo) return markerTable.add(arrowhead, color, size, start);
        const k = `${arrowhead}|${color}|${size}|${start}`;
        if (!markerCache.has(k)) markerCache.set(k, markerTable.add(arrowhead, color, size, start));
        return markerCache.get(k) as string | null;
      },
      emit: () => markerTable.emit(),
    },
  };
}

export function invariantTables(memo: boolean): Tables {
  const table = new InvariantClassTable();
  const markerTable = new InvariantMarkerTable();
  const call = (kind: string, style: ComputedStyle, sig: string): string =>
    kind === 's' ? table.shapeClasses(style, sig) : kind === 't' ? table.textClasses(style, sig) : table.plateClasses(style, sig);
  const get = memo ? memoize(call, (kind, style, sig) => `${kind}|${sig}|${style.geometryHash}`) : call;
  const markerCache = new Map<string, string | null>();
  return {
    classes: {
      needsSignature: true,
      shapeClasses: (style, sig) => get('s', style, sig),
      textClasses: (style, sig) => get('t', style, sig),
      plateClasses: (style, sig) => get('p', style, sig),
      emit: () => table.emit(),
    },
    markers: {
      add(arrowhead, color, size, start, sig) {
        if (!memo) return markerTable.add(arrowhead, color, size, start, sig);
        const k = `${arrowhead}|${color}|${size}|${start}|${sig}`;
        if (!markerCache.has(k)) markerCache.set(k, markerTable.add(arrowhead, color, size, start, sig));
        return markerCache.get(k) as string | null;
      },
      emit: () => markerTable.emit(),
    },
  };
}
