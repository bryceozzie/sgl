import { describe, expect, it, vi } from 'vitest';
import { createUpdateCheck, followUpdate, UPDATE_CHECK_INTERVAL_MS } from '../src/io/pwa.js';

/** F12: another tab accepted an update, so this one runs code whose lazy
 *  chunks the new service worker no longer precaches. */
describe('following an update accepted in another tab', () => {
  function harness(safe: boolean) {
    const calls: string[] = [];
    let settle: () => void = () => undefined;
    const done = followUpdate({
      flush: () => {
        calls.push('flush');
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
      safe: () => {
        calls.push('safe?');
        return safe;
      },
      remember: () => calls.push('remember'),
      reload: () => calls.push('reload'),
      stale: () => calls.push('stale'),
    });
    return { calls, settle: () => settle(), done };
  }

  it('saves first, then remembers the open document and reloads', async () => {
    const h = harness(true);
    expect(h.calls).toEqual(['flush']); // nothing else until the write has settled
    h.settle();
    await h.done;
    expect(h.calls).toEqual(['flush', 'safe?', 'remember', 'reload']);
  });

  it('does not reload a tab whose documents could not be saved (in memory only): it says so instead', async () => {
    const h = harness(false);
    h.settle();
    await h.done;
    expect(h.calls).toEqual(['flush', 'safe?', 'stale']);
  });
});

/** Fix round 1, item 15: a long-open installed app notices an update. */
describe('service-worker update check on becoming visible', () => {
  it('checks at most once an hour', () => {
    let now = 0;
    const update = vi.fn(async () => undefined);
    const checks = createUpdateCheck(update, () => now);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);

    checks.check(); // just registered: that was the check
    expect(update).not.toHaveBeenCalled();
    now = UPDATE_CHECK_INTERVAL_MS - 1;
    checks.check();
    expect(update).not.toHaveBeenCalled();
    now = UPDATE_CHECK_INTERVAL_MS;
    checks.check();
    expect(update).toHaveBeenCalledTimes(1);
    now += 1000;
    checks.check(); // visible again a second later: throttled
    expect(update).toHaveBeenCalledTimes(1);
    now += UPDATE_CHECK_INTERVAL_MS;
    checks.check();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('a failed check (offline) is swallowed, not an unhandled rejection', async () => {
    let now = 0;
    const update = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    const checks = createUpdateCheck(update, () => now, 10);
    now = 10;
    expect(() => checks.check()).not.toThrow();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
