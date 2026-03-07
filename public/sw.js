// Minimal service worker for PWA installability.
// No caching — all requests pass through to the network (localhost app).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// Web Push — show notification only when no client is focused
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const anyFocused = windowClients.some((c) => c.focused);
      if (anyFocused) return; // skip — user is already looking at the app
      return self.registration.showNotification(data.title || 'Shawkat AI', {
        body: data.body || '',
        tag: data.tag || 'default',
        icon: '/icons/icon-192.png',
      });
    })
  );
});

// Focus or open the app when a notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});
