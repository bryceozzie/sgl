import { neutralDark, neutralLight, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { listCorpusDocs, renderCorpusDoc } from './pipeline.js';

/**
 * F17 (execution plan §2.1, DD-07 §6): Inkscape 1.2.2 discards a **whole**
 * `<style>` element when it meets the theme-token rule
 * `svg.sgl{--sgl-canvas:…;--accent:…}`, so every shape in an exported SVG fell
 * back to the default black fill. The fix keeps the tokens (a consumer can
 * still override them) but moves them into a `<style>` element of their own,
 * after the main one, so a tool that drops that element loses only the tokens,
 * never the rules that paint the diagram. And no rule outside the token element
 * may read a token with `var()`: a tool that dropped the token element would
 * leave that rule with nothing to resolve against.
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

describe('F17: theme tokens live in their own <style> element, after the main one (DD-07 §6)', () => {
  for (const { doc, theme } of RUNS) {
    it(`${doc} under ${theme.id}`, async () => {
      const { rendered } = await renderCorpusDoc(doc, theme);
      const elements = styleElements(rendered.svg);
      expect(elements, 'exactly two <style> elements: main, then tokens').toHaveLength(2);
      const [main, tokens] = elements.map(parseCss) as [readonly CssRule[], readonly CssRule[]];

      // The main element: no custom-property declaration anywhere in it — the
      // bisected cause of Inkscape dropping the whole element — and no `var()`.
      const mainTokens = main.flatMap((r) => r.declarations.filter((d) => isToken(d.property)).map((d) => `${r.selector} ${d.property}`));
      expect(mainTokens, 'custom properties in the main <style>').toEqual([]);
      const mainVars = main.flatMap((r) => r.declarations.filter((d) => d.value.includes('var(')).map((d) => `${r.selector} ${d.property}`));
      expect(mainVars, 'var() in the main <style>').toEqual([]);
      expect(main.length).toBeGreaterThan(0);

      // The canvas gets its literal resolved colour, the same one `--sgl-canvas` carries.
      const canvas = main.find((r) => r.selector === '.canvas');
      const canvasToken = tokens[0]?.declarations.find((d) => d.property === '--sgl-canvas');
      expect(canvas?.declarations).toEqual([{ property: 'fill', value: canvasToken?.value }]);

      // The token element: exactly one rule, scoped to the root `svg.sgl`
      // (never `:root`), holding custom properties and nothing else.
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.selector).toBe('svg.sgl');
      expect(tokens[0]!.declarations.filter((d) => !isToken(d.property))).toEqual([]);
      expect(tokens[0]!.declarations.filter((d) => d.value.includes('var('))).toEqual([]);
      expect(tokens[0]!.declarations.length).toBeGreaterThan(1);

      // `RenderResult.styleBlock` is the main element's text and `tokenBlock`
      // the token element's, so a caller re-theming an exported file gets
      // exactly what is in it.
      expect(rendered.styleBlock).toBe(elements[0]);
      expect(rendered.tokenBlock).toBe(elements[1]);

      // Nothing else in the file names a custom property either.
      const outsideStyles = rendered.svg.replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/g, '');
      expect(outsideStyles).not.toContain('var(');
      expect(outsideStyles).not.toMatch(/--[A-Za-z0-9_-]+\s*:/);
    });
  }

  it('the token element comes right after the main one, before <defs>', async () => {
    const { rendered } = await renderCorpusDoc('checkout.sgl');
    expect(rendered.svg).toMatch(/<\/desc><style>[^<]*<\/style><style>svg\.sgl\{[^<]*\}<\/style><defs>/);
  });
});
