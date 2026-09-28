// DD-09 §2 / DD-10 §4: the core bundle budget, < 182 kB gzipped (NFR 4.1).
// Raised from 180 kB by human decision 2026-09-26 (A9); the 300 kB hard
// ceiling is unchanged.
//
// Stage K, decision K6: "the core chunk" is the JS and CSS the initial page
// load fetches — the app's entry chunk and every chunk it imports statically
// (editor, grid), its CSS, and the layout-worker entry and its static
// imports — measured gzipped, file by file, and summed. The lazy `elk` chunk
// (elkjs, loaded by the worker on the first elk layout) is excluded by
// definition (ADR-0005). Fonts and icons are not JS/CSS and are not counted.
//
// The globs take every emitted JS/CSS file but `elk-*.js` and `share-*.js`,
// so a new lazy chunk would be counted too (conservatively) until it is named
// here. `share-*.js` (`state/share.ts` + `base64url.ts`) is lazy since F9's
// fix round 1: boot loads it only for a link with a payload, and Share or a
// pasted link when used (`e2e/offline.spec.ts` covers it offline). A glob
// cannot see elkjs creeping into the boot path, so root `pnpm size` also
// runs `apps/web/scripts/check-core-chunks.mjs` (fix round 1, item 17), which
// walks the entry's static imports and fails if any reaches elk.
//
// `file-actions-*.js` and `engine-options-form-*.js` are A8's lazy chunks
// (Open/Save ▾/Share's work, the Options ▾ form); `documents-menu-*.js` is
// the Documents ▾ list, lazy since A9 phase 2's first step (F20, DD-02
// §10.9 I32), loaded when the menu is first opened; `imports-*.js` is A9's
// (`@sgl/core/imports`, the stored-document index and host, DD-08 §15),
// loaded for the first document with `@imports`; `filename-*.js` is
// `state/filename.ts`, which `file-actions` and `imports` share, so the
// bundler gives it a chunk of its own. Each is precached and has an offline
// case in `e2e/offline.spec.ts`; `check-core-chunks.mjs` fails if any
// excluded chunk is reachable from the entry. `rich-text-*.js` is A18's
// (DD-11 T53: the inline parser `@sgl/core/inline` and the word breaker
// `@sgl/text/wrap`), loaded for the first document with markup in a label or a
// label to wrap; a document with neither never fetches it. `run-faces-*.js` is
// `io/run-faces.ts`, A18's seven run faces (DD-11 T26): registered by `rich-text`
// and listed for export by `file-actions`, which share it, so the bundler gives
// it a chunk of its own; the boot CSS declares none of them.
// `std-trees-*.js` is B5's (DD-12 N52, H9): `tree`'s layout code (and
// `radial`'s, when it lands), imported by the layout worker alone, and only
// dynamically, on the first request for one of those engines;
// `check-core-chunks.mjs` also walks the worker's static imports for it.
//
// size-limit is pinned to 12.1.0 (fix round 1, item 20): 13+ require Node
// ≥ 22.18 (14 uses `fs/promises` `glob`), and CI runs Node 20.19.0
// (`.nvmrc`) with `engine-strict=true`.
// Needs `pnpm --filter @sgl/web build` first (root `pnpm build` does it).
//
// The limit is a human decision: do not raise it to make a change pass.
export default [
  {
    name: 'core (entry + static imports + layout worker), gzip',
    path: ['apps/web/dist/assets/*.js', 'apps/web/dist/assets/*.css', '!apps/web/dist/assets/elk-*.js', '!apps/web/dist/assets/share-*.js', '!apps/web/dist/assets/file-actions-*.js', '!apps/web/dist/assets/engine-options-form-*.js', '!apps/web/dist/assets/documents-menu-*.js', '!apps/web/dist/assets/imports-*.js', '!apps/web/dist/assets/filename-*.js', '!apps/web/dist/assets/rich-text-*.js', '!apps/web/dist/assets/run-faces-*.js', '!apps/web/dist/assets/std-trees-*.js'],
    gzip: true,
    limit: '182 kB',
  },
];
