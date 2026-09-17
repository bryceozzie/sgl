import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compile,
  parse,
  resolve,
  type ClassModel,
  type Diagnostic,
  type SemanticGraph,
} from '@sgl/core';
import { resolveTheme, styleGraph } from '../src/cascade.js';
import { BUILT_IN, neutralLight } from '../src/themes/index.js';
import type { StyledGraph, ThemeDoc } from '../src/types.js';

// ---------------------------------------------------------------------------
// Stage D (07 §5): a corpus document name -> a real StyledGraph, so cascade.test.ts
// and measure.test.ts stop asserting against hand-built graph literals that predate
// a working compiler. Not exported from the package (`files: ["dist"]` never picks
// this up) — it is a dev-only fixture module for the two packages downstream of
// @sgl/core, not a shipped export.
// ---------------------------------------------------------------------------

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));

export const corpusSource = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');

/** Every `.sgl`/`.sgl.json` file anywhere under `corpus/`, including `malformed/`,
 *  `unresolved/` and `injection/` — the whole-corpus invariant this stage's gate
 *  needs (DD-00 §6: pre-measure covers 100% of labels in the corpus) has to hold
 *  even over a partial graph, since `parse`/`resolve`/`compile` never throw. */
export function listCorpusDocs(): readonly string[] {
  const walk = (dir: string, rel = ''): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...walk(`${dir}${entry.name}/`, `${rel}${entry.name}/`));
      else if (entry.name.endsWith('.sgl') || entry.name.endsWith('.sgl.json')) out.push(`${rel}${entry.name}`);
    }
    return out;
  };
  return walk(corpusDir);
}

export interface CorpusGraph {
  readonly graph: SemanticGraph;
  /** `model.classes`, so a caller can drive `styleGraph`'s `documentClasses` param
   *  with the same linearised classes `compile()` actually saw. */
  readonly classes: Readonly<Record<string, ClassModel>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** `parse -> resolve -> compile` over a corpus document — the front end Gate 1 proved. */
export function corpusGraph(name: string): CorpusGraph {
  const { ast, diagnostics: parseDiags } = parse(corpusSource(name));
  const { model, diagnostics: resolveDiags } = resolve(ast);
  const { graph, diagnostics: compileDiags } = compile(model);
  return { graph, classes: model.classes, diagnostics: [...parseDiags, ...resolveDiags, ...compileDiags] };
}

const BUILT_IN_LOOKUP = (id: string): ThemeDoc | undefined => BUILT_IN[id];

export interface CorpusStyledGraph {
  readonly styled: StyledGraph;
  readonly diagnostics: readonly Diagnostic[];
}

/** `parse -> resolve -> compile -> resolveTheme -> styleGraph` over a corpus document,
 *  under a built-in theme (`neutral-light` by default). */
export function corpusStyledGraph(name: string, theme: ThemeDoc = neutralLight): CorpusStyledGraph {
  const { graph, classes, diagnostics: graphDiags } = corpusGraph(name);
  const { value: resolvedTheme, diagnostics: themeDiags } = resolveTheme(theme, BUILT_IN_LOOKUP);
  const { value: styled, diagnostics: styleDiags } = styleGraph(graph, resolvedTheme, classes);
  return { styled, diagnostics: [...graphDiags, ...themeDiags, ...styleDiags] };
}
