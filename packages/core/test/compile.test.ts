import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Document, Entry } from '../src/ast.js';
import { compile } from '../src/compile.js';
import type { DiagnosticCode } from '../src/diagnostics.js';
import type { GraphEdge } from '../src/graph.js';
import type { ClassModel, ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
import { CLEAN_DOCS } from './corpus-docs.js';

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const corpus = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');

/** Every `.sgl`/`.sgl.json` file anywhere under `corpus/`, malformed and
 *  unresolved documents included — the whole-corpus invariant below (DD-09
 *  §3.3 invariant 7) needs the error-tolerant partial-model path too, since
 *  that is exactly where B1's bug (a resolved path of length 0 read as a hit
 *  on the document root) showed up. */
function listCorpusFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listCorpusFiles(`${dir}/${entry.name}`, `${rel}${entry.name}/`));
    else if (entry.name.endsWith('.sgl') || entry.name.endsWith('.sgl.json')) out.push(`${rel}${entry.name}`);
  }
  return out;
}

const compileSrc = (src: string) => {
  const { ast } = parse(src);
  const { model } = resolve(ast);
  return compile(model);
};

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
  'SGL2010',
  'SGL2011',
  'SGL2012',
  'SGL2013',
  'SGL2014',
  'SGL2015',
  'SGL2016',
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

  it('no edge references a node absent from graph.nodes, over the whole corpus (DD-09 §3.3 invariant 7, B1)', () => {
    for (const file of listCorpusFiles(corpusDir.slice(0, -1))) {
      const src = readFileSync(`${corpusDir}${file}`, 'utf8');
      const { ast } = parse(src);
      const { model } = resolve(ast);
      const { graph } = compile(model);
      for (const edge of graph.edges) {
        expect(graph.nodes[edge.from.node], `${file}: ${edge.id} from ${edge.from.node}`).toBeDefined();
        expect(graph.nodes[edge.to.node], `${file}: ${edge.id} to ${edge.to.node}`).toBeDefined();
      }
    }
  });

  it('a resolved path of length 0 (e.g. `inner -> ../` one level down) is SGL2001, not a hit on the document root (B1)', () => {
    // `../` with nothing after it is a grammar violation (`Path` requires at
    // least one `PathStep`), so this also carries a parse error — the same
    // error-tolerant partial-model path a user mid-keystroke produces.
    const { graph, diagnostics } = compileSrc('outer: {\n  inner: {}\n  inner -> ../\n}\n');
    expect(diagnostics.map((d) => d.code)).toContain('SGL2001');
    expect(graph.edges).toHaveLength(0);
    expect(Object.keys(graph.nodes)).toEqual(['outer', 'outer.inner']);
  });
});

