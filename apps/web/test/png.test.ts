import { describe, expect, it } from 'vitest';
import { saveFileName } from '../src/state/filename.js';
import {
  DEFAULT_PNG_SCALE,
  MAX_PNG_PIXELS,
  MAX_PNG_SIDE,
  PNG_SCALES,
  pngPlan,
  rasterCopy,
  svgSize,
} from '../src/state/png.js';

/** D6 (DD-08 §7's PNG row), DOM-free: the size, the cap and the
 *  rasterisation-only copy of `lastGood.svg`. The DOM half (`<img>` → canvas
 *  → `toBlob`) is `png.browser.test.ts` and `e2e/png-export.spec.ts`. */

const SVG = (w: string, h: string, style = '.canvas{fill:#F7F8FA}') =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="sgl" data-sgl="1.0" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><style>${style}</style><rect class="canvas" x="0" y="0" width="${w}" height="${h}"/></svg>`;

describe('scales', () => {
  it('1×, 2× and 3×, 2× by default', () => {
    expect(PNG_SCALES).toEqual([1, 2, 3]);
    expect(DEFAULT_PNG_SCALE).toBe(2);
  });
});

describe('svgSize: the root element’s own width and height', () => {
  it('reads them, decimals included', () => {
    expect(svgSize(SVG('456', '235.188'))).toEqual({ width: 456, height: 235.188 });
  });

  it('reads the root only, not a nested rect’s', () => {
    expect(svgSize('<svg height="20" xmlns="http://www.w3.org/2000/svg" width="10"><rect width="999" height="999"/></svg>')).toEqual({ width: 10, height: 20 });
  });

  it('is null for anything it cannot size', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeNull();
    expect(svgSize(SVG('0', '10'))).toBeNull();
    expect(svgSize(SVG('abc', '10'))).toBeNull();
    expect(svgSize('not svg')).toBeNull();
  });
});

describe('pngPlan: width × scale by height × scale, capped', () => {
  it('multiplies and rounds to whole pixels', () => {
    expect(pngPlan(SVG('456', '235.188'), 1)).toEqual({ ok: true, width: 456, height: 235 });
    expect(pngPlan(SVG('456', '235.188'), 2)).toEqual({ ok: true, width: 912, height: 470 });
    expect(pngPlan(SVG('456', '235.188'), 3)).toEqual({ ok: true, width: 1368, height: 706 });
  });

  it('never rounds a side down to nothing', () => {
    expect(pngPlan(SVG('0.2', '0.2'), 1)).toEqual({ ok: true, width: 1, height: 1 });
  });

  it('refuses a side over 16 384 px, and names a scale that fits', () => {
    expect(MAX_PNG_SIDE).toBe(16384);
    expect(pngPlan(SVG('5461', '40'), 3)).toMatchObject({ ok: true, width: 16383 });
    const refused = pngPlan(SVG('6000', '40'), 3);
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) return;
    expect(refused.message).toContain('18,000 × 120');
    expect(refused.message).toContain('16,384');
    expect(refused.message).toContain('Try 2×');
    expect(pngPlan(SVG('6000', '40'), 2)).toMatchObject({ ok: true, width: 12000, height: 80 });
  });

  it('refuses over 64 Mpx in all even when each side fits', () => {
    expect(MAX_PNG_PIXELS).toBe(8192 * 8192);
    expect(pngPlan(SVG('4096', '4096'), 2)).toMatchObject({ ok: true, width: 8192, height: 8192 });
    const refused = pngPlan(SVG('5000', '5000'), 2);
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) return;
    expect(refused.message).toContain('10,000 × 10,000');
    expect(refused.message).toContain('Try 1×');
  });

  it('with no scale that fits, points at SVG instead', () => {
    const refused = pngPlan(SVG('20000', '10'), 1);
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) return;
    expect(refused.message).not.toContain('Try');
    expect(refused.message).toContain('SVG');
  });

  it('refuses an SVG it cannot size', () => {
    expect(pngPlan('<svg xmlns="http://www.w3.org/2000/svg"/>', 2)).toMatchObject({ ok: false });
  });
});

describe('the rasterisation-only copy (its fonts: @sgl/render-svg’s fonts.test.ts)', () => {
  it('draws at the pixel size: width and height replaced, the viewBox kept, stretched to fill', () => {
    const out = rasterCopy(SVG('456', '235.188'), { width: 912, height: 470 });
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" class="sgl" data-sgl="1.0" width="912" height="470" viewBox="0 0 456 235.188" preserveAspectRatio="none" role="img">')).toBe(true);
    // The nested .canvas rect is untouched.
    expect(out).toContain('<rect class="canvas" x="0" y="0" width="456" height="235.188"/>');
  });

  it('leaves lastGood.svg itself alone (a copy, not an edit)', () => {
    const svg = SVG('10', '10');
    const before = svg;
    rasterCopy(svg, { width: 20, height: 20 });
    expect(svg).toBe(before);
  });
});

describe('the file name', () => {
  it('{title}.png, sanitised like the rest', () => {
    expect(saveFileName('png', 'Checkout Flow')).toBe('Checkout Flow.png');
    expect(saveFileName('png', 'a/b', '.txt')).toBe('a-b.png');
  });
});
