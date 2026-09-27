import type { CompileOptions, Diagnostic, LabelId, Size } from '@sgl/core';
import { compile, parse, resolve } from '@sgl/core';
import { compileImports, createImportLinker, resolveImports } from '@sgl/core/imports';
import { parseInline } from '@sgl/core/inline';
import {
  applyHostFallbacks,
  buildLayoutInput,
  engineNotes,
  layoutConfigDiagnostics,
  quantize,
  validateResult,
  type LayoutContext,
  type LayoutEngine,
  type LayoutInput,
  type LayoutResult,
  type ResolvedThemeMetricsView,
  type StyledGraphInput,
} from '@sgl/layout-api';
import { fixedEngine, gridEngine } from '@sgl/layout-std';
import { labelRunKey, premeasure, StaticMetricsMeasurer, type MeasureTable } from '@sgl/measure';
import { layoutWrapped } from '@sgl/text/wrap';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, unknownThemeDiagnostics, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { fileSystemHost } from '../../core/test/fs-host.js';
import { corpusPath, corpusSource, listCorpusDocs } from '../../theme/test/corpus.js';
import { render, type RenderResult } from '../src/index.js';

export { corpusPath, corpusSource, listCorpusDocs };

/** A18: the corpus documents that hold markdown or wrap, which the rich
 *  pipeline (`INLINE`: compile with `@sgl/core/inline`) draws with marks and
 *  soft breaks (DD-11 T42–T47, T58). */
export const RICH_DOCS: readonly string[] = ['multiline.sgl', 'text/markdown.sgl', 'text/wrap.sgl', 'injection/markdown-in-label.sgl'];
export const INLINE: CompileOptions = { inline: parseInline };

/**
 * `source -> RenderResult`: `parse -> resolve -> compile -> resolveTheme ->
 * styleGraph -> premeasure -> grid -> route/label/quantize -> validateResult
 * -> render`. This is Stage G's own "one function, source to RenderResult,
 * running synchronously in Node" harness (07-execution-plan.md §5) — formalised
 * here from the version Stage F wrote early (as `renderCorpusDoc`, corpus-file
 * only) because Stage F needed it to golden-test the renderer against real
 * geometry rather than a hand-built `LayoutView`. "Synchronously" means no
 * Worker and no `postMessage` round trip, not literally no `Promise`:
 * `LayoutEngine.layout` is `async` by the frozen `@sgl/layout-api` contract, so
 * this awaits it in-process exactly as a synchronous call site would.
 *
 * Uses `StaticMetricsMeasurer` (deterministic, no canvas) so this runs under
 * Node exactly like CI — the same choice `grid.test.ts` makes.
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

const ctxWith = (options: Readonly<Record<string, unknown>>): LayoutContext => ({
  options,
  metrics: METRICS,
  measure: {
    layoutRuns(): never {
      throw new Error('neither grid nor elk asks the host to measure a label it created.');
    },
    layoutRunsAsync(): never {
      throw new Error('neither grid nor elk asks the host to measure a label it created.');
    },
  },
  random: () => 0,
  signal: new AbortController().signal,
  log: () => {},
  sublayout(): never {
    throw new Error('sublayout is reserved, not implemented (DD-06 §2).');
  },
});

export interface RenderedDoc {
  readonly styled: StyledGraph;
  readonly input: LayoutInput;
  readonly result: LayoutResult;
  /** The pre-measure table the layout was sized from (A18: the seam test). */
  readonly table: MeasureTable;
  readonly theme: ResolvedTheme;
  readonly rendered: RenderResult;
  /** Every diagnostic from every stage — parse, resolve, compile, resolveTheme,
   *  styleGraph, validateResult, render — not just the renderer's own slice
   *  (`rendered.diagnostics`). A "clean" corpus document (no *error*
   *  diagnostics) can still carry warnings downstream of compile(): checkout.sgl's
   *  root `@layout.direction` is `SGL4010` under `grid`, which does not declare
   *  it. This field is what the pipeline-level "no unexpected diagnostics"
   *  gate (Stage G) and the diagnostics coverage gate's theme/renderer half
   *  (`diagnostics-coverage.test.ts`) both read. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Lay a `StyledGraph` out under the host pipeline (DD-06 §4, §5) —
 *  `applyHostFallbacks`, the worker runtime's own sequence, which for `grid`
 *  (`labelPlacement: false, edgeRouting: 'straight'`, no edges of its own) is
 *  exactly `grid.test.ts`'s `routeStraight -> placeLabels` — then
 *  `validateResult` (DD-06 §4), so a corrupt engine result is guarded before
 *  the renderer ever sees it, exactly as the design intends. `engine`
 *  defaults to `grid`, which every golden here is taken under; Stage K passes
 *  `elk` for its engine-switch property. */
