import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Document, Entry } from '../src/ast.js';
import { compile } from '../src/compile.js';
import type { DiagnosticCode } from '../src/diagnostics.js';
import type { GraphEdge } from '../src/graph.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const corpus = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');

const compileSrc = (src: string) => {
  const { ast } = parse(src);
  const { model } = resolve(ast);
  return compile(model);
};

/** Every document `compile()` must handle cleanly — no error diagnostics (warnings,
 *  like `checkout.sgl`'s `SGL3001` for `@shape: cloud`, are expected and fine). */
const CLEAN_DOCS = [
  'empty.sgl',
  'single.sgl',
  'json-form.sgl.json',
  'checkout.sgl',
  'nesting-3.sgl',
  'chains.sgl',
  'parallel-selfloop.sgl',
  'ports.sgl',
  'classes.sgl',
  'containers-edges.sgl',
  'wildcards.sgl',
  'wildcard-globs.sgl',
  'shapes.sgl',
  'unicode.sgl',
  'hidden.sgl',
];

/** `SGL2001`, `SGL2003` and every `SGL3xxx` are compile()'s, not resolve()'s
 *  (DD-02 §8) — the `corpus/unresolved/*.sgl` fixtures resolve.test.ts skips for
 *  these codes are this file's to check. */
const RESOLVER_OWNED_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'SGL2002',
  'SGL2004',
  'SGL2005',
  'SGL2006',
  'SGL2007',
  'SGL2008',
  'SGL2009',
  'SGL2010',
  'SGL2011',
  'SGL2012',
]);

