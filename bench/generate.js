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

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scaleDocument } from './scale-document.js';

const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));

function write(relPath, content) {
  writeFileSync(`${corpusDir}${relPath}`, content, 'utf8');
}

write('n50.sgl', scaleDocument(50));
write('n500.sgl', scaleDocument(500));
write('n2000.sgl', scaleDocument(2000));

// A9's keystroke bench (DD-02 §10.8, `packages/core/test/imports-keystroke.test.ts`):
// a 50-node document importing a 500-node library, both in `bench/imports/`
// rather than `corpus/`, so no corpus sweep links them. The library brings
// classes and a variable; imported without `as`, its nodes stay where they
// are (an SGL2026 info), so the importer is still a 50-node document whose
// every keystroke resolves one large import.
const importsDir = fileURLToPath(new URL('./imports/', import.meta.url));
mkdirSync(importsDir, { recursive: true });
const library = scaleDocument(500).replace(
  '@title: "Scale 500"\n',
  '@title: "Scale 500"\n@vars: { brand: "#4F46E5" }\n@classes: {\n  Service: { @shape: round, @style.stroke: $brand }\n  Critical: { @extends: Service, @style.strokeWidth: 3 }\n}\n',
);
const importer = scaleDocument(50)
  .replace('@title: "Scale 50"\n', '@title: "Scale 50, importing"\n@imports: ["./lib500.sgl"]\n')
  .replace('n0: { @label: "Node number 0" }', 'n0: { @type: Critical, @label: "Node number 0" }');
writeFileSync(`${importsDir}lib500.sgl`, library, 'utf8');
writeFileSync(`${importsDir}importer50.sgl`, importer, 'utf8');

console.log('bench/generate.js: wrote n50.sgl, n500.sgl, n2000.sgl, imports/lib500.sgl, imports/importer50.sgl');
