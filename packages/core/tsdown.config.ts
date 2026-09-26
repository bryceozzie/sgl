import { defineConfig } from 'tsdown';

export default defineConfig({
  // `src/json.ts` (A8 fix round 2): canonical JSON as `@sgl/core/json`, so an
  // app bundle that never saves `.sgl.json` at boot keeps `toJson` out of it.
  // `src/imports.ts` (A9, DD-02 §10.9): the import linker as
  // `@sgl/core/imports`, loaded lazily by the app for a document with
  // `@imports`; the boot path keeps only `resolve()`'s hook.
  // `src/inline.ts` (A18, DD-11 T1, T53): the inline markdown parser as
  // `@sgl/core/inline`, in the app's lazy `rich-text` chunk.
  entry: ['src/index.ts', 'src/editor.ts', 'src/json.ts', 'src/imports.ts', 'src/inline.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  // `src/editor.ts` (Stage I) is a second entry that imports the same generated,
  // non-TS grammar module (`src/grammar/sgl.parser.js`) `src/index.ts` already
  // does via `parse.ts`. tsdown's unbundle mode emits one output file per
  // source module and, for that shared non-TS file, extracted it to a hashed
  // chunk without rewriting its importers' relative specifiers — `dist/parse.js`
  // and `dist/editor.js` both kept the literal `./grammar/sgl.parser.js`, which
  // does not exist in `dist/`, breaking both entries at import time.
  //
  // Bundle mode (below) bundles each entry, and code both entries use — just
  // the grammar tables — goes into one shared chunk, `dist/sgl.parser-<hash>.js`
  // (it imports only `@lezer/lr`), and the bundler rewrites both entries'
  // imports to point at it, so it resolves. The parser is *not* inlined twice:
  // `index.js` and `editor.js` each import that one chunk. The entries stay
  // independent where it matters (DD-01 §7): `index.js` pulls in nothing from
  // `editor.js`, so no CodeMirror import reaches a consumer of the `.` entry.
  unbundle: false,
});
