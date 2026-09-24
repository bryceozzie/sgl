// DD-09 §2 / DD-10 §4: the core bundle budget, < 180 kB gzipped (NFR 4.1).
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
// size-limit is pinned to 12.1.0 (fix round 1, item 20): 13+ require Node
// ≥ 22.18 (14 uses `fs/promises` `glob`), and CI runs Node 20.19.0
// (`.nvmrc`) with `engine-strict=true`.
// Needs `pnpm --filter @sgl/web build` first (root `pnpm build` does it).
//
// The limit is a human decision: do not raise it to make a change pass.
export default [
  {
    name: 'core (entry + static imports + layout worker), gzip',
    path: ['apps/web/dist/assets/*.js', 'apps/web/dist/assets/*.css', '!apps/web/dist/assets/elk-*.js', '!apps/web/dist/assets/share-*.js', '!apps/web/dist/assets/file-actions-*.js'],
    gzip: true,
    limit: '180 kB',
  },
];
