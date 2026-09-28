/*
 * `describeShapeError`, in a module of its own (B8 branch 2, DD-10 §2): the
 * layout worker's runtime needs it on its boot path, and `validate.ts`, whose
 * checks only the lazy composer needs in the worker, must not share a module
 * with it, or the bundler puts those checks on the worker's boot path too.
 * `validate.ts` re-exports it, so every importer is unchanged.
 */

/**
 * Returns a human-readable description of what's wrong with `result`'s outer
 * shape, or `null` if it is safe to dereference `.nodes`/`.edges`/`.labels`/
 * `.bounds` the way the rest of this function (and `fallbacks.ts`'s
 * `routeStraight`/`placeLabels`) does. Deliberately shallow — it only guards
 * the four top-level accesses that would otherwise throw; the per-node/
 * per-edge/per-label checks below still catch a malformed value *inside* one
 * of these four.
 *
 * Exported (Stage H fix round 2, item 2) so `worker-runtime.ts` can run the
 * same check on an engine's raw output *before* applying the host fallbacks —
 * `routeStraight`/`placeLabels` make exactly the same assumptions this
 * function's callers do (`result.edges`, `.nodes`, `.labels` all exist), so
 * an engine resolving `undefined` reached them unguarded and threw inside the
 * worker's `try`/`catch`, turning what should be host-side `SGL4002` into
 * worker-side `SGL4011` with a raw `TypeError` message instead. One check,
 * reused, rather than a second copy of it in `worker-runtime.ts`.
 *
 * Takes `unknown`, not `LayoutResult`: the whole point is that the static
 * type is a compile-time guarantee only, and this function is precisely what
 * stands between that guarantee and the untrusted runtime value everywhere it
 * is called.
 */
export function describeShapeError(result: unknown): string | null {
  const r = result;
  if (!isPlainObject(r)) return `engine returned ${describeType(r)}, not a LayoutResult object`;
  if (!isPlainObject(r['nodes'])) return `LayoutResult.nodes is ${describeType(r['nodes'])}, not an object`;
  if (!isPlainObject(r['edges'])) return `LayoutResult.edges is ${describeType(r['edges'])}, not an object`;
  if (!Array.isArray(r['labels'])) return `LayoutResult.labels is ${describeType(r['labels'])}, not an array`;
  if (!isPlainObject(r['bounds'])) return `LayoutResult.bounds is ${describeType(r['bounds'])}, not an object`;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

