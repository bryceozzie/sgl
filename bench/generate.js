#!/usr/bin/env node
// Deterministically writes the generated scale fixtures the perf bench needs.
// No `Math.random`, no `Date.now` (DD-00 §3) — every byte here is a pure
// function of the node count, so re-running this script produces
// byte-identical output, which is what keeps these three out of source
// control (bench/README.md): the shape of a 2 000-node document is one
// decision, made here, not a diff to review each time it changes.
//
// Run with `node bench/generate.js`. Wired into `pnpm test`/`pnpm check` (root
// package.json) so the files always exist before Vitest collects `corpus/`.
//
// `corpus/unresolved/edge-expansion-limit.sgl` (the SGL3005 fixture) used to
// be generated here too, but it is a ~30-line correctness fixture, not a
// scale one — its shape is not "one decision to keep out of diffs" the way
// n50/n500/n2000's is, and generating it made a correctness gate depend on a
// build step running first (a bare `vitest run` or an IDE test runner outside
// `pnpm test` would ENOENT on it). It is committed as a plain corpus fixture
// instead, like every other `unresolved/*.sgl` document.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scaleDocument } from './scale-document.js';

const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));

function write(relPath, content) {
  writeFileSync(`${corpusDir}${relPath}`, content, 'utf8');
}

write('n50.sgl', scaleDocument(50));
write('n500.sgl', scaleDocument(500));
write('n2000.sgl', scaleDocument(2000));

console.log('bench/generate.js: wrote n50.sgl, n500.sgl, n2000.sgl');
