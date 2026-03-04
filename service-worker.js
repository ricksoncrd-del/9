// ============================================================
// HMFC Bible App — Service Worker
// Strategy:
//   • App shell (HTML, SW, manifest)  → Cache First
//   • JSON data files                 → Stale While Revalidate
//   • External images (Unsplash etc.) → Network First w/ cache fallback
//   • Google Fonts                    → Cache First
// ============================================================

const APP_VERSION    = 'v1.0.0';
const SHELL_CACHE    = 'hmfc-shell-'    + APP_VERSION;
const DATA_CACHE     = 'hmfc-data-'     + APP_VERSION;
const IMAGE_CACHE    = 'hmfc-images-'   + APP_VERSION;
const FONT_CACHE     = 'hmfc-fonts-'    + APP_VERSION;

// All known caches — old ones are deleted on activate
const ALL_CACHES = [SHELL_CACHE, DATA_CACHE, IMAGE_CACHE, FONT_CACHE];

// ── App shell files cached immediately on install ───────────
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './service-worker.js'
];

// ── Data files cached and kept fresh in background ──────────
const DATA_FILES = [
  './all-bible-versions.json',
  './churches.json',
  './events.json'
];

// ── Offline fallback page (inline, no extra file needed) ────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>HMFC Bible – Offline</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0e1117;color:#e8e4d9;font-family:system-ui,sans-serif;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100vh;padding:32px;text-align:center}
    .icon{font-size:56px;margin-bottom:20px}
    h1{font-size:22px;color:#c9a84c;margin-bottom:10px}
    p{font-size:14px;color:#a89f8c;line-height:1.7;max-width:320px}
    .verse{margin-top:24px;font-style:italic;font-size:15px;color:#e8e4d9;
           border-left:3px solid #c9a84c;padding:10px 16px;text-align:left;border-radius:4px;
           background:rgba(201,168,76,0.08);max-width:320px}
    .ref{font-size:12px;color:#c9a84c;margin-top:6px;text-align:right}
    button{margin-top:28px;background:#c9a84c;color:#0e0e0e;border:none;
           border-radius:8px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer}
  </style>
</head>
<body>
  <div class="icon">📖</div>
  <h1>You're Offline</h1>
  <p>No internet connection found. The app will load from cache once available. Already-visited content is still accessible.</p>
  <div class="verse">
    "Your word is a lamp for my feet, a light on my path."
    <div class="ref">— Psalm 119:105</div>
  </div>
  <button onclick="location.reload()">Try Again</button>
</body>
</html>`;

// ============================================================
// INSTALL — pre-cache the app shell + data files
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Installing ' + APP_VERSION);

  event.waitUntil(
    Promise.all([
      // Cache shell files
      caches.open(SHELL_CACHE).then(cache => {
        console.log('[SW] Caching app shell');
        return cache.addAll(SHELL_FILES).catch(err => {
          console.warn('[SW] Shell cache partial failure:', err);
        });
      }),

      // Cache data files (best-effort — large files may be slow)
      caches.open(DATA_CACHE).then(cache => {
        console.log('[SW] Caching data files');
        return Promise.allSettled(
          DATA_FILES.map(url =>
            cache.add(url).catch(err =>
              console.warn('[SW] Could not pre-cache ' + url + ':', err)
            )
          )
        );
      }),

      // Store the offline fallback page
      caches.open(SHELL_CACHE).then(cache => {
        return cache.put(
          new Request('./offline.html'),
          new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } })
        );
      })
    ]).then(() => {
      console.log('[SW] Install complete — ' + APP_VERSION);
      // Activate immediately without waiting for old SW to finish
      return self.skipWaiting();
    })
  );
});

// ============================================================
// ACTIVATE — clean up old caches
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activating ' + APP_VERSION);

  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => !ALL_CACHES.includes(key))
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      console.log('[SW] Activate complete — claiming clients');
      return self.clients.claim();
    })
  );
});

// ============================================================
// FETCH — route requests to the right strategy
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Skip non-GET and browser-extension requests ──────────
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── Google Fonts — Cache First ───────────────────────────
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // ── External images (Unsplash, gstatic, etc.) — Network First ──
  if (!url.hostname.includes(self.location.hostname) &&
      (request.destination === 'image' ||
       url.hostname.includes('unsplash.com') ||
       url.hostname.includes('gstatic.com'))) {
    event.respondWith(networkFirstImage(request));
    return;
  }

  // ── JSON data files — Stale While Revalidate ─────────────
  if (url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // ── App shell (HTML, JS, CSS, SW, manifest) — Cache First ─
  event.respondWith(cacheFirstWithOfflineFallback(request));
});

// ============================================================
// STRATEGY HELPERS
// ============================================================

// Cache First — serve from cache, fall back to network + update cache
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.warn('[SW] cacheFirst network failed:', request.url);
    return new Response('Offline', { status: 503 });
  }
}

// Cache First — with offline.html fallback for navigation requests
async function cacheFirstWithOfflineFallback(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    // For page navigation, serve the offline page
    if (request.destination === 'document' || request.mode === 'navigate') {
      const offlinePage = await cache.match('./offline.html');
      if (offlinePage) return offlinePage;
    }
    return new Response('Offline', { status: 503 });
  }
}

// Stale While Revalidate — serve cached immediately, update in background
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Kick off network fetch in background regardless
  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached version immediately if available
  if (cached) return cached;

  // Otherwise wait for network
  const networkResponse = await networkFetch;
  if (networkResponse) return networkResponse;

  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Network First for images — try network, fall back to cache
async function networkFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE);

  try {
    const networkResponse = await fetch(request, { mode: 'no-cors' });
    if (networkResponse) {
      cache.put(request, networkResponse.clone());
      return networkResponse;
    }
  } catch (err) {
    // Network failed — try cache
  }

  const cached = await cache.match(request);
  if (cached) return cached;

  // Return a transparent 1×1 PNG as ultimate fallback
  return new Response(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    { headers: { 'Content-Type': 'image/png' } }
  );
}

// ============================================================
// BACKGROUND SYNC — retry failed event saves (optional)
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-events') {
    console.log('[SW] Background sync triggered');
    // Future: sync locally saved events to a server
  }
});

// ============================================================
// PUSH NOTIFICATIONS (ready to use — requires server setup)
// ============================================================
self.addEventListener('push', event => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'HMFC Bible', body: event.data.text() }; }

  const options = {
    body:    data.body    || 'You have a new notification.',
    icon:    data.icon    || './icons/icon-192.png',
    badge:   data.badge   || './icons/icon-96.png',
    vibrate: [100, 50, 100],
    data:    { url: data.url || './index.html' },
    actions: [
      { action: 'open',    title: '📖 Open App' },
      { action: 'dismiss', title: 'Dismiss'     }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'HMFC Bible', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || './index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ============================================================
// MESSAGE — handle skip-waiting from the UI
// ============================================================
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skipping waiting on request');
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});
