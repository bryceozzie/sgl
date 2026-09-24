import fc from 'fast-check';
import { compile, parse, resolve } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { cascadeSignature, resolveTheme, styleGraph } from '../src/cascade.js';
import { BUILT_IN, neutralDark, neutralLight } from '../src/themes/index.js';
import type { ThemeDoc } from '../src/types.js';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_DOC } from '../../render-svg/test/fixtures/synthetic.js';
import { corpusGraph, listCorpusDocs } from './corpus.js';

/**
 * F9 (execution plan §2.1): `styleGraph` resolves each distinct cascade
 * signature once and reuses the style for every element with no `@size` that
 * shares it. That must be invisible: every style, both graph hashes, every
 * diagnostic and its order equal what resolving every element afresh gives
 * (`{ memo: false }`, the pre-F9 algorithm). Compared as JSON, which is how a
 * `StyledGraph` is observed (goldens, the worker boundary).
 */

const lookup = (id: string): ThemeDoc | undefined => (id === SYNTHETIC_A.id ? SYNTHETIC_A : id === SYNTHETIC_B.id ? SYNTHETIC_B : BUILT_IN[id]);

function both(source: string, themeDoc: ThemeDoc): { readonly memo: string; readonly fresh: string } {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(themeDoc, lookup);
  return {
    memo: JSON.stringify(styleGraph(graph, theme, model.classes)),
    fresh: JSON.stringify(styleGraph(graph, theme, model.classes, { memo: false })),
  };
}

