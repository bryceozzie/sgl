import type { CompileOptions } from '@sgl/core';
import { neutralDark, neutralLight, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { render, renderPaintOnly, structureHash, withStyleBlock, type RenderResult } from '../src/index.js';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_DOC, SYNTHETIC_RICH_DOC } from './fixtures/synthetic.js';
import { corpusSource, INLINE, listCorpusDocs, RICH_DOCS, runPipeline, type RenderedDoc } from './pipeline.js';

/**
 * F9 P3/P4 (execution plan §2; DD-07 §6, §11): the paint-only path.
 * `renderPaintOnly(previous, styled, layout)` turns a full render into the
 * render of the same layout under new paint without walking the elements: it
 * recomputes only the `<style>` text, one rule per paint class the previous
 * render emitted (one per distinct cascade signature), and derives the SVG
 * string from the previous one on demand (`withStyleBlock`). It must be
 * exactly `render(styled, layout)` whenever it answers, and it must refuse
 * (`null`, the caller's cue for the full path) whenever the layout, the
 * geometry or `structureHash` differs.
 */

/** Every document the paint-only property is proved on: the whole corpus
 *  under the built-in pair, and the synthetic role-, shape- and
 *  class-specific pair (`fixtures/synthetic.ts`). */
const PAIRS: readonly (readonly [string, string, ThemeDoc, ThemeDoc, CompileOptions?])[] = [
  ...listCorpusDocs().map((doc) => [doc, corpusSource(doc), neutralLight, neutralDark] as const),
  ['synthetic', SYNTHETIC_DOC, SYNTHETIC_A, SYNTHETIC_B],
  // A18 (DD-11 T57): the documents with markdown and wrapping through the rich
  // pipeline, which draws nested run tspans and soft breaks, and the synthetic
  // pair over a document whose every label is marked up.
  ...RICH_DOCS.map((doc) => [`${doc} (rich)`, corpusSource(doc), neutralLight, neutralDark, INLINE] as const),
  ['synthetic (rich)', SYNTHETIC_RICH_DOC, SYNTHETIC_A, SYNTHETIC_B, INLINE],
];

/** `styled` restyled under `theme`, drawn with `layout` (the same object). */
async function restyled(source: string, theme: ThemeDoc, options?: CompileOptions): Promise<RenderedDoc> {
  return runPipeline(source, theme, undefined, {}, undefined, options);
}

function sameRender(actual: RenderResult, expected: RenderResult): void {
  expect(actual.styleBlock).toBe(expected.styleBlock);
  expect(actual.structureHash).toBe(expected.structureHash);
  expect(actual.bounds).toEqual(expected.bounds);
  expect(actual.diagnostics).toEqual(expected.diagnostics);
  expect(actual.svg).toBe(expected.svg); // P4: byte for byte
}

