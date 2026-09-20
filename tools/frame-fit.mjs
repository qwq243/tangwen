// 图片必须贴着画框：逐个视口量「画卷里那张图」的矩形 / 裁切 / 偏移，
// 逐个断言，出错就红。**图片位置和大小不许靠肉眼估，一律量出来。**
//
// 断言什么（每一条都是「图片跟随画框」的必要条件）：
//   1. 当前那张图 (imgCurr) 的矩形 ≡ .frame-window 的内窗矩形（dx/dy/dw/dh 都 <= 1px）
//      —— 图比框小会露黑边，比框大会被裁掉一截，都不行；
//   2. strip 的位移 == 恰好一个画框宽 —— 不是的话画框里会露出上一张的半边（一条竖缝）；
//   3. 每张 slide 的份额 == 画框宽（33.333% × 300% 必须整除回原值）；
//   4. 图真的加载出来了（naturalWidth > 0）且不在 pending 态 —— 否则画框里是纯黑；
//   5. 没有被拉伸：object-fit: cover 的缩放因子对两轴一致，且两轴都不小于画框；
//   6. 裁切不过分：正方形封面在任何布局下可见面积不低于 45%（「图被裁成一条」也算错位）。
// 另外跑三组「调整之后」的复测：改视口宽度、换卷、竖横互转 —— 这三条是最容易掉链子的路径。
//
// 用法: node tools/frame-fit.mjs [url]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const OUT = join(PROJ, 'tmp', '_shot');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 三套布局都要覆盖：
   横版（1536×1024 背景）/ 竖版画廊（>= 1.375w+180，见 web/app.js 的两个常量）
   / 紧凑态（矮屏或键盘态）。
   这里的尺寸表是按那一道方程挑的：390×725、354×676 属画廊，360×640 属紧凑 ——
   门槛从 269 降到 180（2026-09-20）之后边界挪了，改门槛要回来对一眼这张表。 */
const VIEWS = [
  { label: 'desktop 1440x900', W: 1440, H: 900 },
  { label: 'laptop 1280x800', W: 1280, H: 800 },
  { label: 'narrow 1024x768', W: 1024, H: 768 },
  { label: 'phone 430x932', W: 430, H: 932 },
  { label: 'phone 390x844', W: 390, H: 844 },
  { label: 'phone 390x725(画廊)', W: 390, H: 725 },
  { label: 'phone 360x640(紧凑)', W: 360, H: 640 },
  { label: 'win 354x676(画廊)', W: 354, H: 676 },
  { label: 'win 440x956(画廊)', W: 440, H: 956 },
  { label: 'win 535x912(画廊)', W: 535, H: 912 },
  { label: 'win 474x1050(画廊)', W: 474, H: 1050 },
  { label: 'phone 390x500(键盘态)', W: 390, H: 500 },
  { label: 'pad 820x1180', W: 820, H: 1180 },
];

const MEASURE = `(function(){
  function cbox(el){
    var r=el.getBoundingClientRect(), cs=getComputedStyle(el);
    var bl=parseFloat(cs.borderLeftWidth)||0, bt=parseFloat(cs.borderTopWidth)||0;
    return {x:r.x+bl, y:r.y+bt, w:el.clientWidth, h:el.clientHeight};
  }
  function rbox(sel){
    var el=document.querySelector(sel); if(!el) return null;
    var r=el.getBoundingClientRect();
    return {x:Math.round(r.x), y:Math.round(r.y), right:Math.round(r.right), bottom:Math.round(r.bottom),
            w:Math.round(r.width), h:Math.round(r.height)};
  }
  var frame=document.querySelector('.frame-window');
  var strip=document.getElementById('strip');
  var img=document.getElementById('imgCurr');
  var cs=getComputedStyle(img);
  var r=img.getBoundingClientRect();
  var m=getComputedStyle(strip).transform;
  var mm=m&&m!=='none'?m.match(/matrix\\(([^)]+)\\)/):null;
  var tx=mm?parseFloat(mm[1].split(',')[4]):0;
  return {
    cls:(document.querySelector('.stage')||{}).className,
    title:(document.getElementById('title')||{}).textContent,
    frame:cbox(frame),
    img:{x:r.x,y:r.y,w:r.width,h:r.height},
    frameW:frame.clientWidth,
    seg:strip.getBoundingClientRect().width/3,
    tx:tx,
    natural:[img.naturalWidth,img.naturalHeight],
    objFit:cs.objectFit, objPos:cs.objectPosition,
    pending:img.classList.contains('pending'),
    src:img.getAttribute('src'),
    lamp:rbox('#lamp'), sound:rbox('#sound'), seal:rbox('.seal'), finder:rbox('.finder'),
    wingL:rbox('.wing.left'), wingR:rbox('.wing.right'),
    errs:(window.__errs||[]).slice(0,4)
  };
})()`;

