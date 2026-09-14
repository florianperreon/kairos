/* Kairos — service worker : installation sur l'écran d'accueil + consultation hors ligne.
   Les données vivent en base et ne transitent pas par ce cache.

   Invalidation à chaque déploiement (14/09/2026) :
   - VERSION porte l'empreinte de index.html, réécrite automatiquement par update.py à chaque
     régénération de la page. Une page inchangée = même empreinte = aucun remous ; une page
     modifiée = nouveau service worker, anciens caches supprimés, onglets ouverts rechargés.
   - La page et meta.js sont demandés en « no-cache » : le navigateur revalide toujours auprès
     du serveur (304 si rien n'a changé), au lieu de servir sa copie pendant 10 minutes.
     C'est ce qui empêchait de voir une mise en ligne récente. */
const VERSION = 'kairos-b47437ec4b9f9f';
const CORE = ['./', './index.html', './meta.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', e => {
  // skipWaiting AVANT le pré-cache : une nouvelle version doit prendre la main même si un
  // fichier de CORE manque ou répond mal. Un addAll() qui échoue bloquait toute la mise à jour.
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(CORE.map(u => c.add(u)))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const isData = url.origin === location.origin && /\/(meta|sw)\.js$/.test(url.pathname);
  if (isPage || isData) {
    // Toujours revalidé auprès du serveur, jamais servi depuis le cache HTTP du navigateur ;
    // le cache du service worker ne sert que de secours hors ligne.
    const frais = new Request(req, { cache: 'no-cache' });
    const key = isPage ? './index.html' : './' + url.pathname.split('/').pop();
    e.respondWith(fetch(frais).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => { c.put(key, copy); }); } return r; })
      .catch(() => caches.match(key)));
    return;
  }
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin === location.origin || isFont) {
    // cache d'abord, puis réseau (et mise en cache pour la prochaine fois)
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
  }
});
