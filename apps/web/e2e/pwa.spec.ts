import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/** DD-08 §12: what the service worker precaches, and the manifest. Read from
 *  the build the suite is running against (`vite build` in `webServer`). */

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix + name;
    return statSync(dir + name).isDirectory() ? filesUnder(`${dir}${name}/`, `${rel}/`) : [rel];
  });
}

function precacheUrls(): string[] {
  const sw = readFileSync(`${DIST}sw.js`, 'utf8');
  return [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => m[1]!);
}

test.describe('PWA (DD-08 §12)', () => {
  test('the precache holds every file the build emits (J1: every engine chunk the worker can load)', () => {
    const precached = new Set(precacheUrls());
    // Everything but the service worker's own files and the host's headers
    // file. Workbox skips a file over its size cap with only a warning, so
    // this is what catches an engine chunk (Stage K's `elk`) silently left out.
    const emitted = filesUnder(DIST).filter((f) => f !== 'sw.js' && !/^workbox-[\w-]+\.js$/.test(f) && f !== '_headers' && !f.endsWith('.map'));
    expect(emitted.filter((f) => !precached.has(f))).toEqual([]);

    // Spelled out, per DD-08 §12's list.
    const has = (re: RegExp) => [...precached].some((u) => re.test(u));
    expect(has(/^index\.html$/)).toBe(true); // the shell
    expect(has(/^assets\/layout\.worker-[\w-]+\.js$/)).toBe(true); // the worker, which registers grid
    expect(has(/^assets\/inter-latin-400-normal-[\w-]+\.woff2$/)).toBe(true);
    expect(has(/^assets\/inter-latin-500-normal-[\w-]+\.woff2$/)).toBe(true);
    expect(has(/^assets\/inter-latin-600-normal-[\w-]+\.woff2$/)).toBe(true);
    expect(has(/^fonts\/OFL\.txt$/)).toBe(true);
    expect(has(/^manifest\.webmanifest$/)).toBe(true);
    // No duplicates (Workbox rejects a URL listed twice with two revisions).
    expect(precacheUrls().length).toBe(precached.size);

    // Both engines the worker registers are inside what is precached (Stage K).
    const worker = [...precached].find((u) => u.startsWith('assets/layout.worker-'))!;
    const workerSource = readFileSync(`${DIST}${worker}`, 'utf8');
    expect(workerSource).toContain('sgl.grid');
    expect(workerSource).toContain('sgl.elk');
    // elkjs is its own lazy chunk (K1): precached, imported only by the
    // worker, and only dynamically — never by the page's entry.
    const elk = [...precached].find((u) => /^assets\/elk-[\w-]+\.js$/.test(u));
    expect(elk).toBeDefined();
    const elkFile = elk!.slice('assets/'.length);
    expect(workerSource).toContain(`import("./${elkFile}")`);
    for (const f of filesUnder(`${DIST}assets/`).filter((n) => n.endsWith('.js') && !n.startsWith('layout.worker-') && n !== elkFile)) {
      expect(readFileSync(`${DIST}assets/${f}`, 'utf8'), f).not.toContain(elkFile);
    }
  });

  test('skipWaiting is gated: the worker waits for the "reload" chip to message it', () => {
    const sw = readFileSync(`${DIST}sw.js`, 'utf8');
    // Whatever name the minifier gives the event (it changes with the
    // precache list, i.e. with any asset's hash).
    expect(sw).toMatch(/"SKIP_WAITING"===[\w$]+\.data\.type&&self\.skipWaiting\(\)/);
    expect(sw).not.toMatch(/self\.skipWaiting\(\),/); // not called unconditionally at install
    expect(sw).not.toContain('clientsClaim');
    expect(sw).toContain('createHandlerBoundToURL("index.html")'); // navigateFallback
  });

  test('the manifest: name, icons (192/512, maskable), standalone, file_handlers', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const manifest = (await (await request.get(href!)).json()) as {
      name: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
      file_handlers: { action: string; accept: Record<string, string[]> }[];
    };
    expect(manifest.name).toContain('SGL');
    expect(manifest.display).toBe('standalone');
    for (const size of ['192x192', '512x512']) {
      for (const purpose of ['any', 'maskable']) expect(manifest.icons).toContainEqual(expect.objectContaining({ sizes: size, purpose }));
    }
    for (const icon of manifest.icons) expect((await request.get(icon.src)).headers()['content-type']).toContain('image/png');
    expect(manifest.file_handlers).toEqual([{ action: '/', accept: { 'text/plain': ['.sgl'], 'application/json': ['.sgl.json'] } }]);
  });
});
