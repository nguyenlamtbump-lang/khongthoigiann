/* sw.js — Service Worker của web Olympia.
 * Việc duy nhất: nếu tài nguyên đã nằm trong cache (do preload.js tải) thì trả ngay từ máy,
 * không hỏi mạng nữa. Muốn lấy bản mới → preload.js tải lại với cache:'reload' khi assets-manifest.json đổi phiên bản.
 * KHÔNG cache trang index.html / admin.html (để web luôn nhận bản code mới). */
const ASSETS = 'oly-assets-v1';   // phải trùng với preload.js
const FONTS  = 'oly-fonts-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode === 'navigate' || r.headers.has('range')) return;
  if (r.cache === 'reload') return; // preload.js đang cố ý tải bản mới từ mạng

  const u = new URL(r.url);
  if (u.origin === location.origin) {
    e.respondWith(
      caches.open(ASSETS)
        .then((c) => c.match(r, { ignoreSearch: true }))
        .then((hit) => hit || fetch(r))
    );
  } else if (u.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(r));                 // file phông: không bao giờ đổi
  } else if (u.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(e, r));    // CSS phông: dùng ngay, cập nhật ngầm
  }
});

async function cacheFirst(r) {
  const c = await caches.open(FONTS);
  const hit = await c.match(r);
  if (hit) return hit;
  const res = await fetch(r);
  if (res.ok) c.put(r, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(e, r) {
  const c = await caches.open(FONTS);
  const hit = await c.match(r);
  const net = fetch(r).then((res) => {
    if (res.ok || res.type === 'opaque') c.put(r, res.clone()).catch(() => {});
    return res;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}
