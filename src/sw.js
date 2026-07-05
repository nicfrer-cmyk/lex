// LexTrack service worker — exists ONLY to receive Web Push notifications and handle
// clicking them (focus an already-open tab, or open a new one). Deliberately does NOT
// cache anything or intercept fetch() — this app has no offline mode, and an
// overzealous service worker caching stale app.js/index.html is exactly the kind of
// self-inflicted "I deployed a fix but the site still does the old thing" bug this
// project already hit once with plain HTTP caching (see build.mjs's cache-busting
// comment) — a caching service worker would be a much stickier version of that same
// trap, surviving even a hard refresh.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'LexTrack', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'LexTrack';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      dir: 'rtl',
      lang: 'he',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
