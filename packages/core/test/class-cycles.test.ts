import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { ClassModel, ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

/**
 * A8 fix round 1, items 4 and 5: `@extends` cycles and depth. Resolve and
 * compile break a cycle the same canonical way — rotated to its smallest
 * member, the message naming it, and the back-edge *into* it dropped — so the
 * result does not depend on declaration order; and neither walks the class
 * graph recursively, so depth is not a stack limit.
 */

const leaf = (key: string, type: string[]): ContainerModel => ({ key, path: [key], config: { type }, children: [], edges: [] });
const handBuilt = (classes: readonly ClassModel[], children: ContainerModel[]): DocumentModel => ({
  sgl: '1.0',
  root: { key: '', path: [], config: {}, children, edges: [] },
  classes: Object.fromEntries(classes.map((c) => [c.name, c])),
  spans: new Map(),
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const CYCLE: Readonly<Record<string, readonly string[]>> = { A: ['B'], B: ['C'], C: ['A'] };

describe('item 5: one canonical cycle break, in resolve and in compile', () => {
  const expectedMessage = 'Class `A` extends itself via `A -> B -> C -> A`.';

  it('resolve: every declaration order gives the same diagnostic, the same extends, and the same linearisation', () => {
    const seen = new Set<string>();
    for (const order of permutations(['A', 'B', 'C'])) {
      const classes = order.map((n) => `${n}: { @extends: ${CYCLE[n]?.[0]} }`).join(', ');
      const { model, diagnostics } = resolve(parse(`@classes: { ${classes} }\nx: { @type: [A] }\ny: { @type: [B] }\nz: { @type: [C] }\n`).ast);
      const classesOut = Object.fromEntries(['A', 'B', 'C'].map((n) => [n, model.classes[n]?.extends]));
      const { graph } = compile(model);
      seen.add(
        JSON.stringify({
          diagnostics: diagnostics.map((d) => [d.code, d.message]),
          classesOut,
          lin: ['x', 'y', 'z'].map((id) => graph.nodes[id]?.classes),
        }),
      );
    }
    expect(seen.size).toBe(1);
    const [only] = [...seen];
    const parsed = JSON.parse(only as string) as { diagnostics: [string, string][]; classesOut: Record<string, string[]> };
    expect(parsed.diagnostics).toEqual([['SGL2004', expectedMessage]]);
    // The back-edge into `A` (C extends A) is the one dropped.
    expect(parsed.classesOut).toEqual({ A: ['B'], B: ['C'], C: [] });
  });

  it('compile on a hand-built cyclic model: every order gives the same diagnostic and the same linearisation, matching resolve', () => {
    const resolved = compile(resolve(parse('@classes: { A: { @extends: B }, B: { @extends: C }, C: { @extends: A } }\nx: { @type: [A] }\ny: { @type: [B] }\nz: { @type: [C] }\n').ast).model).graph;
    const seen = new Set<string>();
    for (const order of permutations(['A', 'B', 'C'])) {
      const model = handBuilt(
        order.map((n) => ({ name: n, extends: [...(CYCLE[n] ?? [])], config: {} })),
        [leaf('x', ['A']), leaf('y', ['B']), leaf('z', ['C'])],
      );
      const { graph, diagnostics } = compile(model);
      expect(diagnostics.map((d) => [d.code, d.message])).toEqual([['SGL2004', expectedMessage]]);
      seen.add(JSON.stringify(['x', 'y', 'z'].map((id) => graph.nodes[id]?.classes)));
    }
    expect([...seen]).toEqual([JSON.stringify(['x', 'y', 'z'].map((id) => resolved.nodes[id]?.classes))]);
  });
});

describe('item 4: a 20 000-deep @extends chain', () => {
  const depth = 20_000;

  it('resolves and compiles without overflowing the stack', () => {
    const classes = Array.from({ length: depth }, (_, i) => (i === 0 ? 'C0: {}' : `C${i}: { @extends: C${i - 1} }`)).join(', ');
    const { model, diagnostics } = resolve(parse(`@classes: { ${classes} }\na: { @type: [C${depth - 1}] }\n`).ast);
    expect(diagnostics).toEqual([]);
    const { graph, diagnostics: compileDiags } = compile(model);
    expect(compileDiags).toEqual([]);
    const lin = graph.nodes.a?.classes ?? [];
    expect(lin).toHaveLength(depth);
    expect(lin[0]).toBe('C0');
    expect(lin[depth - 1]).toBe(`C${depth - 1}`);
  });

  it('a 20 000-long cycle is one SGL2004 in resolve, and in compile on a hand-built model', () => {
    const classes = Array.from({ length: depth }, (_, i) => `C${i}: { @extends: C${(i + 1) % depth} }`).join(', ');
    const { diagnostics } = resolve(parse(`@classes: { ${classes} }\na: { @type: [C0] }\n`).ast);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2004']);
    const model = handBuilt(
      Array.from({ length: depth }, (_, i) => ({ name: `C${i}`, extends: [`C${(i + 1) % depth}`], config: {} })),
      [leaf('a', ['C0'])],
    );
    const { graph, diagnostics: compileDiags } = compile(model);
    expect(compileDiags.map((d) => d.code)).toEqual(['SGL2004']);
    expect(graph.nodes.a?.classes).toHaveLength(depth);
  });
});
