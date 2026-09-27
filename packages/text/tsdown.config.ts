import { defineConfig } from 'tsdown';

export default defineConfig({
  // `src/wrap.ts` (DD-11 T3): the word breaker as `@sgl/text/wrap`, so the app
  // loads it lazily (the `rich-text` chunk, T53) and a document without
  // `@size.maxWidth` or `@size.width` never pays for it.
  entry: ['src/index.ts', 'src/wrap.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
