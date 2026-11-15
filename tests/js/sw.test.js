// node --test tests/js/*.test.js
//
// web/sw.js in a mocked service-worker environment (vm), plus a check that
// its SHELL list covers every file the two apps load - a missing one means
// the wallet silently stops working offline.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "..", "web");
const SRC = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
const ORIGIN = "https://licence.test";

function makeResponse(url, { status = 200, redirected = false, body = url } = {}) {
  return { url, status, ok: status >= 200 && status < 300, redirected, type: "basic", body, clone() { return { ...this }; } };
}

// A tiny CacheStorage keyed by pathname (ignoreSearch is all sw.js uses).
function makeCaches() {
  const stores = new Map();
  const key = (req) => new URL(typeof req === "string" ? req : req.url, ORIGIN).pathname;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return { put: async (req, resp) => void m.set(key(req), resp) };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req) => {
      for (const m of stores.values()) if (m.has(key(req))) return m.get(key(req));
      return undefined;
    },
  };
}

// Loads sw.js with `network(url)` deciding each fetch: a Response, a thrown
// error (offline), or a never-settling promise (no signal).
function loadWorker(network) {
  const listeners = {};
  const caches = makeCaches();
  const fetched = [];
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const fetch = async (req, init = {}) => {
    const url = new URL(typeof req === "string" ? req : req.url, ORIGIN).pathname;
    fetched.push(url);
    // every fetch must skip the browser's HTTP cache, or a CDN's long
    // max-age mixes old scripts into a new version
    assert.strictEqual(init.cache, "no-cache", `${url} fetched through the HTTP cache`);
    return network(url, init);
  };
  const Response = { error: () => ({ error: true }), redirect: (url, status) => ({ redirect: url, status }) };
  vm.runInNewContext(SRC, { self, caches, fetch, URL, setTimeout, clearTimeout, Promise, Error, Set, Response });

  const lifecycle = async (type) => {
    let wait;
    listeners[type]({ waitUntil: (p) => (wait = p) });
    return wait;
  };
  const request = (url, { navigate = false, clientId = "", resultingClientId = "" } = {}) => {
    let responded;
    listeners.fetch({
      request: { url: ORIGIN + url, method: "GET", mode: navigate ? "navigate" : "no-cors" },
      clientId,
      resultingClientId,
      respondWith: (p) => (responded = p),
    });
    return responded;
  };
  return { caches, fetched, install: () => lifecycle("install"), activate: () => lifecycle("activate"), request };
}

// SHELL as site paths (it's relative to sw.js, which is at the site root)
const shellOf = () => Array.from(vm.runInNewContext(SRC.match(/const SHELL = (\[[\s\S]*?\]);/)[1]), (p) => new URL(p, ORIGIN + "/").pathname);

test("install caches the whole shell", async () => {
  const w = loadWorker((url) => makeResponse(url));
  await w.install();
  const [cache] = w.caches.stores.values();
  assert.deepStrictEqual([...cache.keys()].sort(), shellOf().sort());
});

test("install fails if any file can't be fetched, so the old cache is kept", async () => {
  for (const failure of ["offline", 404, "redirected"]) {
    const w = loadWorker((url) => {
      if (url === "/show/show.js") {
        if (failure === "offline") throw new TypeError("Failed to fetch");
        if (failure === "redirected") return makeResponse(url, { redirected: true });
        return makeResponse(url, { status: failure });
      }
      return makeResponse(url);
    });
    await w.caches.open("sadl-shell-old");
    await assert.rejects(w.install(), undefined, `${failure}`);
    // a failed install never activates; the old cache is still there
    assert.ok(w.caches.stores.has("sadl-shell-old"));
  }
});

test("a page served from the cache gets all its files from the cache", async () => {
  let online = true;
  const w = loadWorker((url) => (online ? makeResponse(url, { body: `new ${url}` }) : new Promise(() => {})));
  await w.install();
  await w.activate();
  for (const m of w.caches.stores.values()) for (const [k, v] of m) m.set(k, { ...v, body: `old ${k}` });

  online = false; // no signal: the page falls back after the timeout
  const page = await w.request("/scan/", { navigate: true, resultingClientId: "tab1" });
  assert.strictEqual(page.body, "old /scan/");

  online = true; // signal comes back while the page loads its scripts
  w.fetched.length = 0;
  const script = await w.request("/scan/app.js", { clientId: "tab1" });
  assert.strictEqual(script.body, "old /scan/app.js", "same version as the page");
  assert.deepStrictEqual(w.fetched, [], "no network fetch for a cached page's files");
});

