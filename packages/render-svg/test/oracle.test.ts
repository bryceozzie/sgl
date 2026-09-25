import type { ComputedStyle, ThemeDoc } from '@sgl/theme';
import { BUILT_IN, neutralDark, neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { cssColor, edgeElementId, nodeElementId } from '../src/security.js';
import { paintDeclarations, type RuleKind } from '../src/style.js';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_DOC } from './fixtures/synthetic.js';
import { corpusSource, listCorpusDocs, runPipeline } from './pipeline.js';

/**
 * Fix round 1, items 2 and 3: the per-element paint oracle. A paint class is
 * named after a cascade signature (DD-07 §6), and every call site in
 * `index.ts` builds its own signature, so a call site that leaves out one
 * input (a shape, the classes, the inline style) makes two elements with
 * different paint share one class — and the later one's rule never gets
 * written. Nothing about the class *names* shows that; the rules do. So: for
 * every rendered element, the rule of its own `s-`/`t-`/`p-` class must be
 * exactly `paintDeclarations` of its own `ComputedStyle` (its label's, for
 * text; its edge's, for a plate), and every arrowhead's colour rule must be
 * its own edge's stroke.
 *
 * Run over the whole corpus under both built-in themes and over a synthetic
 * document under a synthetic theme pair with role-, shape- and class-specific
 * paint (`fixtures/synthetic.ts`) — the built-in themes are too uniform to
 * catch a missing input on their own.
 */

function rulesOf(styleBlock: string): ReadonlyMap<string, string> {
  return new Map([...styleBlock.matchAll(/^\.([\w-]+)\{([^}]*)\}$/gm)].map((m) => [m[1]!, m[2]!]));
}

/** The one paint class of `kind` in a class attribute. */
function paintClass(classAttr: string, kind: RuleKind): string {
  const prefix = kind === 'shape' ? 's' : kind === 'text' ? 't' : 'p';
  const found = classAttr.split(' ').filter((c) => new RegExp(`^${prefix}-[0-9a-f]{16}$`).test(c));
  expect(found, classAttr).toHaveLength(1);
  return found[0]!;
}

/** The markup of the element group whose `id` is `id`, up to its first `</g>`
 *  (element groups are flat: layers hold them, they hold no groups). */
function group(svg: string, id: string): string | null {
  const at = svg.indexOf(` id="${id}"`);
  if (at < 0) return null;
  return svg.slice(at, svg.indexOf('</g>', at));
}

