import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * B5 branch 4, fix round 1 (item 3): the build's module graph, for
 * `scripts/check-core-chunks.mjs`. Each build — the page's and the layout
 * worker's — records, per emitted JS chunk, the modules whose code it
 * carries (Rollup's `chunk.modules`, those with a rendered length). The
 * page's build writes the lot to `CHUNK_MODULES_FILE` once it has written
 * its bundle (the worker's is built during it, so is already recorded).
 *
 * The file is outside `dist`, so it is neither deployed nor precached. The
 * check refuses one whose chunk list is not exactly `dist/assets`'s JS
 * files, so a stale file from an earlier build cannot pass it.
 */

export const CHUNK_MODULES_FILE = fileURLToPath(new URL('../node_modules/.sgl-build/chunk-modules.json', import.meta.url));

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** File name (under `assets/`) → module ids, repo-relative, without query. */
const graph = new Map<string, readonly string[]>();

/** `role`: `'page'` writes the file; `'worker'` only records. */
export function chunkModules(role: 'page' | 'worker'): Plugin {
  return {
    name: `sgl-chunk-modules-${role}`,
    apply: 'build',
    buildStart() {
      // The worker is built during the page's build, after this.
      if (role === 'page') graph.clear();
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const ids = Object.entries(chunk.modules)
          .filter(([, m]) => m.renderedLength > 0)
          .map(([id]) => {
            const plain = id.replace(/\?.*$/, '');
            return plain.startsWith(ROOT) ? plain.slice(ROOT.length) : plain;
          })
          .sort();
        graph.set(chunk.fileName.replace(/^assets\//, ''), ids);
      }
    },
    writeBundle() {
      if (role !== 'page') return;
      mkdirSync(fileURLToPath(new URL('.', `file://${CHUNK_MODULES_FILE}`)), { recursive: true });
      const out: Record<string, readonly string[]> = {};
      for (const file of [...graph.keys()].sort()) out[file] = graph.get(file)!;
      writeFileSync(CHUNK_MODULES_FILE, `${JSON.stringify(out, null, 1)}\n`);
    },
  };
}
