import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/editor.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  // `src/editor.ts` (Stage I) is a second entry that imports the same generated,
  // non-TS grammar module (`src/grammar/sgl.parser.js`) `src/index.ts` already
  // does via `parse.ts`. tsdown's default unbundle mode extracts that shared,
  // non-TS file into one hashed chunk but does not rewrite every importer's
  // relative specifier to point at it — `dist/parse.js` and `dist/editor.js`
  // both kept the literal `./grammar/sgl.parser.js` path, which does not exist
  // in `dist/` (only the hashed chunk does), breaking both entries at import
  // time. Bundling instead avoids the shared-chunk extraction entirely: the
  // parser's ~4 kB lands inlined in both `index.js` and `editor.js`, which is a
  // fine trade for a grammar this small and keeps the two entry points fully
  // independent, as DD-01 §7 wants.
  unbundle: false,
});