describe('compile() over the corpus', () => {
  it.each(CLEAN_DOCS)('%s compiles with no error diagnostics', (name) => {
    const { diagnostics } = compileSrc(corpus(name));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it.each(CLEAN_DOCS)('%s — compiler golden (semantic graph)', async (name) => {
    const { graph } = compileSrc(corpus(name));
    await expect(`${JSON.stringify(graph, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/compile/${name}.json`);
  });

  it.each(CLEAN_DOCS)('%s — double-run: compile is byte-identical', (name) => {
    const src = corpus(name);
    const r1 = compileSrc(src);
    const r2 = compileSrc(src);
    expect(JSON.stringify(r1.graph)).toBe(JSON.stringify(r2.graph));
    expect(JSON.stringify(r1.diagnostics)).toBe(JSON.stringify(r2.diagnostics));
  });

  it.each(CLEAN_DOCS)('%s — every node and edge span lies inside its source', (name) => {
    const src = corpus(name);
    const { graph } = compileSrc(src);
    for (const node of Object.values(graph.nodes)) {
      expect(node.span.from).toBeGreaterThanOrEqual(0);
      expect(node.span.to).toBeLessThanOrEqual(src.length);
      expect(node.span.from).toBeLessThanOrEqual(node.span.to);
    }
    for (const edge of graph.edges) {
      expect(edge.span.from).toBeGreaterThanOrEqual(0);
      expect(edge.span.to).toBeLessThanOrEqual(src.length);
    }
  });

  it('shuffling root-level declaration order leaves node and edge ID sets unchanged (DD-03 gate)', () => {
    for (const name of CLEAN_DOCS) {
      const { ast } = parse(corpus(name));
      fc.assert(
        fc.property(fc.shuffledSubarray(ast.entries, { minLength: ast.entries.length }), (shuffled) => {
          const shuffledAst: Document = { ...ast, entries: shuffled as Entry[] };
          const base = compile(resolve(ast).model).graph;
          const permuted = compile(resolve(shuffledAst).model).graph;
          expect(Object.keys(permuted.nodes).sort()).toEqual(Object.keys(base.nodes).sort());
          expect(permuted.edges.map((e) => e.id).sort()).toEqual(base.edges.map((e) => e.id).sort());
        }),
        { numRuns: 25 },
      );
    }
  });

  it('adding a child at the front of a wildcarded container leaves every existing edge ID intact (DD-03 §5)', () => {
    const before = compileSrc(corpus('wildcards.sgl')).graph;
    const withNewChild = corpus('wildcards.sgl').replace(
      'lane1: {\n  @label: "Lane 1"\n',
      'lane1: {\n  @label: "Lane 1"\n  zzz_new: {}\n',
    );
    expect(withNewChild).not.toBe(corpus('wildcards.sgl'));
    const after = compileSrc(withNewChild).graph;
    const beforeIds = new Set(before.edges.map((e) => e.id));
    const afterIds = new Set(after.edges.map((e) => e.id));
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
    // The new child is itself matched by every `lane1.*`/`lane1.**` wildcard, so
    // strictly more edges exist afterwards.
    expect(after.edges.length).toBeGreaterThan(before.edges.length);
  });
});

describe('corpus/unresolved/*.sgl — compiler-owned diagnostics (DD-02 §8)', () => {
  const dir = `${corpusDir}unresolved/`;
  const files = [
    'unknown-path.sgl',
    'unknown-port.sgl',
    'unknown-shape.sgl',
    'wildcard-glob-no-match.sgl',
    'wildcard-midpath.sgl',
    'wildcard-no-match.sgl',
    'wildcard-on-leaf.sgl',
    'wildcard-unknown-prefix.sgl',
  ];

  it.each(files)('%s emits exactly its expected code from compile()', (file) => {
    const src = readFileSync(`${dir}${file}`, 'utf8');
    const expected = /\/\/ expects: (SGL\d+)/.exec(src)?.[1] as DiagnosticCode | undefined;
    expect(expected, `${file} is missing a "// expects:" header`).toBeDefined();
    expect(RESOLVER_OWNED_CODES.has(expected as DiagnosticCode)).toBe(false);

    const { ast } = parse(src);
    const { model, diagnostics: resolveDiags } = resolve(ast);
    expect(resolveDiags).toEqual([]); // these are compile()'s alone to raise.
    const { diagnostics } = compile(model);
    expect(diagnostics.map((d) => d.code)).toEqual([expected]);
    const [diag] = diagnostics;
    expect(diag?.span.from).toBeGreaterThanOrEqual(0);
    expect(diag?.span.to).toBeLessThanOrEqual(src.length);
  });
});

describe('endpoint resolution (DD-03 §3)', () => {
  it('drops an edge to a nonexistent path with SGL2001, keeping every other node and edge', () => {
    const { graph, diagnostics } = compileSrc('a\nb\na -> nowhere\na -> b\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2001']);
    expect(Object.keys(graph.nodes)).toEqual(['a', 'b']);
    expect(graph.edges).toHaveLength(1);
  });

  it('too many `../` past the declaring container is SGL2001', () => {
    const { diagnostics } = compileSrc('a\n../nowhere -> a\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2001']);
  });

  it('resolves `/root.absolute` and `../parent.relative` paths (nesting-3.sgl)', () => {
    const { graph } = compileSrc(corpus('nesting-3.sgl'));
    const pairs = graph.edges.map((e) => `${e.from.node}->${e.to.node}`);
    expect(pairs).toContain('platform.services.api->platform.ingress.lb'); // ../ingress.lb
    expect(pairs).toContain('platform.services.worker->external.cdn'); // /external.cdn
  });

  it('keeps a self-loop (DD-03 §3)', () => {
    const { graph, diagnostics } = compileSrc('a\na -> a\n');
    expect(diagnostics).toEqual([]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.from.node).toBe(graph.edges[0]?.to.node);
  });

  it('an edge to a container attaches to its boundary, not its children', () => {
    const { graph, diagnostics } = compileSrc('a\nb: { x: {} }\na -> b\n');
    expect(diagnostics).toEqual([]);
    expect(graph.edges[0]?.to.node).toBe('b');
  });

  it('records `declaredIn` as the declaring container, `null` at the root', () => {
    const { graph } = compileSrc('a\nouter: { inner: {}\n../a -> inner }\na -> outer\n');
    const rootEdge = graph.edges.find((e) => e.to.node === 'outer') as GraphEdge;
    const nestedEdge = graph.edges.find((e) => e.to.node === 'outer.inner') as GraphEdge;
    expect(rootEdge.declaredIn).toBeNull();
    expect(nestedEdge.declaredIn).toBe('outer');
  });
});

