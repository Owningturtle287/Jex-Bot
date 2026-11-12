const PREFIX = "jex-bot-";
// Bump this when publishing changes to the app shell or model.
const CACHE = PREFIX + "v15";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.mjs", "./chats.mjs", "./engine.mjs", "./worker.mjs",
  "./calculator.mjs", "./facts.mjs", "./model-context.mjs", "./model-settings.mjs", "./local-model.mjs", "./model-download.mjs",
  "./memory.mjs", "./conversation-recall.mjs", "./identity.mjs",
  "./vendor/wllama-2.3.7/index.js", "./vendor/wllama-2.3.7/single-thread/wllama.wasm",
  "./vendor/wllama-2.3.7/multi-thread/wllama.wasm",
  "./manifest.webmanifest", "./icons/jex-64.png", "./icons/jex-180.png",
  "./icons/jex-192.png", "./icons/jex-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const specResponse = await fetch("./model/model.json", { cache: "reload" });
    if (!specResponse.ok) throw new Error("Model unavailable for offline setup");
    const spec = await specResponse.clone().json();
    const cache = await caches.open(CACHE);
    await cache.addAll([...ASSETS, ...spec.weights.map(name => "./model/" + name)].map(url =>
      new Request(new URL(url, self.registration.scope), { cache: "reload" })
    ));
    await cache.put(new URL("./model/model.json", self.registration.scope), specResponse);
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const obsolete = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE);
    await Promise.all(obsolete.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  // The download worker persists model ranges in its own cache.
  if (new URL(request.url).pathname.endsWith(".gguf")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === "navigate" ? new URL("./index.html", self.registration.scope) : request;
    return await cache.match(key) || fetch(request);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
