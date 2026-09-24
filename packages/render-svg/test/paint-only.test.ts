import { neutralDark, neutralLight, type ComputedStyle, type StyledGraph } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { render, structureHash } from '../src/index.js';
import { corpusSource, listCorpusDocs, renderCorpusDoc, runPipeline } from './pipeline.js';

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

describe('F7 contract: switching neutral-light <-> neutral-dark changes only the <style>/<defs> text, over the whole corpus', () => {
  for (const doc of listCorpusDocs()) {
    it(doc, async () => {
      const light = await renderCorpusDoc(doc, neutralLight);
      const dark = await renderCorpusDoc(doc, neutralDark);
      // A paint-only switch by construction: layout untouched.
      expect(dark.styled.geometryHash).toBe(light.styled.geometryHash);
      expect(dark.result).toEqual(light.result);

      expect(structure(dark.rendered.svg)).toBe(structure(light.rendered.svg));
      expect(dark.rendered.structureHash).toBe(light.rendered.structureHash);
      // …and the paint really did change, in the <style> text.
      expect(dark.rendered.styleBlock).not.toBe(light.rendered.styleBlock);
      // Swapping the <style> text alone turns one render into the other.
      expect(light.rendered.svg.replace(/<style>[\s\S]*?<\/style>/, () => dark.rendered.svg.match(/<style>[\s\S]*?<\/style>/)![0])).toBe(dark.rendered.svg);
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
      const { styled, result, theme, rendered } = await renderCorpusDoc(doc, neutralLight);
      // Every paint property gone except the arrowhead kind; plates off.
      const bare = repaint(styled, (paint) => ({ ...('arrowhead' in paint ? { arrowhead: paint['arrowhead']! } : {}), ...('labelPlate' in paint ? { labelPlate: 'none' } : {}) }));
      const out = render(bare, result, theme);
      expect(structure(out.svg)).toBe(structure(rendered.svg));
      expect(out.structureHash).toBe(rendered.structureHash);
      if (rendered.svg.includes('class="el-plate ')) expect(out.styleBlock).toMatch(/\.p-[0-9a-f]{16}\{fill:none\}/);
    });
  }

  it('the arrowhead kind is the one paint property the structure follows, and structureHash says so', async () => {
    const { styled, result, theme, rendered } = await renderCorpusDoc('parallel-selfloop.sgl', neutralLight);
    for (const kind of ['open', 'none'] as const) {
      const other = repaint(styled, (paint) => ('arrowhead' in paint ? { ...paint, arrowhead: kind } : paint));
      const out = render(other, result, theme);
      expect(structure(out.svg)).not.toBe(structure(rendered.svg));
      expect(out.structureHash).not.toBe(rendered.structureHash);
      expect(structureHash(other)).toBe(out.structureHash);
    }
    const none = render(repaint(styled, (paint) => ('arrowhead' in paint ? { ...paint, arrowhead: 'none' } : paint)), result, theme);
    expect(none.svg).not.toContain('marker-end');
    expect(none.svg).toContain('<defs></defs>');
  });

  it('structureHash is a function of the styled graph alone, cheap to take before rendering', async () => {
    const { styled, rendered } = await renderCorpusDoc('checkout.sgl', neutralLight);
    expect(structureHash(styled)).toBe(rendered.structureHash);
    expect(rendered.structureHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
