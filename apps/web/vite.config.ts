import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// DD-10 §2. Manual chunks keep the lazily-loaded engines and the editor out of the
// core bundle, which is what the 180 kB core budget (NFR 4.1) is measured against.
// Written as a function so a chunk stays declared before anything imports it.
//
// ⟶ as the app lands: vite-plugin-pwa (Workbox) precaching the shell, both engines
// and both themes, plus `file_handlers` for .sgl; and the layout worker as
// `new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })`
// so Vite bundles it and dynamic import() of engine chunks inside it works.
export default defineConfig({
  plugins: [preact()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('elkjs') || id.includes('layout-elk')) return 'elk';
          if (id.includes('layout-std')) return 'grid';
          if (id.includes('codemirror') || id.includes('@lezer')) return 'editor';
          return undefined;
        },
      },
    },
  },
});
