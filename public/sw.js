// Minimal service worker for PWA installability.
// No caching — all requests pass through to the network (localhost app).

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
