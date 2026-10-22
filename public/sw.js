// Gör sidan installerbar och möjlig att öppna utan nät. Sidans filer hämtas från nätet
// först och sparas i cachen; live-data går aldrig via cachen.
const CACHE = "busskollen-v4";
const SHELL = ["./", "index.html", "style.css", "app.js", "live.js", "network.js", "schematic.js", "config.js", "icon.svg", "manifest.webmanifest"];

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
      // no-cache: fråga servern om filen har ändrats i stället för att lita på webbläsarens cache.
      const fresh = fetch(e.request.mode === "navigate" ? e.request : new Request(e.request, { cache: "no-cache" })).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      // Nätet först, så att en ny version syns direkt; cachen används när man är offline.
      return fresh.catch(() => cached || Promise.reject(new Error("offline")));
    }),
  );
});
