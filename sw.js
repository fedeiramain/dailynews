// Argentina Daily — service worker: guarda la pantalla para que abra rápido y sin conexión
const CACHE = "argdaily-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// La página: primero la red (siempre la versión nueva); si no hay conexión, la guardada
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  e.respondWith(
    fetch(req)
      .then((res) => { const copia = res.clone(); caches.open(CACHE).then((c) => c.put("./", copia)); return res; })
      .catch(() => caches.match("./"))
  );
});
