import type { Plugin, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { ESBUILD_CHUNKS, sglMinify } from '../build/minify.js';
import viteConfig from '../vite.config.js';

/** F20: the app's JS is minified by terser (`build/minify.ts`), not Vite's
 *  default esbuild pass, except the lazy `elk` chunk, which keeps esbuild. */

type Handler = (this: unknown, code: string, chunk: { name: string; fileName: string }) => Promise<{ code: string; map: unknown } | null>;

function handlerOf(plugin: Plugin): Handler {
  const hook = plugin.renderChunk as unknown as { order: string; handler: Handler };
  expect(hook.order).toBe('post');
  return hook.handler;
}

async function run(chunkName: string, code: string): Promise<string> {
  const plugin = sglMinify();
  const out = await handlerOf(plugin).call({}, code, { name: chunkName, fileName: `assets/${chunkName}-x.js` });
  expect(out).not.toBeNull();
  return out!.code;
}

const SOURCE = `
export function describeTotal(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const label = 'total';
  if (false) console.log('never');
  return label + ': ' + total;
}
`;

describe('sglMinify (F20)', () => {
  it('minifies an ordinary chunk with terser: output behaves as the input', async () => {
    const code = await run('index', SOURCE);
    expect(code.length).toBeLessThan(SOURCE.length / 2);
    expect(code).not.toContain('never');
    const mod = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as { describeTotal: (v: number[]) => string };
    expect(mod.describeTotal([1, 2, 3])).toBe('total: 6');
  });

  it('keeps esbuild for the elk chunk (1.4 MB of elkjs: terser takes ~45 s on it)', async () => {
    expect(ESBUILD_CHUNKS).toEqual(['elk']);
    const code = await run('elk', SOURCE);
    const mod = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as { describeTotal: (v: number[]) => string };
    expect(mod.describeTotal([4, 5])).toBe('total: 9');
    // esbuild keeps the export's own name; terser's module mode would too, so
    // tell the two apart by esbuild's own output for the same input.
    const { transformWithEsbuild } = await import('vite');
    expect(code).toBe((await transformWithEsbuild(SOURCE, 'elk-x.js', { minify: true, format: 'esm' })).code);
  });

  it('is what vite.config.ts builds with, for the page and the worker, and CSS keeps esbuild', async () => {
    const config = viteConfig as UserConfig;
    expect(config.build?.minify).toBe(false);
    expect(config.build?.cssMinify).toBe('esbuild');
    const names = (config.plugins ?? []).flat().map((p) => (p as Plugin | null)?.name);
    expect(names).toContain('sgl-minify');
    const workerPlugins = config.worker?.plugins;
    expect(typeof workerPlugins).toBe('function');
    const workerNames = (workerPlugins as () => Plugin[])().map((p) => p.name);
    expect(workerNames).toContain('sgl-minify');
  });
});
