/*! nganhang.js — "Ngân hàng câu hỏi" (chỉ admin).
 *  Tải lười từ index.html lúc admin mở tab đầu tiên → không tốn gì ở lần tải trang.
 *  Nguồn: repo GitHub data-rhyder (đề .xlsx do github-pool-sync đẩy lên, dạng de-thi/YYYY-MM/*.xlsx).
 *  Hai chế độ: (1) chọn nguyên một bộ đề · (2) trộn ngẫu nhiên câu hỏi từ nhiều đề.
 *  Dùng lại bộ đọc/kiểm tra/tải ảnh sẵn có của index.html qua window.__olympiaCore.
 */
(function () {
  'use strict';
  if (window.__olympiaBank) return;

  /* ───────── Cấu hình ───────── */
  var OWNER = 'ngoclam20052k7-commits', REPO = 'data-rhyder', BRANCH = 'main';
  var GH_TREE = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/git/trees/' + BRANCH + '?recursive=1';
  var JSD_LIST = 'https://data.jsdelivr.com/v1/packages/gh/' + OWNER + '/' + REPO + '@' + BRANCH + '?structure=flat';
  var RAW = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + BRANCH + '/';
  var JSD = 'https://cdn.jsdelivr.net/gh/' + OWNER + '/' + REPO + '@' + BRANCH + '/';
  var CACHE_KEY = 'olyBankTreeV1', CACHE_TTL = 10 * 60 * 1000; // GitHub API ẩn danh chỉ 60 lượt/giờ/IP → cache danh sách
  var PAGE = 40, FETCH_TIMEOUT = 180000, CANCEL = '__cancel';

  /* ───────── Tiện ích ───────── */
  var $ = function (id) { return document.getElementById(id); };
  var core = function () { return window.__olympiaCore || {}; };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 16); }); }; // nhường luồng chính để UI kịp vẽ
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fold(s) {
    s = String(s || '');
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* trình duyệt cũ */ }
    return s.replace(/[đĐ]/g, 'd').toLowerCase();
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function shuffle(a) { // Fisher–Yates
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function stamp() {
    var d = new Date();
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ───────── Danh sách file trong repo ───────── */
  // Tên file do github-pool-sync đặt: "rank-<slug>__<epoch_ms>.xlsx" hoặc "test-<slug>__<epoch_ms>.xlsx"
  function mkFile(path, size) {
    var name = path.slice(path.lastIndexOf('/') + 1).replace(/\.xlsx?$/i, '');
    var m = /^(rank|test)-(.+?)(?:__(\d{10,}))?$/i.exec(name);
    var slug = (m ? m[2] : name.replace(/__\d{10,}$/, '')).replace(/[-_]+/g, ' ').trim();
    var dir = path.indexOf('/') < 0 ? '' : path.slice(0, path.lastIndexOf('/'));
    var title = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : name;
    return {
      path: path, size: size || 0, dir: dir, title: title,
      kind: m ? m[1].toUpperCase() : '', ts: m && m[3] ? +m[3] : 0,
      hay: fold(title + ' ' + name + ' ' + dir)
    };
  }
  function sortFiles(a) {
    return a.sort(function (x, y) { return (y.ts - x.ts) || (x.path < y.path ? -1 : 1); }); // mới nhất lên đầu
  }
  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function readCache() {
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && Array.isArray(c.a) && Date.now() - c.t < CACHE_TTL) {
        return sortFiles(c.a.map(function (x) { return mkFile(x[0], x[1]); }));
      }
    } catch (e) { /* bỏ qua cache hỏng */ }
    return null;
  }
  function writeCache(list) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), a: list.map(function (f) { return [f.path, f.size]; }) }));
    } catch (e) { /* hết quota cũng không sao */ }
  }
  function listRepo() { // GitHub API (mới nhất) → nếu lỗi/hết lượt thì jsDelivr
    return getJson(GH_TREE).then(function (j) {
      if (!j || !Array.isArray(j.tree)) throw new Error('bad tree');
      return j.tree.filter(function (t) {
        return t.type === 'blob' && /\.xlsx?$/i.test(t.path) && t.path.split('/').pop().charAt(0) !== '~';
      }).map(function (t) { return mkFile(t.path, t.size); });
    }).catch(function () {
      return getJson(JSD_LIST).then(function (j) {
        if (!j || !Array.isArray(j.files)) throw new Error('Không đọc được danh sách file của repo (GitHub đang giới hạn hoặc bị chặn).');
        return j.files.filter(function (f) { return /\.xlsx?$/i.test(f.name); })
          .map(function (f) { return mkFile(f.name.replace(/^\//, ''), f.size); });
      });
    }).then(sortFiles);
  }

  /* ───────── Tải file (có tiến độ, hủy được, dự phòng jsDelivr) ───────── */
  function newJob() {
    if (S.job) { S.job.stop = true; if (S.job.ac) S.job.ac.abort(); }
    return (S.job = { stop: false, ac: null });
  }
  function chk(j) { if (j.stop) throw new Error(CANCEL); }
  function fetchBuf(path, j, onP) {
    var enc = path.split('/').map(encodeURIComponent).join('/');
    function get(url) {
      var ac = new AbortController(), to = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT);
      j.ac = ac;
      return fetch(url, { signal: ac.signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = +r.headers.get('content-length') || 0;
        if (!total || !r.body || !r.body.getReader) return r.arrayBuffer();
        var rd = r.body.getReader(), parts = [], got = 0;
        return (function pump() {
          return rd.read().then(function (x) {
            if (x.done) {
              var out = new Uint8Array(got), o = 0;
              parts.forEach(function (p) { out.set(p, o); o += p.length; });
              return out.buffer;
            }
            parts.push(x.value); got += x.value.length; onP(Math.min(1, got / total));
            return pump();
          });
        })();
      }).finally(function () { clearTimeout(to); });
    }
    return get(RAW + enc).catch(function (e) {
      if (j.stop) throw e;
      return get(JSD + enc); // raw.githubusercontent đôi khi bị chặn ở VN
    });
  }

  /* ───────── Đọc đề: tải → đọc xlsx → (ảnh xử lý ở bước finalize) ───────── */
  function needCore() {
    var c = core();
    if (!c.parseExamFromBuffer || !c.finalizeExam || !c.setPoolDraft) {
      throw new Error('index.html chưa phải bản mới nhất (thiếu parseExamFromBuffer/finalizeExam). Hãy cập nhật index.html rồi tải lại trang.');
    }
    return c;
  }
  async function readExam(f, j, p0, p1) {
    var c = needCore(), span = p1 - p0;
    var buf = await fetchBuf(f.path, j, function (p) { prog(p0 + span * 0.6 * p, 'Tải file'); });
    chk(j); prog(p0 + span * 0.62, 'Đọc đề'); await tick();
    var ex = await c.parseExamFromBuffer(buf);
    chk(j); prog(p1);
    return ex;
  }
  function finalize(ex, j, p0) { // kiểm tra cấu trúc + tải ảnh (chỉ ảnh của các câu đã chọn)
    return needCore().finalizeExam(ex, function (d, t) {
      if (!j.stop) prog(p0 + (1 - p0) * (t ? d / t : 1), t ? 'Tải ảnh ' + d + '/' + t : 'Kiểm tra đề');
    });
  }
  function sumExam(ex) {
    var p = ex.veDich.packages;
    return (ex.khoiDong.pool || []).length + ' câu Khởi động · VCNV “' + ex.vuotChuongNgaiVat.keyword + '” · ' +
      ex.tangToc.questions.length + ' câu Tăng tốc · Về đích ' + (p[20] || []).length + ' + ' + (p[30] || []).length + ' câu';
  }

  /* ───────── Chế độ 1: dùng nguyên một bộ đề ───────── */
  async function usePick() {
    var f = S.byPath[S.sel];
    if (!f || S.busy) return;
    var j = newJob(); setBusy(true);
    try {
      say('info', 'Đang tải “' + f.title + '”… (file có ảnh nhúng có thể nặng ~10 MB)');
      var ex = await readExam(f, j, 0, 0.5);
      ex.meta = { title: f.title, note: 'Ngân hàng câu hỏi · ' + f.path };
      say('info', 'Đang kiểm tra đề và tải ảnh lên máy chủ…');
      await finalize(ex, j, 0.5); chk(j);
      core().setPoolDraft(ex, '✓ Đã chọn đề “' + f.title + '” từ Ngân hàng câu hỏi. Bấm “Nạp đề thi này vào phòng”.', { kind: 'builder', title: f.title });
      say('ok', '✓ Đề sẵn sàng: ' + sumExam(ex) + '\nBấm “Nạp đề thi này vào phòng” bên dưới để dùng.');
    } catch (e) { fail(e, j); } finally { if (S.job === j) setBusy(false); }
  }

  /* ───────── Chế độ 2: trộn ngẫu nhiên ─────────
   * Đọc lần lượt từng file rồi chọn ngẫu nhiên bằng "reservoir sampling": mỗi file đọc xong chỉ giữ lại
   * các câu đang trúng chọn, phần còn lại được giải phóng → luôn chỉ ~1 file nằm trong RAM (file nặng 10–13 MB).
   * Xác suất chọn đồng đều trên toàn bộ câu của các file nguồn; loại câu trùng nội dung. */
  function Res(n) { this.n = n; this.seen = 0; this.a = []; }
  Res.prototype.add = function (x) {
    var i = this.seen++;
    if (this.a.length < this.n) this.a.push(x);
    else { var k = Math.floor(Math.random() * (i + 1)); if (k < this.n) this.a[k] = x; }
  };
  function feed(res, seen, arr) {
    (arr || []).forEach(function (q) {
      var k = norm(q && q.question);
      if (!k || seen[k]) return;
      seen[k] = 1; res.add(q);
    });
  }
  function absorb(ex, R, seen) {
    feed(R.kd, seen.kd, ex.khoiDong && ex.khoiDong.pool);
    var p = (ex.veDich && ex.veDich.packages) || {};
    feed(R.v20, seen.v20, p[20]); feed(R.v30, seen.v30, p[30]);
    var vc = ex.vuotChuongNgaiVat, k = vc && norm(vc.keyword);
    if (k && vc.rows && vc.rows.length >= 3 && !seen.vc[k]) { seen.vc[k] = 1; R.vc.add(vc); } // VCNV là một khối (từ khóa + 4 hàng + ảnh) nên lấy nguyên khối
    ((ex.tangToc && ex.tangToc.questions) || []).slice(0, 4).forEach(function (q, i) { // Tăng tốc: giữ đúng vị trí câu 1–4 (dạng câu khác nhau)
      if (q && q.question) R.tt[i].add(q);
    });
  }
  function buildMix(R, used) {
    var kd = shuffle(R.kd.a.slice()), n = kd.length;
    var gq = n >= 16 ? 12 : Math.max(1, Math.floor(n / 2)); // đúng tỉ lệ đề gốc: 6 câu/thí sinh × 4 + 12 câu lượt chung = 36
    var qpp = Math.max(1, Math.floor((n - gq) / 4));
    return {
      meta: { title: 'Đề trộn từ Ngân hàng — ' + stamp(), note: 'Trộn ngẫu nhiên từ ' + used.length + ' đề: ' + used.join(' | ') },
      khoiDong: { questionsPerPlayer: qpp, groupQuestions: gq, pool: kd },
      vuotChuongNgaiVat: R.vc.a[0] || { keyword: '', rows: [] },
      tangToc: { questions: R.tt.map(function (r) { return r.a[0]; }).filter(Boolean) },
      veDich: { packages: { 20: shuffle(R.v20.a.slice()), 30: shuffle(R.v30.a.slice()) } }
    };
  }
  async function runMix() {
    if (S.busy) return;
    var cfg = { kd: num('bkKd', 16, 80, 36), v20: num('bkV20', 4, 20, 8), v30: num('bkV30', 4, 20, 8), n: numN() };
    var pool = S.files.filter(function (f) { return !S.dir || f.dir === S.dir; });
    if (!pool.length) return say('err', 'Phạm vi đã chọn chưa có file .xlsx nào.');
    var src = shuffle(pool.slice()); if (cfg.n) src = src.slice(0, cfg.n); // n = 0 → không giới hạn: đọc hết các file trong phạm vi
    var R = { kd: new Res(cfg.kd), vc: new Res(1), v20: new Res(cfg.v20), v30: new Res(cfg.v30), tt: [0, 1, 2, 3].map(function () { return new Res(1); }) };
    var seen = { kd: {}, v20: {}, v30: {}, vc: {} }, used = [], skipped = 0, lastErr = null;
    var j = newJob(); setBusy(true);
    try {
      for (var i = 0; i < src.length; i++) {
        say('info', 'Đang đọc đề ' + (i + 1) + '/' + src.length + ': ' + src[i].title + '…');
        try {
          var ex = await readExam(src[i], j, 0.8 * i / src.length, 0.8 * (i + 1) / src.length);
          absorb(ex, R, seen); used.push(src[i].title); ex = null;
        } catch (e) {
          if (j.stop || e.message === CANCEL) throw e;
          skipped++; lastErr = e; console.warn('[Ngân hàng] bỏ qua', src[i].path, e);
        }
      }
      if (!used.length) throw lastErr || new Error('Không đọc được file nào.');
      var exam = buildMix(R, used);
      say('info', 'Đang kiểm tra đề và tải ảnh của các câu được chọn…');
      await finalize(exam, j, 0.8); chk(j);
      core().setPoolDraft(exam, '✓ Đã trộn đề ngẫu nhiên từ ' + used.length + ' đề. Bấm “Nạp đề thi này vào phòng”.', { kind: 'builder', title: exam.meta.title });
      say('ok', '✓ Đề trộn sẵn sàng: ' + sumExam(exam) + '\nNguồn: ' + used.join(' · ') + (skipped ? '\n(Bỏ qua ' + skipped + ' file lỗi.)' : '') +
        '\nBấm “Nạp đề thi này vào phòng” bên dưới, hoặc bấm “Trộn đề” lần nữa để ra bộ khác.');
    } catch (e) { fail(e, j); } finally { if (S.job === j) setBusy(false); }
  }

  /* ───────── Giao diện ───────── */
  var S = { ready: false, files: null, byPath: {}, sel: null, q: '', dir: '', shown: PAGE, mode: 'pick', busy: false, job: null };
  var lastKey = '', qTimer = 0;

  function say(kind, msg) { var e = $('bkStatus'); if (e) { e.className = 'json-status ' + kind; e.textContent = msg; } }
  function prog(p, label) {
    var t = $('bkTrack'), f = $('bkFill'), l = $('bkPct');
    if (!t) return;
    if (p == null) { t.classList.add('hidden'); l.classList.add('hidden'); lastKey = ''; return; }
    var v = Math.max(0, Math.min(100, Math.round(p * 100))), k = v + '|' + (label || '');
    if (k === lastKey) return; // chỉ chạm DOM khi giá trị đổi
    lastKey = k; t.classList.remove('hidden'); l.classList.remove('hidden');
    f.style.width = v + '%'; if (label) l.textContent = label + ' · ' + v + '%';
  }
  function setBusy(b) {
    S.busy = b;
    ['bkUse', 'bkShuffle', 'bkReload'].forEach(function (id) {
      var e = $(id); if (e) e.disabled = b || (id === 'bkUse' && !S.sel);
    });
    $('bkCancel').classList.toggle('hidden', !b);
    if (!b) prog(null);
  }
  function fail(e, j) {
    if (j.stop || (e && e.message === CANCEL)) return say('info', 'Đã hủy.');
    console.error('[Ngân hàng câu hỏi]', e);
    try { if (window.__olympiaLogAppError) window.__olympiaLogAppError('Ngân hàng câu hỏi', e); } catch (_) { /* không để log làm hỏng luồng */ }
    var m = String(e && e.message || e);
    say('err', '✗ ' + (/failed to fetch|networkerror|load failed|abort|HTTP (403|404|5\d\d)/i.test(m)
      ? 'Không tải được file từ GitHub (mạng chậm, bị chặn hoặc file đã bị xóa). Thử lại sau hoặc bấm ⟳ để tải lại danh sách. [' + m + ']' : m));
  }
  function numN() { // ô trống / 0 = không giới hạn (mặc định)
    var e = $('bkN'), v = parseInt(e.value, 10);
    if (!isFinite(v) || v < 1) { e.value = ''; return 0; }
    v = Math.min(v, 999); e.value = v; return v;
  }
  function num(id, lo, hi, def) {
    var v = parseInt($(id).value, 10);
    if (!isFinite(v)) v = def;
    v = Math.max(lo, Math.min(hi, v)); $(id).value = v; return v;
  }

  function filtered() {
    var q = fold(S.q).trim();
    return S.files.filter(function (f) { return (!S.dir || f.dir === S.dir) && (!q || f.hay.indexOf(q) >= 0); });
  }
  function rowHtml(f) {
    return '<div class="rk-pool-pick-item' + (S.sel === f.path ? ' picked' : '') + '" data-p="' + esc(f.path) + '"><div style="min-width:0">' +
      '<div class="rk-ppi-title">' + (f.kind ? '<span class="bk-tag bk-' + f.kind.toLowerCase() + '">' + f.kind + '</span>' : '') + esc(f.title) + '</div>' +
      '<div class="rk-ppi-meta">' + esc(f.dir.replace(/^de-thi\//, '') || 'gốc repo') + (f.size ? ' · ' + (f.size / 1048576).toFixed(1) + ' MB' : '') +
      (f.ts ? ' · ' + new Date(f.ts).toLocaleDateString('vi-VN') : '') + '</div></div></div>';
  }
  function paintList() {
    var el = $('bkList'), a = filtered(), n = Math.min(a.length, S.shown), h = '';
    for (var i = 0; i < n; i++) h += rowHtml(a[i]);
    if (a.length > n) h += '<button type="button" class="btn btn-outline" data-bk="more" style="margin:6px 0">Xem thêm (' + (a.length - n) + ')</button>';
    el.innerHTML = h || '<div class="small-muted" style="padding:10px">Không có đề nào khớp.</div>';
    $('bkCount').textContent = a.length + ' đề';
  }
  function paintDirs() {
    var cnt = {}, sel = $('bkDir');
    S.files.forEach(function (f) { cnt[f.dir] = (cnt[f.dir] || 0) + 1; });
    var dirs = Object.keys(cnt).sort().reverse();
    sel.innerHTML = '<option value="">Tất cả thư mục (' + S.files.length + ')</option>' + dirs.map(function (d) {
      return '<option value="' + esc(d) + '">' + esc(d.replace(/^de-thi\//, '') || 'gốc repo') + ' (' + cnt[d] + ')</option>';
    }).join('');
    if (S.dir && !cnt[S.dir]) S.dir = '';
    sel.value = S.dir;
  }
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll('#bankMount [data-bk="pick"],#bankMount [data-bk="mix"]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-bk') === m);
    });
    $('bkPick').classList.toggle('hidden', m !== 'pick');
    $('bkMix').classList.toggle('hidden', m !== 'mix');
    $('bkSearch').classList.toggle('hidden', m !== 'pick');
    $('bkHint').innerHTML = m === 'pick'
      ? 'Chọn <b>một bộ đề .xlsx</b> trong repo <b>' + OWNER + '/' + REPO + '</b> rồi bấm “Dùng đề đã chọn”. Web tự đọc, kiểm tra và tải ảnh lên giống tab “Tải file Excel”.'
      : 'Rút <b>ngẫu nhiên câu hỏi</b> từ các đề trong repo để ghép thành một bộ đề mới. Mặc định đọc <b>tất cả các đề</b> trong phạm vi đã chọn (mỗi file có ảnh nặng ~10 MB nên repo càng nhiều đề thì càng lâu). Nhập “Số đề nguồn” để giới hạn: web sẽ bốc ngẫu nhiên đúng chừng đó file.';
  }
  function refresh(force) {
    var list = $('bkList');
    list.innerHTML = '<div class="small-muted" style="padding:10px">Đang tải danh sách đề từ repo…</div>';
    $('bkCount').textContent = '';
    var cached = !force && (S.files || readCache());
    var p = cached ? Promise.resolve(cached) : listRepo().then(function (a) { writeCache(a); return a; });
    return p.then(function (a) {
      S.files = a; S.byPath = {}; a.forEach(function (f) { S.byPath[f.path] = f; });
      if (S.sel && !S.byPath[S.sel]) S.sel = null;
      S.shown = PAGE; paintDirs(); paintList(); syncUse();
      if (!a.length) say('info', 'Repo chưa có file .xlsx nào.');
    }, function (e) {
      S.files = null;
      list.innerHTML = '<div class="small-muted" style="padding:10px;color:#b91c1c">✗ ' + esc(e && e.message || e) + ' Bấm ⟳ để thử lại.</div>';
    });
  }
  function syncUse() {
    var u = $('bkUse'); if (u) u.disabled = S.busy || !S.sel;
    var f = S.byPath[S.sel]; $('bkSel').textContent = f ? 'Đã chọn: ' + f.title : 'Chưa chọn đề nào.';
  }

  var CSS = '#bankMount .bk-bar{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}' +
    '#bankMount .bk-bar .admin-input{flex:1 1 180px;margin:0}#bankMount .bk-bar select{flex:0 1 220px;width:auto;margin:0}' +
    '#bankMount .bk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:12px 0}' +
    '#bankMount .bk-grid label{display:block;font-size:11.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#7c3aed}' +
    '#bankMount .bk-grid .rk-field{margin-top:4px}#bankMount .bk-act{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}' +
    '#bankMount .bk-tag{display:inline-block;margin-right:7px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.5px;vertical-align:1px;background:#e0e7ff;color:#3730a3}' +
    '#bankMount .bk-tag.bk-rank{background:#fef3c7;color:#92400e}#bankMount .rk-pool-pick-list{max-height:300px}' +
    '#bankMount [data-bk]:disabled{opacity:.5;cursor:not-allowed}#bankMount #bkStatus{white-space:pre-line}';

  function build(root) {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root.innerHTML =
      '<div class="rt-chips" style="margin-top:12px"><button type="button" class="rt-chip on" data-bk="pick">📂 Chọn bộ đề</button>' +
      '<button type="button" class="rt-chip" data-bk="mix">🎲 Trộn đề ngẫu nhiên</button></div>' +
      '<p class="small-muted" id="bkHint" style="margin-top:10px"></p>' +
      '<div class="bk-bar"><input class="admin-input" id="bkSearch" type="search" placeholder="Tìm đề theo tên…" autocomplete="off">' +
      '<select class="rk-field" id="bkDir" aria-label="Thư mục"></select>' +
      '<button type="button" class="btn btn-outline" id="bkReload" data-bk="reload" title="Tải lại danh sách từ repo" style="padding:10px 16px">⟳</button>' +
      '<span class="small-muted" id="bkCount"></span></div>' +
      '<div id="bkPick"><div class="rk-pool-pick-list" id="bkList"></div>' +
      '<div class="bk-act"><button type="button" class="btn btn-gold" id="bkUse" data-bk="use" disabled>Dùng đề đã chọn</button><span class="small-muted" id="bkSel"></span></div></div>' +
      '<div id="bkMix" class="hidden"><div class="bk-grid">' +
      '<div><label for="bkKd">Câu Khởi động</label><input class="rk-field" id="bkKd" type="number" min="16" max="80" value="36"></div>' +
      '<div><label for="bkV20">Về đích 20đ</label><input class="rk-field" id="bkV20" type="number" min="4" max="20" value="8"></div>' +
      '<div><label for="bkV30">Về đích 30đ</label><input class="rk-field" id="bkV30" type="number" min="4" max="20" value="8"></div>' +
      '<div><label for="bkN">Số đề nguồn</label><input class="rk-field" id="bkN" type="number" min="1" max="999" placeholder="Tất cả" title="Để trống = không giới hạn, đọc hết các đề trong phạm vi"></div></div>' +
      '<p class="small-muted">VCNV lấy nguyên 1 bộ ngẫu nhiên; Tăng tốc giữ đúng dạng câu 1–4 (mỗi vị trí rút từ một đề); phạm vi lấy theo ô thư mục phía trên.</p>' +
      '<div class="bk-act"><button type="button" class="btn btn-gold" id="bkShuffle" data-bk="shuffle">🎲 Trộn đề</button></div></div>' +
      '<div class="exam-load-track hidden" id="bkTrack"><div class="exam-load-fill" id="bkFill"></div></div><div class="exam-load-pct hidden" id="bkPct"></div>' +
      '<div class="bk-act"><button type="button" class="btn btn-outline hidden" id="bkCancel" data-bk="cancel">Hủy</button></div>' +
      '<div class="json-status" id="bkStatus"></div>';

    root.addEventListener('click', function (e) { // một listener duy nhất (event delegation)
      var a = e.target.closest('[data-bk]'), row = e.target.closest('[data-p]');
      if (a) {
        var k = a.getAttribute('data-bk');
        if (k === 'pick' || k === 'mix') setMode(k);
        else if (k === 'reload') { try { sessionStorage.removeItem(CACHE_KEY); } catch (_) { /* */ } S.files = null; refresh(true); }
        else if (k === 'more') { S.shown += PAGE; paintList(); }
        else if (k === 'use') usePick();
        else if (k === 'shuffle') runMix();
        else if (k === 'cancel' && S.job) { S.job.stop = true; if (S.job.ac) S.job.ac.abort(); }
      } else if (row && !S.busy) {
        var old = $('bkList').querySelector('.picked'); if (old) old.classList.remove('picked');
        row.classList.add('picked'); S.sel = row.getAttribute('data-p'); syncUse();
      }
    });
    $('bkSearch').addEventListener('input', function (e) { // debounce: không dựng lại danh sách mỗi phím gõ
      var v = e.target.value; clearTimeout(qTimer);
      qTimer = setTimeout(function () { S.q = v; S.shown = PAGE; paintList(); }, 150);
    });
    $('bkDir').addEventListener('change', function (e) { S.dir = e.target.value; S.shown = PAGE; paintList(); });
    setMode('pick'); syncUse();
  }

  window.__olympiaBank = {
    open: function () {
      var admin = core().isAdmin && core().isAdmin(), root = $('bankMount');
      if (!admin || !root) return; // chỉ admin
      if (!S.ready) { build(root); S.ready = true; }
      if (!S.files) refresh(false);
    }
  };
})();