const unescape = (s: string): string => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function oracle(source: string, theme: ThemeDoc): Promise<number> {
  const { styled, rendered } = await runPipeline(source, theme);
  const rules = rulesOf(unescape(rendered.styleBlock));
  const svg = rendered.svg;
  let checked = 0;
  const expectRule = (classAttr: string, kind: RuleKind, style: ComputedStyle, what: string): void => {
    const name = paintClass(classAttr, kind);
    expect(rules.get(name) ?? '', `${what}: .${name}`).toBe(paintDeclarations(style.paint, kind).join(';'));
    checked += 1;
  };

  for (const id of styled.graph.order) {
    const node = styled.graph.nodes[id];
    const style = styled.styles[id];
    if (node === undefined || style === undefined || node.hidden) continue;
    const g = group(svg, nodeElementId(id as string));
    if (g === null) continue;
    expectRule(/<path class="([cn]-shape[^"]*)"/.exec(g)![1]!, 'shape', style, `${id} shape`);
    const label = node.labelId === null ? undefined : styled.labelStyles[node.labelId];
    const text = /<text class="([^"]*)"/.exec(g);
    if (label !== undefined && text !== null) expectRule(text[1]!, 'text', label, `${id} title`);
  }

  const labelGroups = [...svg.slice(svg.indexOf('<g class="L-labels">')).matchAll(/<g class="el"[^>]*>([\s\S]*?)<\/g>/g)].map((m) => m[1]!);
  let nextLabel = 0;
  for (const edge of styled.graph.edges) {
    const style = styled.styles[edge.id];
    const g = group(svg, edgeElementId(edge.id as string));
    if (g === null || style === undefined) continue;
    const path = /<path class="(e-path[^"]*)"[^>]*?(?: marker-end="url\(#([^)]+)\)")?(?: marker-start="url\(#([^)]+)\)")?\/>/.exec(g)!;
    expectRule(path[1]!, 'shape', style, `${edge.id} path`);
    for (const markerId of [path[2], path[3]]) {
      if (markerId === undefined) continue;
      const shape = new RegExp(`<marker id="${markerId}"[^>]*><(?:path|circle) class="(m[fs]-[0-9a-f]{16})"`).exec(svg)![1]!;
      const stroke = style.paint['stroke'];
      const color = cssColor(typeof stroke === 'string' ? stroke : '#000000');
      expect(rules.get(shape), `${edge.id} marker`).toBe(shape.startsWith('ms-') ? `stroke:${color}` : `fill:${color}`);
      checked += 1;
    }
    const label = edge.labelId === null ? undefined : styled.labelStyles[edge.labelId];
    if (label === undefined) continue;
    const el = labelGroups[nextLabel++]!;
    const plate = /<rect class="(el-plate[^"]*)"/.exec(el);
    if (plate !== null) expectRule(plate[1]!, 'plate', style, `${edge.id} plate`);
    expectRule(/<text class="(el-text[^"]*)"/.exec(el)![1]!, 'text', label, `${edge.id} label`);
  }
  expect(nextLabel).toBe(labelGroups.length);
  return checked;
}

const strip = (svg: string): string => svg.replace(/<style>[\s\S]*?<\/style>/, '<style></style>').replace(/<defs>[\s\S]*?<\/defs>/, '<defs></defs>');

describe('paint oracle: every element\'s own paint class rule is its own computed paint (fix round 1, item 2)', () => {
  for (const theme of [neutralLight, neutralDark, BUILT_IN['high-contrast']!, BUILT_IN['print']!]) {
    for (const doc of listCorpusDocs()) {
      it(`${doc} under ${theme.id}`, async () => {
        await oracle(corpusSource(doc), theme);
      });
    }
  }
});

describe('synthetic role-, shape- and class-specific themes (fix round 1, item 3)', () => {
  for (const theme of [SYNTHETIC_A, SYNTHETIC_B]) {
    it(`the oracle holds on the synthetic document under ${theme.id}`, async () => {
      const checked = await oracle(SYNTHETIC_DOC, theme);
      expect(checked).toBeGreaterThan(30);
    });
  }

  it('the fixture really is class-, shape- and role-specific: elements differ in paint under one theme', async () => {
    const { rendered, diagnostics } = await runPipeline(SYNTHETIC_DOC, SYNTHETIC_A);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const count = (prefix: string): number => new Set(rendered.styleBlock.match(new RegExp(`^\\.${prefix}-[0-9a-f]{16}\\{`, 'gm'))).size;
    expect(count('s')).toBeGreaterThanOrEqual(8);
    expect(count('t')).toBeGreaterThanOrEqual(6);
    expect(count('p')).toBeGreaterThanOrEqual(3);
    expect(count('mf')).toBeGreaterThanOrEqual(3);
  });

  it('switching synthetic-a <-> synthetic-b changes only the <style>/<defs> text, with equal structureHash', async () => {
    const a = await runPipeline(SYNTHETIC_DOC, SYNTHETIC_A);
    const b = await runPipeline(SYNTHETIC_DOC, SYNTHETIC_B);
    expect(b.styled.geometryHash).toBe(a.styled.geometryHash);
    expect(b.result).toEqual(a.result);
    expect(strip(b.rendered.svg)).toBe(strip(a.rendered.svg));
    expect(b.rendered.structureHash).toBe(a.rendered.structureHash);
    expect(b.rendered.styleBlock).not.toBe(a.rendered.styleBlock);
  });
});
