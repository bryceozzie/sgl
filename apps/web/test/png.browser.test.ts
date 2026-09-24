import { describe, expect, it } from 'vitest';
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import { rasterizePng } from '../src/io/png.js';
import { createHarness } from './harness.js';

/**
 * D6's rasteriser in a real browser (DD-08 §7's PNG row): `lastGood.svg` →
 * the rasterisation-only copy with Inter embedded → `<img>` → canvas →
 * `toBlob`. The trap it exists for: an SVG drawn through `<img>` is an
 * isolated document that cannot use the page's web fonts, so without its own
 * copy of Inter every label would be drawn in a fallback face, the wrong shape
 * and width for the layout it was measured for.
 */

async function lastGoodSvg(source: string): Promise<string> {
  const h = await createHarness(source);
  await h.settle();
  const svg = h.pipeline.lastGood.peek()?.svg;
  h.dispose();
  if (svg === undefined) throw new Error('nothing rendered');
  return svg;
}

async function decode(blob: Blob): Promise<{ readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

async function png(svg: string, scale: 1 | 2 | 3, embedFonts = true): Promise<Blob> {
  const result = await rasterizePng(svg, scale, { embedFonts });
  if (!result.ok) throw new Error(result.message);
  expect(result.blob.type).toBe('image/png');
  return result.blob;
}

const DOC = 'a: "Alpha label"\nb: { @shape: round, @label: "Beta" }\na -> b: "an edge"\n';

describe('size', () => {
  it('is the SVG’s width and height × the scale, in whole pixels', async () => {
    const svg = await lastGoodSvg(DOC);
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const w = Number(root.getAttribute('width'));
    const h = Number(root.getAttribute('height'));
    for (const scale of [1, 2, 3] as const) {
      const out = await decode(await png(svg, scale));
      expect({ width: out.width, height: out.height }).toEqual({ width: Math.round(w * scale), height: Math.round(h * scale) });
    }
  });
});

describe('background', () => {
  const hex = (d: Uint8ClampedArray, i: number): string =>
    `#${[d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  it('is the SVG’s own .canvas colour, edge to edge, under either theme', async () => {
    const seen: string[] = [];
    for (const theme of ['neutral-light', 'neutral-dark']) {
      const svg = await lastGoodSvg(`@theme: "${theme}"\n${DOC}`);
      const expected = /\.canvas\{fill:(#[0-9A-Fa-f]{6})\}/.exec(svg)![1]!.toUpperCase();
      const out = await decode(await png(svg, 2));
      const last = (out.width * out.height - 1) * 4;
      for (const i of [0, (out.width - 1) * 4, last - (out.width - 1) * 4, last]) {
        expect(hex(out.data, i)).toBe(expected);
        expect(out.data[i + 3]).toBe(255);
      }
      seen.push(expected);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('the text is Inter', () => {
  const TEXT = 'Hamburgefontsiv WAVE 0123 illicit';
  const SIZE = 32;
  const WEIGHTS = [400, 500, 600] as const;
  const ROW = 56;
  // One row per bundled weight, in the renderer's own font stack.
  const PROBE = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="${ROW * 3}" viewBox="0 0 720 ${ROW * 3}"><style>.canvas{fill:#FFFFFF}
text{font-family:Inter, system-ui, -apple-system, &apos;Segoe UI&apos;, Roboto, sans-serif;font-size:${SIZE}px;fill:#000000}
${WEIGHTS.map((w, i) => `.w${i}{font-weight:${w}}`).join('\n')}</style><rect class="canvas" x="0" y="0" width="720" height="${ROW * 3}"/>${WEIGHTS.map((_, i) => `<text class="w${i}" x="10" y="${ROW * i + 42}">${TEXT}</text>`).join('')}</svg>`;

  /** The rightmost dark pixel of each row: the ink's extent. */
  function inkRight(out: { readonly width: number; readonly data: Uint8ClampedArray }, row: number): number {
    let right = -1;
    for (let y = row * ROW; y < (row + 1) * ROW; y++) {
      for (let x = 0; x < out.width; x++) if (out.data[(y * out.width + x) * 4]! < 128) right = Math.max(right, x);
    }
    return right;
  }

  /** Where Inter's own metrics put that edge: the page loads the same WOFF2
   *  files and measures with canvas `measureText`. */
  async function interInkRight(): Promise<number[]> {
    const urls = { 400: inter400, 500: inter500, 600: inter600 };
    for (const w of WEIGHTS) {
      const face = new FontFace('InterProbe', `url(${urls[w]})`, { weight: String(w) });
      await face.load();
      document.fonts.add(face);
    }
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
    return WEIGHTS.map((w) => {
      ctx.font = `${w} ${SIZE}px InterProbe`;
      return 10 + ctx.measureText(TEXT).actualBoundingBoxRight;
    });
  }

  it('embedded: the ink ends where Inter’s metrics say, for every weight', async () => {
    const out = await decode(await png(PROBE, 1));
    const expected = await interInkRight();
    // Within the ink's own antialiasing (a pixel counts as ink past half
    // coverage) and the glyph box's rounding: a fallback face misses by far
    // more over a 500 px run (next test; ~30 px in headless Chromium).
    WEIGHTS.forEach((_, i) => expect(Math.abs(inkRight(out, i) - expected[i]!), `weight ${WEIGHTS[i]}`).toBeLessThanOrEqual(3));
  });

  it('without embedding (the trap), a fallback face is drawn instead: the probe tells them apart', async () => {
    const withFont = await decode(await png(PROBE, 1));
    const without = await decode(await png(PROBE, 1, false));
    let differing = 0;
    for (let i = 0; i < withFont.data.length; i += 4) if (Math.abs(withFont.data[i]! - without.data[i]!) > 64) differing += 1;
    expect(differing).toBeGreaterThan(200);
    const expected = await interInkRight();
    expect(WEIGHTS.some((_, i) => Math.abs(inkRight(without, i) - expected[i]!) > 10)).toBe(true);
  });

  it('a real diagram’s labels change with the font too', async () => {
    const svg = await lastGoodSvg(DOC);
    const a = await decode(await png(svg, 2));
    const b = await decode(await png(svg, 2, false));
    let differing = 0;
    for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i]! - b.data[i]!) > 64) differing += 1;
    expect(differing).toBeGreaterThan(50);
  });
});

describe('the cap', () => {
  it('refuses before drawing anything, with the reason', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="40" viewBox="0 0 6000 40"><style>.canvas{fill:#FFFFFF}</style></svg>';
    const result = await rasterizePng(svg, 3);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('Try 2×');
  });
});
