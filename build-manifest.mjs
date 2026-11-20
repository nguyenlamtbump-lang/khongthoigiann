#!/usr/bin/env node
/*
 * build-manifest.mjs — TỰ SINH `assets-manifest.json` (danh sách tài nguyên cho preload.js)
 * ---------------------------------------------------------------------------------
 * Chạy:   node scripts/build-manifest.mjs          (ghi lại assets-manifest.json)
 *         node scripts/build-manifest.mjs --check  (chỉ kiểm tra, báo lỗi nếu manifest đã cũ)
 *
 * Quét thư mục gốc của web + vendor/, mỗi file ghi: u (đường dẫn), n (tên hiển thị trên màn hình tải),
 * v (mã băm nội dung → file đổi thì v đổi), s (kích thước, để vẽ thanh tiến độ).
 * Không cần chạy script này để web nhận bản mới: preload.js còn tự so ETag với máy chủ. Chạy nó chỉ để
 * danh sách/tên/kích thước luôn đúng và có mã v. Tên hiển thị cũ trong manifest được giữ nguyên; muốn đặt tên cho file mới
 * thì thêm vào bảng NAMES bên dưới.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets-manifest.json');
const CHECK = process.argv.includes('--check');

const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.js', '.css', '.woff2', '.mp3', '.ogg', '.html']);
// Không đưa vào danh sách: trang luôn lấy mới từ máy chủ, và chính các file điều khiển việc cache.
const SKIP = new Set(['index.html', 'admin.html', 'sw.js', 'preload.js', 'assets-manifest.json']);
const DIRS = ['', 'vendor'];   // thêm thư mục tài nguyên mới vào đây (vd 'sounds')

const NAMES = {
  'auth-logo.jpg': 'Logo đăng nhập', 'logo.jpg': 'Logo', 'favicon.png': 'Biểu tượng', 'hero.jpg': 'Ảnh bìa',
  'ranked-hero-bg.webp': 'Ảnh đấu hạng', 'ranked-hero-bg-sm.webp': 'Ảnh đấu hạng (nhỏ)', 'huyhieu.html': 'Huy hiệu',
  'giaodien.html': 'Hiệu ứng tin nhắn & giao diện', 'banner-ngay-le.html': 'Banner ngày lễ', 'nganhang.js': 'Ngân hàng câu hỏi',
};

let old = {};
try { for (const a of JSON.parse(readFileSync(OUT, 'utf8')).assets || []) old[a.u] = a; } catch {}

const assets = [];
for (const d of DIRS) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (!statSync(p).isFile() || !EXT.has(extname(f).toLowerCase()) || (d === '' && SKIP.has(f))) continue;
    const u = d ? `${d}/${f}` : f, buf = readFileSync(p);
    assets.push({
      u,
      n: NAMES[u] || old[u]?.n || (/^vendor\//.test(u) ? 'Thư viện ' + f.replace(/[-.][\d.]+.*$/, '') : f),
      v: createHash('sha256').update(buf).digest('hex').slice(0, 10),
      s: buf.length,
    });
  }
}

const text = '{\n "assets": [\n' + assets.map((a) => '  ' + JSON.stringify(a)).join(',\n') + '\n ]\n}\n';
if (CHECK) {
  if (existsSync(OUT) && readFileSync(OUT, 'utf8') === text) { console.log('✅ assets-manifest.json đã đúng.'); process.exit(0); }
  console.error('❌ assets-manifest.json đã cũ — chạy: node scripts/build-manifest.mjs'); process.exit(1);
}
writeFileSync(OUT, text);
console.log(`✅ Đã ghi ${assets.length} tài nguyên vào assets-manifest.json`);
for (const a of assets) console.log('  ' + a.u.padEnd(40) + String(a.s).padStart(9) + '  ' + a.v);
