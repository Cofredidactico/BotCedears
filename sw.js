/**
 * sw.js — Service worker para instalar Vertex Signal como app (PWA).
 *
 * Estrategias, a propósito distintas por tipo de recurso:
 *  - /api/*  → SIEMPRE red directa, nunca se cachea acá. La frescura de los
 *    datos de mercado ya la maneja dataSource.js con su propio TTL; un
 *    segundo caché acá podría volver a mostrar un precio viejo como si fuera
 *    real (el mismo tipo de bug que ya se corrigió una vez).
 *  - Shell de la app (html/js/css) → red primero, caché SOLO como respaldo
 *    si no hay conexión. Cache-first acá dejaría a alguien "atrapado" en una
 *    versión vieja del código después de un deploy.
 *  - Estáticos que casi no cambian (íconos, manifest) → cache-first.
 */
const SHELL_CACHE = 'icp-shell-v1';
const ASSET_CACHE = 'icp-assets-v1';
const SHELL_FILES = [
  './', './index.html', './app.js', './chart.js', './dataSource.js', './indicators.js',
  './scoring.js', './watchlist.js', './portfolio.js', './styles.css', './universe.json',
  './macro.json', './manifest.json',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // cross-origin (TradingView, fonts, etc.): sin tocar
  if (url.pathname.startsWith('/api/')) return; // datos de mercado: siempre red directa

  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        caches.open(ASSET_CACHE).then(c => c.put(req, res.clone()));
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(req).then(res => {
      caches.open(SHELL_CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req))
  );
});
