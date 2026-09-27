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

export interface FollowUpdate {
  /** Writes the open document's pending autosave. */
  readonly flush: () => Promise<void>;
  /** After the flush: is everything this tab holds in storage, so a reload
   *  loses nothing? False on the in-memory store, or when the write failed. */
  readonly safe: () => boolean;
  /** Notes the open document for the reload to reopen (`app-boot.ts`). */
  readonly remember: () => void;
  readonly reload: () => void;
  /** Not safe to reload: tell the user. */
  readonly stale: () => void;
}

/**
 * F12: an update accepted in **another** tab activated a new worker, which
 * now controls this page too (every page of the registration gets
 * `controllerchange` when a worker activates, `clientsClaim` or not) — and
 * on activating, Workbox deleted every precache entry the new manifest does
 * not list, including this page's own lazy chunks (`elk`, `share`,
 * `file-actions`, …) under their old hashed names. Loaded later, offline,
 * they fail. So this page follows the update: it saves, then reloads onto
 * the new version, reopening its own document. A page that cannot save
 * everything first (the in-memory store; a failing write) is **not**
 * reloaded, which would lose its documents: it is told to save its work
 * (`stale`). DOM-free, for the unit test.
 */
export async function followUpdate(deps: FollowUpdate): Promise<void> {
  await deps.flush();
  if (!deps.safe()) return deps.stale();
  deps.remember();
  deps.reload();
}

/** `onUpdateReady`: an update is waiting (the chip). `onUpdatedElsewhere`:
 *  another tab accepted one (`followUpdate`). */
export function registerServiceWorker(onUpdateReady: (apply: ApplyUpdate) => void, onUpdatedElsewhere: () => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  let accepted = false;

  const offer = (worker: ServiceWorker): void => {
    onUpdateReady(() => {
      accepted = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  // This page accepted the update: it has saved already (`App.tsx`), so
  // reload. Another page did: follow it (F12). Never on the first install:
  // it does not claim open pages (`clientsClaim` is off), and a page no
  // worker controls gets no `controllerchange`.
  container.addEventListener('controllerchange', () => {
    if (accepted) window.location.reload();
    else onUpdatedElsewhere();
  });

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