describe('renderPaintOnly is exactly render() under the new paint (P3), and its SVG the same bytes (P4)', () => {
  for (const [name, source, first, second, options] of PAIRS) {
    it(`${name}: ${first.id} → ${second.id} → ${first.id}`, async () => {
      const a = await restyled(source, first, options);
      const b = await restyled(source, second, options);
      // The same layout object and the same measure table: what the
      // application reuses on a theme-only change (DD-11 T42).
      expect(b.result).toEqual(a.result);
      expect(b.table).toEqual(a.table);
      const layout = a.result;
      const full = render(b.styled, layout, b.theme, a.table);

      const there = renderPaintOnly(a.rendered, b.styled, layout, a.table);
      expect(there, 'a paint-only switch must take the paint-only path').not.toBeNull();
      sameRender(there!, full);
      // …and back again, from a result that was itself paint-only.
      const back = renderPaintOnly(there!, a.styled, layout, a.table);
      expect(back).not.toBeNull();
      sameRender(back!, render(a.styled, layout, a.theme, a.table));
      expect(back!.svg).toBe(a.rendered.svg);
    }, 30_000);
  }

  it('the rich documents really draw nested run tspans and their rules', async () => {
    for (const [name, source, first, , options] of PAIRS.filter((p) => p[4] !== undefined && p[0] !== 'multiline.sgl (rich)' && p[0] !== 'text/wrap.sgl (rich)')) {
      const a = await restyled(source, first, options);
      expect(a.rendered.svg, name).toMatch(/<tspan class="r-(strong|em|code)/);
      expect(a.rendered.styleBlock, name).toMatch(/^\.r-(strong|em|code)\{/m);
    }
  });
});

describe('withStyleBlock: replacing the <style> text is byte-exact (P4)', () => {
  for (const [name, source, first, second, options] of PAIRS) {
    it(name, async () => {
      const a = await restyled(source, first, options);
      const b = await restyled(source, second, options);
      const full = render(b.styled, a.result, b.theme, a.table);
      expect(withStyleBlock(a.rendered.svg, full.styleBlock)).toBe(full.svg);
      expect(withStyleBlock(full.svg, a.rendered.styleBlock)).toBe(a.rendered.svg);
    }, 30_000);
  }

  it('escapes the new text exactly as render() does', async () => {
    const a = await restyled('a: "A"\n', neutralLight);
    const out = withStyleBlock(a.rendered.svg, `.x{font-family:'A&B'}`);
    expect(out).toContain('<style>.x{font-family:&apos;A&amp;B&apos;}</style>');
    expect(out.match(/<style>/g)).toHaveLength(1);
  });
});

describe('renderPaintOnly falls back (null) whenever the layout, the geometry or structureHash differs (P3)', () => {
  const SOURCE = corpusSource('checkout.sgl');

  it('a different LayoutResult, even an equal copy', async () => {
    const a = await restyled(SOURCE, neutralLight);
    const b = await restyled(SOURCE, neutralDark);
    expect(renderPaintOnly(a.rendered, b.styled, structuredClone(a.result), a.table)).toBeNull();
    expect(renderPaintOnly(a.rendered, b.styled, b.result, a.table)).toBeNull(); // b's own layout: equal, not the same one
    expect(renderPaintOnly(a.rendered, b.styled, a.result, a.table)).not.toBeNull();
  });

  it('a different measure table, even an equal one (DD-11 T42)', async () => {
    const a = await restyled(SOURCE, neutralLight);
    const b = await restyled(SOURCE, neutralDark);
    expect(b.table).toEqual(a.table);
    expect(renderPaintOnly(a.rendered, b.styled, a.result, b.table)).toBeNull();
    expect(renderPaintOnly(a.rendered, b.styled, a.result)).toBeNull();
  });

  it('different geometry: a theme that changes a stroke width or a font size', async () => {
    const a = await restyled(SOURCE, neutralLight);
    for (const rules of [{ node: { strokeWidth: 3 } }, { 'node.title': { fontSize: 19 } }]) {
      const other: ThemeDoc = { ...neutralDark, id: 'geometry-differs', extends: 'neutral-dark', tokens: {}, rules, byShape: {}, byClass: {} };
      const b = await restyled(SOURCE, other);
      expect(b.styled.geometryHash).not.toBe(a.styled.geometryHash);
      expect(renderPaintOnly(a.rendered, b.styled, a.result, a.table)).toBeNull();
    }
  });

  it('a different structureHash with equal geometry: an arrowhead kind, an inline colour, a class, a label, a link', async () => {
    const a = await restyled(SOURCE, neutralLight);
    const arrow: StyledGraph = {
      ...a.styled,
      styles: Object.fromEntries(Object.entries(a.styled.styles).map(([id, s]) => [id, 'arrowhead' in s.paint ? { ...s, paint: { ...s.paint, arrowhead: 'open' } } : s])) as StyledGraph['styles'],
    };
    expect(arrow.geometryHash).toBe(a.styled.geometryHash);
    expect(structureHash(arrow)).not.toBe(a.rendered.structureHash);
    expect(renderPaintOnly(a.rendered, arrow, a.result, a.table)).toBeNull();

    const base = await restyled('a: { @label: "a" }\nb\na -> b\n', neutralLight);
    for (const other of [
      'a: { @label: "a", @style: { fill: "#123456" } }\nb\na -> b\n',
      '@classes: { K: {} }\na: { @label: "a", @type: K }\nb\na -> b\n',
      'a: { @label: "z" }\nb\na -> b\n',
      'a: { @label: "a", @link: "https://example.com" }\nb\na -> b\n',
    ]) {
      const o = await restyled(other, neutralDark);
      expect(o.styled.geometryHash, other).toBe(base.styled.geometryHash);
      expect(renderPaintOnly(base.rendered, o.styled, base.result, base.table), other).toBeNull();
    }
  });
});

describe('the paint-only path does per-signature work, not per-element work (P3)', () => {
  it('reads one style per paint rule of the previous render, whatever the element count', async () => {
    const source = Array.from({ length: 300 }, (_, i) => `n${i}: { @label: "n${i}" }\nn${i} -> n${(i + 1) % 300}: "e"`).join('\n');
    const a = await restyled(source, neutralLight);
    const b = await restyled(source, neutralDark);
    let reads = 0;
    const counting = <T extends object>(record: T): T =>
      new Proxy(record, {
        get(target, key, receiver) {
          if (typeof key === 'string') reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const watched: StyledGraph = { ...b.styled, styles: counting(b.styled.styles), labelStyles: counting(b.styled.labelStyles) };
    const out = renderPaintOnly(a.rendered, watched, a.result, a.table);
    expect(out).not.toBeNull();
    // structureHash reads every edge's arrowhead (the one paint value the
    // structure follows); the style text itself reads one style per rule.
    const rules = out!.styleBlock.split('\n').filter((l) => /^\.(?:s|t|p|mf|ms)-/.test(l)).length;
    expect(rules).toBeLessThan(10);
    expect(reads).toBeLessThanOrEqual(b.styled.graph.edges.length + rules);
    expect(out!.styleBlock).toBe(render(b.styled, a.result, b.theme, a.table).styleBlock);
  });

  it('derives the SVG string only when it is read (P4)', async () => {
    const a = await restyled('a: "A"\nb: "B"\na -> b\n', neutralLight);
    const b = await restyled('a: "A"\nb: "B"\na -> b\n', neutralDark);
    const out = renderPaintOnly(a.rendered, b.styled, a.result, a.table)!;
    expect(typeof Object.getOwnPropertyDescriptor(out, 'svg')?.get).toBe('function');
    expect(out.svg).toBe(out.svg); // memoised: the same string both times
    expect(out.svg).toBe(render(b.styled, a.result, b.theme, a.table).svg);
  });
});
