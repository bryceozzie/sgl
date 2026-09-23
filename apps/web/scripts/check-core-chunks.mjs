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
}
