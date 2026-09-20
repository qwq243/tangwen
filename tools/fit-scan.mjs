// 竖屏尺寸扫描：判断「这块屏幕够不够撑开画廊」。
// 关键是要在记录面板装满的状态下量 —— 空面板只有 114px，问几轮会长到上限，
// 而竖版画廊上半按 vw 锚、底部按 vh 锚，装满了才撞（历史上 dossier × heard 就是这么来的）。
//
// 用法：node tools/fit-scan.mjs [url]
// 判题要出网，默认拦掉 /api/ask 造假回答（见 mobile-check.mjs 的说明）；
// 加 --real-ask 走真接口。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tmp', '_shot');
const REAL_ASK = process.argv.includes('--real-ask');
const URL = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'http://127.0.0.1:8765/';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

// app.js 里的门槛：H >= 1.375w + 180 才用画廊（由 --slot / .read / .dossier 那几条
// CSS 常量解出来）。**这两个数必须和 web/app.js 的 GALLERY_MIN_RATIO / GALLERY_MIN_PAD 一致**，
// 它是抄过来的一份 —— 2026-09-20 门槛从 269 降到 180（小屏也要画框）时这里没跟着改，
// 于是 360×740 / 390×780 被报成「该紧凑却走了画廊」，白红了一轮。
const GALLERY_MIN_RATIO = 1.375;
const GALLERY_MIN_PAD = 180;

const PROBE = `(function(){
  function box(sel){ var e=document.querySelector(sel); if(!e) return null;
    var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') return {hidden:true};
    var r=e.getBoundingClientRect();
    return {x:Math.round(r.x),right:Math.round(r.right),y:Math.round(r.y),bottom:Math.round(r.bottom),h:Math.round(r.height)}; }
  var sel={plaque:'.plaque',win:'.frame-window',read:'.read',dossier:'.dossier',
           heard:'.heard',status:'.status',dock:'.dock'};
  var b={}; Object.keys(sel).forEach(function(k){ b[k]=box(sel[k]); });
  var watch=['plaque','win','read','dossier','heard','status','dock'];
  var arr=watch.map(function(k){ return [k,b[k]]; }).filter(function(p){ return p[1]&&!p[1].hidden; });
  var overlaps=[];
  for (var i=0;i<arr.length;i++) for (var j=i+1;j<arr.length;j++){
    var a=arr[i][1], c=arr[j][1];
    if (a.bottom > c.y+1 && a.y < c.bottom-1 && a.right > c.x+1 && a.x < c.right-1)
      overlaps.push(arr[i][0]+' × '+arr[j][0]);
  }
  var stage=document.querySelector('.stage');
  return { cls: stage.className, vw: innerWidth, vh: innerHeight,
           turns: document.querySelectorAll('.ledger li').length, boxes: b, overlaps: overlaps };
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'fit_' + PORT)}`,
  '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

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
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

await send('Page.enable'); await send('Runtime.enable');
// 跳过入馆引导，否则它盖在页面上，量到的和截到的都是那张卡片
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
if (!REAL_ASK) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (function(){ var of = window.fetch;
      window.fetch = function(input, init){
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/ask') < 0) return of.apply(this, arguments);
        return Promise.resolve(new Response(JSON.stringify({ ok:true, label:'是', verdict:'yes',
          latency_ms: 412, unlocked:[], keys:[], solved:false }),
          { status:200, headers:{'Content-Type':'application/json'} })); }; })();` });
}

const CASES = [
  [320, 568], [360, 640], [375, 667], [360, 740], [375, 812], [390, 780],
  [390, 844], [412, 915], [430, 932], [360, 800],
  [400, 600], [480, 720], [600, 800], [768, 1024], [820, 1180],
];
const QS = ['妹妹是被杀的吗', '她死在房间里吗', '和保安有关系吗', '房门是虚掩的吗', '她当时还活着吗'];

const bad = [];
for (const [w, h] of CASES) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
  await sleep(3800);
  for (let i = 0; i < QS.length; i++) {
    await ev(`(function(){ var el=document.getElementById('typed'); el.value=${JSON.stringify(QS[i])};
      document.getElementById('typeLine').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1; })()`);
    await sleep(800);
  }
  const r = await ev(PROBE);
  const compact = /compact/.test(r.cls);
  const need = Math.round(w * GALLERY_MIN_RATIO + GALLERY_MIN_PAD);
  const shouldCompact = h < need;
  const room = (r.boxes.dossier && !r.boxes.dossier.hidden) ? r.boxes.dossier.h : 0;
  const ok = r.overlaps.length === 0 && compact === shouldCompact;
  console.log(`${ok ? '✓' : '✗'} ${String(w + 'x' + h).padEnd(9)} 比 ${(h / w).toFixed(3)}  门槛 ${need}  ` +
    `${compact ? '紧凑' : '画廊'}  记录区 ${String(room).padStart(3)}  重叠=${JSON.stringify(r.overlaps)}`);
  if (!ok) {
    bad.push(`${w}x${h}`);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `fit_bad_${w}x${h}.png`), Buffer.from(s.data, 'base64'));
  }
}
console.log('');
console.log(bad.length ? `[FAIL] 有问题的尺寸：${bad.join(', ')}` : '[OK] 全部尺寸：判定符合门槛、零重叠');
ws.close(); chrome.kill();
process.exit(bad.length ? 1 : 0);
