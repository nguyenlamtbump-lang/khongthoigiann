/* preload.js — Màn hình tải tài nguyên + cache cho web Olympia.
 *
 * Mục tiêu: tài nguyên (giaodien.html, huyhieu.html, banner-ngay-le.html, ảnh, thư viện…) LUÔN là bản mới nhất,
 * không cần nhớ sửa số phiên bản "v" trong assets-manifest.json mỗi lần chỉnh file.
 *
 * Cách hoạt động:
 *  1) Mỗi lần mở web chỉ tải 1 file nhỏ: assets-manifest.json (danh sách tài nguyên).
 *  2) Với mỗi tài nguyên đã lưu trong Cache Storage, hỏi lại máy chủ bằng ETag / Last-Modified đã lưu kèm:
 *       • 304 (không đổi)   → giữ nguyên, gần như không tốn dữ liệu;
 *       • 200 (file đã đổi) → lưu bản mới ngay từ chính phản hồi đó (không tải 2 lần).
 *     Tài nguyên chưa có, hoặc "v" trong manifest khác bản đã lưu, thì tải lại hẳn như trước.
 *     Thư viện trong vendor/ (tên file có số phiên bản) coi như không bao giờ đổi → không hỏi lại.
 *  3) Tự dò thêm tài nguyên cùng nguồn mà trang đang dùng nhưng manifest chưa liệt kê: từ chính trang đang mở,
 *     rồi (chạy nền) từ mã nguồn index.html và các file .html trong manifest (giaodien / huyhieu / banner…)
 *     — ảnh, .js, .css, âm thanh, phông chữ được nhắc tới trong đó sẽ được tải và giữ mới như các file khác.
 *  4) Có gì thật sự cần tải về → hiện màn hình tải với thanh tiến độ. Chỉ kiểm tra mà không đổi → vào web ngay, không hiện gì.
 *  5) sw.js (Service Worker) trả tài nguyên từ cache khi mạng chậm/mất, còn bình thường hỏi máy chủ trước (xem sw.js).
 * Danh sách chính thức vẫn nên cập nhật bằng:  node scripts/build-manifest.mjs   (tự quét file + tính "v").
 * Gỡ rối trong Console:  __olyAssetsRefresh()  → ép kiểm tra lại ngay (bỏ qua giới hạn 60 giây).
 * Script này không đụng vào logic của web; nếu trình duyệt không hỗ trợ thì nó tự bỏ qua. */
