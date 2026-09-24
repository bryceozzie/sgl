import type { SemanticGraph } from '@sgl/core';
import { neutralDark, neutralLight, resolveTheme, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { render } from '../src/index.js';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { listCorpusDocs, renderCorpusDoc } from './pipeline.js';

/**
 * F17 (execution plan §2.1, DD-07 §6): Inkscape 1.2.2 discards a **whole**
 * `<style>` element when it meets a rule of custom properties
 * (`svg.sgl{--sgl-canvas:…;--accent:…}`), so every shape in an exported SVG
 * fell back to the default black fill. F17 moved the tokens into an element of
 * their own; F18 (human decision 2026-09-24) then dropped re-theming an
 * exported file by overriding them, and the Stage L re-baseline removed that
 * vestigial element. What stays is F17's guarantee: the file has exactly one
 * `<style>` element and it never contains a custom property, declared or read
 * with `var()`, and nothing else in the file names one either.
 *
 * Asserted over the whole corpus — every document under `neutral-light`, the
 * clean ones under `neutral-dark` too (the same split as `render.test.ts`'s
 * double-run sweep) — by reading the rendered SVG string back, not by calling
 * `buildStyleBlock` directly, so the test holds for what actually ships.
 */

interface CssRule {
  readonly selector: string;
  readonly declarations: readonly { readonly property: string; readonly value: string }[];
}

/** The text content of every `<style>` element, in document order, with the
 *  XML entities `escapeXml` writes decoded back to the CSS the parser sees. */
function styleElements(svg: string): readonly string[] {
  return [...svg.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map((m) => decodeXml(m[1]!));
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * A strict parser for the flat CSS the renderer writes: a sequence of
 * `selector{decl;decl}` rules, whitespace between them, no at-rules, no
 * comments, no nested braces. Anything else throws, so the test fails loudly
 * rather than skipping an unparsed tail. Every value the renderer writes goes
 * through `cssColor`/`cssFontFamily`/`cssKeyword`/`num` (DD-07 §8), none of
 * which admits `;`, `{` or `}`, so splitting on them is exact.
 */
function parseCss(text: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  const re = /\s*([^{}]+?)\s*\{([^{}]*)\}\s*/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) throw new Error(`unparseable CSS at offset ${at}: ${JSON.stringify(text.slice(at, at + 60))}`);
    const declarations = m[2]!
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d !== '')
      .map((d) => {
        const colon = d.indexOf(':');
        if (colon <= 0) throw new Error(`malformed declaration ${JSON.stringify(d)} in ${m[1]}`);
        return { property: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() };
      });
    rules.push({ selector: m[1]!, declarations });
    at = re.lastIndex;
  }
  return rules;
}

const isToken = (property: string): boolean => property.startsWith('--');

const RUNS: readonly { readonly doc: string; readonly theme: ThemeDoc }[] = [
  ...listCorpusDocs().map((doc) => ({ doc, theme: neutralLight })),
  ...CLEAN_DOCS.map((doc) => ({ doc, theme: neutralDark })),
];

describe('F17/F18: one <style> element, with no custom property in it (DD-07 §6)', () => {
  for (const { doc, theme } of RUNS) {
    it(`${doc} under ${theme.id}`, async () => {
      const { rendered, styled } = await renderCorpusDoc(doc, theme);
      const elements = styleElements(rendered.svg);
      expect(elements, 'exactly one <style> element').toHaveLength(1);
      const main = parseCss(elements[0]!);

      // No custom-property declaration anywhere in it — the bisected cause of
      // Inkscape dropping the whole element — and no `var()`.
      const mainTokens = main.flatMap((r) => r.declarations.filter((d) => isToken(d.property)).map((d) => `${r.selector} ${d.property}`));
      expect(mainTokens, 'custom properties in the <style>').toEqual([]);
      const mainVars = main.flatMap((r) => r.declarations.filter((d) => d.value.includes('var(')).map((d) => `${r.selector} ${d.property}`));
      expect(mainVars, 'var() in the <style>').toEqual([]);
      expect(main.some((r) => r.selector === 'svg.sgl' || r.selector === ':root'), 'a token rule').toBe(false);
      expect(main.length).toBeGreaterThan(0);

      // The canvas gets its literal resolved colour.
      const canvas = main.find((r) => r.selector === '.canvas');
      expect(canvas?.declarations).toEqual([{ property: 'fill', value: styled.canvas.background }]);

      // `RenderResult.styleBlock` is exactly that element's text.
      expect(rendered.styleBlock).toBe(elements[0]);
      expect(Object.keys(rendered).sort()).not.toContain('tokenBlock');

      // Nothing else in the file names a custom property either.
      const outsideStyles = rendered.svg.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/g, '');
      expect(outsideStyles).not.toContain('var(');
      expect(outsideStyles).not.toMatch(/--[A-Za-z0-9_-]+\s*:/);
    });
  }

  it('the <style> element comes right after <desc>, before <defs>', async () => {
    const { rendered } = await renderCorpusDoc('checkout.sgl');
    expect(rendered.svg).toMatch(/<\/desc><style>\.canvas\{[^<]*<\/style><defs>/);
  });
});

/**
 * The injection half (DD-07 §8, DD-09 §1.2): the theme's tokens never reach the
 * output now, so a hostile token name or value cannot either; the canvas
 * background still does, through `cssColor`. Driven with break-out attempts,
 * straight into `render()`.
 */
describe('F17/F18: nothing hostile from the theme reaches the <style> unescaped (DD-07 §8)', () => {
  it('hostile token names and values are not emitted, and a hostile canvas background is the loud fallback', () => {
    const { value: base } = resolveTheme(neutralLight, (id) => (id === neutralLight.id ? neutralLight : undefined));
    const breakOut = '</style><script>alert(1)</script><style>';
    const theme: ResolvedTheme = {
      ...base,
      tokens: {
        ...base.tokens,
        [`x}${breakOut}`]: '#ffffff',
        'evil.color': `#fff;}${breakOut}svg{fill:red`,
        'evil.font': `Inter, '${breakOut}', sans-serif`,
        'evil.keyword': `bold}${breakOut}`,
        'evil.url': 'url(javascript:alert(1))',
      },
    };
    const graph: SemanticGraph = {
      nodes: {},
      edges: [],
      rootChildren: [],
      order: [],
      labels: {},
      meta: { nodeCount: 0, edgeCount: 0, containerCount: 0 },
    };
    const styled: StyledGraph = {
      graph,
      styles: {},
      labelStyles: {},
      canvas: { background: `#fff}${breakOut}` },
      themeId: 'neutral-light',
      geometryHash: 'g',
      paintHash: 'p',
    };
    const { svg, styleBlock } = render(styled, { bounds: { x: 0, y: 0, w: 10, h: 10 }, nodes: {}, edges: {}, labels: [] }, theme);

    expect(XMLValidator.validate(svg)).toBe(true);
    const tree = new XMLParser({ preserveOrder: true }).parse(svg) as { svg?: { style?: unknown; script?: unknown }[] }[];
    const children = tree.find((n) => n.svg !== undefined)!.svg!;
    expect(children.filter((c) => 'script' in c)).toEqual([]);
    expect(children.filter((c) => 'style' in c)).toHaveLength(1);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toContain('evil');

    const elements = styleElements(svg);
    expect(elements).toEqual([styleBlock]);
    expect(styleBlock.split('\n')[0]).toBe('.canvas{fill:#FF00FF}');
    expect(styleBlock).not.toContain('<');
    expect(styleBlock).not.toContain('javascript:');
    expect(styleBlock).not.toContain('--');
  });
});
