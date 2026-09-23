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

export function registerServiceWorker(onUpdateReady: (apply: ApplyUpdate) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  let accepted = false;

  const offer = (worker: ServiceWorker): void => {
    onUpdateReady(() => {
      accepted = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  // Reload only for an update the user accepted — not when the very first
  // worker installs (it does not claim open pages: `clientsClaim` is off).
  container.addEventListener('controllerchange', () => {
    if (accepted) window.location.reload();
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