const fails = [];
let checks = 0;
const check = (ok, what, detail) => {
  checks++;
  if (!ok) fails.push(what + (detail ? ' — ' + detail : ''));
  return ok;
};

/* 一次量的结果 -> 一组断言。返回一行摘要 */
function judge(m, tag) {
  const f = m.frame, i = m.img;
  const dx = +(i.x - f.x).toFixed(2), dy = +(i.y - f.y).toFixed(2);
  const dw = +(i.w - f.w).toFixed(2), dh = +(i.h - f.h).toFixed(2);
  const off = +(m.tx + m.frameW).toFixed(2);
  const seg = +(m.seg - m.frameW).toFixed(2);
  const [nw, nh] = m.natural;
  const scale = nw && nh ? Math.max(i.w / nw, i.h / nh) : 0;
  const cw = scale * nw, chh = scale * nh;
  const fills = nw > 0 && cw >= i.w - 1.2 && chh >= i.h - 1.2;
  const flush = nw > 0 && (Math.abs(cw - i.w) < 1.2 || Math.abs(chh - i.h) < 1.2);
  const vis = nw && nh ? (Math.min(cw, i.w) / cw) * (Math.min(chh, i.h) / chh) : 0;

  check(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, `${tag} 图与画框同原点`, `dx=${dx} dy=${dy}`);
  check(Math.abs(dw) <= 1 && Math.abs(dh) <= 1, `${tag} 图与画框同尺寸`, `dw=${dw} dh=${dh}`);
  check(Math.abs(off) <= 0.6, `${tag} 滑动偏移 == 一个画框宽`, `off=${off}`);
  check(Math.abs(seg) <= 0.6, `${tag} 单张份额 == 画框宽`, `seg=${seg}`);
  check(nw > 0, `${tag} 封面已加载`, m.src ? m.src.split('/').pop() : 'src=null');
  check(!m.pending, `${tag} 不是 pending 灰态`);
  check(m.objFit === 'cover', `${tag} object-fit 是 cover`, m.objFit);
  check(fills && flush, `${tag} cover 没拉伸且填满`, `scale=${scale.toFixed(4)}`);
  check(vis >= 0.45, `${tag} 裁切不过分`, `可见=${(vis * 100).toFixed(0)}%`);
  check(m.errs.length === 0, `${tag} 无 JS 报错`, JSON.stringify(m.errs));

  /* 顶部控件不许压侧墙画框：灯/声音/搜索/印章落进左右墙的内窗，
     看着就像「一张贴错的图」（用户在 474×1050 抓到的就是灯压住了框沿）。
     紧凑态侧墙整个 display:none，量到 0×0，跳过。 */
  const walls = [['左墙', m.wingL], ['右墙', m.wingR]].filter(([, w]) => w && w.w > 5 && w.h > 5);
  if (walls.length) {
    const hits = [];
    for (const [what, el] of [['灯', m.lamp], ['声音', m.sound], ['搜索', m.finder], ['印章', m.seal]]) {
      if (!el || el.w < 5 || el.h < 5) continue;
      for (const [wn, w] of walls) {
        const ox = Math.min(el.right, w.right) - Math.max(el.x, w.x);
        const oy = Math.min(el.bottom, w.bottom) - Math.max(el.y, w.y);
        if (ox > 2 && oy > 2) hits.push(`${what}×${wn} 重叠 ${ox.toFixed(0)}x${oy.toFixed(0)}`);
      }
    }
    check(hits.length === 0, `${tag} 顶部控件不压侧墙画框`, hits.join('，') || '干净');
  }
  return `  ${(m.cls.replace('stage', '').trim() || '画横版').padEnd(14)} 框 ${f.w.toFixed(0)}×${f.h.toFixed(0)}`
    + `  图 ${i.w.toFixed(0)}×${i.h.toFixed(0)}  d=${dx}/${dy}/${dw}/${dh}  裁切可见 ${(vis * 100).toFixed(0)}%  ${m.title}`;
}

