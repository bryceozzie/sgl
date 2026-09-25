#!/usr/bin/env node
// Stage K fix round 1, item 17: `size-limit` measures the core chunk by glob
// (every JS/CSS file but `elk-*.js`), so it cannot see elkjs creeping into
// the boot path — a static import of `@sgl/layout-elk` (not `/descriptor`)
// from the main thread would inline elkjs into, or statically import it from,
// a chunk the page loads at boot, and the size would simply go up with no
// check naming the cause. This script, run by root `pnpm size` right after
// size-limit (and so by CI's Size step), fails if any chunk reachable from
// `index.html`'s entry by *static* imports:
//
//   - references the lazy `elk` chunk's file name, or
//   - contains elkjs's own code (a string only elkjs has).
//
// The layout worker is not a static import of the page (it is a
// `new Worker(new URL(...))`), so it is not walked: it is the one chunk that
// is meant to import `elk` (dynamically; `e2e/pwa.spec.ts` checks that).
//
// Needs `apps/web/dist` (root `pnpm build`).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sizeLimit from '../../../.size-limit.js';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
/** A string elkjs's GWT code carries and nothing of ours does. */
const ELKJS_SIGNATURE = 'org.eclipse.elk.layered';

function fail(message) {
  console.error(`check-core-chunks: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(`${DIST}index.html`)) {
  fail('apps/web/dist/index.html is missing; run `pnpm build` first.');
} else {
  const assets = readdirSync(`${DIST}assets`);
  // Exactly one: a second `elk-*.js` is the main thread's own copy of
  // elkjs, emitted because something on the page imports the engine object
  // (whose `layout()` holds the dynamic import) instead of `/descriptor`.
  const elkChunks = assets.filter((f) => /^elk-[\w-]+\.js$/.test(f));
  if (elkChunks.length === 0) fail('no assets/elk-*.js chunk was emitted; the lazy elk chunk is missing.');
  if (elkChunks.length > 1) fail(`elkjs was emitted ${elkChunks.length} times (${elkChunks.join(', ')}); only the worker may import it.`);
  for (const elk of elkChunks) {
    const code = readFileSync(`${DIST}assets/${elk}`, 'utf8');
    if (code.length > 1000 && !code.includes(ELKJS_SIGNATURE)) {
      fail(`${elk} does not contain '${ELKJS_SIGNATURE}'; update ELKJS_SIGNATURE for this elkjs version.`);
    }
  }

  const html = readFileSync(`${DIST}index.html`, 'utf8');
  const entries = [...html.matchAll(/(?:src|href)="\/assets\/([\w.-]+\.js)"/g)].map((m) => m[1]);
  if (entries.length === 0) fail('no /assets/*.js entry found in index.html.');

  // Static imports and re-exports only — `import("./x.js")` (dynamic) is not
  // matched: the `(` never follows `import` in the patterns below.
  const STATIC = /(?:\bimport|\bexport)\s*(?:[\w$*{},\s]*?\s*from\s*)?["']\.\/([\w.-]+\.js)["']/g;
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(`${DIST}assets/${file}`, 'utf8');
    for (const elk of elkChunks) if (code.includes(elk)) fail(`${file} (reachable at boot) references the lazy elk chunk ${elk}.`);
    if (code.includes(ELKJS_SIGNATURE)) fail(`${file} (reachable at boot) contains elkjs's own code.`);
    for (const m of code.matchAll(STATIC)) if (!seen.has(m[1])) queue.push(m[1]);
  }
  if (process.exitCode !== 1) {
    console.log(`check-core-chunks: ${seen.size} boot chunks (${[...seen].sort().join(', ')}); none reaches elk.`);
  }

  // Every chunk `.size-limit.js` leaves out of the core budget as lazy must
  // really be lazy: none may be reachable from the entry by static imports
  // (A9 added `imports-*.js` and `filename-*.js` to that list).
  const lazy = sizeLimit
    .flatMap((entry) => entry.path)
    .filter((p) => p.startsWith('!apps/web/dist/assets/'))
    .map((p) => new RegExp(`^${p.slice('!apps/web/dist/assets/'.length).replace(/[.]/g, '\\.').replace('*', '[\\w-]+')}$`));
  for (const file of seen) if (lazy.some((re) => re.test(file))) fail(`${file} is excluded from the core budget as lazy, but the entry reaches it by static imports.`);
  for (const re of lazy) if (!assets.some((f) => re.test(f))) fail(`no emitted chunk matches ${re}; the exclusion in .size-limit.js names nothing.`);

  // A9 (DD-02 §10.9, I32): everything import-specific is `@sgl/core/imports`
  // and the app's lazy `imports` chunk. No boot chunk may be that chunk or
  // carry one of its catalogue rows (`SGL2017`–`SGL2026`, `IMPORT_CATALOGUE`);
  // the boot chunks must still carry the other rows, else the pattern no
  // longer matches the minified output and this would pass vacuously.
  const IMPORT_ROWS = new Set(['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']);
  let bootRows = 0;
  for (const file of seen) {
    if (/^imports-[\w-]+\.js$/.test(file)) fail(`${file}, the lazy imports chunk, is reachable at boot.`);
    const code = readFileSync(`${DIST}assets/${file}`, 'utf8');
    for (const m of code.matchAll(/\bSGL(\d{4})\s*:\s*\{\s*severity\b/g)) {
      bootRows += 1;
      if (IMPORT_ROWS.has(m[1])) fail(`${file} (reachable at boot) contains the import catalogue row SGL${m[1]}; it belongs to the lazy imports chunk.`);
    }
  }
  if (bootRows === 0) fail('no catalogue row found in the boot chunks; update the row pattern for this minifier output.');
  if (process.exitCode !== 1) console.log(`check-core-chunks: no import catalogue row or imports chunk at boot (${bootRows} other rows).`);

  // A8 follow-up: the layout worker emits only layout diagnostics (`SGL4xxx`),
  // built from `@sgl/core`'s `LAYOUT_CATALOGUE` through `layoutDiagnostic()`.
  // If anything in the worker imports the full `diagnostic()` again, the whole
  // `CATALOGUE` (~1.1 kB gzipped) comes back into it. A catalogue row is
  // `SGLnnnn:{severity:…`; the worker and its static imports may carry only
  // 4xxx rows, and must carry some (else this pattern no longer matches the
  // minified output and the check would pass vacuously).
  const ROW = /\bSGL(\d{4})\s*:\s*\{\s*severity\b/g;
  const workers = assets.filter((f) => /^layout\.worker-[\w-]+\.js$/.test(f));
  if (workers.length !== 1) fail(`expected one assets/layout.worker-*.js chunk, found ${workers.length}.`);
  const inWorker = new Set();
  const workerQueue = [...workers];
  const rows = new Set();
  while (workerQueue.length > 0) {
    const file = workerQueue.shift();
    if (inWorker.has(file)) continue;
    inWorker.add(file);
    const code = readFileSync(`${DIST}assets/${file}`, 'utf8');
    for (const m of code.matchAll(ROW)) {
      rows.add(m[1]);
      if (!m[1].startsWith('4')) fail(`${file} (layout worker) contains catalogue row SGL${m[1]}; the worker may bundle only the SGL4xxx rows.`);
    }
    for (const m of code.matchAll(STATIC)) if (!inWorker.has(m[1])) workerQueue.push(m[1]);
  }
  if (rows.size === 0) fail('no SGL4xxx catalogue row found in the layout worker; update ROW for this minifier output.');
  if (process.exitCode !== 1) {
    console.log(`check-core-chunks: layout worker carries only catalogue rows ${[...rows].sort().map((r) => `SGL${r}`).join(', ')}.`);
  }
}
