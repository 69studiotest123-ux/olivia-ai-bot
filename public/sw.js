importScripts('/firebase-messaging-sw.js');

const CACHE_NAME = 'olivia-elite-v8.27';
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

  // NEW: Network-First strategy for main assets (no more stale cache)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If network is good, update the cache and return the response
        if (response.status === 200 && ASSETS.includes(new URL(event.request.url).pathname)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // If network fails, fallback to cache
        return caches.match(event.request);
      })
  );
});

// Handle Push Notifications for Lock Screen
self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try {
      const raw = event.data.json();
      data = raw.data || raw; 
    } catch (e) {
      data = { title: 'Olivia AI', body: event.data.text() };
    }
  }

  const options = {
    body: data.body || 'New alert received.',
    icon: '/olivia.png',
    badge: '/olivia.png',
    vibrate: [300, 100, 300, 100, 300],
    tag: 'olivia-alert',
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.click_action || data.url || '/'
    },
    actions: [
      { action: 'open', title: 'View Details', icon: '/olivia.png' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Olivia AI', options)
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
