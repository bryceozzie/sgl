import { describe, expect, it, vi } from 'vitest';
import { createUpdateCheck, UPDATE_CHECK_INTERVAL_MS } from '../src/io/pwa.js';

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
