/* IMVU Radar - service worker: cache do app + Web Push */

const CACHE_NAME = 'imvu-radar-v6';
const urlsToCache = [
  '/imvu-site/',
  '/imvu-site/index.html',
  '/imvu-site/style.css',
  '/imvu-site/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});

/* --- Web Push / notificacoes --- */

const iconUrl = () => new URL("icons/icon-192.png", self.registration.scope).href;
const homeUrl = () => new URL("./", self.registration.scope).href;

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || homeUrl();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if (target && !String(client.url || "").includes("nick=") && "navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              /* ignora */
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "IMVU Radar";
  const options = {
    body: payload.body || "",
    icon: typeof payload.icon === "string" && /^https?:/i.test(payload.icon) ? payload.icon : iconUrl(),
    badge: iconUrl(),
    tag: payload.tag || "imvu-radar",
    data: { url: payload.url || homeUrl() },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
