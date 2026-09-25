import { defineConfig } from 'tsdown';

export default defineConfig({
  // `src/fonts.ts` (D2): `embedFonts` as `@sgl/render-svg/fonts`, so an app
  // that embeds fonts only at export keeps it out of the bundle that renders.
  entry: ['src/index.ts', 'src/fonts.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
