// 像素扫描：在 PNG 的一行带里找「金色」列，用来量画框的真实外沿。
// 纯 Node 内置 zlib 解 PNG，不依赖 Pillow / sharp。
//
// 用法: node tools/pixel-scan.mjs <png> <y0> <y1> [span] [side|full]
//   side: left(从左边数 span 列) | right(从右边数) | full(全宽，输出连续段)
//
// 为什么需要它：CSS 里的 --wing-w / --slot-* 只是「内窗」尺寸，
// 背景美术里金框画出来的边还要再往外一截。箭头贴太近就是漏算了这一截。
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，当前 ' + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : -1;
  if (ch < 0) throw new Error('只支持 RGB/RGBA，当前 colorType ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(H * stride);
  let p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
  }
  return { W, H, ch, px: out };
}

const isGold = (r, g, b) => r > 100 && r - b > 36 && g > 62 && g < r + 24;

const [file, y0s, y1s, spans, side] = process.argv.slice(2);
if (!file) { console.error('用法: node tools/pixel-scan.mjs <png> <y0> <y1> [span] [left|right|full]'); process.exit(2); }
const y0 = +y0s, y1 = +y1s, span = +(spans || 300);
const img = decodePNG(readFileSync(file));
const { W, ch, px } = img;
const at = (x, y) => { const i = (y * W + x) * ch; return [px[i], px[i + 1], px[i + 2]]; };

const full = side === 'full';
const xs = full ? [...Array(W).keys()]
  : (side === 'right' ? [...Array(span).keys()].map((i) => W - 1 - i) : [...Array(span).keys()]);

const dens = xs.map((x) => {
  let hit = 0, tot = 0;
  for (let y = y0; y < y1; y += 2) { tot++; const [r, g, b] = at(x, y); if (isGold(r, g, b)) hit++; }
  return { x, hit, ratio: hit / tot };
});

console.log(`${file.split(/[\\/]/).pop()}  W=${W} 带 y=${y0}-${y1} side=${side || 'left'}`);
if (full) {
  const runs = [];
  let start = null;
  for (const d of dens) {
    if (d.ratio >= 0.10) { if (start === null) start = d.x; }
    else if (start !== null) { if (d.x - start >= 3) runs.push(`${start}-${d.x - 1}`); start = null; }
  }
  if (start !== null) runs.push(`${start}-${dens[dens.length - 1].x}`);
  console.log('  金色列连续段(>=3px):', runs.join('  ') || '(无)');
} else {
  const buckets = [];
  for (let s = 0; s < span; s += 10) {
    const tot = dens.filter((d) => d.x >= s && d.x < s + 10).reduce((a, b) => a + b.hit, 0);
    if (tot) buckets.push(`${s}:${tot}`);
  }
  const lit = dens.filter((d) => d.ratio >= 0.10).map((d) => d.x);
  console.log('  金色列数:', lit.length, ' 首=', lit[0] ?? null, ' 末=', lit[lit.length - 1] ?? null);
  console.log('  密度(10px 分桶，键=左侧像素):', buckets.join(' '));
}
