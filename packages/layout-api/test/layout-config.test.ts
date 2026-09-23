import { parse } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { layoutConfigDiagnostics, type EngineSchemas } from '../src/layout-config.js';

/**
 * SGL4010 (Stage K fix round 1, item 23 — human decision 2026-09-23): a
 * container-level `@layout.engine` (per-container engines are B8/B9) and any
 * `@layout.{key}` the effective engine does not declare are warned about,
 * at the key, and ignored.
 */

const ELK: EngineSchemas = {
  id: 'sgl.elk',
  optionsSchema: { properties: { direction: {}, nodeSpacing: {}, rankSpacing: {}, edgeRouting: {}, nodePlacement: {} } },
  hintsSchema: { properties: { rank: {}, priority: {}, portConstraints: {} } },
};
const GRID: EngineSchemas = {
  id: 'sgl.grid',
  optionsSchema: { properties: { columns: {}, gap: {}, align: {} } },
  hintsSchema: { properties: { columns: {}, span: {} } },
};

function run(source: string, engine: EngineSchemas) {
  return layoutConfigDiagnostics(parse(source).ast, engine).map((d) => ({
    code: d.code,
    severity: d.severity,
    text: source.slice(d.span.from, d.span.to),
    message: d.message,
  }));
}

describe('layoutConfigDiagnostics (SGL4010)', () => {
  it('(a) a container-level @layout.engine other than the effective engine warns, at the key, in every spelling', () => {
    const src = 'box: {\n  @layout: { engine: grid }\n  a\n}\nother: {\n  @layout.engine: "sgl.grid"\n  b\n}\n';
    expect(run(src, ELK)).toEqual([
      { code: 'SGL4010', severity: 'warning', text: 'engine', message: '`@layout.engine` is not an option of engine `sgl.elk`; ignored.' },
      { code: 'SGL4010', severity: 'warning', text: '@layout.engine', message: '`@layout.engine` is not an option of engine `sgl.elk`; ignored.' },
    ]);
  });

  it("(a) naming the effective engine itself, or setting it at the root, is not a warning", () => {
    expect(run('@layout.engine: "sgl.elk"\nbox: {\n  @layout: { engine: elk }\n  a\n}\n', ELK)).toEqual([]);
    expect(run('@layout: { engine: grid }\na\n', ELK)).toEqual([]);
  });

  it("(b) a key the effective engine does not declare warns, at root and on containers", () => {
    expect(run('@layout: { columns: 3 }\nbox: {\n  @layout.gap: 4\n  a\n}\n', ELK).map((d) => [d.text, d.message])).toEqual([
      ['columns', '`@layout.columns` is not an option of engine `sgl.elk`; ignored.'],
      ['@layout.gap', '`@layout.gap` is not an option of engine `sgl.elk`; ignored.'],
    ]);
    // `@direction` is sugar for `@layout.direction` (language spec §4).
    expect(run('@direction: right\na\n', GRID).map((d) => d.message)).toEqual(['`@layout.direction` is not an option of engine `sgl.grid`; ignored.']);
  });

  it('(b) declared options and hints are fine', () => {
    expect(run('@layout: { direction: right, nodeSpacing: 30 }\nbox: {\n  @layout.priority: 2\n  a\n}\n', ELK)).toEqual([]);
    expect(run('@layout: { columns: 3, gap: 8 }\nbox: {\n  @layout.columns: 2\n  a\n}\n', GRID)).toEqual([]);
  });

  it('an engine the app does not know: only (a) is checked', () => {
    expect(run('@layout: { anything: 1 }\nbox: {\n  @layout.engine: grid\n  a\n}\n', { id: 'org.example.x' }).map((d) => d.text)).toEqual([
      '@layout.engine',
    ]);
  });
});