describe('ports (DD-03 §3)', () => {
  it('keeps a valid port on both ends', () => {
    const { graph, diagnostics } = compileSrc('a: { @ports: { out: east } }\nb: { @ports: { in: west } }\na[out] -> b[in]\n');
    expect(diagnostics).toEqual([]);
    expect(graph.edges[0]?.from.port).toBe('out');
    expect(graph.edges[0]?.to.port).toBe('in');
  });

  it('drops an unknown port with SGL2003 but keeps the edge attached to the node', () => {
    const { graph, diagnostics } = compileSrc('a\nb\na[missing] -> b\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2003']);
    expect(graph.edges[0]?.from.port).toBeUndefined();
    expect(graph.edges[0]?.from.node).toBe('a');
  });

  it('reads ports only from the node’s own inline `@ports`, not from a class', () => {
    const { graph } = compileSrc('@classes: { Router: { @ports: { out: east } } }\na: Router\nb\na[out] -> b\n');
    // The port is on the class, not inline on `a` — DD-03's rule is explicitly
    // "the target node's @ports" (see resolveShape's counterpart, buildPorts).
    expect(graph.nodes.a?.ports).toEqual([]);
  });
});

describe('shape resolution (DD-03 §4)', () => {
  it('every built-in shape passes through unchanged (shapes.sgl)', () => {
    const { graph, diagnostics } = compileSrc(corpus('shapes.sgl'));
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.r?.shape).toBe('rect');
    expect(graph.nodes.n?.shape).toBe('round');
    expect(graph.nodes.e?.shape).toBe('ellipse');
    expect(graph.nodes.d?.shape).toBe('diamond');
    expect(graph.nodes.h?.shape).toBe('hexagon');
    expect(graph.nodes.c?.shape).toBe('cylinder');
    expect(graph.nodes.p?.shape).toBe('package');
  });

  it('an unknown inline shape is SGL3001 and falls back to rect', () => {
    const { graph, diagnostics } = compileSrc('a: { @shape: trapezoid }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3001']);
    expect(graph.nodes.a?.shape).toBe('rect');
  });

  it('falls back to the highest-precedence class that defines a shape when there is no inline shape', () => {
    const { graph, diagnostics } = compileSrc(
      '@classes: { Base: { @shape: round } Sub: { @extends: Base } }\na: Sub\n',
    );
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.a?.shape).toBe('round');
  });

  it('no shape anywhere is a plain rect, no warning', () => {
    const { graph, diagnostics } = compileSrc('a\n');
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.a?.shape).toBe('rect');
  });
});

describe('class linearisation (DD-02 §4, DD-03 §4)', () => {
  it('a later @type entry outranks an earlier one', () => {
    const { graph } = compileSrc('@classes: { A: { @style.fill: red } B: { @style.fill: blue } }\na: { @type: [A, B] }\n');
    expect(graph.nodes.a?.classes).toEqual(['A', 'B']);
  });

  it('a base class precedes its subclass (simple chain)', () => {
    const { graph } = compileSrc('@classes: { Base: {} Sub: { @extends: Base } }\na: Sub\n');
    expect(graph.nodes.a?.classes).toEqual(['Base', 'Sub']);
  });

  it('diamond inheritance keeps every ancestor exactly once (classes.sgl)', () => {
    const { graph } = compileSrc(corpus('classes.sgl'));
    // Diamond extends [Left, Right], each extending Base — every name appears
    // once, Diamond (most specific) last.
    expect(graph.nodes.diamond?.classes).toHaveLength(4);
    expect(new Set(graph.nodes.diamond?.classes)).toEqual(new Set(['Left', 'Right', 'Base', 'Diamond']));
    expect(graph.nodes.diamond?.classes.at(-1)).toBe('Diamond');
  });

  it('edges linearise @type the same way nodes do', () => {
    const { graph } = compileSrc('@classes: { A: {} B: { @extends: A } }\na\nb\na -> b: { @type: B }\n');
    expect(graph.edges[0]?.classes).toEqual(['A', 'B']);
  });

  it('a node with no @type has an empty class list', () => {
    const { graph } = compileSrc('a\n');
    expect(graph.nodes.a?.classes).toEqual([]);
  });
});

