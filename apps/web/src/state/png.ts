/**
 * D6 (DD-08 §7's PNG row), DOM-free: how big the PNG is, whether it is too
 * big, and the rasterisation-only copy of `lastGood.svg` that is drawn. The
 * DOM half (`<img>` → canvas → `toBlob`, fetching the fonts) is
 * `io/png.ts`. Both live in the lazy `file-actions` chunk.
 *
 * The copy exists because an SVG drawn through `<img>` is an isolated
 * document: it cannot use the page's web fonts, so without a copy of Inter of
 * its own every label would be drawn in a fallback face, whose glyphs have
 * other shapes and widths than the ones the layout was measured with. The
 * copy carries Inter as `@font-face` rules with `data:` URLs. It is never
 * saved: the exported SVG (Save ▾ SVG, Copy SVG) stays `render()`'s output.
 */

export const PNG_SCALES = [1, 2, 3] as const;
export type PngScale = (typeof PNG_SCALES)[number];
export const DEFAULT_PNG_SCALE: PngScale = 2;

/** No side over 16 384 px: Chromium's and Firefox's per-side canvas limit
 *  (32 767 px) with room to spare, and the largest many image viewers open. */
export const MAX_PNG_SIDE = 16384;
/** No more than 8192² ≈ 67 Mpx in all: 256 MiB of RGBA, which a canvas holds
 *  twice over while `toBlob` encodes. Past this, browsers fail a canvas
 *  silently (a blank image or a `null` blob) rather than with an error. */
export const MAX_PNG_PIXELS = 8192 * 8192;

/** The Inter faces the app bundles (DD-08 §5, `fonts.css`). */
export const INTER_WEIGHTS = [400, 500, 600] as const;
export type InterWeight = (typeof INTER_WEIGHTS)[number];

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The root `<svg>` start tag: `render()` output always opens with it. */
const ROOT = /<svg\b[^>]*>/;

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** The root element's own `width` and `height` (DD-07 §9: `render()` writes
 *  them in user units; scale 1 is one pixel per unit), or `null`. */
export function svgSize(svg: string): Size | null {
  const tag = ROOT.exec(svg)?.[0];
  if (tag === undefined) return null;
  const width = Number(attribute(tag, 'width'));
  const height = Number(attribute(tag, 'height'));
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return null;
  return { width, height };
}

function pixels(size: Size, scale: number): Size {
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

function fits(px: Size): boolean {
  return px.width <= MAX_PNG_SIDE && px.height <= MAX_PNG_SIDE && px.width * px.height <= MAX_PNG_PIXELS;
}

const n = (v: number): string => v.toLocaleString('en');

export type PngPlan = ({ readonly ok: true } & Size) | { readonly ok: false; readonly message: string };

/** The PNG's size in whole pixels — the SVG's width and height × `scale`,
 *  rounded — or why it will not be made. */
export function pngPlan(svg: string, scale: number): PngPlan {
  const size = svgSize(svg);
  if (size === null) return { ok: false, message: 'Could not make a PNG: the SVG has no size.' };
  const px = pixels(size, scale);
  if (fits(px)) return { ok: true, ...px };
  const smaller = [...PNG_SCALES].reverse().find((s) => s < scale && fits(pixels(size, s)));
  return {
    ok: false,
    message:
      `This diagram is too large for a PNG at ${scale}×: ${n(px.width)} × ${n(px.height)} px, and the limit is ` +
      `${n(MAX_PNG_SIDE)} px a side and ${n(MAX_PNG_PIXELS)} px in all. ` +
      (smaller !== undefined ? `Try ${smaller}×, or save the SVG.` : 'Save the SVG instead: it has no size limit.'),
  };
}

/** The bundled Inter weights the SVG's `<style>` asks for; 400, CSS's
 *  default weight, always. */
export function usedFontWeights(svg: string): InterWeight[] {
  const used = new Set<number>([400]);
  for (const m of svg.matchAll(/font-weight:\s*(\d+)/g)) used.add(Number(m[1]));
  return INTER_WEIGHTS.filter((w) => used.has(w));
}

/** One embedded face. Base64 has no character that XML text or CSS would
 *  need escaped. */
export function fontFaceRule(weight: InterWeight, base64: string): string {
  return `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${base64}) format('woff2')}`;
}

/** `faces` put first in the SVG's `<style>` element (DD-07 §6: there is
 *  exactly one), or in a new one when it has none. */
export function embedFontFaces(svg: string, faces: string): string {
  const open = svg.indexOf('<style>');
  if (open >= 0) {
    const at = open + '<style>'.length;
    return `${svg.slice(0, at)}${faces}\n${svg.slice(at)}`;
  }
  return svg.replace(ROOT, (tag) => `${tag}<style>${faces}\n</style>`);
}

/** The rasterisation-only copy: drawn at `px` (the root's `width`/`height`
 *  set to the pixel size, the `viewBox` kept, so the vectors are drawn at the
 *  final resolution rather than a 1× bitmap scaled up), with `faces`
 *  embedded. `preserveAspectRatio="none"` makes the picture fill every pixel:
 *  rounding to whole pixels changes the aspect ratio by under half a pixel,
 *  and a letterbox would leave a transparent line along one edge. */
export function rasterCopy(svg: string, px: Size, faces: string): string {
  const size = svgSize(svg);
  const resized = svg.replace(ROOT, (tag) => {
    // Without a viewBox, a new width and height would crop, not scale.
    let out = attribute(tag, 'viewBox') === undefined && size !== null ? tag.replace(/(\s*\/?>)$/, ` viewBox="0 0 ${size.width} ${size.height}"$1`) : tag;
    out = out.replace(/(\swidth=")[^"]*"/, `$1${px.width}"`).replace(/(\sheight=")[^"]*"/, `$1${px.height}"`);
    out = out.replace(/\spreserveAspectRatio="[^"]*"/, '');
    return out.replace(/(\sviewBox="[^"]*")/, '$1 preserveAspectRatio="none"');
  });
  return faces === '' ? resized : embedFontFaces(resized, faces);
}
