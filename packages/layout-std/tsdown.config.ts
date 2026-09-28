import { defineConfig } from 'tsdown';

export default defineConfig({
  // `src/descriptor.ts` (F20): `grid`'s id, name, capabilities and schemas as
  // `@sgl/layout-std/descriptor`, so the page can list the engine without
  // bundling its `layout()`, which only the worker runs.
  // `src/std-trees.ts` (DD-12 N52): `tree`'s layout code, which `lazy.ts`
  // reaches only by a dynamic `import()`. An entry of its own keeps its file
  // name stable (`dist/std-trees.js`), so the app's worker build emits it as
  // the lazy `std-trees-*.js` chunk. It is not in `exports`: nothing imports
  // it but `treeEngine`.
  entry: ['src/index.ts', 'src/descriptor.ts', 'src/std-trees.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
