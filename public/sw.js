// Minimal service worker — just for Web Push alert notifications.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) {}
    const title = data.title || 'Status alert';
    event.waitUntil(self.registration.showNotification(title, {
        body: data.body || '',
        icon: '/brand/favicon-32.png',
        badge: '/brand/favicon-32.png',
        tag: 'status-alert',
        renotify: true,
        data: { url: data.url || '/' },
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
            for (const w of wins) { if (w.url.includes(self.location.origin)) return w.focus(); }
            return self.clients.openWindow(url);
        })
    );
});
