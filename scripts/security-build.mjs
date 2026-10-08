#!/usr/bin/env node
/*
 * security-build.mjs — SINH FILE `_headers` (CSP + các header bảo mật) CHO NETLIFY
 * ---------------------------------------------------------------------------------
 * Không cần cài thêm gì (chỉ dùng Node có sẵn). Chạy:   node scripts/security-build.mjs
 * Netlify tự chạy file này mỗi lần deploy (xem netlify.toml) nên bạn KHÔNG phải nhớ gì cả.
 *
 * VÌ SAO CẦN FILE NÀY?
 *   Chính sách CSP (Content-Security-Policy) bảo vệ web khỏi XSS bằng cách chỉ cho chạy những
 *   <script> đã được "ký" (hash SHA-256). index.html / admin.html của bạn có nhiều khối <script>
 *   viết thẳng trong HTML; mỗi lần bạn sửa chữ nào trong đó thì hash đổi. Script này tự tính lại
 *   hash cho đúng từng khối rồi ghi vào `_headers`, nhờ vậy bạn vẫn sửa index.html như bình thường.
 *
 * NÓ KHÔNG SỬA index.html / admin.html — chỉ ĐỌC chúng và GHI `_headers`.
 * Nếu phát hiện điều gì sẽ làm web hỏng (thư viện sai SRI, script ngoài không được phép...) nó
 * DỪNG và báo lỗi → Netlify giữ nguyên bản đang chạy tốt, web không bao giờ bị hỏng vì nó.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/* ---------------------------------------------------------------------------------
 * CẤU HÌNH — chỉ cần đổi ở đây nếu bạn đổi project Supabase / thêm tên miền riêng.
 * ------------------------------------------------------------------------------- */
const SUPABASE_HOST = 'xaajtrmlwzqhzrgdanjy.supabase.co';

/* Các trình xử lý sự kiện nằm thẳng trong thuộc tính HTML (onload=, onerror=...) mà web đang dùng.
 * Chúng được "ký" từng cái một (chỉ đúng nguyên văn này mới chạy được) thay vì mở toang 'unsafe-inline'.
 *  - onload  : thẻ <link> nạp Google Fonts không chặn trang (có trong HTML, tự dò ra bên dưới).
 *  - onerror : ảnh minh hoạ ở phần "Tổng kết" — chuỗi này nằm trong mã JS nên khai báo sẵn ở `dynamicHandlers`. */
const PAGES = [
  {
    file: 'index.html',
    paths: ['/', '/index.html', '/index'],
    dynamicHandlers: ["this.style.display='none';this.nextElementSibling.style.display='flex';"],
    // Trang thi: đề cho phép dán ảnh từ website bất kỳ (web tải lại để nén) + nhạc giải lao => cần https:/data:/blob:.
    connectExtra: 'https: data: blob:',
    mediaSrc: "'self' blob: data: https:",
  },
  {
    // Trang admin chặt hơn: chỉ nói chuyện với Supabase, không có nhạc/âm thanh.
    file: 'admin.html',
    paths: ['/admin.html', '/admin'],
    dynamicHandlers: [],
    connectExtra: '',
    mediaSrc: '',
  },
];

/* ---------------------------------------------------------------------------------
 * Tiện ích
 * ------------------------------------------------------------------------------- */
const sha = (algo, data) => createHash(algo).update(data).digest('base64');
const fail = (msg) => { console.error('\n❌ ' + msg + '\n'); process.exit(1); };
const warn = (msg) => console.warn('⚠️  ' + msg);

function decodeEntities(v) {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* Tách các thẻ <script> theo đúng cách trình duyệt làm: nội dung kết thúc ở </script gặp đầu tiên. */
function extractScripts(html) {
  const out = [];
  const openRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const attrs = m[1];
    const bodyStart = openRe.lastIndex;
    const closeRe = /<\/script[\s/>]/gi;
    closeRe.lastIndex = bodyStart;
    const c = closeRe.exec(html);
    if (!c) fail('Có thẻ <script> không đóng trong HTML.');
    const body = html.slice(bodyStart, c.index);
    out.push({ attrs, body, src: /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(' ' + attrs) });
    openRe.lastIndex = c.index;
  }
  return out;
}

