const CACHE = "shareprompt-v1-5-stage4";
const SHELL = [
  "/",
  "/builder.html",
  "/saved.html",
  "/manifest.webmanifest",
  "/offline.html",
  "/assets/site.css",
  "/assets/site.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache dynamic routes or admin/auth pages.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/prompt/") ||
    url.pathname === "/prompt.html" ||
    url.pathname === "/admin.html" ||
    url.pathname === "/sitemap.xml"
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response || response.status >= 400) {
          return response;
        }

        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() =>
        caches.match(request).then(
          (cached) => cached || caches.match("/offline.html")
        )
      )
  );
});