describe('styleGraph: the per-signature memo is exact (F9)', () => {
  for (const themeDoc of [neutralLight, neutralDark]) {
    it(`every corpus document under ${themeDoc.id}`, () => {
      const docs = listCorpusDocs();
      expect(docs.length).toBeGreaterThan(20);
      for (const doc of docs) {
        const { graph, classes } = corpusGraph(doc);
        const { value: theme } = resolveTheme(themeDoc, lookup);
        expect(JSON.stringify(styleGraph(graph, theme, classes)), doc).toBe(JSON.stringify(styleGraph(graph, theme, classes, { memo: false })));
      }
    });
  }

  for (const themeDoc of [SYNTHETIC_A, SYNTHETIC_B]) {
    it(`the synthetic document under ${themeDoc.id}`, () => {
      const { memo, fresh } = both(SYNTHETIC_DOC, themeDoc);
      expect(memo).toBe(fresh);
    });
  }

  it('the same graph object styled again and again (a theme switch) stays exact, through geometry changes both ways', () => {
    const wide: ThemeDoc = { ...neutralLight, id: 'wide', extends: 'neutral-dark', tokens: {}, rules: { node: { strokeWidth: 4 }, 'edge.label': { fontSize: 15 } }, byShape: {}, byClass: {} };
    const themes = [neutralLight, neutralDark, neutralDark, wide, neutralLight, wide, wide, neutralDark, SYNTHETIC_A, SYNTHETIC_B];
    for (const doc of ['checkout.sgl', 'classes.sgl', 'containers-edges.sgl', 'n500.sgl']) {
      const { graph, classes } = corpusGraph(doc);
      const hashes = new Set<string>();
      for (const themeDoc of themes) {
        const { value: theme } = resolveTheme(themeDoc, (id) => (id === wide.id ? wide : lookup(id)));
        const memo = styleGraph(graph, theme, classes);
        expect(JSON.stringify(memo), `${doc} under ${themeDoc.id}`).toBe(JSON.stringify(styleGraph(graph, theme, classes, { memo: false })));
        hashes.add(memo.value.geometryHash);
      }
      expect(hashes.size, doc).toBe(2); // wide's geometry, and everyone else's
    }
  });

  it('the graph paintHash is taken on first read, and is the eager value', () => {
    const { graph, classes } = corpusGraph('checkout.sgl');
    const { value: theme } = resolveTheme(neutralDark, lookup);
    const { value: styled } = styleGraph(graph, theme, classes);
    expect(typeof Object.getOwnPropertyDescriptor(styled, 'paintHash')?.get).toBe('function');
    expect(styled.paintHash).toBe(styleGraph(graph, theme, classes, { memo: false }).value.paintHash);
    expect(structuredClone(styled).paintHash).toBe(styled.paintHash);
  });

  it('really reuses: elements that share a signature share one ComputedStyle; @size and a reported diagnostic opt out', () => {
    const source = [
      'a: { @label: "a" }',
      'b: { @label: "b" }',
      'c: { @label: "c", @size: { width: 90 } }',
      'd: { @label: "d", @style: { bogus: 1 } }',
      'e: { @label: "e", @style: { bogus: 1 } }',
    ].join('\n');
    const { model } = resolve(parse(source).ast);
    const { graph } = compile(model);
    const { value: theme } = resolveTheme(neutralLight, lookup);
    const { value: styled, diagnostics } = styleGraph(graph, theme, model.classes);
    const id = (k: string) => graph.order.find((n) => graph.nodes[n]!.path.join('.') === k)!;
    expect(styled.styles[id('b')]).toBe(styled.styles[id('a')]);
    expect(styled.styles[id('c')]).not.toBe(styled.styles[id('a')]); // its own @size
    expect(styled.styles[id('c')]!.geometry['width']).toBe(90);
    expect(styled.styles[id('e')]).not.toBe(styled.styles[id('d')]); // reported, so resolved afresh
    // …and each reported against its own element, once.
    expect(diagnostics.filter((d) => d.code === 'SGL5003').map((d) => source.slice(d.span.from, d.span.to).split(':')[0])).toEqual(['d', 'e']);
    expect(cascadeSignature('node', graph.nodes[id('d')]!.shape, [], graph.nodes[id('d')]!.config)).toBe(cascadeSignature('node', graph.nodes[id('e')]!.shape, [], graph.nodes[id('e')]!.config));
  });

  it('random documents: shapes, classes, inline styles (valid, token, unknown, mistyped), @size and containers', () => {
    const shape = fc.constantFrom('', '@shape: round, ', '@shape: cylinder, ', '@shape: diamond, ');
    const type = fc.constantFrom('', '@type: Hot, ', '@type: Cold, ', '@type: [Hot, Cold], ', '@type: Bad, ');
    const inline = fc.constantFrom(
      '',
      '@style: { fill: "#abcdef" }, ',
      '@style: { stroke: "@accent", color: "#ff0000" }, ',
      '@style: { fill: "@nope" }, ',
      '@style: { bogus: 1 }, ',
      '@style: { opacity: "x", fontSize: 14 }, ',
      '@style: { strokeDash: dashed }, ',
    );
    const size = fc.constantFrom('', '@size: { width: 120 }, ', '@size: { width: "@nope" }, ', '@size: { fill: "#f00" }, ');
    const node = fc.tuple(shape, type, inline, size);
    const edge = fc.tuple(type, inline, fc.boolean(), fc.constantFrom('->', '<->', '--'));
    const docArb = fc.record({
      nodes: fc.array(node, { minLength: 1, maxLength: 12 }),
      edges: fc.array(fc.tuple(fc.nat(), fc.nat(), edge), { maxLength: 12 }),
      container: fc.boolean(),
      theme: fc.constantFrom(neutralLight, neutralDark, SYNTHETIC_A, SYNTHETIC_B),
    });
    fc.assert(
      fc.property(docArb, ({ nodes, edges, container, theme }) => {
        const lines = [
          '@classes: {',
          '  Hot: { @style: { fill: "#110000", bogus: 2 } }',
          '  Cold: { @style: { stroke: "@ink" } }',
          '  Bad: { @style: { opacity: "no" } }',
          '}',
        ];
        nodes.forEach(([s, t, i, z], k) => lines.push(`n${k}: { ${s}${t}${i}${z}@label: "n${k}" }`));
        if (container) lines.push(`box: { @type: Hot, @label: "box", inner: { @label: "in" }, other: { @style: { bogus: 1 } } }`);
        for (const [from, to, [t, i, labelled, arrow]] of edges) {
          const body = `${t}${i}${labelled ? '@label: "e"' : ''}`;
          lines.push(`n${from % nodes.length} ${arrow} n${to % nodes.length}${body === '' ? '' : `: { ${body} }`}`);
        }
        const { memo, fresh } = both(lines.join('\n'), theme);
        expect(memo).toBe(fresh);
      }),
      { numRuns: 150 },
    );
  });
});
