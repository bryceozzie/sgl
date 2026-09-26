import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, openFile, renderedSvg, saveAs, storedOpenDocument, toastMessages, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * D2 (DD-07 §9, DD-08 §7; human decision 2026-09-25): Save ▾ SVG and Copy SVG
 * embed the Inter weights the diagram uses, as `@font-face` rules with
 * `data:font/woff2` URLs in its one `<style>` element, so the file draws in
 * Inter where Inter is not installed — above all as an `<img>`, which cannot
 * use the page's fonts. `render()`'s output (the live view, `lastGood.svg`,
 * the stored boot picture) stays unembedded. Offline: `offline.spec.ts`.
 */

const shipped = (weight: number): Buffer =>
  readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`, import.meta.url)));

interface Face {
  readonly family: string;
  readonly weight: number;
  readonly style: string;
  readonly bytes: Buffer;
}

function decodeXml(s: string): string {
  return s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The one `<style>` element's text, decoded. */
function styleText(svg: string): string {
  const all = [...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect(all).toHaveLength(1);
  return decodeXml(all[0]![1]!);
}

/** Every `@font-face` in the file, its `data:` URL decoded. */
function faces(svg: string): Face[] {
  return [...styleText(svg).matchAll(/@font-face\{([^}]*)\}/g)].map((m) => {
    const body = m[1]!;
    const src = /src:url\(data:font\/woff2;base64,([^)]*)\) format\('woff2'\)/.exec(body);
    expect(src, body.slice(0, 120)).not.toBeNull();
    const b64 = src![1]!;
    // Valid base64: only the alphabet, padded, and it round-trips.
    expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(b64.length % 4).toBe(0);
    const bytes = Buffer.from(b64, 'base64');
    expect(bytes.toString('base64')).toBe(b64);
    return {
      family: /font-family:'([^']*)'/.exec(body)![1]!,
      weight: Number(/font-weight:(\d+)/.exec(body)![1]),
      style: /font-style:(\w+)/.exec(body)![1]!,
      bytes,
    };
  });
}

/** The weights the file's own rules draw text at (not the `@font-face` rules). */
function usedWeights(svg: string): number[] {
  const css = styleText(svg).replace(/@font-face\{[^}]*\}/g, '');
  return [...new Set([...css.matchAll(/font-weight:(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** `svg` without the `@font-face` lines `embedFonts` adds: `render()`'s own. */
const withoutFaces = (svg: string): string => svg.replace(/@font-face\{[^}]*\}\n/g, '');

test('Save ▾ SVG embeds exactly the Inter weights it uses, as the shipped WOFF2 bytes', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT); // the example is checkout.sgl
  const saved = await saveAs(page, 'svg');
  const embedded = faces(saved.text);
  expect(usedWeights(saved.text)).toEqual([400, 500, 600]);
  expect(embedded.map((f) => [f.family, f.style, f.weight])).toEqual([
    ['Inter', 'normal', 400],
    ['Inter', 'normal', 500],
    ['Inter', 'normal', 600],
  ]);
  for (const f of embedded) expect(f.bytes.equals(shipped(f.weight)), `weight ${f.weight}`).toBe(true);
  // Everything but the faces is lastGood.svg, byte for byte: render() is untouched.
  await expect.poll(async () => (await storedOpenDocument(page))?.lastGoodSvg).toBe(withoutFaces(saved.text));
  expect((await storedOpenDocument(page))!.lastGoodSvg).not.toContain('@font-face');

  // A diagram with node titles only (500): only 500.
  await openFile(page, 'plain.sgl', 'a: "Alpha"\nb: "Beta"\n');
  await waitForExactNodeCount(page, 2);
  const plain = await saveAs(page, 'svg');
  expect(usedWeights(plain.text)).toEqual([500]);
  expect(faces(plain.text).map((f) => f.weight)).toEqual([500]);

  // No text at all: nothing embedded.
  await openFile(page, 'blank.sgl', 'a: { @label: "" }\nb: { @label: "" }\na -> b\n');
  await waitForExactNodeCount(page, 2);
  // plain.sgl also has two nodes: wait for this document's own picture, not the last one's.
  await expect(renderedSvg(page).locator('g[id="n-a"]')).not.toContainText('Alpha');
  const blank = await saveAs(page, 'svg');
  expect(blank.text).not.toContain('font-family');
  expect(faces(blank.text)).toEqual([]);
});

/**
 * D2's proof, the PNG test's ink probe (`test/png.browser.test.ts`) on the
 * exported file itself: loaded as an `<img>` (an isolated document with no
 * access to the page's fonts) and drawn at 4×, the label's ink is as wide as
 * Inter's own metrics say (canvas `measureText` with the page's Inter, the
 * same WOFF2). The same file without its faces, which is `render()`'s own
 * output, is drawn in a fallback face and misses.
 */
const PROBE_LABEL = 'Hamburgefontsiv WAVE 0123';

async function inkWidthAsImage(page: Page, svg: string): Promise<{ readonly ink: number; readonly inter: number }> {
  return page.evaluate(
    async ({ svg, label }) => {
      const SCALE = 4;
      const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      const w = Number(root.getAttribute('width'));
      const h = Number(root.getAttribute('height'));
      const text = root.querySelector('text.n-title')!;
      const style = text.getAttribute('class')!;
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image(w * SCALE, h * SCALE);
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      const canvas = new OffscreenCanvas(w * SCALE, h * SCALE);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w * SCALE, h * SCALE);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Ink: the title's colour is dark; the node's fill, its border
      // (#8A96A8) and the canvas are all light in the red channel.
      let left = Infinity;
      let right = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (data[(y * canvas.width + x) * 4]! < 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      // Inter's own extent for the same run, at the title's size and weight
      // (its `g-` rule; the page has Inter loaded, from the same WOFF2).
      const geometry = style.split(' ').find((c) => c.startsWith('g-'))!;
      const rule = new RegExp(`\\.${geometry}\\{([^}]*)\\}`).exec(svg)![1]!;
      const font = `${/font-weight:(\d+)/.exec(rule)![1]} ${/font-size:([\d.]+px)/.exec(rule)![1]} Inter`;
      await document.fonts.load(font);
      const m = new OffscreenCanvas(1, 1).getContext('2d')!;
      m.font = font;
      const metrics = m.measureText(label);
      return { ink: (right - left + 1) / SCALE, inter: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight };
    },
    { svg, label: PROBE_LABEL },
  );
}

test('loaded as an <img>, the exported SVG draws its text in Inter; without the faces it does not', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the probe’s tolerance is measured in Chromium');
  await page.goto('/');
  await openFile(page, 'probe.sgl', `a: "${PROBE_LABEL}"\n`);
  await waitForExactNodeCount(page, 1);
  const saved = (await saveAs(page, 'svg')).text;
  expect(faces(saved).length).toBeGreaterThan(0);

  const embedded = await inkWidthAsImage(page, saved);
  // Within a pixel: antialiasing at 4× and the glyph box's rounding.
  expect(Math.abs(embedded.ink - embedded.inter), JSON.stringify(embedded)).toBeLessThanOrEqual(1);

  const bare = await inkWidthAsImage(page, withoutFaces(saved));
  expect(Math.abs(bare.ink - bare.inter), JSON.stringify(bare)).toBeGreaterThan(3);
});

/**
 * A18 (DD-11 T49, T50): a label drawn in a mark exports with that mark's own
 * face — Inter Bold, Inter Italic, IBM Plex Mono — chosen per element, and an
 * `<img>` of the file draws the run in it. The same ink probe as above, on a
 * one-node diagram whose whole title is one mark, against the face's own
 * metrics on the page (the same WOFF2 files).
 */
const shippedFile = (file: string): Buffer => {
  const pkg = file.startsWith('ibm-plex-mono') ? 'ibm-plex-mono' : 'inter';
  return readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url)));
};

async function runInkAsImage(page: Page, svg: string, font: string): Promise<{ readonly ink: number; readonly face: number }> {
  return page.evaluate(
    async ({ svg, label, font }) => {
      const SCALE = 4;
      const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      const w = Number(root.getAttribute('width'));
      const h = Number(root.getAttribute('height'));
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image(w * SCALE, h * SCALE);
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      const canvas = new OffscreenCanvas(w * SCALE, h * SCALE);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w * SCALE, h * SCALE);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = Infinity;
      let right = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (data[(y * canvas.width + x) * 4]! < 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      await document.fonts.load(font);
      const m = new OffscreenCanvas(1, 1).getContext('2d')!;
      m.font = font;
      const metrics = m.measureText(label);
      return { ink: (right - left + 1) / SCALE, face: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight };
    },
    { svg, label: PROBE_LABEL, font },
  );
}

test('rich labels: Save ▾ SVG embeds exactly the faces each run uses, and an <img> of it draws bold, italic and code in their real faces', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the probe’s tolerance is measured in Chromium');
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // Node titles are 13px Inter 500 (neutral-light).
  const cases = [
    { mark: `**${PROBE_LABEL}**`, run: 'r-strong', font: '700 13px Inter', face: ['Inter', 'normal', 700, 'inter-latin-700-normal.woff2'] },
    { mark: `*${PROBE_LABEL}*`, run: 'r-em', font: 'italic 500 13px Inter', face: ['Inter', 'italic', 500, 'inter-latin-500-italic.woff2'] },
    { mark: `\`${PROBE_LABEL}\``, run: 'r-code', font: '400 13px "IBM Plex Mono"', face: ['IBM Plex Mono', 'normal', 400, 'ibm-plex-mono-latin-400-normal.woff2'] },
  ] as const;
  for (const c of cases) {
    await openFile(page, 'rich.sgl', `a: "${c.mark}"\n`);
    await waitForExactNodeCount(page, 1);
    // This document's own run, not the last one's.
    await expect(renderedSvg(page).locator(`g[id="n-a"] tspan[class="${c.run}"]`)).toHaveCount(1);
    const saved = (await saveAs(page, 'svg')).text;
    // Only the run's face: the title has no plain text, so not even Inter 500.
    const embedded = faces(saved);
    expect(embedded.map((f) => [f.family, f.style, f.weight]), c.mark).toEqual([c.face.slice(0, 3)]);
    expect(embedded[0]!.bytes.equals(shippedFile(c.face[3])), c.mark).toBe(true);

    const drawn = await runInkAsImage(page, saved, c.font);
    expect(Math.abs(drawn.ink - drawn.face), `${c.mark} ${JSON.stringify(drawn)}`).toBeLessThanOrEqual(1);
    const bare = await runInkAsImage(page, withoutFaces(saved), c.font);
    expect(Math.abs(bare.ink - bare.face), `${c.mark} without faces ${JSON.stringify(bare)}`).toBeGreaterThan(3);
  }

  // Mixed: exactly the faces used, never a cross product (T50).
  await openFile(page, 'mixed.sgl', 'a: "plain **bold** `code`"\nb\na -> b: "*async*"\n');
  await waitForExactNodeCount(page, 2);
  const mixed = faces((await saveAs(page, 'svg')).text).map((f) => `${f.family} ${f.style} ${f.weight}`);
  expect(mixed).toEqual(['IBM Plex Mono normal 400', 'Inter italic 400', 'Inter normal 500', 'Inter normal 700']);
});

test.describe('Copy SVG', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('copies the same bytes Save ▾ SVG saves, fonts embedded', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const saved = (await saveAs(page, 'svg')).text;
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .copy-svg').click();
    await expect(toastMessages(page)).toContainText(['SVG copied']);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(saved);
    expect(faces(copied).map((f) => f.weight)).toEqual([400, 500, 600]);
  });
});

test('if the fonts cannot be fetched, Save ▾ SVG says so and saves nothing', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // After the page has its fonts: only the export's own fetch fails.
  await page.route(/\/assets\/inter-latin-\d+-normal-.*\.woff2$/, (route) => route.abort());
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.locator('.save-menu > summary').click();
  await page.locator('.save-menu .save-svg').click();
  await expect(page.locator('.toast-error .toast-message')).toContainText(['Could not save the SVG']);
  expect(downloads).toEqual([]);
});
