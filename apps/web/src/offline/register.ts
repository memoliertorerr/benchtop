/**
 * Registers the offline service worker (public/sw.js, BT40) in production builds only: in dev
 * it would cache modules Vite serves fresh on every edit.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error: unknown) => {
      console.warn('benchtop: offline support unavailable', error);
    });
  });
}
