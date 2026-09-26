import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { headersFor, parseHeadersFile } from '../build/headers.js';
import { EXAMPLE_NODE_COUNT, openFile, pngSize, renderedSvg, saveAs, savePng, setSource, toastMessages, waitForExactNodeCount, waitForNodeCount, waitForTheme } from './helpers.js';

/** J4: the build's `_headers` (DD-10 §5, DD-09 §1.2's CSP), served by the
 *  e2e server, and the app working under it. */

// Service-worker registration is part of what must work under the policy.
test.use({ serviceWorkers: 'allow' });

const HEADERS = parseHeadersFile(readFileSync(fileURLToPath(new URL('../dist/_headers', import.meta.url)), 'utf8'));

test('the server sends exactly what dist/_headers declares', async ({ request }) => {
  const asset = `/${readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8').match(/assets\/index-[\w-]+\.js/)![0]}`;
  for (const path of ['/', asset, '/sw.js', '/manifest.webmanifest']) {
    const headers = (await request.get(path)).headers();
    for (const [name, value] of headersFor(HEADERS, path)) expect(headers[name.toLowerCase()], `${path} ${name}`).toBe(value);
  }
  expect((await request.get('/')).headers()['content-security-policy']).toContain("script-src 'self'");
});

test('the app works under the CSP with no violation', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const consoleCsp: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) consoleCsp.push(m.text());
  });

  // Boot (IndexedDB, the layout worker, fonts, the service worker), a render,
  // a theme switch, Open, every Save item (PNG at every scale: the
  // rasterisation-only SVG with Inter as `data:` fonts, through a `blob:`
  // <img>, D6), both Copy items (D7) and the Share dialog.
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBeTruthy();
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);
  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  await openFile(page, 'x.sgl', 'a: "A"\nb: "B"\na -> b\n');
  await waitForExactNodeCount(page, 2);
  for (const kind of ['sgl', 'json', 'svg'] as const) await saveAs(page, kind);
  for (const scale of [1, 2, 3] as const) expect(pngSize((await savePng(page, scale)).bytes).width).toBeGreaterThan(0);
  for (const copy of ['copy-svg', 'copy-png']) {
    await page.locator('.save-menu > summary').click();
    await page.locator(`.save-menu .${copy}`).click();
  }
  await expect(toastMessages(page)).toContainText(['SVG copied', 'PNG copied']);
  await page.locator('.share-open').click();
  await expect(page.locator('.share-link')).toHaveValue(/#s=/);
  await page.keyboard.press('Escape');
  // A9 (DD-08 §15.5): a document with @imports loads the lazy `imports`
  // chunk, and its Share link carries the imported document (`i=`).
  // (x.sgl is open, so it imports the stored example by its save name.)
  await setSource(page, '@imports: [{ path: "./Checkout Flow.sgl", as: ex }]\nme\n');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT + 2); // me, the container ex, and the example under it
  await page.locator('.share-open').click();
  await expect(page.locator('.share-link')).toHaveValue(/#s=[^&]+&e=[^&]+&t=[^&]+&i=/);
  await page.keyboard.press('Escape');
  // A18 (DD-11 T26, T53): markup and a box load the lazy `rich-text` chunk,
  // which registers the run faces with the Font Loading API (no stylesheet),
  // and the faces load under `font-src 'self'`; Save ▾ SVG and a PNG embed them.
  await setSource(page, 'a: { @label: "**Bold** *italic* `code` and a long tail to wrap", @size: { maxWidth: 120 } }\n');
  await waitForExactNodeCount(page, 1);
  await expect(renderedSvg(page).locator('tspan.r-code')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded' && /Plex|Inter/.test(f.family) && (f.weight === '700' || f.style === 'italic' || /Plex/.test(f.family))).length))
    .toBeGreaterThanOrEqual(3);
  expect((await saveAs(page, 'svg')).text).toMatch(/font-family:&apos;IBM Plex Mono&apos;/);
  expect(pngSize((await savePng(page, 1)).bytes).width).toBeGreaterThan(0);

  expect(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)).toEqual([]);
  expect(consoleCsp).toEqual([]);

  // And the policy is really enforced, and the listener really hears it: an
  // inline script is blocked and reported.
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.head.append(s);
  });
  // One report per enforcing policy: the header and its <meta> mirror.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations.length)).toBeGreaterThan(0);
  for (const v of await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)) expect(v).toMatch(/^script-src/);
  expect(await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan)).toBeUndefined();
});