(function () {
  'use strict';
  var MANIFEST = 'assets-manifest.json', CACHE = 'oly-assets-v2', OLD_CACHES = ['oly-assets-v1'], META = 'oly-meta-v1';
  var SEEN = 'oly_assets_seen_v1', CHK = 'oly_assets_checked_v2', MISS = 'oly_assets_missing_v1', CONC = 4;
  var VHDR = 'X-Oly-V', EHDR = 'X-Oly-Etag', LHDR = 'X-Oly-Lm', AHDR = 'X-Oly-Auto';
  var RECHECK = 60000;          // tối thiểu 60 giây giữa 2 lần hỏi lại máy chủ (mở nhiều tab / tải lại liên tục không tốn thêm)
  var MISS_TTL = 86400000;      // tên file dò ra nhưng máy chủ báo 404 → 24 giờ sau mới thử lại
  var MAX_EXTRA = 40;           // tối đa số tài nguyên tự dò thêm
  var doc = document, root = doc.documentElement;

  if (!window.caches || !navigator.serviceWorker || !window.fetch || !window.Promise ||
      location.protocol === 'file:' || window.top !== window) return;

  var resolveReady, noop = function () {};
  window.__olyAssetsReady = new Promise(function (r) { resolveReady = r; });

  var abs = function (u) { return new URL(u, location.href).href; };
  var keyOf = function (u) { return abs(u).split(/[?#]/)[0]; };

  /* ---------- Công tắc huyhieu (admin → Cài đặt hệ thống) ----------
   * Admin tắt huy hiệu → không tải sẵn huyhieu.html, và xoá bản đã lưu trong Cache Storage.
   * Cờ nhớ ở localStorage 'oly_huyhieu_off' ('1' = tắt, '0' = bật); index.html cập nhật cờ mỗi lần đọc cấu hình.
   * Lần đầu (chưa có cờ) hỏi nhanh máy chủ 1 lần (tối đa 2,5 giây); lỗi mạng → coi như bật, không nhớ cờ. */
  var HH_FILE = 'huyhieu.html', HH_KEY = 'oly_huyhieu_off';
  var SB_URL = 'https://xaajtrmlwzqhzrgdanjy.supabase.co', SB_KEY = 'sb_publishable_rY0SthDOBA4RUgz-Sji_8Q_ZY_DAISl';
  function hhOff() {
    var f = null;
    try { f = localStorage.getItem(HH_KEY); } catch (e) {}
    if (f === '0' || f === '1') return Promise.resolve(f === '1');
    var ctl = window.AbortController ? new AbortController() : null;
    var tm = setTimeout(function () { if (ctl) ctl.abort(); }, 2500);
    return fetch(SB_URL + '/rest/v1/rpc/fs_get', {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_path: 'config/huyhieu' }), signal: ctl ? ctl.signal : undefined
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
      clearTimeout(tm);
      var off = !!d && d.enabled === false;
      try { localStorage.setItem(HH_KEY, off ? '1' : '0'); } catch (e) {}
      return off;
    }).catch(function () { clearTimeout(tm); return false; });
  }
  var TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    svg: 'image/svg+xml', js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', woff2: 'font/woff2' };
  var guess = function (u) { return TYPES[(u.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] || 'application/octet-stream'; };
  var seen = false;
  try { seen = !!localStorage.getItem(SEEN); } catch (e) {}

  var lsGet = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };
  function isDue() { return Date.now() - (+lsGet(CHK) || 0) > RECHECK; }
  function isImmutable(a) { return a.immutable === true || /(^|\/)vendor\//.test(a.u); }

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
      '<p class="opl-note">Chỉ tải phần mới — những lần mở sau web sẽ vào ngay.</p></div>';
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
  // Màn hình tải chỉ hiện khi THẬT SỰ có file phải tải về (kiểm tra 304 không làm hiện gì).
  // Lần đầu: hiện ngay; các lần sau: chỉ hiện nếu việc tải kéo dài quá 0,4 giây.
  var needUi = false, uiDelayOver = false, uiTimer = null;
  function wantUi() { needUi = true; if (uiDelayOver) showUi(); }
  function startUiTimer() {
    needUi = false; uiDelayOver = !seen;
    clearTimeout(uiTimer);
    if (seen) uiTimer = setTimeout(function () { uiDelayOver = true; if (needUi) showUi(); }, 400);
  }

  /* ---------- Danh sách tài nguyên ---------- */
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

  /* ---------- Tự dò tài nguyên được nhắc tới trong trang / mã nguồn ---------- */
  var EXT = /\.(?:jpe?g|png|webp|gif|svg|js|css|woff2|mp3|ogg)$/i;
  var NOT_ASSET = /(^|\/)(?:preload|sw)\.js$/i;   // 2 file này luôn phải lấy thẳng từ máy chủ
  function norm(raw) {
    if (!raw) return null;
    raw = String(raw).split(/[?#]/)[0].replace(/^\.\//, '');
    if (!raw || /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(raw)) return null;   // http:, data:, blob:, //host → bỏ
    if (/\.\./.test(raw) || !EXT.test(raw) || NOT_ASSET.test(raw)) return null;
    return raw;
  }
  function addExtra(out, have, raw) {
    var u = norm(raw); if (!u) return;
    var k; try { k = keyOf(u); } catch (e) { return; }
    if (have[k]) return;
    have[k] = 1; out.push({ u: u, n: u, s: 0, auto: 1 });
  }
  function fromDoc(out, have) {
    try {
      doc.querySelectorAll('link[href],script[src],img[src],source[src],video[poster]').forEach(function (el) {
        addExtra(out, have, el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('poster'));
      });
    } catch (e) {}
  }
  var RE_LIT = /["'(]([A-Za-z0-9_\-./]+\.(?:jpe?g|png|webp|gif|svg|js|css|woff2|mp3|ogg))(?:\?[^"')\s]*)?["')]/g;
  function fromText(out, have, text) {
    var m, n = 0; RE_LIT.lastIndex = 0;
    while ((m = RE_LIT.exec(text)) && n++ < 4000) addExtra(out, have, m[1]);
  }
  function missingList() { try { return JSON.parse(lsGet(MISS) || '{}') || {}; } catch (e) { return {}; } }
  function noteMissing(a) {
    var l = missingList(), now = Date.now();
    Object.keys(l).forEach(function (k) { if (now - l[k] > MISS_TTL) delete l[k]; });
    l[a.u] = now; lsSet(MISS, JSON.stringify(l));
  }

  /* ---------- Cache ---------- */
  // Mỗi mục cache mang theo: phiên bản manifest (X-Oly-V), ETag (X-Oly-Etag), Last-Modified (X-Oly-Lm).
  // Nhờ ETag/Last-Modified, file đổi trên máy chủ là biết ngay — không phụ thuộc việc có sửa "v" hay không.
  function plan(list, force) {
    var due = force || isDue();
    return caches.open(CACHE).then(function (c) {
      return Promise.all(list.map(function (a) {
        return c.match(abs(a.u), { ignoreSearch: true }).then(function (hit) {
          if (!hit) return { a: a };                                                   // chưa có → tải
          if (a.v != null && hit.headers.get(VHDR) !== String(a.v)) return { a: a };   // manifest đổi "v" → tải lại hẳn
          if (isImmutable(a) || !due) return null;
          if (hit.headers.get(EHDR) || hit.headers.get(LHDR)) return { a: a, hit: hit }; // hỏi lại máy chủ bằng ETag
          return null;                                                                 // máy chủ không có ETag → chỉ dựa vào "v"
        });
      }));
    }).then(function (l) { return l.filter(Boolean); });
  }

  var SAME = 'same', NEW = 'new', GONE = 'gone';
  function download(a, onBytes, onTotal, hit) {
    a._got = 0;
    var hd = {};
    if (hit) {
      var et = hit.headers.get(EHDR), lm = hit.headers.get(LHDR);
      if (et) hd['If-None-Match'] = et; else if (lm) hd['If-Modified-Since'] = lm;
    }
    return fetch(a.u, { cache: 'reload', headers: hd }).then(function (res) {
      if (res.status === 304) return { s: SAME };           // không đổi → giữ bản đang lưu
      if (res.status === 404) return { s: GONE };           // file không còn trên máy chủ → bỏ qua, không báo lỗi
      if (!res.ok) throw new Error(res.status);
      if (hit) { wantUi(); onTotal(+res.headers.get('Content-Length') || (a.s > 0 ? a.s : 100000)); }
      var type = res.headers.get('Content-Type') || guess(a.u), chunks = [];
      var meta = { et: res.headers.get('ETag') || '', lm: res.headers.get('Last-Modified') || '' };
      if (!res.body || !res.body.getReader) {
        return res.blob().then(function (b) { a._got = b.size; onBytes(b.size); return { s: NEW, b: new Blob([b], { type: type }), meta: meta }; });
      }
      var rd = res.body.getReader();
      return (function pump() {
        return rd.read().then(function (x) {
          if (x.done) return { s: NEW, b: new Blob(chunks, { type: type }), meta: meta };
          chunks.push(x.value); a._got += x.value.length; onBytes(x.value.length);
          return pump();
        });
      })();
    }).then(function (r) {
      if (r.s !== NEW) return r.s;
      var h = { 'Content-Type': r.b.type || guess(a.u) };
      h[VHDR] = a.v != null ? String(a.v) : '';
      if (r.meta.et) h[EHDR] = r.meta.et;
      if (r.meta.lm) h[LHDR] = r.meta.lm;
      if (a.auto) h[AHDR] = '1';
      return caches.open(CACHE).then(function (c) { return c.put(keyOf(a.u), new Response(r.b, { status: 200, headers: h })); })
        .then(function () { return NEW; });
    });
  }

  // jobs: [{a, hit?}] — có hit = chỉ hỏi lại (conditional), không có = tải thật.
  function execute(jobs) {
    var r = { failed: 0, changed: 0 };
    if (!jobs.length) return Promise.resolve(r);
    var total = 0, loaded = 0, done = 0, i = 0;
    jobs.forEach(function (j) { if (!j.hit) { total += j.a.s > 0 ? j.a.s : 100000; wantUi(); } });
    var tick = function (label) { paint(done >= jobs.length ? 1 : Math.min(loaded / Math.max(total, 1), .99), label); };
    var onTotal = function (n) { total += n; };
    var worker = function () {
      if (i >= jobs.length) return Promise.resolve();
      var j = jobs[i++], a = j.a;
      if (!j.hit) tick('Đang tải: ' + (a.n || a.u));
      var add = function (n) { loaded += n; tick(); };
      var attempt = function (left) {
        return download(a, add, onTotal, j.hit).then(function (s) {
          if (s === NEW) r.changed++;
          else if (s === GONE && a.auto) noteMissing(a);
        }, function (err) {
          loaded -= a._got; // trừ phần đã tính của lần thử hỏng
          if (left > 0) return attempt(left - 1);
          r.failed++;
        });
      };
      return attempt(1).then(function () { done++; tick(); return worker(); });
    };
    var pool = [];
    for (var k = 0; k < Math.min(CONC, jobs.length); k++) pool.push(worker());
    return Promise.all(pool).then(function () { return r; });
  }

  // keepAuto = false → xoá luôn các mục tự dò không còn được nhắc tới nữa.
  function cleanup(list, keepAuto) {
    var keep = {}; list.forEach(function (a) { keep[keyOf(a.u)] = 1; });
    return caches.open(CACHE).then(function (c) {
      return c.keys().then(function (ks) {
        return Promise.all(ks.filter(function (k) { return !keep[k.url.split(/[?#]/)[0]]; }).map(function (k) {
          if (!keepAuto) return c.delete(k);
          return c.match(k).then(function (h) { if (!h || h.headers.get(AHDR) !== '1') return c.delete(k); });
        }));
      });
    }).catch(noop);
  }
  function dropOldCaches() {
    OLD_CACHES.forEach(function (n) { caches.delete(n).catch(noop); });
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

  /* ---------- Dò nền: tài nguyên được nhắc tới trong index.html / giaodien.html / huyhieu.html / banner… ---------- */
  function deepScan(m, force) {
    var conn = navigator.connection;
    if (!force && conn && conn.saveData) return Promise.resolve();
    var have = {}; m.assets.forEach(function (a) { have[keyOf(a.u)] = 1; });
    var out = [], miss = missingList(), now = Date.now();
    var srcs = [fetch('index.html', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })];
    var htmls = m.assets.filter(function (a) { return /\.html?$/i.test(a.u); });
    srcs.push(caches.open(CACHE).then(function (c) {
      return Promise.all(htmls.map(function (a) {
        return c.match(abs(a.u), { ignoreSearch: true }).then(function (h) { return h ? h.text() : ''; }).catch(function () { return ''; });
      }));
    }).then(function (l) { return l.join('\n'); }));
    return Promise.all(srcs).then(function (t) {
      fromDoc(out, have);
      t.forEach(function (x) { if (x) fromText(out, have, x); });
      out = out.filter(function (a) { return !(miss[a.u] && now - miss[a.u] < MISS_TTL); }).slice(0, MAX_EXTRA);
      return plan(out, force).then(function (jobs) { return execute(jobs); }).then(function () {
        var all = m.assets.concat(out);
        decodeImages(all);
        return cleanup(all, false);
      });
    }).catch(noop);
  }

  /* ---------- Chạy ---------- */
  navigator.serviceWorker.register('sw.js').catch(noop);
  dropOldCaches();

  function run(force) {
    startUiTimer();
    return fetchManifest().then(function (m) {
      if (!m) throw 0;
      return hhOff().then(function (off) {
        if (off) m.assets = m.assets.filter(function (a) { return a.u !== HH_FILE; }); // tắt → coi như không còn trong danh sách
        var extras = [], have = {};
        m.assets.forEach(function (a) { have[keyOf(a.u)] = 1; });
        fromDoc(extras, have);                                       // tài nguyên của chính trang đang mở
        var miss = missingList(), now = Date.now();
        extras = extras.filter(function (a) { return !(miss[a.u] && now - miss[a.u] < MISS_TTL); }).slice(0, MAX_EXTRA);
        var all = m.assets.concat(extras);
        return plan(all, force).then(function (jobs) {
          cleanup(all, true);                                       // xoá mục không còn trong danh sách (giữ mục tự dò)
          return execute(jobs).then(function (r) {
            decodeImages(all);
            if (ui) paint(.99, 'Đang hoàn tất…');
            return fontsReady().then(function () { return { failed: r.failed, m: m }; });
          });
        });
      });
    }).catch(function () { return null; }).then(function (r) {
      clearTimeout(uiTimer);
      if (!r || !r.failed) lsSet(CHK, String(Date.now()));          // có lỗi → lần mở sau thử lại ngay, không đợi 60 giây
      lsSet(SEEN, '1');
      if (ui) {
        if (r && r.failed) {
          paint(1, 'Một số tài nguyên chưa tải được — sẽ thử lại lần mở sau');
          hideUi(1400);
        } else {
          paint(1, 'Hoàn tất!');
          hideUi(450);
        }
      }
      return r;
    });
  }

  var first = run(false);
  first.then(function () { resolveReady(); });
  first.then(function (r) { // dò nền sau khi web đã mở xong, không làm chậm lúc vào
    if (!r || !r.m || !isDueDeep()) return;
    var go = function () { markDeep(); deepScan(r.m, false); };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1500);
  });
  var DEEP = 'oly_assets_deep_v1';
  function isDueDeep() { return Date.now() - (+lsGet(DEEP) || 0) > 10 * 60000; }  // dò sâu tối đa 10 phút/lần
  function markDeep() { lsSet(DEEP, String(Date.now())); }

  // Ép kiểm tra lại toàn bộ ngay (dùng khi gỡ rối): __olyAssetsRefresh()
  window.__olyAssetsRefresh = function () {
    return run(true).then(function (r) { return r && r.m ? deepScan(r.m, true).then(function () { markDeep(); return 'xong'; }) : 'không có manifest'; });
  };
})();
