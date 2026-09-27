import { describe, expect, it } from 'vitest';
import { createShareLinkQueue } from '../src/state/share-links.js';
import type { ShareDecodeResult } from '../src/state/share.js';

/** F13 round 1, item 6: pasted share links are handled one at a time, and
 *  the hash is cleared before a link is imported, so a reload in between
 *  (F12) cannot import it twice. */
describe('createShareLinkQueue', () => {
  function harness() {
    let hash = '';
    const log: string[] = [];
    const opening: (() => void)[] = [];
    const queue = createShareLinkQueue({
      hash: () => hash,
      clearHash: () => {
        log.push(`clear:${hash}`);
        hash = '';
      },
      decode: async (h): Promise<ShareDecodeResult> => (h === '#bad' ? { kind: 'invalid', reason: 'corrupt' } : h === '' ? { kind: 'none' } : { kind: 'ok', payload: { source: h } }),
      open: (payload) => {
        log.push(`open:${payload.source}`);
        return new Promise<void>((resolve) =>
          opening.push(() => {
            log.push(`opened:${payload.source}`);
            resolve();
          }),
        );
      },
      onInvalid: () => log.push('invalid'),
    });
    return {
      log,
      opening,
      paste(h: string) {
        hash = h;
        return queue();
      },
    };
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  it('clears the hash before opening the link', async () => {
    const h = harness();
    void h.paste('#one');
    await settle();
    expect(h.log).toEqual(['clear:#one', 'open:#one']);
  });

  it('a second link waits until the first is open', async () => {
    const h = harness();
    void h.paste('#one');
    await settle();
    void h.paste('#two');
    await settle();
    expect(h.log).toEqual(['clear:#one', 'open:#one']); // #two not started
    h.opening[0]!();
    await settle();
    expect(h.log).toEqual(['clear:#one', 'open:#one', 'opened:#one', 'clear:#two', 'open:#two']);
  });

  it('an invalid link toasts and clears the hash; nothing opens', async () => {
    const h = harness();
    void h.paste('#bad');
    await settle();
    expect(h.log).toEqual(['clear:#bad', 'invalid']);
  });
});
