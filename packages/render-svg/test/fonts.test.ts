import { readFileSync } from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { parseInline } from '@sgl/core/inline';
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

  // A 30 s timeout (07 §2): the whole corpus renders here, ~1.8 s quiet.
  it('every corpus document, embedded', async () => {
    for (const doc of listCorpusDocs()) {
      const { svg } = (await renderCorpusDoc(doc)).rendered;
      const out = embedFonts(svg, INTER);
      expect(XMLValidator.validate(out), doc).toBe(true);
      expect(out.match(/<style>/g)?.length ?? 0, doc).toBe(svg.match(/<style>/g)?.length ?? 0);
    }
  }, 30_000);

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

/**
 * DD-11 T50: with run rules (`.r-em`, `.r-code`, `.r-strong`), faces are chosen
 * per element — each `<text>`'s own face, and each run tspan's face (its `r-`
 * rules over what it inherits from its `<text>`) — never as the cross product
 * of every family, weight and style any rule names. The app ships A18's faces
 * (T26), so the full set is given here.
 */
describe('usedFontFaces per element, with run rules (DD-11 T50)', () => {
  const ALL: readonly EmbeddedFont[] = [
    ...[400, 500, 600, 700].map((weight) => ({ family: 'Inter', weight, style: 'normal', woff2Base64: 'AAAA' })),
    ...[400, 500, 600, 700].map((weight) => ({ family: 'Inter', weight, style: 'italic', woff2Base64: 'BBBB' })),
    ...[400, 700].map((weight) => ({ family: 'IBM Plex Mono', weight, style: 'normal', woff2Base64: 'CCCC' })),
  ];
  const INLINE = { inline: parseInline };
  const used = async (source: string): Promise<string[]> => {
    const { rendered } = await runPipeline(source, undefined, undefined, {}, undefined, INLINE);
    return usedFontFaces(rendered.svg, ALL).map((f) => `${f.family} ${f.style} ${f.weight}`);
  };

  it('one italic edge label adds Inter italic 400 only, not an italic for every weight', async () => {
    expect(await used('a: "A"\nb: "B"\na -> b: "*async*"\n')).toEqual(['Inter italic 400', 'Inter normal 500']);
  });

  it('a label drawn only in marks does not need its plain face', async () => {
    expect(await used('a: "**A**"\n')).toEqual(['Inter normal 700']);
    expect(await used('a: "**A** b"\n')).toEqual(['Inter normal 500', 'Inter normal 700']);
  });

  it('em at each role\'s base weight: node 500, container 600, edge 400; strong and em together is 700 italic', async () => {
    expect(await used('g: { @label: "*G*", n: { @label: "*N* ***both***" } }\nx\ng.n -> x: "*e*"\n')).toEqual([
      'Inter italic 400',
      'Inter italic 500',
      'Inter italic 600',
      'Inter italic 700',
      'Inter normal 500',
    ]);
  });

  it('code is IBM Plex Mono 400, strong code is Plex 700, and never italic', async () => {
    expect(await used('a: "`x`"\n')).toEqual(['IBM Plex Mono normal 400']);
    expect(await used('a: "**`x`**"\n')).toEqual(['IBM Plex Mono normal 700']);
    expect(await used('a: "*`x`*"\n')).toEqual(['IBM Plex Mono normal 400']);
  });

  /**
   * Fix round 1, item 6: pinned, not compared with itself. The golden is the
   * selection `usedFontFaces` made at `24e5638` (before T50), over the same
   * ten shipped faces, for every corpus document's render; generated once
   * with that commit's `fonts.ts` and not regenerated by this test.
   */
  it('an SVG with no run classes gets exactly the selection it had before T50 (the corpus, pinned at 24e5638)', async () => {
    const pinned = JSON.parse(readFileSync(new URL('./__goldens__/fonts/corpus-faces.json', import.meta.url), 'utf8')) as Record<string, string[]>;
    const docs = [...listCorpusDocs()].sort();
    expect(Object.keys(pinned)).toEqual(docs);
    for (const doc of docs) {
      const { svg } = (await renderCorpusDoc(doc)).rendered;
      expect(svg).not.toMatch(/class="r-/);
      expect(usedFontFaces(svg, ALL).map((f) => `${f.family} ${f.style} ${f.weight}`), doc).toEqual(pinned[doc]);
    }
  });

  it('embeds the chosen faces, sorted, and the file stays well-formed', async () => {
    const { rendered } = await runPipeline('a: "**Pay** `v2` *it*"\nb\na -> b: "***x***"\n', undefined, undefined, {}, undefined, INLINE);
    const out = embedFonts(rendered.svg, ALL);
    expect(XMLValidator.validate(out)).toBe(true);
    expect(faces(out).map((f) => /font-family:'([^']*)';font-style:(\w+);font-weight:(\d+)/.exec(f)!.slice(1).join(' '))).toEqual([
      'IBM Plex Mono normal 400',
      'Inter italic 500',
      'Inter italic 700',
      'Inter normal 500',
      'Inter normal 700',
    ]);
    expect(out.replace(/@font-face\{[^}]*\}\n/g, '')).toBe(rendered.svg);
  });
});
