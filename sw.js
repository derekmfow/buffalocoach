/**
 * sw.js — minimal pass-through service worker.
 *
 * Exists only to satisfy Chrome/Android's "installable PWA" criteria. It does
 * NOT cache anything — every request goes straight to the network. This keeps
 * behavior identical to a normal web app: no stale API responses, no stale HTML,
 * no cache invalidation headaches when Derek deploys.
 *
 * If offline support is ever needed, add a fetch handler that caches the app
 * shell (index.html + any static assets) while still going network-first for
 * /api/ and /uploads/.
 */

self.addEventListener('install', (event) => {
  // Take over immediately on first install so the app is installable on this visit.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim any open clients so they talk to this SW right away.
  event.waitUntil(self.clients.claim());
});

// No fetch handler = browser default. The SW is registered and active, which
// is all installability requires.
