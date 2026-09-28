import { parse, resolve } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { layoutConfigDiagnostics, layoutPlan, type EngineSchemas } from '../src/layout-config.js';

/**
 * DD-14 C6, C8–C12 (B8 branch 2): the main thread's layout plan, which
 * containers are boundaries, with which engine and which options, and the
 * `@layout` checks made scope-aware: a boundary's keys are its own engine's
 * options, a plain container's are the surrounding engine's hints, a pin is
 * judged by the engine that places the node, and an engine that is not
 * available on a container is `SGL4012`.
 */

const ELK: EngineSchemas = {
  id: 'sgl.elk',
  optionsSchema: {
    properties: {
      direction: { default: 'down' },
      nodeSpacing: { default: 40 },
      rankSpacing: { default: 70 },
      edgeRouting: { default: 'ORTHOGONAL' },
      nodePlacement: { default: 'BRANDES_KOEPF' },
    },
  },
  hintsSchema: { properties: { rank: {}, priority: {}, portConstraints: {} } },
};
const GRID: EngineSchemas = {
  id: 'sgl.grid',
  optionsSchema: { properties: { columns: { default: 'auto' }, gap: { default: 24 }, align: { default: 'center' } } },
  hintsSchema: { properties: { columns: {}, span: {} } },
  accepts: (key, value) => key !== 'columns' || value === 'auto' || (typeof value === 'number' && value >= 1 && value <= 50),
};
const FIXED: EngineSchemas = { id: 'sgl.fixed', optionsSchema: { properties: { gap: { default: 24 } } }, hintsSchema: { properties: {} }, pins: true };
const TREE: EngineSchemas = {
  id: 'sgl.tree',
  optionsSchema: { properties: { direction: { default: 'down' }, nodeSpacing: { default: 40 }, rankSpacing: { default: 70 }, edgeRouting: { default: 'orthogonal' } } },
  hintsSchema: { properties: { direction: {}, root: {} } },
};
const ENGINES = [ELK, GRID, FIXED, TREE];
const engines = (id: string): EngineSchemas | undefined => ENGINES.find((e) => e.id === id);
const ELK_OPTIONS = { direction: 'down', edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF', nodeSpacing: 40, rankSpacing: 70 };

function plan(source: string, root: { engine: string; options: Readonly<Record<string, unknown>> } = { engine: 'sgl.elk', options: ELK_OPTIONS }) {
  const { ast } = parse(source);
  const r = layoutPlan(ast, resolve(ast).model, root, engines);
  return {
    scopes: r.scopes.map((s) => ({ node: s.node, engine: s.engine, options: s.options, at: s.span === undefined ? undefined : source.slice(s.span.from, s.span.to) })),
    diagnostics: r.diagnostics.map((d) => [d.code, d.severity, source.slice(d.span.from, d.span.to), d.message]),
  };
}

/** `layoutConfigDiagnostics` with the plan's boundaries, as the app calls it. */
function checks(source: string, root: EngineSchemas = ELK) {
  const { ast } = parse(source);
  const { scopes, quiet } = layoutPlan(ast, resolve(ast).model, { engine: root.id, options: {} }, engines);
  const byNode = new Map(scopes.map((s) => [s.node as string, engines(s.engine)!]));
  return layoutConfigDiagnostics(ast, root, [], (id) => byNode.get(id), quiet).map((d) => [d.code, source.slice(d.span.from, d.span.to), d.message]);
}

const SPEC_9 = `@layout: { engine: "elk", direction: right }
payments: {
  @label: "Payments"
  @layout: { engine: grid, columns: 2 }
  api
  ledger
  outbox
}
psp
payments.api -> psp
`;

describe('layoutPlan (DD-14 C8)', () => {
  it("spec §9: `payments` is a grid boundary with its own options, the rest the engine's defaults, and its span is the `engine` key", () => {
    expect(plan(SPEC_9)).toEqual({
      scopes: [{ node: 'payments', engine: 'sgl.grid', options: { align: 'center', columns: 2, gap: 24 }, at: 'engine' }],
      diagnostics: [],
    });
  });

  it('every spelling of the engine: a bare name, a full id, the dotted key, a variable', () => {
    const src = '@vars: { e: fixed }\na: {\n  @layout.engine: "sgl.grid"\n  x\n}\nb: {\n  @layout: { engine: $e }\n  y\n}\nc: {\n  @layout.engine: tree\n  z\n}\n';
    expect(plan(src).scopes.map((s) => [s.node, s.engine, s.at])).toEqual([
      ['a', 'sgl.grid', '@layout.engine'],
      ['b', 'sgl.fixed', 'engine'],
      ['c', 'sgl.tree', '@layout.engine'],
    ]);
  });

  it('pre-order, in graph order, nested boundaries included', () => {
    const src = 'outer: {\n  @layout.engine: elk\n  inner: {\n    @layout.engine: grid\n    p\n  }\n  q\n}\nlast: {\n  @layout.engine: fixed\n  r\n}\n';
    expect(plan(src, { engine: 'sgl.grid', options: {} }).scopes.map((s) => s.node)).toEqual(['outer', 'outer.inner', 'last']);
  });

  describe('options (C6)', () => {
    it('a boundary using the root\'s engine inherits the root\'s options (the form and the document), and overrides the ones it sets', () => {
      const root = { engine: 'sgl.elk', options: { ...ELK_OPTIONS, nodeSpacing: 55, direction: 'down' } };
      const src = 'row: {\n  @layout: { engine: elk, direction: right }\n  a\n  b\n}\n';
      expect(plan(src, root).scopes[0]!.options).toEqual({ ...ELK_OPTIONS, nodeSpacing: 55, direction: 'right' });
    });

    it('`@direction` at a boundary sets its `direction`', () => {
      const src = 'row: {\n  @layout.engine: elk\n  @direction: left\n  a\n}\n';
      expect(plan(src).scopes[0]!.options).toEqual({ ...ELK_OPTIONS, direction: 'left' });
    });

    it('from the nearest enclosing boundary using the same engine, skipping others between', () => {
      const src = [
        'outer: {',
        '  @layout: { engine: grid, gap: 8, align: start }',
        '  mid: {',
        '    @layout: { engine: elk, nodeSpacing: 12 }',
        '    inner: {',
        '      @layout: { engine: grid, columns: 3 }',
        '      p',
        '    }',
        '    deep: {',
        '      @layout: { engine: elk }',
        '      q',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      const r = plan(src, { engine: 'sgl.elk', options: { ...ELK_OPTIONS, rankSpacing: 99 } });
      expect(r.scopes).toEqual([
        { node: 'outer', engine: 'sgl.grid', options: { align: 'start', columns: 'auto', gap: 8 }, at: 'engine' },
        { node: 'outer.mid', engine: 'sgl.elk', options: { ...ELK_OPTIONS, rankSpacing: 99, nodeSpacing: 12 }, at: 'engine' },
        { node: 'outer.mid.inner', engine: 'sgl.grid', options: { align: 'start', columns: 3, gap: 8 }, at: 'engine' },
        { node: 'outer.mid.deep', engine: 'sgl.elk', options: { ...ELK_OPTIONS, rankSpacing: 99, nodeSpacing: 12 }, at: 'engine' },
      ]);
      expect(r.diagnostics).toEqual([]);
    });

    it('keys come out sorted whatever the document\'s order', () => {
      const src = 'b: {\n  @layout: { gap: 3, engine: grid, align: start }\n  x\n}\n';
      expect(Object.keys(plan(src).scopes[0]!.options)).toEqual(['align', 'columns', 'gap']);
    });

    it('a key the engine does not declare is not an option (it is SGL4010, below); a value it refuses is SGL2011 at the key, and not sent', () => {
      const src = 'b: {\n  @layout: { engine: grid, columns: 900, direction: right }\n  x\n}\n';
      expect(plan(src)).toEqual({
        scopes: [{ node: 'b', engine: 'sgl.grid', options: { align: 'center', columns: 'auto', gap: 24 }, at: 'engine' }],
        diagnostics: [['SGL2011', 'warning', 'columns', '`@layout.columns` expects a value engine `sgl.grid` accepts; ignored.']],
      });
    });
  });

  describe('not a boundary (C1, §3.7)', () => {
    it('a leaf, a hidden container, and a container whose children are all hidden', () => {
      const src = 'leaf: { @layout.engine: grid }\nh: {\n  @hidden: true\n  @layout.engine: grid\n  x\n}\nempty: {\n  @layout.engine: grid\n  y: { @hidden: true }\n}\n';
      expect(plan(src)).toEqual({ scopes: [], diagnostics: [] });
    });

    it('a container inside a hidden one', () => {
      expect(plan('h: {\n  @hidden: true\n  box: {\n    @layout.engine: grid\n    x\n  }\n}\n').scopes).toEqual([]);
    });
  });

  describe('SGL4012 (C12): an engine that is not available', () => {
    it('warns at the key, naming the engine that lays the container out instead; the container is not a boundary', () => {
      const src = 'box: {\n  @layout: { engine: dagre }\n  x\n}\nouter: {\n  @layout.engine: grid\n  inner: {\n    @layout.engine: "org.example.nope"\n    y\n  }\n}\n';
      expect(plan(src)).toEqual({
        scopes: [{ node: 'outer', engine: 'sgl.grid', options: { align: 'center', columns: 'auto', gap: 24 }, at: '@layout.engine' }],
        diagnostics: [
          ['SGL4012', 'warning', 'engine', 'Layout engine `dagre` is not available; `box` is laid out by `sgl.elk`.'],
          ['SGL4012', 'warning', '@layout.engine', 'Layout engine `org.example.nope` is not available; `outer.inner` is laid out by `sgl.grid`.'],
        ],
      });
    });

    it('on a leaf too, but not on a hidden node', () => {
      const src = 'a: { @layout.engine: nope }\nb: {\n  @hidden: true\n  @layout.engine: nope\n}\n';
      expect(plan(src).diagnostics.map((d) => d[2])).toEqual(['@layout.engine']);
    });

    it('set twice, the later key is the one reported, as the resolver keeps it', () => {
      const src = 'box: {\n  @layout.engine: grid\n  @layout: { engine: nope }\n  x\n}\n';
      expect(plan(src)).toEqual({ scopes: [], diagnostics: [['SGL4012', 'warning', 'engine', 'Layout engine `nope` is not available; `box` is laid out by `sgl.elk`.']] });
    });
  });
});

describe('layoutConfigDiagnostics, scope-aware (DD-14 C9–C11)', () => {
  it("spec §9 has no diagnostic: a container's `engine` is not SGL4010, and `columns` is grid's option", () => {
    expect(checks(SPEC_9)).toEqual([]);
  });

  it("a container's `engine` key is never SGL4010, available or not (an unavailable one is the plan's SGL4012)", () => {
    expect(checks('a: {\n  @layout.engine: grid\n  x\n}\nb: {\n  @layout.engine: nope\n  y\n}\nleaf: { @layout.engine: fixed }\n')).toEqual([]);
  });

  it("a boundary's keys are its own engine's options, as the root's are (C6): a hint of it, or another engine's option, is SGL4010 naming it", () => {
    const src = 'box: {\n  @layout: { engine: grid, gap: 4, span: 2, direction: right }\n  x\n}\nrow: {\n  @layout: { engine: elk, nodeSpacing: 3, priority: 1 }\n  y\n}\n';
    expect(checks(src, GRID)).toEqual([
      ['SGL4010', 'span', '`@layout.span` is not an option of engine `sgl.grid`; ignored.'],
      ['SGL4010', 'direction', '`@layout.direction` is not an option of engine `sgl.grid`; ignored.'],
      ['SGL4010', 'priority', '`@layout.priority` is not an option of engine `sgl.elk`; ignored.'],
    ]);
  });

  it("a plain container's keys are hints for the engine around it (C9): `@direction` under elk is SGL4010, `columns` inside a grid box is not", () => {
    const src = 'box: {\n  @direction: right\n  @layout.priority: 2\n  x\n}\ncells: {\n  @layout.engine: grid\n  sub: {\n    @layout: { columns: 1, gap: 4 }\n    y\n  }\n}\n';
    expect(checks(src)).toEqual([
      // A hint check says "hint": `direction` is an elk option, not a hint (fix round 1, item 1).
      ['SGL4010', '@direction', '`@layout.direction` is not a hint of engine `sgl.elk`; ignored.'],
      ['SGL4010', 'gap', '`@layout.gap` is not a hint of engine `sgl.grid`; ignored.'],
    ]);
  });

  it("a leaf's keys are hints too, and the message says so (fix round 1, item 1)", () => {
    expect(checks('a: { @direction: left, @layout.priority: 1 }\n')).toEqual([['SGL4010', '@direction', '`@layout.direction` is not a hint of engine `sgl.elk`; ignored.']]);
  });

  it("under tree, a plain container's `@direction` is a hint and is fine (DD-12 N38)", () => {
    expect(checks('@layout.engine: tree\nsales: {\n  @direction: right\n  a\n}\n', TREE)).toEqual([]);
  });

  it('a hidden container, one inside it, and a container whose children are all hidden get no key check: the plan skips them too (fix round 1, item 2; §3.7)', () => {
    const src = 'h: {\n  @hidden: true\n  @layout: { engine: grid, columns: 2, direction: right }\n  inner: {\n    @direction: left\n    x\n  }\n}\nempty: {\n  @layout: { engine: grid, columns: 2, direction: right }\n  y: { @hidden: true }\n}\n';
    expect(checks(src)).toEqual([]);
  });

  it('keys on a container whose engine is not available are hints for the engine around it', () => {
    expect(checks('box: {\n  @layout: { engine: nope, columns: 2 }\n  x\n}\n').map((d) => d[1])).toEqual(['columns']);
  });

  it('a pin is judged by the engine that places the node (C10): inside a fixed box, none; the box itself under elk, SGL4021', () => {
    const src = 'rack: {\n  @layout.engine: fixed\n  @pin: { x: 1, y: 2 }\n  top: { @pin: { x: 0, y: 0 } }\n}\n';
    expect(checks(src)).toEqual([['SGL4021', '@pin', '`@pin` is not honoured by engine `sgl.elk`; ignored.']]);
  });

  it('inside an elk box in a fixed document, a pin is SGL4021, and the box\'s own pin is fine', () => {
    const src = '@layout.engine: fixed\nouter: {\n  @pin: { x: 0, y: 0 }\n  @layout.engine: elk\n  a: { @pin: { x: 1, y: 1 } }\n}\n';
    expect(checks(src, FIXED)).toEqual([['SGL4021', '@pin', '`@pin` is not honoured by engine `sgl.elk`; ignored.']]);
  });

  it("without the plan's boundaries, every container is plain", () => {
    const { ast } = parse(SPEC_9);
    expect(layoutConfigDiagnostics(ast, ELK).map((d) => [d.code, SPEC_9.slice(d.span.from, d.span.to)])).toEqual([['SGL4010', 'columns']]);
  });
});
