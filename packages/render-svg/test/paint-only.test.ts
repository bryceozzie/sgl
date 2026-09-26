import { BUILT_IN, neutralDark, neutralLight, type ComputedStyle, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { render, structureHash } from '../src/index.js';
import { corpusSource, INLINE, listCorpusDocs, renderCorpusDoc, RICH_DOCS, runPipeline } from './pipeline.js';

/**
 * F7 (execution plan §2.1, DD-07 §6, §11): the paint-only property. A theme
 * switch that leaves geometry alone changes only the text of the `<style>` and
 * `<defs>` elements; every byte outside them — every element, every `class`
 * attribute, every marker reference — is the same. Paint class names are
 * cascade signatures, marker ids name no colour, and which elements exist
 * never depends on paint (a paint class with no declarations keeps its name,
 * `labelPlate: none` keeps its plate rect as `fill:none`). The one exception by
 * design is the arrowhead kind, which names the marker and whose `none` drops
 * the marker attribute: `structureHash` covers it.
 */

/** The SVG with the `<style>` and `<defs>` texts emptied: what a paint-only
 *  swap keeps. */
function structure(svg: string): string {
  const out = svg.replace(/<style>[\s\S]*?<\/style>/, '<style></style>').replace(/<defs>[\s\S]*?<\/defs>/, '<defs></defs>');
  // Exactly one of each, so nothing else can hide in a second one.
  expect(svg.match(/<style>/g)).toHaveLength(1);
  expect(svg.match(/<defs>/g)).toHaveLength(1);
  return out;
}

function classAttributes(svg: string): readonly string[] {
  return [...svg.matchAll(/ class="([^"]*)"/g)].map((m) => m[1]!);
}

/** All four built-in themes (C5 added `high-contrast` and `print`): each pair
 *  must be a paint-only switch. */
const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark, BUILT_IN['high-contrast']!, BUILT_IN['print']!];

describe('F7 contract: switching between any two built-in themes changes only the <style>/<defs> text, over the whole corpus', () => {
  it('covers four themes', () => {
    expect(THEMES.map((t) => t?.id)).toEqual(['neutral-light', 'neutral-dark', 'high-contrast', 'print']);
  });

  // A18 (DD-11 T57): the documents with markdown and wrapping through the rich
  // pipeline too, which draws nested run tspans, run rules and soft breaks.
  for (const [doc, rich] of [...listCorpusDocs().map((d) => [d, false] as const), ...RICH_DOCS.map((d) => [d, true] as const)]) {
    it(rich ? `${doc} (rich)` : doc, async () => {
      const all = await Promise.all(THEMES.map((t) => (rich ? runPipeline(corpusSource(doc), t, undefined, {}, undefined, INLINE) : renderCorpusDoc(doc, t))));
      const styleOf = (svg: string): string => svg.match(/<style>[\s\S]*?<\/style>/)![0];
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          const [a, b] = [all[i]!, all[j]!];
          const pair = `${THEMES[i]!.id} -> ${THEMES[j]!.id}`;
          // A paint-only switch by construction: layout untouched.
          expect(b.styled.geometryHash, pair).toBe(a.styled.geometryHash);
          expect(b.result, pair).toEqual(a.result);
          expect(structure(b.rendered.svg), pair).toBe(structure(a.rendered.svg));
          expect(b.rendered.structureHash, pair).toBe(a.rendered.structureHash);
          // Swapping the <style> text alone turns one render into the other, both ways.
          expect(a.rendered.svg.replace(/<style>[\s\S]*?<\/style>/, () => styleOf(b.rendered.svg)), pair).toBe(b.rendered.svg);
          expect(b.rendered.svg.replace(/<style>[\s\S]*?<\/style>/, () => styleOf(a.rendered.svg)), pair).toBe(a.rendered.svg);
        }
      }
      // …and the paint really did change, in the <style> text: every theme
      // paints differently from neutral-light. (high-contrast and print can
      // paint a small document identically — black on white, no container,
      // no label — which is still a paint-only switch.)
      for (let j = 1; j < all.length; j += 1) expect(all[j]!.rendered.styleBlock, THEMES[j]!.id).not.toBe(all[0]!.rendered.styleBlock);
    });
  }
});

describe('F7: two documents differing only in @theme get the same class names and marker ids', () => {
  it('checkout.sgl with @theme "neutral-light" vs "neutral-dark", each under the theme it names', async () => {
    const source = corpusSource('checkout.sgl');
    expect(source).toContain('@theme: "neutral-light"');
    const light = await runPipeline(source, neutralLight);
    const dark = await runPipeline(source.replace('@theme: "neutral-light"', '@theme: "neutral-dark"'), neutralDark);
    const lightClasses = classAttributes(light.rendered.svg.replace(/<defs>[\s\S]*?<\/defs>/, ''));
    expect(lightClasses.some((c) => /\bs-[0-9a-f]{16}\b/.test(c))).toBe(true);
    expect(lightClasses.some((c) => /\bt-[0-9a-f]{16}\b/.test(c))).toBe(true);
    expect(classAttributes(dark.rendered.svg)).toEqual(classAttributes(light.rendered.svg));
    const markerRefs = (svg: string): readonly string[] => [...svg.matchAll(/marker-(?:end|start)="url\(#([^)]+)\)"/g)].map((m) => m[1]!);
    expect(markerRefs(light.rendered.svg).length).toBeGreaterThan(0);
    expect(markerRefs(dark.rendered.svg)).toEqual(markerRefs(light.rendered.svg));
    expect(structure(dark.rendered.svg)).toBe(structure(light.rendered.svg));
    // Only the <style> text differs; the markers' colours are rules in it.
    expect(dark.rendered.svg.match(/<defs>[\s\S]*?<\/defs>/)![0]).toBe(light.rendered.svg.match(/<defs>[\s\S]*?<\/defs>/)![0]);
    expect(dark.rendered.styleBlock).not.toBe(light.rendered.styleBlock);
  });
});

