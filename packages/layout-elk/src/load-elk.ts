import type { ElkNode } from './mapping.js';

/**
 * Loads `elkjs/lib/elk.bundled.js` once, on first use, and caches the `ELK`
 * instance (Stage K, decision K1).
 *
 * **K11 — the scoped `document` stub.** elkjs 0.11.1's `elk.bundled.js`
 * (line 6430, the inlined `elk-worker.min.js`) decides where it runs with
 *
 *     if (typeof document === 'undefined' && typeof self !== 'undefined') {
 *       var i = new h(self); self.onmessage = i.saveDispatch      // "I am the worker"
 *     } else if (typeof module !== 'undefined' && module.exports) {
 *       module.exports = { default: FakeWorker, Worker: FakeWorker }
 *     }
 *
 * Inside our layout worker there is no `document`, so it takes the first
 * branch: it installs itself as `self.onmessage` on *our* worker and never
 * exports the in-thread FakeWorker, and `new ELK()` then throws "_Worker is
 * not a constructor". So, only when `document` is absent, and only for the
 * duration of the dynamic `import()`, `globalThis.document` is set to an empty
 * object and deleted again in a `finally` — a failed import leaves nothing
 * behind. No DOM API is defined: the stub only hides the *absence* of one from
 * elkjs for one import. On a page's main thread (`document` exists) nothing
 * changes. The cached promise serialises loading, so no two loads can race
 * the stub. `pnpm patch` (a patched 1.4 MB generated file to maintain) and
 * elkjs's own worker build (06 §4 pitfall 7) were both rejected.
 */

export interface ElkInstance {
  layout(graph: ElkNode): Promise<ElkNode>;
}

type ElkConstructor = new () => ElkInstance;

let elkInstance: Promise<ElkInstance> | null = null;

async function importElk(): Promise<ElkInstance> {
  const scope = globalThis as { document?: unknown };
  const stub = typeof scope.document === 'undefined';
  if (stub) scope.document = {};
  try {
    const mod = (await import('elkjs/lib/elk.bundled.js')) as { readonly default: unknown };
    return new (mod.default as ElkConstructor)();
  } finally {
    if (stub) delete scope.document;
  }
}

/** A failed load is not cached, so the next request retries it (a chunk that
 *  failed to fetch). */
export function loadElk(): Promise<ElkInstance> {
  if (elkInstance === null) {
    elkInstance = importElk().catch((err: unknown) => {
      elkInstance = null;
      throw err;
    });
  }
  return elkInstance;
}
