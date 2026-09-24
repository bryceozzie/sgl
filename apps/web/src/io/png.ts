import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import { fontFaceRule, pngPlan, rasterCopy, usedFontWeights, type InterWeight, type Size } from '../state/png.js';

/**
 * D6 (DD-08 §7's PNG row), the DOM half: `lastGood.svg`'s
 * rasterisation-only copy (`state/png.ts`) → a `blob:` `<img>` →
 * `img.decode()` → a canvas at the pixel size → `toBlob('image/png')`. In the
 * lazy `file-actions` chunk.
 *
 * The fonts are the very files `fonts.css` loads (Vite gives both the same
 * hashed URL), fetched from our own origin (`connect-src 'self'`; offline,
 * from the service worker's precache) and embedded as `data:` URLs, which is
 * all an SVG drawn as an image may load. Under DD-09 §1.2's CSP this needs
 * `img-src blob:` for the `<img>` and nothing else: the `data:` fonts inside
 * the image document are not subject to the page's `font-src` (checked in
 * Chromium under the real headers, `e2e/csp.spec.ts`).
 */

const FONT_URLS: Readonly<Record<InterWeight, string>> = { 400: inter400, 500: inter500, 600: inter600 };

/** One `@font-face` rule per weight, fetched once per page and kept (a
 *  failure is not kept, so the next export tries again). */
const faces = new Map<InterWeight, Promise<string>>();

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function faceFor(weight: InterWeight): Promise<string> {
  let face = faces.get(weight);
  if (face === undefined) {
    face = fetch(FONT_URLS[weight])
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(readBase64)
      .then((b64) => fontFaceRule(weight, b64));
    face.catch(() => faces.delete(weight));
    faces.set(weight, face);
  }
  return face;
}

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
  let embedded = '';
  if (embedFonts) {
    try {
      embedded = (await Promise.all(usedFontWeights(svg).map(faceFor))).join('\n');
    } catch {
      return { ok: false, message: 'Could not make the PNG: the diagram’s font (Inter) could not be loaded.' };
    }
  }
  const url = URL.createObjectURL(new Blob([rasterCopy(svg, px, embedded)], { type: 'image/svg+xml' }));
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
