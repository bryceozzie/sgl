import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { compile } from '../src/compile.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

/**
 * DD-13 P5 (help branch 1): the facts help and E6 read from code are exported
 * as data, and each constant is the one the code itself uses, so neither can
 * drift from the other. Every case here checks the constant against the
 * behaviour it names, not against a copy of its value.
 */

const run = (src: string) => {
  const { ast, diagnostics: parsed } = parse(src);
  const { model, diagnostics: resolved } = resolve(ast);
  const compiled = compile(model);
  return { graph: compiled.graph, codes: [...parsed, ...resolved, ...compiled.diagnostics].map((d) => d.code) };
};

describe('DD-13 P5: facts in code, exported as data', () => {
  it('CONFIG_REGISTRY and LANGUAGE_SHAPES are exported from @sgl/core', () => {
    expect(Array.isArray(core.CONFIG_REGISTRY)).toBe(true);
    expect(core.CONFIG_REGISTRY.some((row) => row.key === 'shape')).toBe(true);
    expect(core.LANGUAGE_SHAPES).toBeInstanceOf(Set);
    expect(core.LANGUAGE_SHAPES.has('cylinder')).toBe(true);
  });

  it('DEFAULT_SHAPE is the shape a node without @shape gets, and the fallback for SGL3001 and SGL3006', () => {
    expect(core.DEFAULT_SHAPE).toBe('rect');
    expect(core.DRAWABLE_SHAPES.has(core.DEFAULT_SHAPE)).toBe(true);
    const { graph, codes } = run('a\nb: { @shape: banana }\nc: { @shape: cloud }\n');
    expect(codes).toEqual(['SGL3001', 'SGL3006']);
    expect(graph.nodes['a' as core.NodeId]?.shape).toBe(core.DEFAULT_SHAPE);
    expect(graph.nodes['b' as core.NodeId]?.shape).toBe(core.DEFAULT_SHAPE);
    expect(graph.nodes['c' as core.NodeId]?.shape).toBe(core.DEFAULT_SHAPE);
  });

  it('PORT_SIDES is exactly the set of sides SGL3007 accepts', () => {
    expect([...core.PORT_SIDES]).toEqual(['north', 'south', 'east', 'west']);
    for (const side of core.PORT_SIDES) {
      const { graph, codes } = run(`a: { @ports: { p: ${side} } }\n`);
      expect(codes).toEqual([]);
      expect(graph.nodes['a' as core.NodeId]?.ports).toEqual([{ id: 'p', side }]);
    }
    for (const side of ['North', 'up', 'left', 'top']) {
      expect(run(`a: { @ports: { p: ${side} } }\n`).codes).toEqual(['SGL3007']);
    }
  });

  it('STRUCTURAL_KEYS names @extends (classes) and @edges (the canonical form), which have no registry row', () => {
    expect(core.STRUCTURAL_KEYS.map((k) => k.key)).toEqual(['extends', 'edges']);
    for (const { key } of core.STRUCTURAL_KEYS) {
      expect(core.CONFIG_REGISTRY.some((row) => row.key === key || row.key === `${key}.*`)).toBe(false);
    }
  });

  it('@extends is accepted in a class body, its STRUCTURAL_KEYS scope, and nowhere else', () => {
    const spec = core.STRUCTURAL_KEYS.find((k) => k.key === 'extends');
    expect(spec?.scope).toEqual(['class']);
    const { graph, codes } = run('@classes: { Base: { @shape: round }, Sub: { @extends: Base } }\na: Sub\n');
    expect(codes).toEqual([]);
    expect(graph.nodes['a' as core.NodeId]?.shape).toBe('round');
    expect(run('a: { @extends: Base }\n').codes).toContain('SGL2010');
  });

  it('@edges is accepted at the root and in a container, its STRUCTURAL_KEYS scopes', () => {
    const spec = core.STRUCTURAL_KEYS.find((k) => k.key === 'edges');
    expect(spec?.scope).toEqual(['root', 'node']);
    expect(spec?.canonicalOnly).toBe(true);
    const root = run('a\nb\n@edges: [{ from: "a", to: "b" }]\n');
    expect(root.codes).toEqual([]);
    expect(root.graph.edges).toHaveLength(1);
    const inner = run('g: { a, b, @edges: [{ from: "a", to: "b" }] }\n');
    expect(inner.codes).toEqual([]);
    expect(inner.graph.edges).toHaveLength(1);
  });
});
