// Brane service worker — cache-first for static assets, network-first for API/WS.
//
// The two constants below are placeholders in this source file and are rewritten
// in `dist/sw.js` by scripts/gen-precache.mjs, which reads the export that was
// actually produced. Editing them here has no effect on a build; see that script
// for why the list is generated rather than maintained by hand.
const CACHE_NAME = "brane-dev"; // __BRANE_CACHE_NAME__
const PRECACHE = ["/"]; // __BRANE_PRECACHE__
const VENDOR_CACHE = "brane-vendor-dev"; // __BRANE_VENDOR_CACHE__

// Vendored files fetched on demand rather than precached: KaTeX's font tail and
// pdf.js. They go in a cache of their own, named for a hash of the vendored
// files alone, because CACHE_NAME changes on essentially every build — and
// `activate` drops every cache but the current ones. Kept in CACHE_NAME, a face
// fetched last week was gone after the next deploy, so "updated while online,
// then went offline" rendered math in fallback glyphs. Here they survive every
// build that doesn't change the vendored files themselves, and a KaTeX or
// pdf.js upgrade retires them together.
function isVendor(pathname) {
  return (
    pathname.startsWith("/katex/") ||
    pathname === "/pdf.min.mjs" ||
    pathname === "/pdf.worker.min.mjs"
  );
}

// Assets safe to serve from cache without revalidating. `_expo/static` is
// content-hashed; the rest are vendored files that only change with a build,
// which is also when CACHE_NAME changes and the old cache is dropped.
function isStatic(pathname) {
  return (
    pathname.startsWith("/_expo/static/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/katex/") ||
    pathname === "/favicon.svg" ||
    pathname === "/manifest.json" ||
    // pdf.js is deliberately left out of PRECACHE (1.7 MB); this is what makes
    // it stick after the first PDF you open.
    pathname === "/pdf.min.mjs" ||
    pathname === "/pdf.worker.min.mjs"
  );
}

// Precache the shell on install. `addAll` is atomic on purpose: a partial
// precache is the silent half-offline state this worker exists to eliminate, so
// a failed install leaves the previous worker serving and retries on next load.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Clean old caches — every one but this build's shell and the vendored files
  // it ships, which may well be the same files an older build fetched.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== VENDOR_CACHE).map((k) => caches.delete(k)),
      )
    ).then(() => self.clients.claim())
  );
});

function cacheFirst(request, cacheName) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response.ok && !isShellFallback(response)) {
        const clone = response.clone();
        caches.open(cacheName).then((cache) => cache.put(request, clone));
      }
      return response;
    });
  });
}

// None of the static paths is HTML, but the servers answer a path they don't
// have with the SPA shell and a 200 — the daemon's static handler and the
// Cloudflare worker's single-page fallback both do. A font or script URL
// requested mid-deploy (an `expo export` clears its output first) would cache
// that page under its own name, cache-first, never revalidated. In
// VENDOR_CACHE it would then outlive every build until KaTeX or pdf.js
// changed. So an HTML answer to a static request is served, never kept.
function isShellFallback(response) {
  return (response.headers.get("content-type") || "").toLowerCase().startsWith("text/html");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET, API calls, and WebSocket upgrades
  if (
    event.request.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws/")
  ) {
    return;
  }

  if (isStatic(url.pathname)) {
    event.respondWith(cacheFirst(event.request, isVendor(url.pathname) ? VENDOR_CACHE : CACHE_NAME));
    return;
  }

  // HTML pages (/, /[nid], etc.) — network-first with cache fallback
  // This ensures updates propagate but offline still works. The final fallback
  // is the precached "/", which is the whole point of precaching it: a cold
  // offline load of a deep route still gets the SPA shell.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