const isExecutableType = (attrs) => {
  const t = /\stype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(' ' + attrs);
  if (!t) return true;
  const v = (t[2] ?? t[3] ?? t[4] ?? '').trim().toLowerCase();
  return v === '' || v === 'module' || v === 'text/javascript' || v === 'application/javascript';
};

function staticHandlerValues(html) {
  // Thuộc tính on...="..." ở các thẻ HTML thật (không nằm trong <script>/<style>).
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[\s/>]/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[\s/>]/gi, '<style></style>');
  const vals = [];
  const re = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(stripped))) vals.push(decodeEntities(m[1] ?? m[2]));
  return vals;
}

/* Cảnh báo nếu mã JS tạo ra HTML có onclick=/onerror=... mà chưa được khai báo (sẽ bị CSP chặn). */
function dynamicHandlerWarnings(html, allowed) {
  const found = new Set();
  const re = /\bon(?:click|dblclick|error|load|change|input|submit|keydown|keyup|keypress|focus|blur|mouseover|mouseout|mousedown|mouseup|touchstart|touchend|toggle|scroll|wheel|contextmenu|dragstart|drop|paste|copy)\s*=\s*\\?["']/gi;
  let m;
  while ((m = re.exec(html))) found.add(html.slice(m.index, m.index + 160).replace(/\\/g, '').replace(/\s+/g, ' '));
  const known = [...allowed].map((a) => a.replace(/\s+/g, ' '));
  return [...found].filter((s) => !known.some((a) => s.includes(a)));
}

/* ---------------------------------------------------------------------------------
 * Kiểm tra thư viện cục bộ (SRI)
 * ------------------------------------------------------------------------------- */
function verifyLocalScripts(pageName, scripts) {
  for (const s of scripts) {
    if (!s.src) continue;
    const url = s.src[2] ?? s.src[3] ?? s.src[4];
    if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
      fail(`${pageName}: có <script src="${url}"> tải từ website khác. CSP chỉ cho phép script cùng domain ` +
           `('self'). Hãy tải file đó về thư mục vendor/ (xem hướng dẫn) hoặc thêm domain vào script-src có chủ đích.`);
    }
    const rel = url.split(/[?#]/)[0].replace(/^\//, '');
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) fail(`${pageName}: không thấy file ${rel} (được tham chiếu bởi <script src="${url}">).`);
    const integ = /\sintegrity\s*=\s*"([^"]+)"/i.exec(' ' + s.attrs);
    if (integ) {
      const [algo, expected] = integ[1].split('-');
      const actual = sha(algo, readFileSync(abs));
      if (expected !== actual) {
        fail(`${pageName}: SRI của ${rel} KHÔNG khớp nội dung file (trình duyệt sẽ chặn nó).\n` +
             `   đang ghi : ${integ[1]}\n   đúng là  : ${algo}-${actual}`);
      }
    } else {
      warn(`${pageName}: ${rel} chưa có thuộc tính integrity (SRI).`);
    }
  }
}

/* ---------------------------------------------------------------------------------
 * Dựng CSP cho từng trang
 * ------------------------------------------------------------------------------- */