describe('hidden nodes (DD-03 §6, §7, §9)', () => {
  it('a hidden node stays in `nodes` but is excluded from `order`', () => {
    const { graph } = compileSrc(corpus('hidden.sgl'));
    expect(Object.keys(graph.nodes)).toContain('ghost');
    expect(graph.order).not.toContain('ghost');
  });

  it('emits one SGL3002 per hidden node, counting each incident edge once', () => {
    const { diagnostics } = compileSrc(corpus('hidden.sgl'));
    const hiddenDiags = diagnostics.filter((d) => d.code === 'SGL3002');
    expect(hiddenDiags).toHaveLength(1);
    expect(hiddenDiags[0]?.message).toContain('2 edges');
  });

  it('a self-loop on a hidden node counts as one incident edge', () => {
    const { diagnostics } = compileSrc('a: { @hidden: true }\na -> a\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3002']);
    expect(diagnostics[0]?.message).toContain('1 edge');
  });

  it('propagates hidden down the subtree: a child of a hidden container is also hidden and excluded from order', () => {
    const { graph } = compileSrc('outer: { @hidden: true, inner: {} }\n');
    expect(graph.nodes.outer?.hidden).toBe(true);
    expect(graph.nodes['outer.inner']?.hidden).toBe(true);
    expect(graph.order).toEqual([]);
  });

  it('hidden nodes never match a wildcard', () => {
    const { graph } = compileSrc('lane1: { a: {} b: {} c: { @hidden: true } }\nswitch\nlane1.* -> switch\n');
    expect(graph.edges.map((e) => e.from.node).sort()).toEqual(['lane1.a', 'lane1.b']);
  });

  it('an explicit empty label and a hidden node both give a null labelId', () => {
    const { graph } = compileSrc('a: { @label: "" }\nb: { @hidden: true }\n');
    expect(graph.nodes.a?.labelId).toBeNull();
    expect(graph.nodes.b?.labelId).toBeNull();
  });
});

