import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { headersFor, parseHeadersFile } from '../build/headers.js';
import { EXAMPLE_NODE_COUNT, openFile, saveAs, waitForExactNodeCount, waitForNodeCount, waitForTheme } from './helpers.js';

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

test('the app works under the CSP with no violation', async ({ page }) => {
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
  // a theme switch, Open, every Save item and the Share dialog.
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBeTruthy();
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);
  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  await openFile(page, 'x.sgl', 'a: "A"\nb: "B"\na -> b\n');
  await waitForExactNodeCount(page, 2);
  for (const kind of ['sgl', 'json', 'svg'] as const) await saveAs(page, kind);
  await page.locator('.share-open').click();
  await expect(page.locator('.share-link')).toHaveValue(/#s=/);

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