function buildCsp({ scriptHashes, handlerHashes, page }) {
  const sb = SUPABASE_HOST;
  const d = [
    ["default-src", "'none'"],
    ["base-uri", "'self'"],
    // Supabase (REST, Auth, Storage, Edge Functions) + Realtime (websocket). Phần `connectExtra` của
    // từng trang: trang thi cần https:/data:/blob: (ảnh đề dán từ website khác); admin thì không.
    ["connect-src", `'self' https://${sb} wss://${sb} ${page.connectExtra}`.trim()],
    ["font-src", "'self' https://fonts.gstatic.com data:"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["img-src", "'self' data: blob: https:"],
    ["manifest-src", "'self'"],
    ["media-src", page.mediaSrc || "'none'"],
    ["object-src", "'none'"],
    ["script-src", ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(' ')],
    ["script-src-attr", handlerHashes.length
      ? ["'unsafe-hashes'", ...handlerHashes.map((h) => `'sha256-${h}'`)].join(' ')
      : "'none'"],
    ["style-src", "'self' 'unsafe-inline' https://fonts.googleapis.com"],
    ["worker-src", "'self' blob:"],
    ["upgrade-insecure-requests", ""],
  ];
  return d.map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');
}

/* Permissions-Policy: chỉ TẮT các tính năng web KHÔNG dùng (web đang dùng toàn màn hình, clipboard,
 * wake-lock, rung, âm thanh nên các mục đó được để nguyên). */
const PERMISSIONS_POLICY = [
  'accelerometer=()', 'browsing-topics=()', 'camera=()', 'display-capture=()', 'geolocation=()',
  'gyroscope=()', 'hid=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
  'serial=()', 'usb=()', 'xr-spatial-tracking=()',
].join(', ');

const COMMON_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Permissions-Policy', PERMISSIONS_POLICY],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
];

/* ---------------------------------------------------------------------------------
 * Chạy
 * ------------------------------------------------------------------------------- */
const rules = [];
for (const page of PAGES) {
  const abs = join(ROOT, page.file);
  if (!existsSync(abs)) { warn(`Không thấy ${page.file} — bỏ qua.`); continue; }
  const html = readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n'); // trình duyệt chuẩn hoá xuống dòng trước khi băm
  const scripts = extractScripts(html);

  verifyLocalScripts(page.file, scripts);

  const inline = scripts.filter((s) => !s.src && isExecutableType(s.attrs) && s.body.trim() !== '');
  const scriptHashes = [...new Set(inline.map((s) => sha('sha256', s.body)))];

  const handlers = [...new Set([...staticHandlerValues(html), ...page.dynamicHandlers])];
  const handlerHashes = handlers.map((h) => sha('sha256', h));

  const stray = dynamicHandlerWarnings(html, handlers);
  for (const s of stray) warn(`${page.file}: có thuộc tính sự kiện chưa được khai báo: "${s}…" — sẽ bị CSP chặn.`);

  const csp = buildCsp({ scriptHashes, handlerHashes, page });
  for (const p of page.paths) rules.push({ path: p, headers: [['Content-Security-Policy', csp]] });
  console.log(`✔ ${page.file}: ${inline.length} khối <script> inline → ${scriptHashes.length} hash; ` +
              `${handlers.length} trình xử lý sự kiện; CSP dài ${csp.length} ký tự.`);
}

let out = '# =====================================================================\n' +
          '# FILE NÀY ĐƯỢC SINH TỰ ĐỘNG bởi scripts/security-build.mjs — ĐỪNG SỬA TAY.\n' +
          '# (Netlify chạy lại script mỗi lần deploy; muốn đổi cấu hình hãy sửa script.)\n' +
          '# =====================================================================\n\n';
out += '/*\n' + COMMON_HEADERS.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n';
for (const r of rules) out += r.path + '\n' + r.headers.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n';
out += '/vendor/*\n  Cache-Control: public, max-age=31536000, immutable\n';

const target = join(ROOT, '_headers');
if (CHECK_ONLY) {
  const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (cur !== out) fail('`_headers` đang lỗi thời so với index.html/admin.html. Chạy: node scripts/security-build.mjs');
  console.log('✔ _headers khớp với mã nguồn hiện tại.');
} else {
  writeFileSync(target, out);
  console.log(`✔ Đã ghi ${target}`);
}
