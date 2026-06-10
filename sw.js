// ============================================================
// UrbanistAI — Service Worker (Fase 0)
// Estrategia: cache-first para el shell de la app.
// Cambiar CACHE_NAME al actualizar assets para forzar recarga.
// ============================================================

const CACHE_NAME = 'urbanistai-v3';

// Archivos del shell de la app que se pre-cachean al instalar
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
];

// ---- Instalación: pre-cachear el shell ---------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_ASSETS))
  );
  // Activar el nuevo SW inmediatamente sin esperar a que se cierre la pestaña
  self.skipWaiting();
});

// ---- Activación: limpiar cachés antiguos -------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  // Tomar el control de todas las pestañas abiertas sin recargar
  self.clients.claim();
});

// ---- Fetch: devolver desde caché, pedir a red si no hay ----
self.addEventListener('fetch', event => {
  // Solo interceptar GET del mismo origen
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // Cache hit → responder directamente (funciona offline)
      if (cached) return cached;
      // Cache miss → ir a la red
      return fetch(event.request).catch(() => {
        // Si la red falla y no hay caché, no podemos hacer nada más
        // (en fases futuras aquí podríamos servir una página de error offline)
      });
    })
  );
});
