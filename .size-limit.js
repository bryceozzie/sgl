// DD-09 §2 / DD-10 §4: the core bundle budget, < 180 kB gzipped (NFR 4.1).
//
// Stage K, decision K6: "the core chunk" is the JS and CSS the initial page
// load fetches — the app's entry chunk and every chunk it imports statically
// (editor, grid), its CSS, and the layout-worker entry and its static
// imports — measured gzipped, file by file, and summed. The lazy `elk` chunk
// (elkjs, loaded by the worker on the first elk layout) is excluded by
// definition (ADR-0005). Fonts and icons are not JS/CSS and are not counted.
//
// The globs take every emitted JS/CSS file but `elk-*.js`, so a new lazy
// chunk would be counted too (conservatively) until it is named here;
// `apps/web/e2e/pwa.spec.ts` checks that elk is imported only by the worker.
// Needs `pnpm --filter @sgl/web build` first (root `pnpm build` does it).
//
// The limit is a human decision: do not raise it to make a change pass.
export default [
  {
    name: 'core (entry + static imports + layout worker), gzip',
    path: ['apps/web/dist/assets/*.js', 'apps/web/dist/assets/*.css', '!apps/web/dist/assets/elk-*.js'],
    gzip: true,
    limit: '180 kB',
  },
];
