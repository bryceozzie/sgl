import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHIPPED } from '../src/io/fonts.js';

/**
 * DD-08 §5 and DD-11 T26/T49: the faces the app ships. `fonts.css` declares
 * each one (so the browser fetches it only when some text uses it, and
 * `measurer.ready()` can load it before the first layout, T28), and export
 * embeds from exactly the same list (`SHIPPED`, D2). The two lists are one
 * set, and it is T26's: Inter 400/500/600/700 roman, Inter 400–700 italic,
 * IBM Plex Mono 400/700, Latin subset only, each with its licence.
 */

const APP = new URL('../', import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, APP)), 'utf8');

interface Face {
  readonly family: string;
  readonly weight: number;
  readonly style: string;
  readonly file: string;
}

const key = (f: Face): string => `${f.family} ${f.style} ${f.weight} ${f.file}`;

function cssFaces(): Face[] {
  return [...read('src/fonts.css').matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const body = m[1]!;
    expect(body).toMatch(/font-display:\s*block;/);
    return {
      family: /font-family:\s*'([^']+)'/.exec(body)![1]!,
      weight: Number(/font-weight:\s*(\d+)/.exec(body)![1]),
      style: /font-style:\s*(\w+)/.exec(body)![1]!,
      file: /url\('[^']*\/([^/']+\.woff2)'\)/.exec(body)![1]!,
    };
  });
}

/** Vite's `?url` gives the file's own path in a test (and a hashed asset URL in a build). */
const basename = (url: string): string => /([^/?]+\.woff2)/.exec(url)![1]!.replace(/-[\w-]{8}\.woff2$/, '.woff2');

const T26: readonly Face[] = [
  { family: 'IBM Plex Mono', weight: 400, style: 'normal', file: 'ibm-plex-mono-latin-400-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 700, style: 'normal', file: 'ibm-plex-mono-latin-700-normal.woff2' },
  ...[400, 500, 600, 700].map((weight) => ({ family: 'Inter', weight, style: 'normal', file: `inter-latin-${weight}-normal.woff2` })),
  ...[400, 500, 600, 700].map((weight) => ({ family: 'Inter', weight, style: 'italic', file: `inter-latin-${weight}-italic.woff2` })),
];

describe('the shipped faces (DD-11 T26, T49; DD-08 §5)', () => {
  it('fonts.css declares exactly T26\'s eleven faces, Latin subset, font-display: block', () => {
    expect(cssFaces().map(key).sort()).toEqual(T26.map(key).sort());
  });

  it('export embeds from the same eleven faces (SHIPPED)', () => {
    expect(SHIPPED.map((f) => key({ ...f, file: basename(f.url) })).sort()).toEqual(T26.map(key).sort());
  });

  it('every face exists in its package, and each family ships its licence', () => {
    for (const f of T26) {
      const pkg = f.family === 'Inter' ? 'inter' : 'ibm-plex-mono';
      expect(existsSync(fileURLToPath(new URL(`node_modules/@fontsource/${pkg}/files/${f.file}`, APP))), f.file).toBe(true);
    }
    expect(read('public/fonts/OFL.txt')).toContain('The Inter Project Authors');
    const plex = read('public/fonts/OFL-IBM-Plex-Mono.txt');
    expect(plex).toContain('IBM Corp.');
    expect(plex).toContain('SIL Open Font License, Version 1.1');
  });
});
