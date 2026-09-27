/**
 * Service-worker registration for DD-08 §12, written by hand rather than
 * through `vite-plugin-pwa`'s `virtual:pwa-register`, which would put
 * `workbox-window` into the app bundle. The generated `sw.js` (`generateSW`,
 * `skipWaiting: false`) already listens for `{ type: 'SKIP_WAITING' }`, so
 * gating the update behind the "Update available — reload" chip is: offer the
 * waiting worker, and message it only when the user clicks.
 */

/** At most this often, a page that becomes visible again asks the browser to
 *  check for a new service worker (fix round 1, item 15). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The browser checks for a new `sw.js` on navigation, and on its own only
 * about once a day — so an installed app left open for days, never reloaded,
 * would never see its "Update available" chip. `check()` is called whenever
 * the page becomes visible again and runs `update()` if the last check was at
 * least `intervalMs` ago; a failed check (offline) is ignored and retried at
 * the next opportunity past the interval. DOM-free, for the unit test.
 */
export function createUpdateCheck(update: () => Promise<unknown>, now: () => number, intervalMs: number = UPDATE_CHECK_INTERVAL_MS): { check(): void } {
  let last = now(); // registering has just checked
  return {
    check() {
      const at = now();
      if (at - last < intervalMs) return;
      last = at;
      update().catch(() => undefined);
    },
  };
}

/** Activates the waiting worker; the page reloads once it takes control. */
export type ApplyUpdate = () => void;

/** F12: a tab that cannot follow an update without losing documents. The
 *  wording depends on where the update was accepted (round 1, item 4). */
export const STALE_ELSEWHERE = 'SGL was updated in another tab. This tab could not save everything, so it was not reloaded: save your work (Save ▾), then reload.';
export const STALE_HERE = 'This tab could not save everything, so it was not reloaded for the update: save your work (Save ▾), then reload.';

export interface FollowUpdate {
  /** `flush()` writes everything pending, including what is typed while it
   *  runs, and says whether all of it reached the store. */
  readonly autosave: { flush(): Promise<boolean> };
  /** The store outlives the page (IndexedDB, not the in-memory store). */
  readonly persistent: boolean;
  /** Notes the open document for the reload to reopen (`app-boot.ts`). */
  readonly remember: () => void;
  /** Reloads, or (the accepting tab, before activation) activates the
   *  waiting worker, which then reloads the page. */
  readonly reload: () => void;
  /** Not safe to reload: tell the user. */
  readonly stale: (message: string) => void;
}

/**
 * F12: an update activates a new worker, which then controls every open
 * page of the registration (each gets `controllerchange`, `clientsClaim` or
 * not) — and on activating, Workbox deletes every precache entry the new
 * manifest does not list, including this page's own lazy chunks (`elk`,
 * `share`, `file-actions`, …) under their old hashed names. Loaded later,
 * offline, they fail. So a page follows the update: it saves, then reloads
 * onto the new version, reopening its own document. It is safe to reload
 * only when the store is persistent and nothing is pending, in flight or
 * failed after the flush (round 1, items 1 and 3); otherwise a reload would
 * lose documents, so the page stays and is told to save its work. `here`:
 * this tab accepted the update (the chip, and again after activation).
 * DOM-free, for the unit test.
 */
export async function followUpdate(deps: FollowUpdate, here: boolean): Promise<void> {
  if (!(await deps.autosave.flush()) || !deps.persistent) return deps.stale(here ? STALE_HERE : STALE_ELSEWHERE);
  deps.remember();
  deps.reload();
}

/** A `controllerchange` listener that calls `handle` once per new
 *  controller (round 1, item 7): the event can repeat for one worker. */
export function oncePerController(controller: () => unknown, handle: () => void): () => void {
  let seen = controller();
  return () => {
    const now = controller();
    if (now === seen) return;
    seen = now;
    handle();
  };
}

/** `onUpdateReady`: an update is waiting (the chip). `onControllerChange`:
 *  a new worker took control, accepted by this tab or by another
 *  (`followUpdate`). */
export function registerServiceWorker(onUpdateReady: (apply: ApplyUpdate) => void, onControllerChange: (here: boolean) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  let accepted = false;

  const offer = (worker: ServiceWorker): void => {
    onUpdateReady(() => {
      accepted = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  // Never on the first install: it does not claim open pages (`clientsClaim`
  // is off), and a page no worker controls gets no `controllerchange`. The
  // accepting tab follows too, so what was typed between its click and the
  // activation is saved before it reloads (round 1, item 3).
  container.addEventListener(
    'controllerchange',
    oncePerController(
      () => container.controller,
      () => onControllerChange(accepted),
    ),
  );

  const register = async (): Promise<void> => {
    try {
      const registration = await container.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
      // A worker already waiting from an earlier visit.
      if (registration.waiting !== null && container.controller !== null) offer(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (installing === null) return;
        installing.addEventListener('statechange', () => {
          // "installed" with a controller present means an *update* is waiting
          // behind the current worker; without one it is the first install.
          if (installing.state === 'installed' && container.controller !== null) offer(installing);
        });
      });
      const updates = createUpdateCheck(() => registration.update(), () => Date.now());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') updates.check();
      });
    } catch (err) {
      console.warn('[SGL] service worker registration failed; the app works, but not offline.', err);
    }
  };

  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
