import { afterEach, describe, expect, it } from 'vitest';
import { compile, parse, resolve, type LabelId, type Size } from '@sgl/core';
import { buildLayoutInput, type LayoutResult, type StyledGraphInput } from '@sgl/layout-api';
import { runHostSequence } from '@sgl/layout-api/conformance';
import { gridEngine } from '@sgl/layout-std';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { render, renderPaintOnly, type RenderResult } from '@sgl/render-svg';
import { BUILT_IN, neutralDark, neutralLight, resolveTheme, styleGraph, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { showLastGood } from '../src/canvas/paint.js';
import type { LastGood } from '../src/state/types.js';
import { SYNTHETIC_A, SYNTHETIC_B, SYNTHETIC_DOC } from '../../../packages/render-svg/test/fixtures/synthetic.js';

/**
 * F9 P3's oracle, in a real DOM (Chromium and Firefox): after a paint-only
 * theme switch — the canvas swapping the new `<style>` text into the tree it
 * already shows (`showLastGood`, what `Canvas.tsx` runs) — the live DOM must
 * serialise exactly as the DOM of a full `render()` under the new theme does,
 * for the whole corpus under the built-in pair and the synthetic document
 * under the synthetic role-, shape- and class-specific pair. Both
 * directions, and a second swap on top of the first.
 */

const SOURCES = import.meta.glob<string>(['../../../corpus/**/*.sgl', '../../../corpus/**/*.sgl.json'], { query: '?raw', import: 'default', eager: true });

const METRICS = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: { node: 1.5, edge: 1.5, container: 1 }, arrowSize: 8 };
const lookup = (id: string): ThemeDoc | undefined => (id === SYNTHETIC_A.id ? SYNTHETIC_A : id === SYNTHETIC_B.id ? SYNTHETIC_B : BUILT_IN[id]);

interface Styled {
  readonly styled: StyledGraph;
  readonly theme: ResolvedTheme;
}

function styleUnder(source: string, doc: ThemeDoc): Styled {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(doc, lookup);
  return { styled: styleGraph(graph, theme, model.classes).value, theme };
}

async function layOut(styled: StyledGraph): Promise<LayoutResult> {
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const sizes: Record<LabelId, Size> = {};
  for (const id of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const t = table[labelRunKey(styled, id)];
    sizes[id] = t === undefined ? { w: 0, h: 0 } : { w: t.width, h: t.height };
  }
  return (await runHostSequence(gridEngine, buildLayoutInput(styled as StyledGraphInput, sizes), {}, METRICS)).result;
}

const lastGoodOf = (styled: StyledGraph, layout: LayoutResult, result: RenderResult): LastGood => ({
  styled,
  layout,
  get svg() {
    return result.svg;
  },
  styleBlock: result.styleBlock,
  paintPlan: result.paintPlan,
});

/** The DOM a full render gives, serialised the way the canvas's own is. */
function fullDom(svg: string): { readonly html: string; readonly xml: string } {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  document.body.querySelector('svg.host')!.append(g);
  g.innerHTML = svg;
  const out = { html: g.innerHTML, xml: new XMLSerializer().serializeToString(g.firstElementChild!) };
  g.remove();
  return out;
}

function host(): SVGGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'host');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'rendered');
  svg.append(g);
  document.body.append(svg);
  return g;
}

afterEach(() => {
  document.body.replaceChildren();
});

const CASES: readonly (readonly [string, string, ThemeDoc, ThemeDoc])[] = [
  ...Object.keys(SOURCES)
    .sort()
    .map((path) => [path.replace('../../../corpus/', ''), SOURCES[path]!, neutralLight, neutralDark] as const),
  ['synthetic', SYNTHETIC_DOC, SYNTHETIC_A, SYNTHETIC_B],
];

describe('the paint-only swap leaves exactly the DOM of a full render (F9 P3 oracle)', () => {
  it('covers the whole corpus', () => {
    expect(CASES.length).toBeGreaterThan(25);
  });

  for (const [name, source, first, second] of CASES) {
    it(`${name}: ${first.id} → ${second.id} → ${first.id}`, async () => {
      const a = styleUnder(source, first);
      const b = styleUnder(source, second);
      const layout = await layOut(a.styled);
      const wrapper = host();

      const fullA = render(a.styled, layout, a.theme);
      expect(showLastGood(wrapper, lastGoodOf(a.styled, layout, fullA), null)).toBe(false);

      const toB = renderPaintOnly(fullA, b.styled, layout);
      expect(toB, 'a paint-only switch').not.toBeNull();
      expect(showLastGood(wrapper, lastGoodOf(b.styled, layout, toB!), fullA.paintPlan)).toBe(true);
      const expectedB = fullDom(render(b.styled, layout, b.theme).svg);
      expect(wrapper.innerHTML).toBe(expectedB.html);
      expect(new XMLSerializer().serializeToString(wrapper.firstElementChild!)).toBe(expectedB.xml);

      const back = renderPaintOnly(toB!, a.styled, layout);
      expect(showLastGood(wrapper, lastGoodOf(a.styled, layout, back!), toB!.paintPlan)).toBe(true);
      expect(wrapper.innerHTML).toBe(fullDom(fullA.svg).html);
    });
  }

  it('replaces the tree when what is on screen is not the tree the render was drawn as', async () => {
    const a = styleUnder(SYNTHETIC_DOC, SYNTHETIC_A);
    const b = styleUnder(SYNTHETIC_DOC, SYNTHETIC_B);
    const layout = await layOut(a.styled);
    const wrapper = host();
    const fullA = render(a.styled, layout, a.theme);
    const toB = renderPaintOnly(fullA, b.styled, layout)!;
    // Something else is on screen (a stored boot picture, say): no swap.
    wrapper.innerHTML = '<svg class="sgl"><style>.x{}</style></svg>';
    expect(showLastGood(wrapper, lastGoodOf(b.styled, layout, toB), null)).toBe(false);
    expect(wrapper.innerHTML).toBe(fullDom(render(b.styled, layout, b.theme).svg).html);
  });
});
