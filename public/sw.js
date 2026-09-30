const CACHE_NAME = "my-stash-v2";
const STATIC_ASSETS = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Navigations: NETWORK-FIRST so a deployed update lands on the very next
  // launch while online. The cached shell ("/") is only the offline fallback.
  // (The previous strategy here was cache-first, which pinned the old app to
  // installed PWAs indefinitely — a reload never fetched the new HTML.)
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", clone));
          }
          return response;
        })
        .catch(() =>
          caches.match("/").then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // sw.js itself: handled by the browser (Cache-Control: no-cache via
  // _headers) — must never be answered from the Cache API.
  if (url.pathname === "/sw.js") return;

  // Everything else (hashed, immutable static assets): cache-first, fill the
  // cache on miss, same-origin only. API calls are cross-origin and fall
  // through to the network + the browser's own HTTP cache.
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok && url.origin === self.location.origin) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
    )
  );
});
