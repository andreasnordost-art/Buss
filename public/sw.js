// Gör sidan installerbar och snabb att öppna igen. Sidans egna filer visas direkt
// från cachen och uppdateras i bakgrunden; live-data hämtas alltid från nätet.
const CACHE = "busskollen-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "network.js", "schematic.js", "config.js", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      // Linjenätet ändras varje natt: hämta det från nätet först.
      if (url.pathname.endsWith("network.json")) return fresh.catch(() => cached);
      return cached ? (fresh.catch(() => {}), cached) : fresh;
    }),
  );
});
