// Service worker de Galería.
// Estrategia: cache-first para recursos del mismo origen (app shell y tiempo de ejecución),
// con red como respaldo y guardado en caché de lo que se vaya cargando.

const VERSION = "v1";
const CACHE_PREFIX = "galeria-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

// Recursos del app shell que se precargan al instalar.
// Los CSS y JS se cachean en tiempo de ejecución la primera vez que se piden.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Un recurso que falle no debe impedir la instalación.
      await Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(handleRequest(request));
});

async function handleRequest(request) {
  const cache = await caches.open(CACHE_NAME);

  // Cache-first: si ya está guardado, se sirve desde caché.
  const cached = await cache.match(request);
  if (cached) return cached;

  // Si no está, se pide a la red y se guarda para la próxima vez.
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (error) {
    // Sin red: para navegaciones se devuelve la página principal guardada.
    if (request.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return Response.error();
  }
}
