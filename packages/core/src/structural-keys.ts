/**
 * The two `@` keys the resolver handles itself, beside the config registry
 * (DD-13 P5): they shape the document model rather than sit in a config bag,
 * so they have no `CONFIG_REGISTRY` row, and `validateConfigKey` never sees
 * them in the scope where they mean something.
 *
 * - `@extends` in a class body: the classes this one extends (DD-02 §4),
 *   pulled out into `ClassModel.extends`.
 * - `@edges` on the root or a container: the canonical JSON form of that
 *   container's edges (DD-02 §6, language spec §9). An author rarely writes it;
 *   `toJson` does.
 *
 * `resolve.ts` matches on `EXTENDS_KEY` and `EDGES_KEY`, so this table and the
 * resolver name the same keys. The help reference (DD-13) and, later,
 * autocomplete (E6) read the table.
 *
 * Its own module rather than a row type in `config-registry.ts`, so a change
 * to either does not touch the other.
 */

import type { ConfigKeySpec } from './model.js';

export const EXTENDS_KEY = 'extends';
export const EDGES_KEY = 'edges';

export interface StructuralKeySpec {
  readonly key: string;
  readonly scope: readonly ConfigKeySpec['scope'][number][];
  readonly type: 'array';
  /** Written by `toJson`'s canonical form; an author rarely writes it. */
  readonly canonicalOnly?: true;
}

export const STRUCTURAL_KEYS: readonly StructuralKeySpec[] = [
  { key: EXTENDS_KEY, scope: ['class'], type: 'array' },
  { key: EDGES_KEY, scope: ['root', 'node'], type: 'array', canonicalOnly: true },
];
