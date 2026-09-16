/**
 * The config key registry (DD-02 §7) — one table driving resolver validation
 * (`SGL2010`–`SGL2012`), `toJson` emission order, and (later) autocomplete.
 *
 * `shape` and `direction` are typed `enum` for documentation only: whether a
 * value is a *valid* shape is a theme/render concern (`SGL3001`, DD-03/DD-07),
 * not a resolver one, so `validateConfigKey` never rejects an enum value here.
 */

import type { ConfigKeySpec } from './model.js';

const ALL_SCOPES: readonly ConfigKeySpec['scope'][number][] = ['root', 'node', 'edge', 'class'];

export const CONFIG_REGISTRY: readonly ConfigKeySpec[] = [
  { key: 'sgl', scope: ['root'], type: 'string', order: 0 },
  { key: 'title', scope: ['root'], type: 'string', order: 1 },
  { key: 'theme', scope: ['root'], type: 'string', order: 2 },
  { key: 'layout', scope: ['root', 'node'], type: 'object', order: 3 },
  { key: 'layout.*', scope: ['node', 'edge'], type: 'any', order: 3 },
  { key: 'classes', scope: ['root'], type: 'object', order: 4 },
  { key: 'label', scope: ['node', 'edge', 'class'], type: 'string', order: 5 },
  { key: 'type', scope: ['node', 'edge'], type: 'array', order: 6 },
  {
    key: 'shape',
    scope: ['node', 'class'],
    type: 'enum',
    enum: ['rect', 'round', 'circle', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'cloud', 'document', 'actor', 'package', 'note'],
    order: 7,
  },
  // Sugar for `@layout.direction`: valid wherever `@layout` itself is (root's
  // document-level block, language spec §4, as well as a node's own).
  { key: 'direction', scope: ['root', 'node'], type: 'enum', enum: ['down', 'up', 'left', 'right'], order: 8 },
  // Real validation of a style value is DD-04's job (theme cascade); a
  // bareword like `dashed` is a valid shorthand the corpus actually uses
  // (`checkout.sgl`, `chains.sgl`), so the resolver never rejects `@style`.
  { key: 'style', scope: ['node', 'edge', 'class'], type: 'any', order: 9 },
  { key: 'size', scope: ['node', 'class'], type: 'object', order: 10 },
  { key: 'ports', scope: ['node', 'class'], type: 'object', order: 11 },
  { key: 'order', scope: ['node', 'edge'], type: 'number', order: 12 },
  { key: 'hidden', scope: ['node', 'edge'], type: 'boolean', order: 13 },
  { key: 'link', scope: ['node', 'edge'], type: 'string', order: 14 },
  { key: 'tooltip', scope: ['node', 'edge'], type: 'string', order: 15 },
  { key: 'a11y', scope: ['node', 'edge'], type: 'object', order: 16 },
  { key: 'meta', scope: ALL_SCOPES, type: 'any', order: 17 },
] as const;

/** Every row whose bag-key this registry key matches — `'layout'` and `'layout.*'`
 *  both answer for the top-level bag key `'layout'`. */
export function rowsForKey(key: string): readonly ConfigKeySpec[] {
  return CONFIG_REGISTRY.filter((row) => row.key === key || row.key === `${key}.*`);
}

/** `toJson`'s emission order (DD-02 §6): registry order first, then anything
 *  the registry does not know about, which keeps its own first-seen order. */
export function configKeyOrder(key: string): number {
  const rows = rowsForKey(key);
  return rows.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...rows.map((r) => r.order));
}

export type ConfigValidation =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'unknown' } // SGL2010 — kept
  | { readonly outcome: 'bad-scope' } // SGL2012 — dropped
  | { readonly outcome: 'bad-type'; readonly expected: string }; // SGL2011 — dropped

const matchesType = (type: ConfigKeySpec['type'], value: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'enum':
    case 'any':
      return true;
  }
};

/** Validate one top-level config-bag key against the registry (DD-02 §7). */
export function validateConfigKey(
  key: string,
  value: unknown,
  scope: ConfigKeySpec['scope'][number],
): ConfigValidation {
  const rows = rowsForKey(key);
  if (rows.length === 0) return { outcome: 'unknown' };
  if (!rows.some((row) => row.scope.includes(scope))) return { outcome: 'bad-scope' };
  const inScope = rows.filter((row) => row.scope.includes(scope));
  if (inScope.some((row) => matchesType(row.type, value))) return { outcome: 'ok' };
  return { outcome: 'bad-type', expected: inScope.map((row) => row.type).join(' or ') };
}
