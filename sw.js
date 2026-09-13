/* Kairos — service worker : installation sur l'écran d'accueil + consultation hors ligne.
   Le portail est une page unique dont les données sont chiffrées ; le cache ne contient donc
   rien de lisible sans le mot de passe. Stratégie : la page (index.html) est demandée au réseau
   en priorité et le cache sert de secours (hors ligne) ; icônes, manifeste et polices en cache d'abord. */
const VERSION = 'kairos-v6';
const CORE = ['./', './index.html', './meta.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const isData = url.origin === location.origin && /\/meta\.js$/.test(url.pathname);
  if (isPage || isData) {
    // réseau d'abord (pour recevoir la mise à jour quotidienne des données), cache en secours
    const key = isPage ? './index.html' : './' + url.pathname.split('/').pop();
    e.respondWith(fetch(req).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => { c.put(key, copy); }); } return r; })
      .catch(() => caches.match(key)));
    return;
  }
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin === location.origin || isFont) {
    // cache d'abord, puis réseau (et mise en cache pour la prochaine fois)
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
  }
});
