import { parse } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import { BUILT_IN } from '@sgl/theme';
import { layoutWrapped } from '@sgl/text/wrap';
import { describe, expect, it } from 'vitest';
import { compileHelpDir } from '../build/help-plugin.js';
import type { ExampleSpec } from '../src/help/content.js';
import { DEFAULT_ENGINE_ID, REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { createImportsRuntime } from '../src/state/imports.js';
import { createMemoryStore } from '../src/state/storage.js';
import { examplesOf } from './help-check.js';
import { createHarness, HARNESS_ENGINES } from './harness.js';

/**
 * DD-13 P18 (help branch 2): every example in the help runs through the
 * app's own pipeline (`createPipeline`, via `harness.ts`, with every engine
 * the worker registers, run in process through `runHostSequence`), with the
 * app's own `engineSchemas`, rich text and imports runtime, under its engine
 * and each of the four built-in themes:
 *
 * - the multiset of diagnostic codes equals its `expect`;
 * - it renders (`lastGood` is set), unless `preview=false`, which must then
 *   really not render;
 * - its `contains` is in the SVG;
 * - a second run gives the same SVG (DD-00 §3);
 * - a root `@layout` needs `engine=`, and the two agree (P27).
 *
 * Every snippet parses with no `SGL1xxx`.
 */

const THEMES = Object.keys(BUILT_IN).sort();
const content = compileHelpDir();
const all = content.entries.flatMap((e) => examplesOf(e));
const examples = all.filter((x) => x.mode === 'example');
const snippets = all.filter((x) => x.mode === 'snippet');

interface Run {
  readonly codes: readonly string[];
  readonly svg: string | undefined;
  readonly rootLayout: boolean;
  readonly documentEngineId: string | undefined;
}

async function run(x: ExampleSpec, themeId: string): Promise<Run> {
  const h = await createHarness(
    x.source,
    {
      defaultEngineId: engineIdOf(x),
      defaultThemeId: themeId,
      engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id),
      loadRichText: async () => ({ inline: parseInline, lineModel: layoutWrapped }),
      loadImports: () => createImportsRuntime(createMemoryStore(), undefined),
    },
    { firstRender: false },
  );
  try {
    await h.settle();
    const p = h.pipeline;
    expect(p.pipelineError.value, `${x.id}: pipeline error`).toBeNull();
    return {
      codes: p.diags.value.map((d) => d.code).sort(),
      svg: p.lastGood.value?.svg,
      rootLayout: p.model.value.model.root.config.layout !== undefined,
      documentEngineId: p.documentEngineId.value,
    };
  } finally {
    h.dispose();
  }
}

const engineIdOf = (x: ExampleSpec): string => (x.engine === undefined ? DEFAULT_ENGINE_ID : `sgl.${x.engine}`);

describe('help examples (DD-13 P18)', () => {
  it('there are examples and snippets to check (not vacuous)', () => {
    expect(examples.length).toBeGreaterThan(20);
    expect(snippets.length).toBeGreaterThan(0);
  });

  it('the harness lays out with every engine the worker registers', () => {
    expect(HARNESS_ENGINES.map((e) => e.id)).toEqual(REGISTERED_ENGINES.map((e) => e.id));
  });

  it.each(examples.map((x) => [x.id, x] as const))('%s', async (_id, x) => {
    expect(REGISTERED_ENGINES.map((e) => e.id), `${x.id}: engine`).toContain(engineIdOf(x));
    for (const themeId of THEMES) {
      const first = await run(x, themeId);
      const where = `${x.id} under ${themeId}`;
      expect(first.codes, `${where}: diagnostics`).toEqual([...x.expect].sort());
      if (x.preview) expect(first.svg, `${where}: it renders`).toBeDefined();
      else expect(first.svg, `${where}: preview=false, so it must not render`).toBeUndefined();
      if (x.contains !== undefined) expect(first.svg, `${where}: contains`).toContain(x.contains);
      if (first.rootLayout) {
        expect(x.engine, `${x.id}: a root @layout needs engine= (DD-13 P27)`).toBeDefined();
        if (first.documentEngineId !== undefined) expect(first.documentEngineId, `${x.id}: @layout.engine and engine= agree`).toBe(engineIdOf(x));
      }
      const second = await run(x, themeId);
      expect(second.svg, `${where}: a second run gives the same SVG`).toBe(first.svg);
    }
  }, 60_000);

  it.each(snippets.map((x) => [x.id, x] as const))('%s parses with no SGL1xxx', (_id, x) => {
    expect(parse(x.source).diagnostics.map((d) => d.code).filter((c) => c.startsWith('SGL1'))).toEqual([]);
  });
});
