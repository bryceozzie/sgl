import plex400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import plex700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2?url';
import inter400i from '@fontsource/inter/files/inter-latin-400-italic.woff2?url';
import inter500i from '@fontsource/inter/files/inter-latin-500-italic.woff2?url';
import inter600i from '@fontsource/inter/files/inter-latin-600-italic.woff2?url';
import inter700i from '@fontsource/inter/files/inter-latin-700-italic.woff2?url';
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';

/**
 * A18's eight run faces (DD-11 T26, T25): Inter 700 (`strong`), Inter italic
 * 400–700 (`em` at each role's base weight, and `strong` + `em`), IBM Plex Mono
 * 400 and 700 (`code`, strong code). Latin subset.
 *
 * Not on the boot path: `fonts.css` declares only the themes' three faces, and
 * these are registered through the CSS Font Loading API by the lazy
 * `rich-text` chunk (`registerRunFaces`), which a document with markup in a
 * label or a label to wrap loads before anything is measured. A `FontFace`
 * added to `document.fonts` fetches nothing until `measurer.ready()` asks for
 * it (`document.fonts.load`) or text is drawn in it, so the font gate (T28)
 * still waits for exactly the faces a document uses. No stylesheet is
 * injected: a `FontFace` is governed by `font-src 'self'` alone (DD-09 §1.2),
 * and the files are same-origin assets, precached like every other.
 *
 * Export imports the same list (`io/fonts.ts`'s `SHIPPED`): Vite gives both
 * the same hashed URLs.
 */
export interface RunFace {
  readonly family: string;
  readonly weight: number;
  readonly style: 'normal' | 'italic';
  readonly url: string;
}

export const RUN_FACES: readonly RunFace[] = [
  { family: 'Inter', weight: 700, style: 'normal', url: inter700 },
  { family: 'Inter', weight: 400, style: 'italic', url: inter400i },
  { family: 'Inter', weight: 500, style: 'italic', url: inter500i },
  { family: 'Inter', weight: 600, style: 'italic', url: inter600i },
  { family: 'Inter', weight: 700, style: 'italic', url: inter700i },
  { family: 'IBM Plex Mono', weight: 400, style: 'normal', url: plex400 },
  { family: 'IBM Plex Mono', weight: 700, style: 'normal', url: plex700 },
];

let registered = false;

/** Add the eight faces to `document.fonts`, once (`font-display: block`, as
 *  `fonts.css`'s). A no-op without the Font Loading API (Node, a worker). */
export function registerRunFaces(): void {
  if (registered || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  registered = true;
  for (const f of RUN_FACES) {
    document.fonts.add(new FontFace(f.family, `url(${JSON.stringify(f.url)}) format('woff2')`, { weight: String(f.weight), style: f.style, display: 'block' }));
  }
}
