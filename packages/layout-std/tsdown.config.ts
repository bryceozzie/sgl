import { defineConfig } from 'tsdown';

export default defineConfig({
  // `src/descriptor.ts` (F20): `grid`'s id, name, capabilities and schemas as
  // `@sgl/layout-std/descriptor`, so the page can list the engine without
  // bundling its `layout()`, which only the worker runs.
  entry: ['src/index.ts', 'src/descriptor.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
