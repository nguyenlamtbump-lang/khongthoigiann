/* sw.js — Service Worker của web Olympia.
 * Với tài nguyên đã được preload.js lưu vào cache:
 *   • thư viện trong vendor/ (tên file có số phiên bản, không bao giờ đổi) → trả ngay từ máy;
 *   • còn lại (giaodien.html, huyhieu.html, banner, ảnh, .js…) → HỎI MÁY CHỦ TRƯỚC (kèm ETag nên file không đổi thì chỉ tốn 304),
 *     lấy được bản mới thì dùng luôn và cập nhật cache; mạng chậm quá 4 giây hoặc mất mạng thì trả bản đã lưu.
 *     Nhờ vậy sửa giaodien.html / huyhieu.html… là người dùng thấy ngay ở lần tải kế tiếp, không bị kẹt bản cũ trong cache.
 * KHÔNG cache trang index.html / admin.html (để web luôn nhận bản code mới), cũng không đụng preload.js / sw.js. */
const ASSETS = 'oly-assets-v2';   // phải trùng với preload.js
const OLD_ASSETS = ['oly-assets-v1'];
const FONTS  = 'oly-fonts-v1';
const NET_WAIT = 4000;            // ms chờ máy chủ trước khi dùng bản đã lưu
const KEEP = ['X-Oly-V', 'X-Oly-Auto'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  Promise.all(OLD_ASSETS.map((n) => caches.delete(n))).then(() => self.clients.claim())
));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode === 'navigate' || r.headers.has('range')) return;
  if (r.cache === 'reload') return; // preload.js đang cố ý tải bản mới từ mạng

  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (/(^|\/)(sw|preload)\.js$/.test(u.pathname) || /(^|\/)assets-manifest\.json$/.test(u.pathname)) return; // luôn lấy thẳng từ mạng
    e.respondWith(managed(e, r, u));
  } else if (u.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(r));                 // file phông: không bao giờ đổi
  } else if (u.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(e, r));    // CSS phông: dùng ngay, cập nhật ngầm
  }
});

async function managed(e, r, u) {
  const c = await caches.open(ASSETS);
  const hit = await c.match(r, { ignoreSearch: true });
  if (!hit) return fetch(r);                                  // không nằm trong danh sách của preload → như bình thường
  if (/(^|\/)vendor\//.test(u.pathname)) return hit;          // thư viện đóng số phiên bản → cache là đủ

  const key = u.origin + u.pathname;
  const net = fetch(r, { cache: 'no-cache' });
  // Lưu bản mới vào cache (chạy song song, không chặn việc trả file cho trang). clone() phải gọi ngay khi có phản hồi.
  e.waitUntil(net.then((res) => {
    if (res.status !== 200) return;
    const copy = res.clone();
    const h = new Headers();
    h.set('Content-Type', res.headers.get('Content-Type') || hit.headers.get('Content-Type') || 'application/octet-stream');
    KEEP.forEach((k) => { const v = hit.headers.get(k); if (v != null) h.set(k, v); });
    const et = res.headers.get('ETag'), lm = res.headers.get('Last-Modified');
    if (et) h.set('X-Oly-Etag', et);
    if (lm) h.set('X-Oly-Lm', lm);
    return copy.blob().then((body) => c.put(key, new Response(body, { status: 200, headers: h })));
  }).catch(() => {}));  // dù đã trả bản cũ vì chờ lâu, vẫn để mạng tải xong rồi cập nhật cache

  const slow = new Promise((resolve) => setTimeout(() => resolve(null), NET_WAIT));
  try {
    const res = await Promise.race([net, slow]);
    if (res && (res.ok || res.status === 404 || res.status === 410)) return res;   // 404 = file đã bị xoá thật
    return hit;                                               // chậm / lỗi máy chủ → bản đã lưu
  } catch (err) {
    return hit;                                               // mất mạng
  }
}

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