test("a page from the network gets its files from the network", async () => {
  const w = loadWorker((url) => makeResponse(url, { body: `new ${url}` }));
  await w.install();
  await w.activate();
  const page = await w.request("/scan/", { navigate: true, resultingClientId: "tab2" });
  assert.strictEqual(page.body, "new /scan/");
  const script = await w.request("/scan/app.js", { clientId: "tab2" });
  assert.strictEqual(script.body, "new /scan/app.js");
});

test("the cache is only filled by install, never by a page's fetches", async () => {
  const w = loadWorker((url) => makeResponse(url, { body: `new ${url}` }));
  await w.install();
  await w.activate();
  for (const m of w.caches.stores.values()) for (const [k, v] of m) m.set(k, { ...v, body: `old ${k}` });
  await w.request("/show/", { navigate: true, resultingClientId: "tab3" });
  await w.request("/scanner.js", { clientId: "tab3" });
  const [cache] = w.caches.stores.values();
  assert.strictEqual(cache.get("/scanner.js").body, "old /scanner.js", "one app's visit must not update files the other shares");
});

test("a server error falls back to the cached copy", async () => {
  let status = 200;
  const w = loadWorker((url) => makeResponse(url, { status, body: `${status} ${url}` }));
  await w.install();
  await w.activate();
  status = 503;
  const page = await w.request("/show/", { navigate: true, resultingClientId: "tab4" });
  assert.strictEqual(page.body, "200 /show/");
  status = 404; // a client error is the real answer, not an outage
  const missing = await w.request("/nope.js", { clientId: "tab5" });
  assert.strictEqual(missing.status, 404);
});

test("an unknown page while offline redirects to the cached root page", async () => {
  let online = true;
  const w = loadWorker((url) => {
    if (!online) throw new TypeError("Failed to fetch");
    return makeResponse(url);
  });
  await w.install();
  await w.activate();
  online = false;
  const resp = await w.request("/nope/", { navigate: true, resultingClientId: "tab6" });
  assert.deepStrictEqual(resp, { redirect: ORIGIN + "/", status: 302 });
});

test("the deploy's version stamp matches CACHE in sw.js", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "pages.yml"), "utf8");
  const [, pattern] = workflow.match(/sed -i "s\/([^/]+)\//);
  assert.match(SRC, new RegExp(pattern), "pages.yml's sed no longer finds CACHE in sw.js");
});

test("SHELL lists every file both apps load, and nothing that doesn't exist", () => {
  const shell = shellOf();
  const file = (p) => path.join(WEB, p.endsWith("/") ? `${p}index.html` : p);  // p starts with "/"
  for (const p of shell) assert.ok(fs.existsSync(file(p)), `${p} is in SHELL but not in web/`);

  const loaded = new Set();
  for (const [page, dir] of [["index.html", "/"], ["scan/index.html", "/scan/"], ["show/index.html", "/show/"]]) {
    const html = fs.readFileSync(path.join(WEB, page), "utf8");
    for (const [, ref] of html.matchAll(/<(?:script|link|a)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (/^https?:/.test(ref)) continue;
      loaded.add(new URL(ref, ORIGIN + dir).pathname);
    }
  }
  const worker = fs.readFileSync(path.join(WEB, "pdf417-worker.js"), "utf8");
  for (const [, list] of worker.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const [, ref] of list.matchAll(/"([^"]+)"/g)) loaded.add(new URL(ref, ORIGIN + "/").pathname);
  }
  for (const [, ref] of fs.readFileSync(path.join(WEB, "scanner.js"), "utf8").matchAll(/new URL\("([^"]+)", document\.currentScript\.src\)/g)) {
    loaded.add(new URL(ref, ORIGIN + "/").pathname);
  }

  for (const page of ["scan", "show"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(WEB, page, "manifest.webmanifest"), "utf8"));
    for (const icon of manifest.icons) loaded.add(new URL(icon.src, `${ORIGIN}/${page}/`).pathname);
  }
  const missing = [...loaded].filter((p) => !shell.includes(p));
  assert.deepStrictEqual(missing, [], "loaded by a page but not cached for offline use");
});
