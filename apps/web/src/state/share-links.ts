import type { ShareDecodeResult, SharePayload } from './share.js';

/** What `createShareLinkQueue` reads and does; `io/app-boot.ts` gives it
 *  `location.hash`, `history.replaceState` and the lazy `share` chunk. */
export interface ShareLinkDeps {
  readonly hash: () => string;
  readonly clearHash: () => void;
  readonly decode: (hash: string) => Promise<ShareDecodeResult>;
  /** Stores the link and switches to it; resolves once it is open. */
  readonly open: (payload: SharePayload) => Promise<void>;
  readonly onInvalid: () => void;
}

/**
 * DD-08 §8's pasted share links (F13), DOM-free. The returned function is
 * the `hashchange` handler. Links are handled **one at a time**: the next
 * one starts only once the previous one's `open` has resolved, i.e. once it
 * is the open document (round 1, item 6). A link replaced by a newer hash
 * before it was decoded is skipped. The hash is cleared **before** the link
 * is imported, so a reload in the middle (F12, an update) cannot import it a
 * second time; the import itself has already remembered the new document as
 * the one to open. An invalid link clears the hash and toasts.
 */
export function createShareLinkQueue(deps: ShareLinkDeps): () => Promise<void> {
  let queue = Promise.resolve();
  return () => {
    const hash = deps.hash();
    queue = queue
      .then(async () => {
        if (deps.hash() !== hash) return;
        const decoded = await deps.decode(hash);
        if (decoded.kind === 'none' || deps.hash() !== hash) return;
        deps.clearHash();
        if (decoded.kind === 'invalid') return deps.onInvalid();
        await deps.open(decoded.payload);
      })
      .catch((err: unknown) => console.error('[SGL] opening a share link failed.', err));
    return queue;
  };
}
