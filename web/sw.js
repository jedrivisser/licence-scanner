// Service worker for the site: the about page (./) and both installable
// apps, the scanner (scan/) and the barcode wallet (show/). Paths are
// relative to this file, so the site works under any base path.
// Network-first, so a redeploy is picked up on the next load - but with a
// short timeout, because the wallet must open instantly with no or bad
// signal: after NETWORK_TIMEOUT_MS the cached copy is used. Everything runs
// on the device, so the cached shell is the whole app.
//
// A page and its files must come from the same version: a new page with an
// old script (or the reverse) breaks. So:
//   - the cache is only ever filled by install, all files at once, bypassing
//     the browser's HTTP cache (a CDN may let it keep scripts for hours), so
//     it always holds one complete version;
//   - the deploy (.github/workflows/pages.yml) stamps CACHE with the commit,
//     so every deploy changes this file and installs a fresh set;
//   - the timeout applies per page load, not per file - a page served from
//     the cache gets all its files from the cache, and a page that came from
//     the network waits longer for its files (SUBRESOURCE_TIMEOUT_MS) before
//     falling back.
const CACHE = "sadl-shell-dev";
const NETWORK_TIMEOUT_MS = 2500;
const SUBRESOURCE_TIMEOUT_MS = 10000;
const SHELL = [
  "./",
  "about.js",
  "licences.txt",
  "style.css",
  "sadl.js",
  "wi.js",
  "camera-pick.js",
  "scanner.js",
  "scan-hints.js",
  "scanner.css",
  "pdf417-worker.js",
  "pdf417-edge.js",
  "pdf417-codes.js",
  "pdf417-encode.js",
  "scan/",
  "scan/app.js",
  "scan/manifest.webmanifest",
  "scan/icons/favicon-32.png",
  "scan/icons/apple-touch-icon.png",
  "scan/icons/icon-192.png",
  "scan/icons/icon-512.png",
  "scan/icons/maskable-512.png",
  "show/",
  "show/show.js",
  "show/show.css",
  "show/manifest.webmanifest",
  "show/icons/favicon-32.png",
  "show/icons/apple-touch-icon.png",
  "show/icons/icon-192.png",
  "show/icons/icon-512.png",
  "show/icons/maskable-512.png",
];

// Redirected responses are never stored - served for a navigation they're
// rejected.
function cacheable(resp) {
  return resp.ok && !resp.redirected;
}

// All or nothing: if any file can't be fetched (bad signal while updating),
// the install fails, and the previous version and its complete cache stay
// in charge until the next try. Only then does activate delete old caches.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(
          SHELL.map((url) =>
            fetch(url, { credentials: "same-origin", cache: "no-cache" }).then((resp) => {
              if (!cacheable(resp)) throw new Error(`${url}: ${resp.status}${resp.redirected ? " (redirected)" : ""}`);
              return c.put(url, resp);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true });
}

// Pages (client ids) that were served from the cache. Lost if the browser
// stops the worker, which it only does when idle - after a page has loaded.
const cachedPages = new Set();

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const navigate = req.mode === "navigate";

  if (!navigate && cachedPages.has(event.clientId)) {
    event.respondWith(fromCache(req).then((hit) => hit || fetch(req)));
    return;
  }

  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const finish = (resp, cached) => {
        if (settled || !resp) return;
        settled = true;
        if (navigate && cached && event.resultingClientId) cachedPages.add(event.resultingClientId);
        resolve(resp);
      };
      const fallback = () =>
        fromCache(req).then((hit) => {
          if (hit) finish(hit, true);
          return hit;
        });
      const timer = setTimeout(fallback, navigate ? NETWORK_TIMEOUT_MS : SUBRESOURCE_TIMEOUT_MS);
      // revalidated (cheap 304s), so a page from the network gets current files
      fetch(req, { cache: "no-cache" })
        .then(async (resp) => {
          clearTimeout(timer);
          // the host failing (502/503) is no reason to lose the offline copy
          if (resp.status >= 500 && (await fallback())) return;
          finish(resp, false);
        })
        .catch(async () => {
          clearTimeout(timer);
          if (await fallback()) return;
          // an unknown page while offline: go to the site's root page, which
          // is cached (served here, its relative links would break)
          finish(navigate ? Response.redirect(self.registration.scope, 302) : Response.error(), true);
        });
    })
  );
});
