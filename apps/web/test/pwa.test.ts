import { describe, expect, it, vi } from 'vitest';
import { createUpdateCheck, followUpdate, oncePerController, STALE_ELSEWHERE, STALE_HERE, UPDATE_CHECK_INTERVAL_MS, type FollowUpdate } from '../src/io/pwa.js';
import { createAutosave, type Autosave } from '../src/state/autosave.js';
import { switchDocument } from '../src/state/documents.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';
import { createFakeClock } from './fake-schedule.js';

const rec = (id: string, source = `${id}: "X"\n`): DocumentRecord => ({
  id,
  title: id,
  source,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt: 1,
});

/** F12: an update, accepted here or in another tab, retires the precache
 *  this page's lazy chunks came from. */
describe('following an update', () => {
  function steps(autosave: Pick<Autosave, 'flush'>, persistent: boolean, calls: string[]): FollowUpdate {
    return {
      autosave,
      persistent,
      remember: () => calls.push('remember'),
      reload: () => calls.push('reload'),
      stale: (message) => calls.push(`stale:${message}`),
    };
  }

  it('saves first, then remembers the open document and reloads', async () => {
    const calls: string[] = [];
    let settle: () => void = () => undefined;
    const autosave = {
      flush: () => {
        calls.push('flush');
        return new Promise<boolean>((resolve) => (settle = () => resolve(true)));
      },
    };
    const done = followUpdate(steps(autosave, true, calls), false);
    expect(calls).toEqual(['flush']); // nothing else until the write has settled
    settle();
    await done;
    expect(calls).toEqual(['flush', 'remember', 'reload']);
  });

  it('does not reload a tab whose documents live only in memory: it says so instead', async () => {
    const calls: string[] = [];
    await followUpdate(steps({ flush: async () => true }, false, calls), false);
    expect(calls).toEqual([`stale:${STALE_ELSEWHERE}`]);
  });

  it('round 1, item 4: the tab that accepted the update is told in its own words', async () => {
    const calls: string[] = [];
    await followUpdate(steps({ flush: async () => false }, true, calls), true);
    expect(calls).toEqual([`stale:${STALE_HERE}`]);
    expect(STALE_HERE).not.toMatch(/another tab/);
    expect(STALE_ELSEWHERE).toMatch(/another tab/);
  });

  it('round 1, item 1: an Open whose record could not be stored makes the tab unsafe to reload', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore({ documents: [rec('old')] });
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    store.failPut = () => new Error('disk');
    // Open: the new record's put fails; editing continues in memory.
    const result = await switchDocument({ store, autosave, load: () => undefined }, rec('opened'), { created: true });
    expect(result.ok).toBe(false);
    const calls: string[] = [];
    await followUpdate(steps(autosave, true, calls), false);
    expect(calls).toEqual([`stale:${STALE_ELSEWHERE}`]);
    // Once a write succeeds, the record is stored and a reload is safe.
    store.failPut = null;
    const later: string[] = [];
    await followUpdate(steps(autosave, true, later), false);
    expect(later).toEqual(['remember', 'reload']);
    expect((await store.getDocument('opened'))?.source).toBe(rec('opened').source);
  });

  it('round 1, item 3: an edit typed during the flush whose write then fails is not reloaded away', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const real = store.putDocument.bind(store);
    let release: () => void = () => undefined;
    let puts = 0;
    store.putDocument = async (r) => {
      puts += 1;
      if (puts === 1) await new Promise<void>((resolve) => (release = resolve));
      if (puts === 2) throw new Error('disk');
      return real(r);
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(rec('doc', 'a'));
    const calls: string[] = [];
    const following = followUpdate(steps(autosave, true, calls), false);
    autosave.request(rec('doc', 'ab')); // typed while the first write hangs
    release();
    await following;
    expect(calls).toEqual([`stale:${STALE_ELSEWHERE}`]);
  });
});

/** Round 1, item 7: `controllerchange` is handled once per worker. */
describe('oncePerController', () => {
  it('runs once for each new controller, never twice for the same one', () => {
    let controller: object | null = { v: 1 };
    const handle = vi.fn();
    const listener = oncePerController(() => controller, handle);
    controller = { v: 2 };
    listener();
    listener();
    expect(handle).toHaveBeenCalledTimes(1);
    controller = { v: 3 };
    listener();
    expect(handle).toHaveBeenCalledTimes(2);
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
