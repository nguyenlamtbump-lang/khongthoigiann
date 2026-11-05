/* preload.js — Màn hình tải tài nguyên + cache cho web Olympia.
 *
 * Cách hoạt động:
 *  1) Mỗi lần mở web chỉ tải 1 file nhỏ: assets-manifest.json (danh sách tài nguyên + phiên bản "v").
 *  2) So với những gì đã lưu trong Cache Storage: tài nguyên nào chưa có / đổi phiên bản mới tải.
 *  3) Có gì cần tải → hiện màn hình tải với thanh tiến độ. Không có gì → vào web ngay, không hiện gì.
 *  4) sw.js (Service Worker) lo việc trả tài nguyên từ cache cho các lần sau.
 * Thêm tài nguyên mới: chỉ cần thêm 1 dòng vào assets-manifest.json (xem scripts/build-manifest.mjs).
 * Script này không đụng vào logic của web; nếu trình duyệt không hỗ trợ thì nó tự bỏ qua. */
(function () {
  'use strict';
  var MANIFEST = 'assets-manifest.json', CACHE = 'oly-assets-v1', META = 'oly-meta-v1';
  var SEEN = 'oly_assets_seen_v1', CONC = 4, VHDR = 'X-Oly-V';
  var doc = document, root = doc.documentElement;

  if (!window.caches || !navigator.serviceWorker || !window.fetch || !window.Promise ||
      location.protocol === 'file:' || window.top !== window) return;

  var resolveReady, noop = function () {};
  window.__olyAssetsReady = new Promise(function (r) { resolveReady = r; });

  var abs = function (u) { return new URL(u, location.href).href; };
  var TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    svg: 'image/svg+xml', js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', woff2: 'font/woff2' };
  var guess = function (u) { return TYPES[(u.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] || 'application/octet-stream'; };
  var seen = false;
  try { seen = !!localStorage.getItem(SEEN); } catch (e) {}

  /* ---------- Giao diện màn hình tải ---------- */
  var ui = null;
  var CSS = '#olyPreload{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;box-sizing:border-box;background:radial-gradient(120% 90% at 50% 0%,#4c1d95 0%,#1e1b3a 62%);' +
    'color:#fff;font-family:"Be Vietnam Pro",system-ui,-apple-system,"Segoe UI",sans-serif;opacity:1;transition:opacity .4s ease;' +
    'touch-action:none;-webkit-user-select:none;user-select:none}' +
    '#olyPreload.opl-out{opacity:0;pointer-events:none}' +
    '#olyPreload .opl-card{width:min(420px,100%);text-align:center}' +
    '#olyPreload .opl-logo{width:92px;height:92px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 18px;' +
    'border:3px solid rgba(255,255,255,.85);box-shadow:0 0 0 6px rgba(249,115,22,.25),0 14px 34px rgba(0,0,0,.4);' +
    'animation:oplPulse 1.8s ease-in-out infinite}' +
    '#olyPreload h1{margin:0 0 4px;font-size:21px;line-height:1.3;font-weight:800;letter-spacing:.2px}' +
    '#olyPreload .opl-sub{margin:0 0 22px;font-size:13px;color:#ddd6fe}' +
    '#olyPreload .opl-bar{height:12px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden}' +
    '#olyPreload .opl-bar i{display:block;height:100%;border-radius:inherit;transform-origin:left center;transform:scaleX(0);' +
    'background:linear-gradient(90deg,#f97316,#fbbf24,#a78bfa);transition:transform .25s ease-out}' +
    '#olyPreload .opl-row{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:13px;color:#e9e5ff}' +
    '#olyPreload .opl-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}' +
    '#olyPreload .opl-pct{font-weight:800;color:#fff;min-width:42px;text-align:right}' +
    '#olyPreload .opl-note{margin:18px 0 0;font-size:12px;color:#c4b5fd;opacity:.85}' +
    '@keyframes oplPulse{50%{transform:scale(1.06)}}' +
    '@media (prefers-reduced-motion:reduce){#olyPreload .opl-logo{animation:none}#olyPreload,#olyPreload .opl-bar i{transition:none}}';

  function showUi() {
    if (ui || !root) return;
    var st = doc.createElement('style'); st.textContent = CSS;
    var d = doc.createElement('div'); d.id = 'olyPreload'; d.setAttribute('role', 'status');
    d.innerHTML = '<div class="opl-card"><img class="opl-logo" src="auth-logo.jpg" alt="" decoding="async">' +
      '<h1>Đường Lên Đỉnh Olympia</h1><p class="opl-sub">Đang chuẩn bị tài nguyên…</p>' +
      '<div class="opl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>' +
      '<div class="opl-row"><span class="opl-name">Đang kiểm tra…</span><span class="opl-pct">0%</span></div>' +
      '<p class="opl-note">Chỉ tải một lần — những lần mở sau web sẽ vào ngay.</p></div>';
    root.appendChild(st); root.appendChild(d);
    ui = { box: d, st: st, bar: d.querySelector('.opl-bar'), fill: d.querySelector('.opl-bar i'),
      name: d.querySelector('.opl-name'), pct: d.querySelector('.opl-pct'), sub: d.querySelector('.opl-sub') };
  }
  function paint(p, label) {
    if (!ui) return;
    p = Math.max(0, Math.min(1, p));
    ui.fill.style.transform = 'scaleX(' + p + ')';
    ui.pct.textContent = Math.round(p * 100) + '%';
    ui.bar.setAttribute('aria-valuenow', Math.round(p * 100));
    if (label) ui.name.textContent = label;
  }
  function hideUi(delay) {
    setTimeout(function () {
      if (!ui) return;
      var u = ui; ui = null;
      u.box.classList.add('opl-out');
      setTimeout(function () { try { u.box.remove(); u.st.remove(); } catch (e) {} }, 450);
    }, delay || 0);
  }

  /* ---------- Cache ---------- */
  function fetchManifest() {
    return fetch(MANIFEST, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      var copy = r.clone();
      caches.open(META).then(function (c) { return c.put(MANIFEST, copy); }).catch(noop);
      return r.json();
    }).catch(function () { // mất mạng → dùng bản danh sách đã lưu
      return caches.open(META).then(function (c) { return c.match(MANIFEST); })
        .then(function (r) { return r ? r.json() : null; });
    }).then(function (m) { return m && Array.isArray(m.assets) ? m : null; }).catch(function () { return null; });
  }

  // Phiên bản được ghi ngay trên chính mục cache (header X-Oly-V) → không bao giờ lệch với dữ liệu thật.
  function plan(m) {
    return caches.open(CACHE).then(function (c) {
      return Promise.all(m.assets.map(function (a) {
        return c.match(abs(a.u), { ignoreSearch: true }).then(function (hit) {
          return hit && hit.headers.get(VHDR) === String(a.v) ? null : a;
        });
      }));
    }).then(function (l) { return l.filter(Boolean); });
  }

  function download(a, onBytes) {
    a._got = 0;
    return fetch(a.u, { cache: 'reload' }).then(function (res) {
      if (res.status === 404) return null; // file không còn trên máy chủ → bỏ qua, không báo lỗi
      if (!res.ok) throw new Error(res.status);
      var type = res.headers.get('Content-Type') || guess(a.u), chunks = [];
      if (!res.body || !res.body.getReader) {
        return res.blob().then(function (b) { a._got = b.size; onBytes(b.size); return new Blob([b], { type: type }); });
      }
      var rd = res.body.getReader();
      return (function pump() {
        return rd.read().then(function (x) {
          if (x.done) return new Blob(chunks, { type: type });
          chunks.push(x.value); a._got += x.value.length; onBytes(x.value.length);
          return pump();
        });
      })();
    }).then(function (blob) {
      if (!blob) return;
      var h = { 'Content-Type': blob.type || guess(a.u) }; h[VHDR] = String(a.v);
      return caches.open(CACHE).then(function (c) { return c.put(abs(a.u), new Response(blob, { status: 200, headers: h })); });
    });
  }

  function cleanup(m) { // xoá tài nguyên không còn trong danh sách
    var keep = {}; m.assets.forEach(function (a) { keep[abs(a.u)] = 1; });
    return caches.open(CACHE).then(function (c) {
      return c.keys().then(function (ks) {
        return Promise.all(ks.filter(function (k) { return !keep[k.url.split(/[?#]/)[0]]; }).map(function (k) { return c.delete(k); }));
      });
    }).catch(noop);
  }

  function decodeImages(list) { // giải mã sẵn ảnh để lần hiển thị đầu không bị giật
    list.forEach(function (a) {
      if (!/\.(jpe?g|png|webp|gif)$/i.test(a.u)) return;
      try { var i = new Image(); i.src = a.u; if (i.decode) i.decode().catch(noop); } catch (e) {}
    });
  }

  function fontsReady() {
    var f = doc.fonts && doc.fonts.ready;
    return f ? Promise.race([f, new Promise(function (r) { setTimeout(r, 2500); })]).catch(noop) : Promise.resolve();
  }

  /* ---------- Chạy ---------- */
  navigator.serviceWorker.register('sw.js').catch(noop);
  var timer = setTimeout(showUi, seen ? 400 : 0); // lần đầu hiện ngay; lần sau chỉ hiện nếu tải lâu

  fetchManifest().then(function (m) {
    if (!m) throw 0;
    return plan(m).then(function (todo) {
      cleanup(m);
      if (!todo.length) return null;
      var total = 0, loaded = 0, done = 0, failed = 0;
      todo.forEach(function (a) { total += a.s > 0 ? a.s : 100000; });
      var tick = function (label) { paint(done >= todo.length ? 1 : Math.min(loaded / total, .99), label); };
      var i = 0;
      var worker = function () {
        if (i >= todo.length) return Promise.resolve();
        var a = todo[i++];
        tick('Đang tải: ' + (a.n || a.u));
        var add = function (n) { loaded += n; tick(); };
        var attempt = function (left) {
          return download(a, add).catch(function (err) {
            loaded -= a._got; // trừ phần đã tính của lần thử hỏng
            if (left > 0) return attempt(left - 1);
            failed++;
          });
        };
        return attempt(1).then(function () { done++; tick(); return worker(); });
      };
      var pool = [];
      for (var k = 0; k < Math.min(CONC, todo.length); k++) pool.push(worker());
      return Promise.all(pool).then(function () {
        decodeImages(todo);
        if (ui) { paint(.99, 'Đang hoàn tất…'); }
        return fontsReady().then(function () { return { failed: failed }; });
      });
    });
  }).catch(noop).then(function (r) {
    clearTimeout(timer);
    try { localStorage.setItem(SEEN, '1'); } catch (e) {}
    if (ui) {
      if (r && r.failed) {
        paint(1, 'Một số tài nguyên chưa tải được — sẽ thử lại lần mở sau');
        hideUi(1400);
      } else {
        paint(1, 'Hoàn tất!');
        hideUi(450);
      }
    }
    resolveReady();
  });
})();
