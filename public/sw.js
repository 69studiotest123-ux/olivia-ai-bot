importScripts('/firebase-messaging-sw.js');

const CACHE_NAME = 'olivia-elite-v8.20';
const ASSETS = [
  '/',
  '/index.html',
  '/olivia.png',
  '/apple-touch-icon.png',
  '/manifest.json',
  '/push-notifications.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS);
      })
  );
});

self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // CRITICAL FIX: Bypass cache for real-time API requests
  if (event.request.url.includes('/api/')) {
    return event.respondWith(fetch(event.request));
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        return response || fetch(event.request);
      })
  );
});

// Handle Push Notifications for Lock Screen
self.addEventListener('push', event => {
  let data = { title: 'Olivia AI', body: 'New alert received.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Olivia AI', body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: '/olivia.png',
    badge: '/olivia.png',
    vibrate: [200, 100, 200],
    tag: 'olivia-alert',
    renotify: true,
    data: {
      url: data.url || '/'
    },
    actions: [
      { action: 'open', title: 'Open App', icon: '/olivia.png' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle Notification Click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const urlToOpen = event.notification.data.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