describe('corpus/unresolved/*.sgl — compiler-owned diagnostics (DD-02 §8)', () => {
  const dir = `${corpusDir}unresolved/`;
  const files = [
    'unknown-path.sgl',
    'unknown-port.sgl',
    'unknown-shape.sgl',
    'shape-not-drawn.sgl',
    'bad-port-side.sgl',
    'wildcard-glob-no-match.sgl',
    'wildcard-midpath.sgl',
    'wildcard-no-match.sgl',
    'wildcard-on-leaf.sgl',
    'wildcard-unknown-prefix.sgl',
    'edge-expansion-limit.sgl',
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

  it('ports cascade from a class onto the node, inline winning per port id (DD-02 §7)', () => {
    const { graph, diagnostics } = compileSrc(
      '@classes: { Router: { @ports: { out: east } } }\na: Router\nb\na[out] -> b\n',
    );
    // DD-02 §7 gives `ports` scope `node, class` so a class can supply them;
    // "the target node's @ports" in DD-03 §3 is about which node an *endpoint*
    // validates against, not about whether a class contributes to the set.
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.a?.ports).toEqual([{ id: 'out', side: 'east' }]);
    expect(graph.edges[0]?.from.port).toBe('out');
  });

  it('inline @ports overrides a class port with the same id but keeps the class’s others (classes.sgl)', () => {
    const { graph } = compileSrc(corpus('classes.sgl'));
    const sorted = (ports: readonly { id: string; side: string }[] | undefined) =>
      [...(ports ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(graph.nodes.routed?.ports)).toEqual([
      { id: 'in', side: 'west' },
      { id: 'out', side: 'east' },
    ]);
    expect(sorted(graph.nodes.routedOverride?.ports)).toEqual([
      { id: 'in', side: 'west' },
      { id: 'out', side: 'west' },
    ]);
  });

  it('an invalid port side is SGL3007 and falls back to east', () => {
    const { graph, diagnostics } = compileSrc('a: { @ports: { out: banana } }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3007']);
    expect(graph.nodes.a?.ports).toEqual([{ id: 'out', side: 'east' }]);
  });

  it('F2: an inline invalid port side carries no related span (nothing else to point at)', () => {
    const { diagnostics } = compileSrc('a: { @ports: { out: banana } }\n');
    expect(diagnostics[0]?.related).toBeUndefined();
  });

  it('F2: a class-sourced invalid port side carries a related span at the class declaration', () => {
    const src = '@classes: { Bad: { @ports: { out: banana } } }\na: Bad\nb: Bad\n';
    const { diagnostics } = compileSrc(src);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3007', 'SGL3007']);
    const classSpan = src.indexOf('Bad: {');
    for (const d of diagnostics) {
      expect(d.related).toHaveLength(1);
      expect(d.related?.[0]?.span.from).toBe(classSpan);
      expect(d.related?.[0]?.message).toContain('Bad');
    }
  });

  it('a non-string port side is also SGL3007, not a silent coercion', () => {
    const { graph, diagnostics } = compileSrc('a: { @ports: { out: 5 } }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3007']);
    expect(diagnostics[0]?.message).toContain('5');
    expect(graph.nodes.a?.ports).toEqual([{ id: 'out', side: 'east' }]);
  });

  it('both sides wildcarded and both sides ported: one SGL2003 per distinct portless node, not per edge (DD-03 §3.1, B2)', () => {
    const { graph, diagnostics } = compileSrc(
      'lane1: { a: { @ports: { out: east } } b: { @ports: { out: east } } c: { @ports: { out: east } } }\n' +
        'lane2: { x: {} y: {} }\n' +
        'lane1.*[out] -> lane2.*[in]\n',
    );
    expect(graph.edges).toHaveLength(6);
    const portDiags = diagnostics.filter((d) => d.code === 'SGL2003');
    expect(portDiags).toHaveLength(2);
    expect(new Set(portDiags.map((d) => d.message))).toEqual(
      new Set(["`lane2.x` has no port `in`; the edge attaches to the node instead.", "`lane2.y` has no port `in`; the edge attaches to the node instead."]),
    );
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

  it('F2 (execution plan §2.1): an inline unknown shape carries no related span', () => {
    const { diagnostics } = compileSrc('a: { @shape: trapezoid }\n');
    expect(diagnostics[0]?.related).toBeUndefined();
  });

  it('F2: three nodes sharing one bad class each get their own SGL3001, all related to the one class declaration', () => {
    const src = '@classes: { Bad: { @shape: trapezoid } }\na: Bad\nb: Bad\nc: Bad\n';
    const { diagnostics } = compileSrc(src);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3001', 'SGL3001', 'SGL3001']);
    const classSpan = src.indexOf('Bad: {');
    for (const d of diagnostics) {
      expect(d.related).toHaveLength(1);
      expect(d.related?.[0]?.span.from).toBe(classSpan);
      expect(d.related?.[0]?.message).toContain('Bad');
    }
    // Every diagnostic's own span is still the node, not the class (unchanged
    // behaviour — related is additive, not a replacement for the node span).
    expect(diagnostics[0]?.span.from).toBe(src.indexOf('a: Bad'));
  });

  it('a language-recognised but not-yet-drawn shape is SGL3006 (info), not SGL3001, and falls back to rect (A1)', () => {
    const { graph, diagnostics } = compileSrc('a: { @shape: actor }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3006']);
    expect(diagnostics[0]?.severity).toBe('info');
    expect(graph.nodes.a?.shape).toBe('rect');
  });

  it('checkout.sgl’s @shape: cloud (via the External class, on `edge` and `psp`) is SGL3006, not SGL3001', () => {
    const { diagnostics } = compileSrc(corpus('checkout.sgl'));
    const cloudDiags = diagnostics.filter((d) => d.code === 'SGL3006');
    expect(cloudDiags).toHaveLength(2);
    expect(diagnostics.filter((d) => d.code === 'SGL3001')).toHaveLength(0);
    // F2: class-sourced, so both point back at `External`'s declaration.
    for (const d of cloudDiags) {
      expect(d.related).toHaveLength(1);
      expect(d.related?.[0]?.message).toContain('External');
    }
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

  it('an edge with its own @hidden is hidden between two otherwise-visible nodes, and reports no SGL3002 (A2, hidden.sgl)', () => {
    const { graph, diagnostics } = compileSrc(corpus('hidden.sgl'));
    const edge = graph.edges.find((e) => e.from.node === 'visible' && e.to.node === 'another') as GraphEdge;
    expect(edge.hidden).toBe(true);
    expect(edge.labelId).toBeNull(); // @label: "silent" is set but ignored — hidden wins
    expect(graph.nodes.visible?.hidden).toBe(false);
    expect(graph.nodes.another?.hidden).toBe(false);
    expect(diagnostics.filter((d) => d.code === 'SGL3002')).toHaveLength(1); // unchanged: only `ghost`
  });

  it('an edge is effectively hidden when either endpoint node is hidden, even without its own @hidden (A2, hidden.sgl)', () => {
    const { graph } = compileSrc(corpus('hidden.sgl'));
    const toGhost = graph.edges.find((e) => e.from.node === 'visible' && e.to.node === 'ghost') as GraphEdge;
    const fromGhost = graph.edges.find((e) => e.from.node === 'ghost' && e.to.node === 'other') as GraphEdge;
    expect(toGhost.hidden).toBe(true);
    expect(fromGhost.hidden).toBe(true);
    const plain = graph.edges.find((e) => e.from.node === 'visible' && e.to.node === 'other') as GraphEdge;
    expect(plain.hidden).toBe(false);
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

  it('a mid-path `**` is SGL3004 and the edge is dropped', () => {
    const { graph, diagnostics } = compileSrc('switch\nlane1: { a: { handler: {} } }\nlane1.**.handler -> switch\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3004']);
    expect(graph.edges).toHaveLength(0);
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
    // `ported.r` (one-sided `ported.*[out] -> switch`), plus `fan2.m` and
    // `fan2.n` from the both-sided `fan1.*[out] -> fan2.*[in]` — one warning
    // per distinct portless node (B2), not per edge: fan2's 2 nodes appear in
    // 3 edges each (6 edges total) but owe only 2 warnings between them.
    expect(portDiags).toHaveLength(3);
    const edges = graph.edges.filter((e) => e.to.node === 'switch' && e.from.node.startsWith('ported.'));
    expect(edges).toHaveLength(3);
    expect(edges.find((e) => e.from.node === 'ported.r')?.from.port).toBeUndefined();
    expect(edges.find((e) => e.from.node === 'ported.p')?.from.port).toBe('out');

    const fanEdges = graph.edges.filter((e) => e.from.node.startsWith('fan1.'));
    expect(fanEdges).toHaveLength(6);
    expect(fanEdges.every((e) => e.from.port === 'out')).toBe(true);
    expect(fanEdges.every((e) => e.to.port === undefined)).toBe(true);
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

describe('wildcards in parent path segments (language spec §3, human decision 2026-09-24)', () => {
  const pairs = (edges: readonly GraphEdge[]) => edges.map((e) => [e.from.node, e.to.node]);

  /** Two `store*` containers with api-ish children, plus every near-miss the
   *  rules say contributes nothing: a matched parent with no matching child, a
   *  matched leaf, a hidden matched parent, and a hidden child. */
  const STORES =
    'payments: { api: {} }\n' +
    'store1: { api: {} apiV2: {} db: {} }\n' +
    'store2: { internal: {} api-edge: {} apiHidden: { @hidden: true } }\n' +
    'store3: { db: {} }\n' + // matched parent, no `api*` child: silent
    'stored\n' + // matched leaf: silent
    'storefront: { @hidden: true, api: {} }\n' + // hidden parent: its children are not reached
    'other: { api: {} }\n'; // not matched by `store*`

  it('`store*.api* -> payments.api` expands to exactly the expected edges, depth-first in declaration order', () => {
    const { graph, diagnostics } = compileSrc(`${STORES}store*.api* -> payments.api\n`);
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([
      ['store1.api', 'payments.api'],
      ['store1.apiV2', 'payments.api'],
      ['store2.api-edge', 'payments.api'],
    ]);
  });

  it('expansion order is depth-first in child declaration order at each level', () => {
    const src = 'sink\nb: { y: {} x: {} }\na: { z: { q: {} } w: {} }\n*.* -> sink\n*.** -> sink\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    expect(graph.edges.map((e) => e.from.node)).toEqual([
      // `*.*`: b's children, then a's — declaration order, not alphabetical.
      'b.y',
      'b.x',
      'a.z',
      'a.w',
      // `*.**`: each matched parent's descendants in pre-order.
      'b.y',
      'b.x',
      'a.z',
      'a.z.q',
      'a.w',
    ]);
  });

  it('a bare `*` in a middle segment, followed by a literal key', () => {
    const { graph, diagnostics } = compileSrc('db\nsvc1: { api: {} }\nsvc2: { web: {} }\nsvc3: { api: {} }\n*.api -> db\n');
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([
      ['svc1.api', 'db'],
      ['svc3.api', 'db'],
    ]);
  });

  it('globs in a middle and the final segment together (`lane*.cam*`)', () => {
    const src = 'switch\nlane1: { cam1: {} mic: {} }\nlane2: { camA: {} camB: {} }\nlink: { cam9: {} }\nlane*.cam* -> switch\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    expect(graph.edges.map((e) => e.from.node)).toEqual(['lane1.cam1', 'lane2.camA', 'lane2.camB']);
  });

  it('a leading `/` before a middle wildcard resolves from the root', () => {
    const src =
      'bus\nplatform: { a: { handler: {} } b: { other: {} } c: { handler: {} } }\n' +
      'deep: { inner: { /platform.*.handler -> /bus } }\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([
      ['platform.a.handler', 'bus'],
      ['platform.c.handler', 'bus'],
    ]);
  });

  it('`../` before a middle wildcard resolves relative to the enclosing container', () => {
    const src = 'lanes: {\n  l1: { h: {} }\n  l2: { h: {} }\n  hub: {\n    x: {}\n    ../*.h -> x\n  }\n}\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    // `hub` itself matches `*` but has no `h`: it contributes silently.
    expect(pairs(graph.edges)).toEqual([
      ['lanes.l1.h', 'lanes.hub.x'],
      ['lanes.l2.h', 'lanes.hub.x'],
    ]);
  });

  it('an unresolvable literal prefix before a middle wildcard is still SGL2001', () => {
    const { diagnostics } = compileSrc('x\nnowhere.*.h -> x\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2001']);
  });

  it('a partial match (a matched parent with no matching child) contributes nothing, silently', () => {
    const { graph, diagnostics } = compileSrc('sink\ns1: { api: {} }\ns2: { db: {} }\ns*.api -> sink\n');
    expect(diagnostics).toEqual([]);
    expect(graph.edges.map((e) => e.from.node)).toEqual(['s1.api']);
  });

  it('a leaf matched in a middle segment contributes nothing, silently', () => {
    const { graph, diagnostics } = compileSrc('sink\ns1: { api: {} }\ns2\ns*.* -> sink\n');
    expect(diagnostics).toEqual([]);
    expect(graph.edges.map((e) => e.from.node)).toEqual(['s1.api']);
  });

  it('a whole endpoint expanding to nothing is SGL3003, once', () => {
    const { graph, diagnostics } = compileSrc(`${STORES}store*.nope* -> payments.api\n`);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3003']);
    expect(diagnostics[0]?.message).toBe('`store*.nope*` matched no nodes; the edge was skipped.');
    expect(graph.edges).toHaveLength(0);
  });

  it('`a.**.b` is SGL3004 with the narrowed template', () => {
    const { graph, diagnostics } = compileSrc('x\na: { m: { b: {} } }\na.**.b -> x\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3004']);
    expect(diagnostics[0]?.message).toBe('`**` may only be the last part of a path; `a.**.b` was skipped.');
    expect(graph.edges).toHaveLength(0);
  });

  it('hidden parents are skipped, and hidden nodes are never matched at any level', () => {
    const src =
      'sink\nvis: { api: {} }\nghost: { @hidden: true, api: {} }\nhalf: { api: { @hidden: true } }\n*.api -> sink\n*.* -> sink\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([
      ['vis.api', 'sink'],
      ['vis.api', 'sink'],
    ]);
  });

  it('both sides wildcarded with middle segments is a cross product with self-pairs omitted', () => {
    const src = 'g1: { a: {} b: {} }\ng2: { c: {} }\ng*.* -> g*.*\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics).toEqual([]);
    // 3 x 3 = 9 pairs, minus the 3 self-pairs = 6, in (from, to) order.
    expect(pairs(graph.edges)).toEqual([
      ['g1.a', 'g1.b'],
      ['g1.a', 'g2.c'],
      ['g1.b', 'g1.a'],
      ['g1.b', 'g2.c'],
      ['g2.c', 'g1.a'],
      ['g2.c', 'g1.b'],
    ]);
  });

  it('the self-pair rule applies when only middle segments are wildcards (`*.api -> *.api`)', () => {
    const { graph, diagnostics } = compileSrc('s1: { api: {} }\ns2: { api: {} }\n*.api -> *.api\n');
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([
      ['s1.api', 's2.api'],
      ['s2.api', 's1.api'],
    ]);
  });

  it('a middle glob is case-sensitive: `store*.api` does not match `Store1` (SGL3003)', () => {
    const { graph, diagnostics } = compileSrc('z\nStore1: { api: {} }\nstore*.api -> z\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3003']);
    expect(graph.edges).toHaveLength(0);
  });

  it('a middle glob matches the key, not the label', () => {
    const { graph, diagnostics } = compileSrc('z\nx1: { @label: "store", api: {} }\nstore*.api -> z\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3003']);
    expect(graph.edges).toHaveLength(0);
  });

  it('a literal step after a middle wildcard matches the key, not the label', () => {
    const src = 'z\ns1: { cam: { @label: "Camera" } }\n';
    const byKey = compileSrc(`${src}s*.cam -> z\n`);
    expect(byKey.diagnostics).toEqual([]);
    expect(pairs(byKey.graph.edges)).toEqual([['s1.cam', 'z']]);
    const byLabel = compileSrc(`${src}s*.Camera -> z\n`);
    expect(byLabel.diagnostics.map((d) => d.code)).toEqual(['SGL3003']);
    expect(byLabel.graph.edges).toHaveLength(0);
  });

  it('descendants of a hidden node are never reached (`a.**` skips `a.h` and `a.h.x`)', () => {
    const { graph, diagnostics } = compileSrc('z\na: { h: { @hidden: true, x: {} } v: {} }\na.** -> z\n');
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([['a.v', 'z']]);
  });

  it('a bare middle `*` inside a nested container resolves in that container’s scope', () => {
    const { graph, diagnostics } = compileSrc('g: {\n  s1: { api: {} }\n  db: {}\n  *.api -> db\n}\n');
    expect(diagnostics).toEqual([]);
    expect(pairs(graph.edges)).toEqual([['g.s1.api', 'g.db']]);
  });

  it('a mid-path `**` is SGL3004 even when its prefix does not resolve (`nope.**.b`)', () => {
    const { graph, diagnostics } = compileSrc('x\nnope.**.b -> x\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3004']);
    expect(graph.edges).toHaveLength(0);
  });

  it('ports attach per expansion, with one SGL2003 per matched node lacking the port', () => {
    const src =
      'switch\nlane1: { cam1: { @ports: { out: east } } cam2: {} }\nlane2: { camA: { @ports: { out: east } } }\n' +
      'lane*.cam*[out] -> switch\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['SGL2003', expect.stringContaining('lane1.cam2') as unknown as string],
    ]);
    expect(graph.edges.map((e) => [e.from.node, e.from.port])).toEqual([
      ['lane1.cam1', 'out'],
      ['lane1.cam2', undefined],
      ['lane2.camA', 'out'],
    ]);
  });

  it('the 1 000-edge ceiling applies to the whole statement (SGL3005)', () => {
    const container = (name: string) =>
      `${name}: { ${Array.from({ length: 10 }, (_, i) => `n${i}: {}`).join(' ')} }\n`;
    // 4 `a*` containers x 10 children = 40 per side; 40 x 40 = 1 600 > 1 000.
    const src =
      ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'].map(container).join('') + 'keep1\nkeep2\na*.* -> b*.*\nkeep1 -> keep2\n';
    const { graph, diagnostics } = compileSrc(src);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL3005']);
    expect(diagnostics[0]?.message).toContain('1600');
    expect(pairs(graph.edges)).toEqual([['keep1', 'keep2']]);
  });

  it('corpus/wildcard-paths.sgl expands to exactly its documented edges, with no diagnostics', () => {
    const { graph, diagnostics } = compileSrc(corpus('wildcard-paths.sgl'));
    expect(diagnostics).toEqual([]);
    const api = ['store1.api', 'store1.apiV2', 'store2.api-edge'];
    const cams = ['lanes.lane1.cam1', 'lanes.lane1.cam2', 'lanes.lane2.camA'];
    expect(pairs(graph.edges)).toEqual([
      ...api.map((a) => [a, 'payments.api']),
      ...api.map((a) => [a, 'bus']),
      ...['lanes.lane1.cam1', 'lanes.lane1.cam2', 'lanes.lane2.camA', 'lanes.lane2.camA.lens'].map((n) => [n, 'switch']),
      ...cams.flatMap((f) => cams.filter((t) => t !== f).map((t) => [f, t])),
      ['platform.auth.handler', 'bus'],
      ['platform.billing.handler', 'bus'],
      ['platform.billing.handler', 'platform.auth.handler'],
      ['platform.billing.worker', 'platform.auth.handler'],
    ]);
    expect(graph.edges.filter((e) => e.to.node === 'bus' && e.from.node.startsWith('store')).every((e) => e.from.port === 'out')).toBe(true);
  });

  it('expanded edges have the same ids, labels and config as the same edges written by hand', () => {
    const expanded = compileSrc(`${STORES}store*.api* -> payments.api: { @label: "calls", @style: dashed }\n`).graph;
    const byHand = compileSrc(
      `${STORES}` +
        'store1.api -> payments.api: { @label: "calls", @style: dashed }\n' +
        'store1.apiV2 -> payments.api: { @label: "calls", @style: dashed }\n' +
        'store2.api-edge -> payments.api: { @label: "calls", @style: dashed }\n',
    ).graph;
    const strip = (e: GraphEdge) => ({ ...e, span: undefined });
    expect(expanded.edges).toHaveLength(3);
    expect(expanded.edges.map((e) => e.id)).toEqual(byHand.edges.map((e) => e.id));
    expect(expanded.edges.map(strip)).toEqual(byHand.edges.map(strip));
    expect(expanded.labels).toEqual(byHand.labels);
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

describe('F3: class linearisation guards against an `@extends` cycle', () => {
  // `resolve()` splices every cycle's back-edge before a model reaches
  // `compile()`, so these models are hand-built: a second producer of class
  // tables (A9 imports) must not be able to turn bad input into a stack
  // overflow. The cycle is reported with the resolver's own code, once.
  const at = { from: 0, to: 0 };
  const path = (name: string) => ({
    kind: 'PathExpr' as const,
    root: false,
    parents: 0,
    segments: [{ kind: 'Name' as const, value: name, span: at }],
    span: at,
  });
  const cls = (name: string, ...bases: string[]): ClassModel => ({ name, extends: bases, config: {} });
  const leaf = (key: string, type: string[]): ContainerModel => ({ key, path: [key], config: { type }, children: [], edges: [] });
  const model = (classes: ClassModel[], children: ContainerModel[], edgeType?: string[]): DocumentModel => ({
    sgl: '1.0',
    root: {
      key: '',
      path: [],
      config: {},
      children,
      edges: edgeType === undefined ? [] : [{ from: path('a'), to: path('b'), directed: 'forward', config: { type: edgeType }, ordinal: 0 }],
    },
    classes: Object.fromEntries(classes.map((c) => [c.name, c])),
    spans: new Map(),
  });

  it('a mutual cycle compiles, reports SGL2004 once, and linearises each class once', () => {
    const { graph, diagnostics } = compile(model([cls('A', 'B'), cls('B', 'A')], [leaf('a', ['A']), leaf('b', ['B'])], ['A']));
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2004']);
    // Canonical break (fix round 1, item 5): the back-edge into the smallest
    // member, `B extends A`, is the one dropped, whichever class is reached first.
    expect(diagnostics[0]?.message).toBe('Class `A` extends itself via `A -> B -> A`.');
    expect(graph.nodes.a?.classes).toEqual(['B', 'A']);
    expect(graph.nodes.b?.classes).toEqual(['B']);
    expect(graph.edges[0]?.classes).toEqual(['B', 'A']);
  });

  it('a self cycle compiles and reports SGL2004 once', () => {
    const { graph, diagnostics } = compile(model([cls('A', 'A')], [leaf('a', ['A'])]));
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2004']);
    expect(diagnostics[0]?.message).toBe('Class `A` extends itself via `A -> A`.');
    expect(graph.nodes.a?.classes).toEqual(['A']);
  });

  it('a diamond is not a cycle', () => {
    const { graph, diagnostics } = compile(model([cls('Base'), cls('L', 'Base'), cls('R', 'Base'), cls('D', 'L', 'R')], [leaf('a', ['D'])]));
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.a?.classes).toEqual(['L', 'Base', 'R', 'D']);
  });
});
