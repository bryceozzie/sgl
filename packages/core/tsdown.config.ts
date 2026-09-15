import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/editor.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