describe('wildcard expansion (DD-03 §3.1, language spec §3)', () => {
  it('`lane1.*` fans out to direct children only, hidden child excluded (2 edges)', () => {
    const { graph } = compileSrc('lane1: { a: {} b: {} c: { @hidden: true } }\nswitch\nlane1.* -> switch\n');
    expect(graph.edges).toHaveLength(2);
  });

  it('`deep.**` matches every descendant, containers included (3 edges)', () => {
    const { graph } = compileSrc(corpus('wildcards.sgl'));
    const edges = graph.edges.filter((e) => e.to.node === 'switch' && e.from.node.startsWith('deep'));
    expect(edges.map((e) => e.from.node).sort()).toEqual(['deep.top', 'deep.top.mid', 'deep.top.mid.leaf']);
  });

  it('both sides wildcarded is a cross product, taken across two different containers (4 edges)', () => {
    const { graph } = compileSrc('lane1: { a: {} b: {} }\nlane2: { x: {} y: {} }\nlane1.* -> lane2.*\n');
    expect(graph.edges).toHaveLength(4);
  });

  it('a cross product against the same set excludes self-pairs (language spec §3)', () => {
    const { graph } = compileSrc('g: { a: {} b: {} c: {} }\ng.* -> g.*\n');
    // 3x3 = 9 pairs, minus the 3 self-pairs (a-a, b-b, c-c) = 6.
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges.every((e) => e.from.node !== e.to.node)).toBe(true);
  });

  it('an empty match is SGL3003 and drops only that edge', () => {
    const { graph, diagnostics } = compileSrc(corpus('wildcards.sgl'));
    expect(diagnostics.filter((d) => d.code === 'SGL3003')).toHaveLength(1);
    expect(graph.edges.some((e) => e.from.node === 'empty')).toBe(false);
  });

  it('a mid-path wildcard is SGL3004 and the edge is dropped', () => {
    const { diagnostics } = compileSrc('switch\nlane1: { a: { handler: {} } }\nlane1.*.handler -> switch\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3004']);
  });

  it('every expanded edge carries the wildcard statement’s label and config', () => {
    const { graph } = compileSrc('lane1: { a: {} b: {} }\nswitch\nlane1.* -> switch: "joins"\n');
    expect(graph.edges.every((e) => e.config.label === 'joins')).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });

  it('name globs: prefix, suffix, both ends, and quoted-key matching', () => {
    const { graph } = compileSrc('switch\nlane1: { cam1: {} mic1: {} door1: { @label: "Camera" } cam9: { @hidden: true } }\n' +
      'stores: { "users-db": {} cache: {} "order service": {} }\n' +
      'lane1.cam* -> switch\nstores.*-db -> switch\nstores.order* -> switch\n');
    const to = (from: string) => graph.edges.filter((e) => e.to.node === 'switch' && e.from.node === from);
    expect(to('lane1.cam1')).toHaveLength(1); // prefix
    expect(to('lane1.mic1')).toHaveLength(0); // not matched by cam*
    expect(to('lane1.door1')).toHaveLength(0); // label says Camera, key doesn't
    expect(to('lane1.cam9')).toHaveLength(0); // hidden
    expect(to('stores.users-db')).toHaveLength(1); // *-db suffix
    expect(to('stores.cache')).toHaveLength(0);
    expect(to('stores.order service')).toHaveLength(1); // quoted key, order*
  });

  it('chains expand per link independently', () => {
    const { graph } = compileSrc('lane1: { a: {} b: {} }\nlane2: { x: {} y: {} }\nswitch\nlane1.* -> switch -> lane2.*\n');
    const toSwitch = graph.edges.filter((e) => e.to.node === 'switch');
    const fromSwitch = graph.edges.filter((e) => e.from.node === 'switch');
    expect(toSwitch).toHaveLength(2);
    expect(fromSwitch).toHaveLength(2);
  });

  it('ports ride along with expansion: matched nodes without the port get SGL2003, the rest attach', () => {
    const { graph, diagnostics } = compileSrc(corpus('wildcards.sgl'));
    const portDiags = diagnostics.filter((d) => d.code === 'SGL2003');
    expect(portDiags).toHaveLength(1); // only `ported.r` lacks `out`
    const edges = graph.edges.filter((e) => e.to.node === 'switch' && e.from.node.startsWith('ported.'));
    expect(edges).toHaveLength(3);
    expect(edges.find((e) => e.from.node === 'ported.r')?.from.port).toBeUndefined();
    expect(edges.find((e) => e.from.node === 'ported.p')?.from.port).toBe('out');
  });

  it('the expansion ceiling emits SGL3005 and skips the whole statement, leaving other edges intact', () => {
    // Two 40-child containers cross-product to 1 600 edges, over MAX_EDGE_EXPANSION.
    const span = { from: 0, to: 0 };
    const makeChildren = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `${prefix}${i}`,
        path: [prefix, `${prefix}${i}`],
        config: {},
        children: [],
        edges: [],
      }));
    const wildcardTo = (name: string) => ({
      kind: 'PathExpr' as const,
      root: false,
      parents: 0,
      span,
      segments: [
        { kind: 'Name' as const, value: name, span },
        { kind: 'Wildcard' as const, depth: 'children' as const, prefix: '', suffix: '', span },
      ],
    });
    const root = {
      key: '',
      path: [],
      config: {},
      children: [
        { key: 'a', path: ['a'], config: {}, children: makeChildren('a', 40), edges: [] },
        { key: 'b', path: ['b'], config: {}, children: makeChildren('b', 40), edges: [] },
      ],
      edges: [{ from: wildcardTo('a'), to: wildcardTo('b'), directed: 'forward' as const, config: {}, ordinal: 0 }],
    };
    const { diagnostics, graph } = compile({ sgl: '1.0', root, classes: {}, spans: new Map() });
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3005']);
    expect(graph.edges).toHaveLength(0);
  });
});