/** `styled` with every style's paint rewritten by `f` — geometry untouched. */
function repaint(styled: StyledGraph, f: (paint: ComputedStyle['paint'], id: string) => ComputedStyle['paint']): StyledGraph {
  const map = (styles: Readonly<Record<string, ComputedStyle>>): Record<string, ComputedStyle> =>
    Object.fromEntries(Object.entries(styles).map(([id, s]) => [id, { ...s, paint: f(s.paint, id), paintHash: `${s.paintHash}'` }]));
  return { ...styled, styles: map(styled.styles) as StyledGraph['styles'], labelStyles: map(styled.labelStyles) as StyledGraph['labelStyles'], paintHash: `${styled.paintHash}'` };
}

describe('F7: structure rules — which elements and names exist never depends on a paint value (DD-07 §6)', () => {
  const DOCS = ['checkout.sgl', 'parallel-selfloop.sgl', 'classes.sgl', 'containers-edges.sgl'];

  for (const doc of DOCS) {
    it(`${doc}: paint with no declarations at all, and labelPlate none, keep every class, plate and marker`, async () => {
      const { styled, result, theme, rendered, table } = await renderCorpusDoc(doc, neutralLight);
      // Every paint property gone except the arrowhead kind; plates off.
      const bare = repaint(styled, (paint) => ({ ...('arrowhead' in paint ? { arrowhead: paint['arrowhead']! } : {}), ...('labelPlate' in paint ? { labelPlate: 'none' } : {}) }));
      const out = render(bare, result, theme, table);
      expect(structure(out.svg)).toBe(structure(rendered.svg));
      expect(out.structureHash).toBe(rendered.structureHash);
      if (rendered.svg.includes('class="el-plate ')) expect(out.styleBlock).toMatch(/\.p-[0-9a-f]{16}\{fill:none\}/);
    });
  }

  it('the arrowhead kind is the one paint property the structure follows, and structureHash says so', async () => {
    const { styled, result, theme, rendered, table } = await renderCorpusDoc('parallel-selfloop.sgl', neutralLight);
    for (const kind of ['open', 'none'] as const) {
      const other = repaint(styled, (paint) => ('arrowhead' in paint ? { ...paint, arrowhead: kind } : paint));
      const out = render(other, result, theme, table);
      expect(structure(out.svg)).not.toBe(structure(rendered.svg));
      expect(out.structureHash).not.toBe(rendered.structureHash);
      expect(structureHash(other)).toBe(out.structureHash);
    }
    const none = render(repaint(styled, (paint) => ('arrowhead' in paint ? { ...paint, arrowhead: 'none' } : paint)), result, theme, table);
    expect(none.svg).not.toContain('marker-end');
    expect(none.svg).toContain('<defs></defs>');
  });

  it('an inline @style colour edit changes class names, so it changes structureHash too; a theme switch does not (fix round 1, item 4)', async () => {
    const src = (fill: string, stroke: string): string => `a: { @style: { fill: "${fill}" }, @label: "a" }\nb: { @label: "b" }\na -> b: { @label: "e", @style: { stroke: "${stroke}" } }\n`;
    const one = await runPipeline(src('#111111', '#333333'), neutralLight);
    for (const [fill, stroke] of [['#222222', '#333333'], ['#111111', '#444444']] as const) {
      const two = await runPipeline(src(fill, stroke), neutralLight);
      // Same geometry and layout: exactly the case a paint-only swap would take.
      expect(two.styled.geometryHash).toBe(one.styled.geometryHash);
      expect(two.result).toEqual(one.result);
      expect(structure(two.rendered.svg)).not.toBe(structure(one.rendered.svg));
      expect(two.rendered.structureHash).not.toBe(one.rendered.structureHash);
    }
    const dark = await runPipeline(src('#111111', '#333333'), neutralDark);
    expect(dark.rendered.structureHash).toBe(one.rendered.structureHash);
    expect(structure(dark.rendered.svg)).toBe(structure(one.rendered.svg));
  });

  it('structureHash also follows the graph content that reaches the output: a class, a label, a link (fix round 1, item 4)', async () => {
    const base = await runPipeline('a: { @label: "a" }\nb\na -> b\n', neutralLight);
    for (const other of [
      '@classes: { K: {} }\na: { @label: "a", @type: K }\nb\na -> b\n',
      'a: { @label: "z" }\nb\na -> b\n',
      'a: { @label: "a", @link: "https://example.com" }\nb\na -> b\n',
      'a: { @label: "a" }\nb\na -- b\n',
    ]) {
      const o = await runPipeline(other, neutralLight);
      expect(o.rendered.structureHash, other).not.toBe(base.rendered.structureHash);
    }
  });

  it('structureHash is a function of the styled graph alone, cheap to take before rendering', async () => {
    const { styled, rendered } = await renderCorpusDoc('checkout.sgl', neutralLight);
    expect(structureHash(styled)).toBe(rendered.structureHash);
    expect(rendered.structureHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
