// Cache para que la app funcione sin internet. Sube la versión al cambiar archivos.
const CACHE = 'mis-gastos-v3';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'sync.js', 'manifest.webmanifest', 'icon.svg'];
const FIREBASE_SDK = '/firebasejs/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Librería de Firebase: cada versión es fija, así que se sirve desde caché si ya está.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith(FIREBASE_SDK)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    })));
    return;
  }

  // Lo demás de otros sitios (Google, Firestore) va directo a la red.
  if (url.origin !== self.location.origin) return;

  // Archivos de la app: red primero (para recibir actualizaciones), caché si no hay conexión.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
