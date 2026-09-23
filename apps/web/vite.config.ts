import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { HEADERS_FILE, META_CSP, headersFor, parseHeadersFile } from './build/headers.js';

/**
 * DD-10 §5 / DD-09 §1.2 (J4): writes `dist/_headers`, mirrors the CSP into the
 * built `index.html` as a `<meta>`, and makes `vite preview` serve the build
 * with those same headers — so the e2e suite, which runs against `vite
 * preview`, runs under the production CSP (`e2e/csp.spec.ts` also checks the
 * served headers against `dist/_headers` on disk). Build and preview only: the
 * dev server needs inline scripts and a websocket for HMR.
 */
function sglHeaders(): Plugin {
  const rules = parseHeadersFile(HEADERS_FILE);
  return {
    name: 'sgl-headers',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS_FILE });
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (ctx.server !== undefined) return undefined; // dev server: no CSP.
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: META_CSP }, injectTo: 'head-prepend' }];
      },
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        // (`@types/node` is not part of this app's toolchain; `url` is there.)
        const pathname = new URL((req as { url?: string }).url ?? '/', 'http://preview.invalid').pathname;
        for (const [name, value] of headersFor(rules, pathname)) res.setHeader(name, value);
        next();
      });
    },
  };
}

// DD-10 §2. Manual chunks keep the lazily-loaded engines and the editor out of the
// core bundle, which is what the 180 kB core budget (NFR 4.1) is measured against.
// Written as a function so a chunk stays declared before anything imports it.
export default defineConfig({
  plugins: [
    preact(),
    // DD-08 §12. `generateSW` precaches whatever the build emits that
    // `globPatterns` matches — the shell, the worker and every engine chunk
    // the worker can import (J1: only `grid` today; an engine chunk exists
    // only once something imports it, so Stage K's `elk` is picked up by
    // registering it, with no change here), the Inter WOFF2 files, `OFL.txt`,
    // the icons and the manifest. Both themes and the example document are
    // compiled into the app chunk, so they come with it. The size cap is
    // raised because Workbox *skips* (with only a warning) any file over its
    // 2 MiB default, and `elk` is large; `e2e/pwa.spec.ts` fails if any
    // emitted asset is ever missing from the precache.
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      injectRegister: false, // `src/io/pwa.ts` registers by hand (no workbox-window).
      includeManifestIcons: false, // `globPatterns` already takes `icons/*.png`.
      manifest: {
        id: '/',
        name: 'SGL — Structured Graphing Language',
        short_name: 'SGL',
        description: 'Text-first diagramming: write structured text, see the diagram. Works offline.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f7f8fa',
        theme_color: '#1b2330',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [{ action: '/', accept: { 'text/plain': ['.sgl'], 'application/json': ['.sgl.json'] } }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,txt}'], // + manifest.webmanifest, added by the plugin
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // DD-08 §12: the new worker waits until the "Update available —
        // reload" chip is clicked, so an in-progress edit is never lost.
        skipWaiting: false,
        clientsClaim: false,
      },
    }),
    sglHeaders(),
  ],
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