async function layOut(
  styled: StyledGraph,
  engine: LayoutEngine,
  options: Readonly<Record<string, unknown>>,
): Promise<{ readonly input: LayoutInput; readonly result: LayoutResult; readonly table: MeasureTable; readonly diagnostics: readonly Diagnostic[] }> {
  const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const input = buildLayoutInput(styled as StyledGraphInput, labelSizes);
  const raw = await engine.layout(input, ctxWith(options));
  const result = quantize(applyHostFallbacks(input, raw, engine.capabilities, METRICS), 64);
  // DD-12 N20: the engine's own notes, checked and rebuilt as the host does.
  const diagnostics = validateResult(result, styled.graph, engine.id);
  return { input, result, table, diagnostics: [...diagnostics, ...engineNotes(raw.notes)] };
}

/** The whole pipeline, `source -> RenderResult`, under one theme. Calls the
 *  engine directly, in-process — no worker (Stage G). With `path`, the
 *  document's file, `@imports` are linked by the file-system host against
 *  its directory (A9, `corpus/imports/`), through the import-aware resolve
 *  and compile, as the app does for a document with `@imports`. */
/** The engines this harness can run: `grid`, every golden's engine, and
 *  `fixed` (feat/b5-fixed). */
const HARNESS_ENGINES: readonly LayoutEngine[] = [gridEngine, fixedEngine];

/** The engine a document names at its root `@layout.engine`, by id or bare
 *  name (DD-12 N22), when the harness has it; otherwise `grid`. So the pin
 *  fixtures that say `engine: fixed` run under `fixed`, and a document that
 *  names `elk` (`checkout.sgl`, `pin-under-elk.sgl`) still runs under `grid`,
 *  as every render golden was taken. */
export function harnessEngine(root: Readonly<Record<string, unknown>>): LayoutEngine {
  const layout = root['layout'];
  const named = typeof layout === 'object' && layout !== null && !Array.isArray(layout) ? (layout as Record<string, unknown>)['engine'] : undefined;
  return HARNESS_ENGINES.find((e) => named === e.id || `sgl.${String(named)}` === e.id) ?? gridEngine;
}

export async function runPipeline(
  source: string,
  themeDoc: ThemeDoc = neutralLight,
  engineArg?: LayoutEngine,
  options: Readonly<Record<string, unknown>> = {},
  path?: string,
  compileOptions?: CompileOptions,
): Promise<RenderedDoc> {
  const { ast, diagnostics: d1 } = parse(source);
  const linker = path === undefined ? undefined : createImportLinker(fileSystemHost(path), { self: path });
  const { model, diagnostics: d2 } = linker === undefined ? resolve(ast) : resolveImports(ast, linker);
  const { graph, diagnostics: d3 } = linker === undefined ? compile(model, undefined, compileOptions) : compileImports(model, undefined, compileOptions);
  const engine = engineArg ?? harnessEngine(model.root.config);
  // SGL4010 (Stage K fix round 1, item 23) and SGL4021 (DD-12 N6), as the
  // app's pipeline emits them: the document's `@layout` keys and `@pin`s
  // against the engine laying it out.
  const d3b = layoutConfigDiagnostics(ast, {
    id: engine.id,
    ...(engine.optionsSchema && { optionsSchema: engine.optionsSchema }),
    ...(engine.hintsSchema && { hintsSchema: engine.hintsSchema }),
    ...(engine.capabilities.pins === true && { pins: true }),
  }, d2);
  // SGL5007 (F31), as the app's pipeline emits it: the document's own
  // `@theme` names no built-in theme. The harness draws in `themeDoc` either way.
  const d3c = unknownThemeDiagnostics(ast, model);
  const { value: theme, diagnostics: d4 } = resolveTheme(themeDoc, (id) => BUILT_IN[id]);
  const { value: styled, diagnostics: d5 } = styleGraph(graph, theme, model.classes);
  const { input, result, table, diagnostics: d6 } = await layOut(styled, engine, options);
  const rendered = render(styled, result, theme, table);
  return {
    styled,
    input,
    result,
    table,
    theme,
    rendered,
    diagnostics: [...d1, ...d2, ...d3, ...d3b, ...d3c, ...d4, ...d5, ...d6, ...rendered.diagnostics],
  };
}

/** The whole pipeline for one corpus document under one theme — `runPipeline`
 *  plus reading the fixture off disk. */
export async function renderCorpusDoc(name: string, themeDoc: ThemeDoc = neutralLight): Promise<RenderedDoc> {
  return runPipeline(corpusSource(name), themeDoc, undefined, undefined, corpusPath(name));
}