describe('edge IDs and parallelIndex (DD-03 §5)', () => {
  it('assigns a distinct ID per parallel edge, in edge order', () => {
    const { graph } = compileSrc(corpus('parallel-selfloop.sgl'));
    const ids = graph.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a label change does not change the edge ID; an endpoint change does', () => {
    const same = compileSrc('a\nb\na -> b\n').graph.edges[0]?.id;
    const labelled = compileSrc('a\nb\na -> b: "x"\n').graph.edges[0]?.id;
    const different = compileSrc('a\nb\nc\na -> c\n').graph.edges[0]?.id;
    expect(labelled).toBe(same);
    expect(different).not.toBe(same);
  });

  it('reordering unrelated edges leaves every ID unchanged', () => {
    const first = compileSrc('a\nb\nc\nd\na -> b\nc -> d\n').graph.edges;
    const reordered = compileSrc('a\nb\nc\nd\nc -> d\na -> b\n').graph.edges;
    expect(new Set(first.map((e) => e.id))).toEqual(new Set(reordered.map((e) => e.id)));
  });
});

describe('labels (DD-03 §6)', () => {
  it("a node's default title is its key, not its full path", () => {
    const { graph } = compileSrc('outer: { inner: {} }\n');
    const labelId = graph.nodes['outer.inner']?.labelId as string;
    expect(graph.labels[labelId]?.runs).toEqual([{ text: 'inner' }]);
  });

  it('a multi-line label splits into one run per line', () => {
    const { graph } = compileSrc('a: { @label: "one\\ntwo" }\n');
    const labelId = graph.nodes.a?.labelId as string;
    expect(graph.labels[labelId]?.runs).toEqual([{ text: 'one' }, { text: 'two' }]);
  });

  it('an edge gets no label unless @label is explicitly set', () => {
    const { graph } = compileSrc('a\nb\na -> b\n');
    expect(graph.edges[0]?.labelId).toBeNull();
  });
});

describe('graph-level fields', () => {
  it('rootChildren is the top-level nodes in declaration order', () => {
    const { graph } = compileSrc('b\na\nc\n');
    expect(graph.rootChildren).toEqual(['b', 'a', 'c']);
  });

  it('meta counts nodes, edges and containers', () => {
    const { graph } = compileSrc('a: { x: {} }\nb\na.x -> b\n');
    expect(graph.meta).toEqual({ nodeCount: 3, edgeCount: 1, containerCount: 1 });
  });

  it('title comes from @title at the document root', () => {
    expect(compileSrc('@title: "My Diagram"\na\n').graph.title).toBe('My Diagram');
    expect(compileSrc('a\n').graph.title).toBeUndefined();
  });

  it('order is a pre-order walk: a node before its children (nesting-3.sgl)', () => {
    const { graph } = compileSrc(corpus('nesting-3.sgl'));
    const platformIdx = graph.order.indexOf('platform');
    const ingressIdx = graph.order.indexOf('platform.ingress');
    const lbIdx = graph.order.indexOf('platform.ingress.lb');
    expect(platformIdx).toBeLessThan(ingressIdx);
    expect(ingressIdx).toBeLessThan(lbIdx);
  });
});
