/**
 * A lazy chunk (DD-10 §2), imported on first use (F12/F13 round 1, item 2).
 * A failed load is reported through `onChunkFailure` (the app toasts) and
 * not cached, so the next use tries again: after an update another tab
 * accepted, a chunk this page's code names can be gone from the precache,
 * and caching the rejection would make the control dead for good, silently.
 * DOM-free.
 */

let report: () => void = () => undefined;

/** What a failed load calls (the app: a toast). */
export function onChunkFailure(fn: () => void): void {
  report = fn;
}

export function lazyChunk<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= load().catch((err: unknown) => {
      loading = undefined;
      report();
      throw err;
    }));
}
