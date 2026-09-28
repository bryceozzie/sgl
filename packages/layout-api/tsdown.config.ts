import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/conformance.ts', 'src/compose.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
