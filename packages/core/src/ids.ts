/** Branded ID types (DD-00 §3). Plain strings at runtime, distinct at the type level. */

export type NodeId = string & { readonly __brand: 'NodeId' };
export type EdgeId = string & { readonly __brand: 'EdgeId' };
export type LabelId = string & { readonly __brand: 'LabelId' };
export type PortId = string & { readonly __brand: 'PortId' };

/** Built-in shapes the MVP renderer can draw (DD-07 §4). Unknown values fall back
 *  to `rect` with an SGL3001 warning, so this is not a closed set at the language level. */
export type ShapeId =
  | 'rect'
  | 'round'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'cylinder'
  | 'package'
  | (string & {});

/** The same seven names as `ShapeId`'s closed members, as a runtime set Stage C
 *  checks a resolved `@shape` value against (DD-03 §4): drawable → kept, a name
 *  from the language's twelve-shape vocabulary (`LANGUAGE_SHAPES`,
 *  `config-registry.ts`) that isn't one of these seven → `SGL3006` ("not drawn
 *  yet"), anything else → `SGL3001` ("unknown"), both falling back to `rect`.
 *  `@sgl/render-svg`'s shape modules (DD-07 §4) are the one-true source this
 *  mirrors; kept here rather than imported from a package `@sgl/core` may not
 *  depend on. */
export const DRAWABLE_SHAPES: ReadonlySet<string> = new Set<ShapeId>([
  'rect',
  'round',
  'ellipse',
  'diamond',
  'hexagon',
  'cylinder',
  'package',
]);

/** The shape a node gets when neither it nor any of its classes sets `@shape`,
 *  and the fallback for `SGL3001`/`SGL3006` (DD-03 §4). One definition, which
 *  `compile.ts`, `@sgl/render-svg`'s `resolveShape` and the help reference
 *  (DD-13 P5, P7) all read. */
export const DEFAULT_SHAPE = 'rect' satisfies ShapeId;

export const asNodeId = (s: string): NodeId => s as NodeId;
export const asEdgeId = (s: string): EdgeId => s as EdgeId;
export const asLabelId = (s: string): LabelId => s as LabelId;
export const asPortId = (s: string): PortId => s as PortId;

/**
 * Path segments joined by `.`, with a literal `\` or `.` inside a segment
 * escaped as `\\` / `\.` (DD-03 §2.1). The backslash is escaped first so the
 * dot-escape's own backslash is never mistaken for one that was already
 * there. Root (`path.length === 0`) is the empty string — DD-03 says root is
 * never a node, but `resolve()` uses the same joining rule for its span-table
 * key on the root container, so the empty case is defined here too.
 *
 * The one function both `resolve()` (span-table keys) and Stage C (`NodeId`
 * proper) build a path string from, so the two can never drift apart.
 */
export const nodeIdFromPath = (path: readonly string[]): string =>
  path.map((seg) => seg.replace(/\\/g, '\\\\').replace(/\./g, '\\.')).join('.');
