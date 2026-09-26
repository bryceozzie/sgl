import plex400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import plex700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2?url';
import inter400i from '@fontsource/inter/files/inter-latin-400-italic.woff2?url';
import inter400 from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import inter500i from '@fontsource/inter/files/inter-latin-500-italic.woff2?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';
import inter600i from '@fontsource/inter/files/inter-latin-600-italic.woff2?url';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import inter700i from '@fontsource/inter/files/inter-latin-700-italic.woff2?url';
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';
import { embedFonts, usedFontFaces, type FontFaceKey } from '@sgl/render-svg/fonts';

/**
 * D2 (DD-07 §9, DD-08 §7): an SVG leaving the app — Save ▾ SVG, Copy SVG, and
 * the PNG's rasterisation-only copy — carries the shipped faces it uses,
 * embedded by `@sgl/render-svg/fonts`'s `embedFonts`. This is the DOM half:
 * the bytes. In the lazy `file-actions` chunk.
 *
 * The faces are the very files `fonts.css` loads (Vite gives both the same
 * hashed URL), fetched from our own origin (`connect-src 'self'`; offline,
 * from the service worker's precache), only the weights the SVG uses.
 */

export interface ShippedFace extends FontFaceKey {
  readonly url: string;
}

/** The faces the app bundles (DD-08 §5, `fonts.css`), Latin subset: Inter
 *  400–600, and A18's eight (DD-11 T26, T49): Inter 700, Inter italic 400–700,
 *  IBM Plex Mono 400 and 700. Export fetches only those an SVG draws with
 *  (`usedFontFaces`, per element: T50). */
export const SHIPPED: readonly ShippedFace[] = [
  { family: 'Inter', weight: 400, style: 'normal', url: inter400 },
  { family: 'Inter', weight: 500, style: 'normal', url: inter500 },
  { family: 'Inter', weight: 600, style: 'normal', url: inter600 },
  { family: 'Inter', weight: 700, style: 'normal', url: inter700 },
  { family: 'Inter', weight: 400, style: 'italic', url: inter400i },
  { family: 'Inter', weight: 500, style: 'italic', url: inter500i },
  { family: 'Inter', weight: 600, style: 'italic', url: inter600i },
  { family: 'Inter', weight: 700, style: 'italic', url: inter700i },
  { family: 'IBM Plex Mono', weight: 400, style: 'normal', url: plex400 },
  { family: 'IBM Plex Mono', weight: 700, style: 'normal', url: plex700 },
];

/** Each face's base64, fetched once per page and kept (a failure is not
 *  kept, so the next export tries again). */
const bytes = new Map<string, Promise<string>>();

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

function base64Of(url: string): Promise<string> {
  let b64 = bytes.get(url);
  if (b64 === undefined) {
    b64 = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(readBase64);
    b64.catch(() => bytes.delete(url));
    bytes.set(url, b64);
  }
  return b64;
}

/** `svg` with the shipped faces it uses embedded (unchanged if it has no
 *  text). Rejects when a face cannot be fetched: the caller refuses the
 *  export rather than hand over a file that draws in the wrong face. */
export async function withEmbeddedFonts(svg: string): Promise<string> {
  const faces = usedFontFaces(svg, SHIPPED);
  const fonts = await Promise.all(
    faces.map(async ({ family, weight, style, url }) => ({ family, weight, style, woff2Base64: await base64Of(url) })),
  );
  return embedFonts(svg, fonts);
}
