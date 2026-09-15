import { NotImplemented, type SemanticGraph, type StageResult } from '@sgl/core';
import type { ResolvedTheme, StyledGraph, ThemeDoc } from './types.js';

/** Resolve a theme document: follow `extends`, resolve `@token` references,
 *  normalise insets, dashes and lengths. Design: DD-04 §3. */
export function resolveTheme(
  doc: ThemeDoc,
  lookup: (id: string) => ThemeDoc | undefined,
): StageResult<ResolvedTheme> {
  void doc;
  void lookup;
  throw new NotImplemented('resolveTheme()', 'DD-04 §3');
}

/**
 * Apply the cascade per element and compute the two hashes.
 *
 * Pure and synchronous. Two `StyledGraph`s with equal `geometryHash` produce
 * identical layout inputs, which is what lets the application skip re-layout on a
 * paint-only change (DD-08 §3).
 *
 * Design: DD-04 §4, §5.
 */
export function styleGraph(graph: SemanticGraph, theme: ResolvedTheme): StageResult<StyledGraph> {
  void graph;
  void theme;
  throw new NotImplemented('styleGraph()', 'DD-04 §4');
}
