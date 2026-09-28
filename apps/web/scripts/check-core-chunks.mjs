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

  // F20: the page lists `grid` in Engine ▾ from `@sgl/layout-std/descriptor`
  // alone; only the worker runs `gridEngine.layout()`. The worker's copy must
  // carry the packing code (else this signature, one of its error messages, no
  // longer matches the minified output and the check would pass vacuously).
  // feat/b5-fixed: the same for `fixed` (DD-12 H9: static in the worker).
  const LAYOUT_SIGNATURES = { grid: 'grid: unknown scope', fixed: 'fixed: unknown scope' };
  const workerFiles = assets.filter((f) => /^layout\.worker-[\w-]+\.js$/.test(f));
  for (const [engine, signature] of Object.entries(LAYOUT_SIGNATURES)) {
    for (const file of seen) {
      if (readFileSync(`${DIST}assets/${file}`, 'utf8').includes(signature)) fail(`${file} (reachable at boot) contains the ${engine} engine's layout code; the page needs only @sgl/layout-std/descriptor.`);
    }
    if (!workerFiles.some((f) => readFileSync(`${DIST}assets/${f}`, 'utf8').includes(signature))) {
      fail(`no layout worker chunk contains '${signature}'; update LAYOUT_SIGNATURES for this minifier output.`);
    }
  }
  if (process.exitCode !== 1) console.log('check-core-chunks: the grid and fixed layout code is in the worker only.');

  // A8 follow-up, then feat/b5-pin fix round 1 (item 4): the layout worker
  // builds no diagnostic at all. It posts an engine's failure as a plain
  // `reason`, and the host builds SGL4011 from `LAYOUT_CATALOGUE` itself, so
  // no catalogue row may reach the worker: if anything there imports
  // `diagnostic()` or `layoutDiagnostic()` again, rows come back with it. A
  // row is `SGLnnnn:{severity:…`. It cannot pass vacuously: the boot check
  // above fails if the same pattern stops matching the boot chunks' rows.
  const ROW = /\bSGL(\d{4})\s*:\s*\{\s*severity\b/g;
  const workers = assets.filter((f) => /^layout\.worker-[\w-]+\.js$/.test(f));
  if (workers.length !== 1) fail(`expected one assets/layout.worker-*.js chunk, found ${workers.length}.`);
  const inWorker = new Set();
  const workerQueue = [...workers];
  while (workerQueue.length > 0) {
    const file = workerQueue.shift();
    if (inWorker.has(file)) continue;
    inWorker.add(file);
    const code = readFileSync(`${DIST}assets/${file}`, 'utf8');
    for (const m of code.matchAll(ROW)) fail(`${file} (layout worker) contains catalogue row SGL${m[1]}; the worker builds no diagnostics.`);
    for (const m of code.matchAll(STATIC)) if (!inWorker.has(m[1])) workerQueue.push(m[1]);
  }
  if (process.exitCode !== 1) console.log(`check-core-chunks: the layout worker carries no catalogue row (the boot chunks' ${bootRows} match the same pattern).`);

  // B5 branch 4 (DD-12 N52, H9): `tree`'s layout code is the lazy
  // `std-trees` chunk, which only the worker imports, dynamically, on the
  // first tree request (`treeEngine`, `@sgl/layout-std/src/lazy.ts`). So:
  // exactly one such chunk is emitted, and it holds the layout code (its
  // `tree: unknown scope` error, so this cannot pass vacuously); neither the
  // page's boot chunks nor the worker's static imports are it or carry that
  // code; the worker references it (else `tree` could never load); and no
  // boot chunk references it at all (only the worker may import it).
  const TREES_SIGNATURE = 'tree: unknown scope';
  const treesChunks = assets.filter((f) => /^std-trees-[\w-]+\.js$/.test(f));
  if (treesChunks.length !== 1) fail(`expected one assets/std-trees-*.js chunk, found ${treesChunks.length} (${treesChunks.join(', ')}).`);
  for (const trees of treesChunks) {
    if (!readFileSync(`${DIST}assets/${trees}`, 'utf8').includes(TREES_SIGNATURE)) fail(`${trees} does not contain '${TREES_SIGNATURE}'; update TREES_SIGNATURE for this minifier output.`);
    for (const file of seen) {
      if (file === trees) fail(`${trees}, the lazy std-trees chunk, is reachable at boot.`);
      else if (readFileSync(`${DIST}assets/${file}`, 'utf8').includes(trees)) fail(`${file} (reachable at boot) references the lazy std-trees chunk ${trees}; only the layout worker may import it.`);
    }
    if (inWorker.has(trees)) fail(`${trees}, the lazy std-trees chunk, is a static import of the layout worker.`);
    if (!workers.some((w) => readFileSync(`${DIST}assets/${w}`, 'utf8').includes(trees))) fail(`the layout worker does not reference ${trees}; tree could not load its layout code.`);
  }
  for (const file of [...seen, ...inWorker]) {
    if (!treesChunks.includes(file) && readFileSync(`${DIST}assets/${file}`, 'utf8').includes(TREES_SIGNATURE)) fail(`${file} (boot or worker) contains tree's layout code; it belongs to the lazy std-trees chunk.`);
  }
  if (process.exitCode !== 1) console.log(`check-core-chunks: tree's layout code is the lazy ${treesChunks.join(', ')}, which only the worker imports, dynamically.`);

  // Fix round 1 of B5 branch 4 (item 3): the signature above is one string of
  // `tree.ts`, so a static import of `forest.ts` (or of anything else of the
  // chunk's but `tree.ts`) by the worker went unseen (mutation M14). So, from
  // the build's module graph (`build/chunk-modules.ts`), mapped back to
  // source files through each package's `dist` source maps: every module of
  // STD_TREES_MODULES is carried by the std-trees chunk, and no module the
  // std-trees chunk carries is carried by any other chunk — so by none the
  // page or the worker reaches by static imports. `feat/b5-radial` adds its
  // modules to the list.
  const STD_TREES_MODULES = ['packages/layout-std/src/forest.ts', 'packages/layout-std/src/tree.ts'];
  const REPO = fileURLToPath(new URL('../../../', import.meta.url));
  const graphFile = fileURLToPath(new URL('../node_modules/.sgl-build/chunk-modules.json', import.meta.url));
  if (!existsSync(graphFile)) fail(`${graphFile} is missing; run \`pnpm build\` (build/chunk-modules.ts writes it).`);
  else {
    /** @type {Record<string, string[]>} */
    const graph = JSON.parse(readFileSync(graphFile, 'utf8'));
    const jsAssets = assets.filter((f) => f.endsWith('.js')).sort();
    const recorded = Object.keys(graph).sort();
    if (JSON.stringify(recorded) !== JSON.stringify(jsAssets)) {
      fail(`the module graph lists ${recorded.length} chunks and dist/assets has ${jsAssets.length} JS files; it is stale or incomplete (rebuild).`);
    }
    // A module of a built package is its `dist` file: read its source map.
    const sourcesCache = new Map();
    const sourcesOf = (id) => {
      if (!sourcesCache.has(id)) {
        const map = `${REPO}${id}.map`;
        const sources = /^packages\/[^/]+\/dist\/.*\.js$/.test(id) && existsSync(map)
          ? JSON.parse(readFileSync(map, 'utf8')).sources.map((s) => fileURLToPath(new URL(s, `file://${REPO}${id}`)).slice(REPO.length))
          : [id];
        sourcesCache.set(id, sources);
      }
      return sourcesCache.get(id);
    };
    const carried = (file) => new Set((graph[file] ?? []).flatMap(sourcesOf));
    for (const trees of treesChunks) {
      const own = carried(trees);
      for (const m of STD_TREES_MODULES) if (!own.has(m)) fail(`${trees} does not carry ${m}; the std-trees chunk must hold all of ${STD_TREES_MODULES.join(', ')}.`);
      for (const file of recorded) {
        if (file === trees) continue;
        const where = seen.has(file) ? 'reachable at boot' : inWorker.has(file) ? 'a static import of the layout worker' : 'another chunk';
        for (const m of carried(file)) if (own.has(m) || STD_TREES_MODULES.includes(m)) fail(`${file} (${where}) carries ${m}, a module of the lazy std-trees chunk.`);
      }
    }
    if (process.exitCode !== 1) console.log(`check-core-chunks: the module graph puts ${STD_TREES_MODULES.join(', ')} in the std-trees chunk only.`);
  }

  // DD-13 P46 (help branch 2): the help content is lazy. Its compiled form
  // reaches the build only through `virtual:sgl-help-content`, which only the
  // lazy help chunks may import (help branch 4). Neither the boot chunks nor
  // the layout worker may carry the quick start's first heading or its
  // summary, the sentinels for the whole of it. (`test/reference-boot.test.ts`
  // checks the sources' imports.)
  const quickstart = readFileSync(fileURLToPath(new URL('../help/quickstart.md', import.meta.url)), 'utf8').split('\n');
  const heading = /^#\s+(.*?)\s*\{#/.exec(quickstart[0] ?? '')?.[1];
  const summary = quickstart.slice(1).find((l) => l.trim() !== '')?.trim();
  if (heading === undefined || summary === undefined) fail('apps/web/help/quickstart.md does not start with a heading carrying its id and a summary.');
  else {
    for (const file of [...seen, ...inWorker]) {
      const code = readFileSync(`${DIST}assets/${file}`, 'utf8');
      for (const sentinel of [summary, `"${heading}"`]) if (code.includes(sentinel)) fail(`${file} (boot or worker) contains the help content (${JSON.stringify(sentinel)}); it belongs to the lazy help chunks.`);
    }
    if (process.exitCode !== 1) console.log('check-core-chunks: no help content at boot or in the worker.');
  }
}
