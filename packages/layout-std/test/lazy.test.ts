import {
  createWorkerHost,
  createWorkerRuntime,
  EngineRegistry,
  type HostToWorker,
  type LayoutInput,
  type WorkerToHost,
} from '@sgl/layout-api';
import { describe, expect, it } from 'vitest';
import { layoutInputForSource, METRICS } from '../../layout-elk/test/corpus-input.js';
import { treeDescriptor } from '../src/descriptor.js';
import { lazyEngine, treeEngine, type LayoutFn } from '../src/lazy.js';
import { layoutTree } from '../src/tree.js';

/**
 * The lazy `std-trees` chunk (DD-12 N52, H9): `treeEngine` is a static
 * descriptor plus a `layout()` that loads the chunk on its first call. A
 * failed load degrades as `elk`'s lazy chunk does (DD-06 §3, K1): the
 * request fails with `SGL4011` and no layout (the app keeps the previous
 * one), nothing is cached, and the next request loads it afresh.
 */

type Listener = (ev: { readonly data: WorkerToHost }) => void;

/** The real host and the real worker runtime, over an in-memory channel
 *  (as `layout-api/test/host-runtime.integration.test.ts` wires them). */
function channel(registry: EngineRegistry): Worker {
  const listeners: Listener[] = [];
  let terminated = false;
  const runtime = createWorkerRuntime(registry, {
    post: (message) => queueMicrotask(() => !terminated && listeners.forEach((l) => l({ data: message }))),
  });
  return {
    postMessage: (message: HostToWorker) => queueMicrotask(() => !terminated && runtime.receive(message)),
    addEventListener: (_type: 'message', l: Listener) => listeners.push(l),
    terminate: () => {
      terminated = true;
    },
  } as unknown as Worker;
}

const INPUT: LayoutInput = layoutInputForSource('r: "R"\na: "A"\nr -> a\n');

describe('lazyEngine: the chunk loads on first use, once', () => {
  it('does not load at registration, loads on the first layout, and reuses it', async () => {
    let loads = 0;
    const engine = lazyEngine(treeDescriptor, () => {
      loads += 1;
      return Promise.resolve(layoutTree);
    });
    const registry = new EngineRegistry();
    registry.register(engine);
    expect(loads).toBe(0);
    await engine.layout(INPUT, { options: {}, metrics: METRICS } as never);
    await engine.layout(INPUT, { options: {}, metrics: METRICS } as never);
    expect(loads).toBe(1);
  });

  it('treeEngine is the descriptor plus a lazy layout(): it lays out through the chunk', async () => {
    const r = await treeEngine.layout(INPUT, { options: {}, metrics: METRICS } as never);
    expect(Object.keys(r.nodes).sort()).toEqual(['a', 'r']);
  });
});

describe('a chunk that fails to load (degradation, as elk’s)', () => {
  it('fails that request with SGL4011 and no layout, and the next request retries the load and succeeds', async () => {
    let attempts = 0;
    const engine = lazyEngine(treeDescriptor, (): Promise<LayoutFn> => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: std-trees-x.js')) : Promise.resolve(layoutTree);
    });
    const registry = new EngineRegistry();
    registry.register(engine);
    const host = createWorkerHost(() => channel(registry));
    try {
      const run = () => host.run(treeDescriptor.id, INPUT, {}, METRICS, {}, new AbortController().signal);
      const failed = await run();
      expect(failed.value).toBeNull();
      expect(failed.diagnostics.map((d) => [d.code, d.severity])).toEqual([['SGL4011', 'error']]);
      expect(failed.diagnostics[0]!.message).toContain('sgl.tree');
      expect(failed.diagnostics[0]!.message).toContain('Failed to fetch dynamically imported module');

      const ok = await run();
      expect(attempts).toBe(2);
      expect(ok.diagnostics).toEqual([]);
      expect(Object.keys(ok.value!.nodes).sort()).toEqual(['a', 'r']);
    } finally {
      host.dispose();
    }
  });

  it('two requests racing a failing load both fail, and neither caches the failure', async () => {
    let attempts = 0;
    let fail = true;
    const engine = lazyEngine(treeDescriptor, () => {
      attempts += 1;
      return fail ? Promise.reject(new Error('offline')) : Promise.resolve(layoutTree);
    });
    const ctx = { options: {}, metrics: METRICS } as never;
    const both = await Promise.allSettled([engine.layout(INPUT, ctx), engine.layout(INPUT, ctx)]);
    expect(both.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    expect(attempts).toBe(1); // one load shared by both
    fail = false;
    await expect(engine.layout(INPUT, ctx)).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });
});
