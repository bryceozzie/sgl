import { describe, expect, it, vi } from 'vitest';
import { lazyChunk, onChunkFailure } from '../src/state/lazy.js';

/** F12/F13 round 1, item 2: a lazy chunk that fails to load (gone from the
 *  precache after an update, offline) is reported, and the next use tries
 *  again instead of getting the same rejected promise forever. */
describe('lazyChunk', () => {
  it('loads once and shares the result', async () => {
    const load = vi.fn(async () => ({ v: 1 }));
    const get = lazyChunk(load);
    expect(await get()).toBe(await get());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed load is reported and not cached: the next use retries', async () => {
    const report = vi.fn();
    onChunkFailure(report);
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new TypeError('Failed to fetch dynamically imported module');
      return { v: 2 };
    });
    const get = lazyChunk(load);
    await expect(get()).rejects.toThrow(TypeError);
    expect(report).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await get()).toEqual({ v: 2 });
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
