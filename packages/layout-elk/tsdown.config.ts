import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/descriptor.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
