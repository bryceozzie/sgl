import { parse, resolve } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { layoutConfigDiagnostics, rootLayoutOptions, type EngineSchemas } from '../src/layout-config.js';

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

  it('(b) at the root, a key must be an option: the root has no hints (DD-12 H6)', () => {
    expect(run('@layout: { priority: 2, span: 2 }\n@layout.rank: same\na\n', ELK).map((d) => d.text)).toEqual(['priority', 'span', '@layout.rank']);
    expect(run('@layout: { span: 2, columns: 3 }\na\n', GRID).map((d) => d.message)).toEqual(['`@layout.span` is not an option of engine `sgl.grid`; ignored.']);
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

describe('layoutConfigDiagnostics (SGL4021, DD-12 N6)', () => {
  const PINNING: EngineSchemas = { ...GRID, id: 'sgl.fixed', pins: true };
  const froms = (src: string, engine: EngineSchemas): number[] =>
    layoutConfigDiagnostics(parse(src).ast, engine).map((d) => d.span.from);

  it('a node @pin under an engine without the pins capability warns once, at the key', () => {
    const src = 'a: { @pin: { x: 1, y: 2 } }\nb: "B"\n';
    expect(run(src, ELK)).toEqual([
      { code: 'SGL4021', severity: 'warning', text: '@pin', message: '`@pin` is not honoured by engine `sgl.elk`; ignored.' },
    ]);
    expect(run(src, GRID).map((d) => d.message)).toEqual(['`@pin` is not honoured by engine `sgl.grid`; ignored.']);
  });

  it('an engine that declares `pins: true` is not warned about; `pins: false` or absent is', () => {
    const src = 'a: { @pin: { x: 1, y: 2 } }\n';
    expect(run(src, PINNING)).toEqual([]);
    expect(run(src, { ...PINNING, pins: false }).map((d) => d.code)).toEqual(['SGL4021']);
    expect(run(src, { id: 'org.example.x' }).map((d) => d.code)).toEqual(['SGL4021']);
  });

  it('one warning per node, at its first pin key, however the pin is spelled; containers and their children each count', () => {
    const src = 'a: {\n  @pin.x: 1\n  @pin.y: 2\n}\nbox: {\n  @pin: $p\n  inner: { @pin: { x: 0, y: 0 } }\n}\n';
    expect(froms(src, ELK)).toEqual([src.indexOf('@pin.x'), src.indexOf('@pin: $p'), src.indexOf('@pin: { x: 0')]);
    expect(run(src, ELK).map((d) => d.text)).toEqual(['@pin.x', '@pin', '@pin']);
  });

  it("a pin on the root, a class or an edge is not SGL4021 (it is the resolver's SGL2012)", () => {
    expect(run('@pin: { x: 1, y: 2 }\n@classes: { P: { @pin: { x: 1, y: 2 } } }\na: P\nb: "B"\na -> b: { @pin: { x: 1, y: 2 } }\n', ELK)).toEqual([]);
  });

  // Fix round 1, item 6: a pin the resolver dropped (SGL2011) is reported once, by the resolver.
  describe('a pin the resolver dropped', () => {
    const withResolver = (src: string, engine: EngineSchemas) => {
      const { ast } = parse(src);
      return layoutConfigDiagnostics(ast, engine, resolve(ast).diagnostics).map((d) => [d.code, src.slice(d.span.from, d.span.to)]);
    };

    it.each([
      ['y missing', 'a: { @pin: { x: 10 } }\n'],
      ['dotted, y missing', 'a: {\n  @pin.x: 10\n}\n'],
      ['out of range through a variable', '@vars: { far: { x: 1000000, y: 0 } }\na: { @pin: $far }\n'],
      ['not an object', 'a: { @pin: 5 }\n'],
    ])('%s: no SGL4021', (_, src) => {
      expect(withResolver(src, ELK)).toEqual([]);
    });

    it('only the node whose pin was dropped is skipped', () => {
      expect(withResolver('a: { @pin: { x: 10 } }\nb: { @pin: { x: 1, y: 2 } }\n', ELK)).toEqual([['SGL4021', '@pin']]);
      const src = 'a: { @pin: { x: 10 } }\nb: { @pin: { x: 1, y: 2 } }\n';
      expect(layoutConfigDiagnostics(parse(src).ast, ELK, resolve(parse(src).ast).diagnostics)[0]!.span.from).toBe(src.indexOf('@pin: { x: 1,'));
    });

    it('without the resolver\'s diagnostics every pin key counts, as before', () => {
      expect(run('a: { @pin: { x: 10 } }\n', ELK).map((d) => d.code)).toEqual(['SGL4021']);
    });
  });

  // Fix round 1, item 7: one SGL4021 per node, not per declaration.
  it('a node declared twice warns once, at its first pin key in source order', () => {
    const src = 'a: { @pin: { x: 1, y: 2 } }\nb: "B"\na: { @pin: { x: 3, y: 4 } }\nbox: {\n  c: { @pin.x: 0, @pin.y: 0 }\n}\nbox: {\n  c: { @pin: { x: 5, y: 5 } }\n  @pin: { x: 9, y: 9 }\n}\n';
    expect(froms(src, ELK)).toEqual([src.indexOf('@pin'), src.indexOf('@pin.x'), src.indexOf('@pin: { x: 9')].sort((p, q) => p - q));
  });

  it('two nodes with the same key under different parents are different nodes', () => {
    expect(froms('p: { a: { @pin: { x: 1, y: 2 } } }\nq: { a: { @pin: { x: 1, y: 2 } } }\n', ELK)).toHaveLength(2);
  });

  it('a document without a pin gets none', () => {
    expect(run('a: { @size: { width: 10 } }\nb: "B"\na -> b\n', ELK)).toEqual([]);
  });
});

/**
 * DD-12 H6 (N40): the root `@layout` keys other than `engine` are options of
 * the effective engine, and reach it. The resolver's side of the seam: the
 * resolved root bag in, the options for the host out.
 */
describe('rootLayoutOptions (DD-12 H6)', () => {
  function options(source: string, engine: EngineSchemas) {
    const { ast } = parse(source);
    const r = rootLayoutOptions(ast, resolve(ast).model.root.config, engine);
    return { options: r.options, diagnostics: r.diagnostics.map((d) => [d.code, d.severity, source.slice(d.span.from, d.span.to), d.message]) };
  }

  it('every root key the engine declares as an option, and not `engine`, in every spelling', () => {
    expect(options('@layout: { engine: "elk", direction: right }\na\n', ELK)).toEqual({ options: { direction: 'right' }, diagnostics: [] });
    expect(options('@layout.nodeSpacing: 30\n@direction: up\na\n', ELK).options).toEqual({ direction: 'up', nodeSpacing: 30 });
    expect(options('@vars: { g: 8 }\n@layout: { columns: 3, gap: $g, align: start }\na\n', GRID).options).toEqual({ align: 'start', columns: 3, gap: 8 });
  });

  it('a key the engine does not declare is not sent (it is SGL4010), nor is a hint, nor a container key', () => {
    expect(options('@layout: { columns: 3, priority: 2 }\nbox: {\n  @layout.direction: up\n  a\n}\n', ELK)).toEqual({ options: {}, diagnostics: [] });
    expect(options('@layout: { direction: right }\na\n', GRID).options).toEqual({});
  });

  it('an engine without an options schema, or a document without a root @layout, gets none', () => {
    expect(options('@layout: { anything: 1 }\na\n', { id: 'org.example.x' })).toEqual({ options: {}, diagnostics: [] });
    expect(options('a\n', ELK)).toEqual({ options: {}, diagnostics: [] });
  });

  it("a value the engine's `accepts` refuses is SGL2011 at the key that set it, and not sent", () => {
    const accepts = (key: string, value: unknown) => key !== 'nodeSpacing' || (typeof value === 'number' && value <= 500);
    const r = options('@layout: { direction: left, nodeSpacing: 900 }\na\n', { ...ELK, accepts });
    expect(r.options).toEqual({ direction: 'left' });
    expect(r.diagnostics).toEqual([['SGL2011', 'warning', 'nodeSpacing', '`@layout.nodeSpacing` expects a value engine `sgl.elk` accepts; ignored.']]);
    // Set twice: the later one wins, so it is the one reported.
    const src = '@layout.nodeSpacing: 20\n@layout: { nodeSpacing: -1 }\na\n';
    expect(options(src, { ...ELK, accepts: (_k, v) => typeof v === 'number' && v >= 0 }).diagnostics.map((d) => d[2])).toEqual(['nodeSpacing']);
  });

  it('keys come out sorted, so the request is the same however the document orders them', () => {
    expect(Object.keys(options('@layout: { rankSpacing: 9, direction: up, nodeSpacing: 3 }\na\n', ELK).options)).toEqual(['direction', 'nodeSpacing', 'rankSpacing']);
  });
});
