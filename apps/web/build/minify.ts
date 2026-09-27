import { minify, type MinifyOptions } from 'terser';
import { transformWithEsbuild, type Plugin, type Rollup } from 'vite';

/**
 * F20: the app's JavaScript is minified by terser rather than Vite's default
 * esbuild pass. On this app terser's output is ~5 kB smaller gzipped over the
 * core bundle (DD-10 §2), with no change to the code itself: better constant
 * folding, inlining and dead-branch removal across a chunk. Terser is not a
 * runtime dependency; it runs here at build time only.
 *
 * Wired in `vite.config.ts` with `build.minify: false` (so esbuild does not
 * minify first: terser over esbuild's output came out *larger*) and
 * `build.cssMinify: 'esbuild'` (CSS as before). The hook is ordered `post`,
 * after Vite's own `renderChunk` work (the build target's syntax lowering),
 * so it sees the final chunk.
 *
 * The lazy `elk` chunk keeps esbuild: it is 1.4 MB of elkjs, already
 * GWT-minified, outside the core budget (ADR-0005), and terser takes ~45 s on
 * it where esbuild takes under one.
 */

/** Chunks (by Rollup chunk name) minified by esbuild instead of terser. */
export const ESBUILD_CHUNKS: readonly string[] = ['elk'];

/** `module: true` (ES modules, strict, top-level names may be mangled);
 *  two compress passes (a third gains ~80 B). No `unsafe*` option. */
export const TERSER_OPTIONS: MinifyOptions = { module: true, ecma: 2020, compress: { passes: 2 } };

export function sglMinify(): Plugin {
  let sourcemap = false;
  return {
    name: 'sgl-minify',
    apply: 'build',
    configResolved(config) {
      sourcemap = config.build.sourcemap !== false;
    },
    renderChunk: {
      order: 'post',
      async handler(code, chunk) {
        if (ESBUILD_CHUNKS.includes(chunk.name)) {
          const out = await transformWithEsbuild(code, chunk.fileName, { minify: true, format: 'esm', sourcemap });
          return { code: out.code, map: sourcemap ? (out.map as Rollup.SourceMapInput) : null };
        }
        const out = await minify(code, { ...TERSER_OPTIONS, sourceMap: sourcemap ? { asObject: true } : false });
        if (out.code === undefined) throw new Error(`sgl-minify: terser returned no code for ${chunk.fileName}`);
        return { code: out.code, map: sourcemap ? (out.map as Rollup.SourceMapInput) : null };
      },
    },
  };
}
