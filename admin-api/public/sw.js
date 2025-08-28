const CACHE = 'mrtests-admin-v2';
const ASSETS = [
  '/admin',
  '/admin/admin.css',
  '/admin/admin.js',
  '/assets/MRTESTSLOGO.png',
  '/assets/favicon-32.png',
  '/assets/favicon-16.png',
  '/assets/apple-touch-icon.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', e => {
  console.log('Service Worker installing...');
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => {
        console.log('Caching assets...');
        return cache.addAll(ASSETS);
      })
      .then(() => {
        console.log('Service Worker installed');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', e => {
  console.log('Service Worker activating...');
  e.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('Service Worker activated');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;
  
  // Skip cross-origin requests
  if (!e.request.url.startsWith(self.location.origin)) return;
  
  e.respondWith(
    caches.match(e.request)
      .then(response => {
        // Return cached version or fetch from network
        if (response) {
          console.log('Serving from cache:', e.request.url);
          return response;
        }
        
        console.log('Fetching from network:', e.request.url);
        return fetch(e.request).then(fetchResponse => {
          // Don't cache non-successful responses
          if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
            return fetchResponse;
          }
          
          // Clone the response
          const responseToCache = fetchResponse.clone();
          
          caches.open(CACHE)
            .then(cache => {
              cache.put(e.request, responseToCache);
            });
          
          return fetchResponse;
        });
      })
      .catch(() => {
        // Return offline page or fallback for navigation requests
        if (e.request.mode === 'navigate') {
          return caches.match('/admin');
        }
      })
  );
});
