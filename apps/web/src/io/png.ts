import { pngPlan, rasterCopy, type Size } from '../state/png.js';
import { withEmbeddedFonts } from './fonts.js';

/**
 * D6 (DD-08 §7's PNG row), the DOM half: `lastGood.svg`'s
 * rasterisation-only copy (`state/png.ts`) with the Inter faces it uses
 * embedded (`io/fonts.ts`, the same embedding Save ▾ SVG applies, D2) → a
 * `blob:` `<img>` → `img.decode()` → a canvas at the pixel size →
 * `toBlob('image/png')`. In the lazy `file-actions` chunk.
 *
 * An SVG drawn as an image may load nothing but `data:` URLs, so the fonts
 * must be inside it. Under DD-09 §1.2's CSP this needs `img-src blob:` for
 * the `<img>` and nothing else: the `data:` fonts inside the image document
 * are not subject to the page's `font-src` (checked in Chromium under the
 * real headers, `e2e/csp.spec.ts`).
 */

export type PngResult = ({ readonly ok: true; readonly blob: Blob } & Size) | { readonly ok: false; readonly message: string };

export interface RasterizeOptions {
  /** Embed Inter (default). `false` only for tests: it draws the trap, a
   *  fallback face. */
  readonly embedFonts?: boolean;
}

const FAILED = 'Could not make the PNG: the browser could not draw the diagram at that size. Try a smaller scale, or save the SVG.';

/** `svg` as a PNG at `scale`, or why not (the size cap is checked first,
 *  before anything is fetched or drawn). */
export async function rasterizePng(svg: string, scale: number, { embedFonts = true }: RasterizeOptions = {}): Promise<PngResult> {
  const plan = pngPlan(svg, scale);
  if (!plan.ok) return plan;
  const px = { width: plan.width, height: plan.height };
  let copy = rasterCopy(svg, px);
  if (embedFonts) {
    try {
      copy = await withEmbeddedFonts(copy);
    } catch {
      return { ok: false, message: 'Could not make the PNG: the diagram’s font (Inter) could not be loaded.' };
    }
  }
  const url = URL.createObjectURL(new Blob([copy], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = px.width;
    canvas.height = px.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return { ok: false, message: FAILED };
    ctx.drawImage(img, 0, 0, px.width, px.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) return { ok: false, message: FAILED };
    return { ok: true, blob, ...px };
  } catch {
    return { ok: false, message: FAILED };
  } finally {
    URL.revokeObjectURL(url);
  }
}
