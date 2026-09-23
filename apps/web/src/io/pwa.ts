/**
 * Service-worker registration for DD-08 §12, written by hand rather than
 * through `vite-plugin-pwa`'s `virtual:pwa-register`, which would put
 * `workbox-window` into the app bundle. The generated `sw.js` (`generateSW`,
 * `skipWaiting: false`) already listens for `{ type: 'SKIP_WAITING' }`, so
 * gating the update behind the "Update available — reload" chip is: offer the
 * waiting worker, and message it only when the user clicks.
 */

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
    } catch (err) {
      console.warn('[SGL] service worker registration failed; the app works, but not offline.', err);
    }
  };

  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}
