import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { embedFonts, usedFontFaces, type EmbeddedFont } from '../src/fonts.js';
import { listCorpusDocs, renderCorpusDoc, runPipeline } from './pipeline.js';

/**
 * D2 (DD-07 §9): an exported SVG carries the fonts it uses. `embedFonts` is the
 * pure half, called by the application at export (Save ▾ SVG, Copy SVG and the
 * PNG's rasterisation-only copy) and by a future CLI: it never runs inside
 * `render()`, so no golden changes.
 */

// Not real WOFF2: `embedFonts` copies base64 through and never decodes it.
// The app's e2e suite checks the shipped files byte for byte.
const INTER: readonly EmbeddedFont[] = [
  { family: 'Inter', weight: 400, style: 'normal', woff2Base64: 'AAAA' },
  { family: 'Inter', weight: 500, style: 'normal', woff2Base64: 'BBBB' },
  { family: 'Inter', weight: 600, style: 'normal', woff2Base64: 'CC==' },
];

const STACK = 'Inter, system-ui, -apple-system, &apos;Segoe UI&apos;, Roboto, sans-serif';

/** A minimal SVG in `render()`'s own shape: one `<style>`, escaped as it escapes. */
const svgWith = (css: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><title id="sgl-t">t</title><style>${css}</style><rect class="canvas" x="0" y="0" width="10" height="10"/></svg>`;

/** The text of the (one) `<style>` element, XML entities decoded. */
function styleText(svg: string): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(svg);
  if (m === null) throw new Error('no <style>');
  return m[1]!.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const faces = (svg: string): string[] => styleText(svg).split('\n').filter((l) => l.startsWith('@font-face'));
const weightsOf = (svg: string): number[] => faces(svg).map((f) => Number(/font-weight:(\d+)/.exec(f)![1]));

describe('embedFonts: the used faces, first in the one <style>', () => {
  it('checkout.sgl uses 400, 500 and 600: one @font-face each, as data: URLs, ahead of the rules', async () => {
    const { svg } = (await renderCorpusDoc('checkout.sgl')).rendered;
    const out = embedFonts(svg, INTER);
    expect(faces(out)).toEqual([
      "@font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,AAAA) format('woff2')}",
      "@font-face{font-family:'Inter';font-style:normal;font-weight:500;src:url(data:font/woff2;base64,BBBB) format('woff2')}",
      "@font-face{font-family:'Inter';font-style:normal;font-weight:600;src:url(data:font/woff2;base64,CC==) format('woff2')}",
    ]);
    expect(styleText(out).startsWith('@font-face')).toBe(true);
    expect(out.match(/<style>/g)).toHaveLength(1);
  });

  it('changes nothing else: removing the faces gives back render()’s bytes', async () => {
    const { svg } = (await renderCorpusDoc('checkout.sgl')).rendered;
    const out = embedFonts(svg, INTER);
    expect(out.replace(/@font-face\{[^}]*\}\n/g, '')).toBe(svg);
  });

  it('embeds only the weights the style rules name', () => {
    expect(weightsOf(embedFonts(svgWith(`.g-1{font-family:${STACK};font-size:13px;font-weight:500}`), INTER))).toEqual([500]);
    expect(weightsOf(embedFonts(svgWith(`.g-1{font-family:${STACK};font-weight:600}\n.g-2{font-family:${STACK};font-weight:400}`), INTER))).toEqual([400, 600]);
  });

  it('a family with no font-weight is drawn at 400, CSS’s normal', () => {
    expect(weightsOf(embedFonts(svgWith(`.g-1{font-family:${STACK};font-size:13px}`), INTER))).toEqual([400]);
    expect(weightsOf(embedFonts(svgWith(`text{font-family:${STACK}}\n.w{font-weight:600}`), INTER))).toEqual([400, 600]);
  });

  it('a weight with no face of its own gets the face CSS font matching would pick', () => {
    expect(weightsOf(embedFonts(svgWith(`.g{font-family:Inter;font-weight:700}`), INTER))).toEqual([600]);
    expect(weightsOf(embedFonts(svgWith(`.g{font-family:Inter;font-weight:bold}`), INTER))).toEqual([600]);
    expect(weightsOf(embedFonts(svgWith(`.g{font-family:Inter;font-weight:300}`), INTER))).toEqual([400]);
    expect(weightsOf(embedFonts(svgWith(`.g{font-family:Inter;font-weight:450}`), INTER))).toEqual([500]);
  });

  it('only families the SVG names; family names match case-insensitively, as in CSS', () => {
    const other: EmbeddedFont = { family: 'Other Sans', weight: 400, style: 'normal', woff2Base64: 'DDDD' };
    expect(faces(embedFonts(svgWith(`.g{font-family:inter}`), [...INTER, other]))).toHaveLength(1);
    expect(faces(embedFonts(svgWith(`.g{font-family:&apos;Other Sans&apos;, sans-serif}`), [...INTER, other]))).toEqual([
      "@font-face{font-family:'Other Sans';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,DDDD) format('woff2')}",
    ]);
  });

  it('an italic rule uses the normal face when that is all there is (the browser slants it)', () => {
    expect(weightsOf(embedFonts(svgWith(`.g{font-family:Inter;font-style:italic;font-weight:500}`), INTER))).toEqual([500]);
  });
});

describe('embedFonts: nothing to embed', () => {
  it('an SVG with no text is returned as it is', async () => {
    // Two boxes and an arrow, no label anywhere: no text rule is emitted.
    const { svg } = (await runPipeline('a: { @label: "" }\nb: { @label: "" }\na -> b\n')).rendered;
    expect(svg).toContain('<path class="e-path');
    expect(svg).not.toContain('font-family');
    expect(embedFonts(svg, INTER)).toBe(svg);
  });

  it('the empty corpus document too', async () => {
    const { svg } = (await renderCorpusDoc('empty.sgl')).rendered;
    expect(embedFonts(svg, INTER)).toBe(svg);
  });

  it('no fonts supplied, or none of the used family', () => {
    const svg = svgWith(`.g{font-family:${STACK};font-weight:500}`);
    expect(embedFonts(svg, [])).toBe(svg);
    expect(embedFonts(svg, [{ family: 'Mono', weight: 500, style: 'normal', woff2Base64: 'AAAA' }])).toBe(svg);
  });

  it('no <style> element', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>';
    expect(embedFonts(svg, INTER)).toBe(svg);
  });
});

describe('usedFontFaces: what the caller needs to fetch', () => {
  it('picks from descriptors that have no bytes yet', () => {
    const candidates = [
      { family: 'Inter', weight: 600, style: 'normal', url: '/600.woff2' },
      { family: 'Inter', weight: 400, style: 'normal', url: '/400.woff2' },
      { family: 'Inter', weight: 500, style: 'normal', url: '/500.woff2' },
    ];
    expect(usedFontFaces(svgWith(`.g{font-family:Inter;font-weight:600}`), candidates).map((c) => c.url)).toEqual(['/600.woff2']);
    expect(usedFontFaces(svgWith('.canvas{fill:#FFFFFF}'), candidates)).toEqual([]);
  });
});

describe('determinism', () => {
  it('byte-stable, and independent of the order the fonts are given in', async () => {
    const { svg } = (await renderCorpusDoc('checkout.sgl')).rendered;
    const a = embedFonts(svg, INTER);
    expect(embedFonts(svg, INTER)).toBe(a);
    expect(embedFonts(svg, [...INTER].reverse())).toBe(a);
  });

  it('two faces for one slot: the first given wins, whatever else is in the list', () => {
    const dup: EmbeddedFont = { family: 'Inter', weight: 400, style: 'normal', woff2Base64: 'ZZZZ' };
    expect(faces(embedFonts(svgWith('.g{font-family:Inter}'), [INTER[0]!, dup]))[0]).toContain('base64,AAAA)');
    expect(faces(embedFonts(svgWith('.g{font-family:Inter}'), [dup, INTER[0]!]))[0]).toContain('base64,ZZZZ)');
  });
});

describe('escaping: the output stays well-formed XML with one <style>', () => {
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: false });

  it('every corpus document, embedded', async () => {
    for (const doc of listCorpusDocs()) {
      const { svg } = (await renderCorpusDoc(doc)).rendered;
      const out = embedFonts(svg, INTER);
      expect(XMLValidator.validate(out), doc).toBe(true);
      expect(out.match(/<style>/g)?.length ?? 0, doc).toBe(svg.match(/<style>/g)?.length ?? 0);
    }
  });

  it('a hostile family name is escaped for CSS and then for XML', () => {
    const family = "Evil'</style><script>alert(1)</script>&\\";
    // The SVG names it as `render()` would write any quoted family.
    const svg = svgWith(`.g{font-family:&apos;Evil&apos;}`);
    const out = embedFonts(
      svgWith(`.g{font-family:${family.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')}}`),
      [{ family, weight: 400, style: 'normal', woff2Base64: 'AAAA' }],
    );
    expect(XMLValidator.validate(out)).toBe(true);
    expect(out).not.toContain('<script');
    expect(out.match(/<style>/g)).toHaveLength(1);
    const root = parser.parse(out) as { svg: { style: string } };
    expect(root.svg.style).toContain("font-family:'Evil\\'</style><script>alert(1)</script>&\\\\'");
    expect(embedFonts(svg, INTER)).toBe(svg); // `Evil` is not Inter.
  });

  it('refuses a caller’s bad input rather than writing it into the file', () => {
    const svg = svgWith('.g{font-family:Inter}');
    expect(() => embedFonts(svg, [{ family: 'Inter', weight: 400, style: 'normal', woff2Base64: 'AA)A' }])).toThrow(/base64/);
    expect(() => embedFonts(svg, [{ family: 'Inter', weight: 400, style: 'normal;x', woff2Base64: 'AAAA' }])).toThrow(/style/);
    expect(() => embedFonts(svg, [{ family: 'Inter', weight: 4000, style: 'normal', woff2Base64: 'AAAA' }])).toThrow(/weight/);
  });
});