const PORT = 9721;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'ffit_' + Date.now())}`,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

const waitFor = async (fn) => {
  const t0 = Date.now();
  for (;;) { try { const r = await fn(); if (r) return r; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 20000) throw new Error('Chrome 调试端口 20s 没起来'); await sleep(200); }
};
await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? rej(new Error(method + ' ' + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const shotTo = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64'));
};
const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
const measure = async () => {
  const m = await ev(MEASURE);
  return m;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" });

console.log('=== A. 逐视口：图必须贴在画框里 ===');
for (const v of VIEWS) {
  await size(v.W, v.H);
  await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
  await sleep(4200);
  const m = await measure();
  console.log(judge(m, v.label));
}

console.log('\n=== B. 调整之后（最易掉链子的三条路径）===');
await size(390, 844);
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4200);
console.log(judge(await measure(), 'B0 基线 390x844'));

// B1 只改宽度（画卷宽度 = 滑动步长，宽度变了不重算就会露出上一张的半边）
await size(430, 844); await sleep(1200);
console.log(judge(await measure(), 'B1 加宽到 430'));
await size(390, 844); await sleep(1200);
console.log(judge(await measure(), 'B1 收回 390'));

// B2 换卷（换卷要重新上三张图 + 重新落偏移）
await ev("document.getElementById('next').click()"); await sleep(1500);
console.log(judge(await measure(), 'B2 换到下一卷'));
await ev("document.getElementById('next').click()"); await sleep(1500);
console.log(judge(await measure(), 'B2 再换一卷'));

// B3 竖横互转
await size(844, 390); await sleep(1400);
console.log(judge(await measure(), 'B3 转成横屏'));
await size(390, 844); await sleep(1400);
console.log(judge(await measure(), 'B3 转回竖屏'));

// B4 键盘态（紧凑）+ 收起键盘
await size(390, 500); await sleep(1400);
console.log(judge(await measure(), 'B4 键盘态 390x500'));
await size(390, 844); await sleep(1400);
console.log(judge(await measure(), 'B4 键盘收起'));

console.log('\n=== C. 逐卷换过去量一遍（每卷封面都不一样，宽的高壮的都得贴住）===');
const count = await ev("fetch('/api/puzzles').then(r=>r.json()).then(d=>d.puzzles.length)");
console.log(`  共 ${count} 卷：每换一卷都重新量「图 vs 框」`);
await size(390, 844);
await sleep(1200);
let worstCrop = 1, worstAt = '';
let badCount = 0;
for (let i = 0; i < count; i++) {
  await ev("document.getElementById('next').click()");
  await sleep(900);
  const m = await measure();
  const dx = Math.abs(m.img.x - m.frame.x), dy = Math.abs(m.img.y - m.frame.y);
  const dw = Math.abs(m.img.w - m.frame.w), dh = Math.abs(m.img.h - m.frame.h);
  const [nw, nh] = m.natural;
  const scale = nw && nh ? Math.max(m.img.w / nw, m.img.h / nh) : 0;
  const vis = nw && nh ? (Math.min(scale * nw, m.img.w) / (scale * nw)) * (Math.min(scale * nh, m.img.h) / (scale * nh)) : 0;
  const bad = [];
  checks++;
  if (dx > 1 || dy > 1 || dw > 1 || dh > 1) bad.push(`d=${dx.toFixed(1)}/${dy.toFixed(1)}/${dw.toFixed(1)}/${dh.toFixed(1)}`);
  if (nw === 0) bad.push('封面没加载 ' + (m.src || 'null'));
  if (m.pending) bad.push('还在 pending 灰态');
  if (Math.abs(m.tx + m.frameW) > 0.6) bad.push(`偏移 ${(m.tx + m.frameW).toFixed(2)}`);
  if (vis < 0.45) bad.push(`裁切只剩 ${(vis * 100).toFixed(0)}%`);
  if (vis < worstCrop) { worstCrop = vis; worstAt = m.title; }
  if (bad.length) { badCount++; console.log(`  ✗ 第 ${String(i + 1).padStart(2, '0')} 卷 ${m.title}  ${bad.join('  ')}`); fails.push(`第 ${i + 1} 卷 ${m.title}: ${bad.join(' ')}`); }
}
console.log(badCount ? `  ${badCount} 卷有问题（见上）` : `  ✓ ${count} 卷全部贴住`);
console.log(`  最狠的一次裁切：${(worstCrop * 100).toFixed(0)}%（${worstAt}）`);
if (worstCrop < 0.45) fails.push('存在裁切过分的封面');

console.log('');
if (fails.length) {
  console.log(`[FAIL] ${fails.length} / ${checks} 项没过：`);
  fails.slice(0, 40).forEach((f) => console.log('   - ' + f));
} else {
  console.log(`[OK] 全部通过（${checks} 项断言）—— 任何视口 / 布局 / 调整之后，图片都严丝合缝贴在画框里`);
}
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
