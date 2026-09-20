// 竖屏「可用高度」扫描：紧凑态六段各占多高、空白落在哪、画廊态在哪一档开始撞。
//
// 为什么要扫这个：手机在微信/QQ 里打开时，webview 高度 ≠ 屏高
// （要去掉状态栏 + 顶部导航 + 底部工具栏，通常只有 730 左右），
// 而 GALLERY_MIN_RATIO 的门槛是按「满屏」推的 —— 需要看清真实落到哪一档。
//
// 用法: node tools/compact-scan.mjs [url]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const OUT = join(PROJ, 'tmp', '_shot');
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9879;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 390/412/430 是三种常见 CSS 宽；每个宽度扫「满屏 -> 微信里那种被压掉一截」的几档
// 354×676 / 440×956：2026-09-20 画廊门槛降到 +180 后新覆盖的两档（用户实抓的尺寸）
const VIEWS = [
  { W: 354, H: 676, tag: '354x676 窄窗画廊' },
  { W: 390, H: 844, tag: '390x844 满屏' },
  { W: 390, H: 800, tag: '390x800 去掉状态栏' },
  { W: 390, H: 780, tag: '390x780' },
  { W: 390, H: 730, tag: '390x730 微信典型' },
  { W: 390, H: 660, tag: '390x660 微信+工具栏' },
  { W: 412, H: 780, tag: '412x780 微信典型' },
  { W: 430, H: 760, tag: '430x760 微信典型' },
  { W: 440, H: 956, tag: '440x956 画廊' },
  { W: 360, H: 640, tag: '360x640 小屏' },
];

const PROBE = `(function(){
  function box(sel){ var e=document.querySelector(sel); if(!e) return null;
    var cs=getComputedStyle(e);
    if(cs.display==='none'||e.hidden) return null;
    var r=e.getBoundingClientRect();
    if(r.height<1) return null;
    return {y:Math.round(r.y),bottom:Math.round(r.bottom),h:Math.round(r.height),
            x:Math.round(r.x),w:Math.round(r.width)}; }
  var stage=document.querySelector('.stage');
  var read=document.querySelector('.read');
  var surf=document.getElementById('surface');
  var s=box('.stage'), pl=box('.plaque'), fw=box('.frame-window'),
      rd=box('.read'), sf=box('#surface'), doo=box('.dossier'),
      st=box('.status'), dk=box('.dock');
  // 汤面在阅读区里的上下留白（紧凑态是 margin:auto 居中，这就是那两条空带）
  var padTop = (rd && sf) ? sf.y - rd.y : null;
  var padBot = (rd && sf) ? rd.bottom - sf.bottom : null;
  var out = { cls: stage.className, vw: innerWidth, vh: innerHeight,
              title: (document.getElementById('title')||{}).textContent,
              stage:s, plaque:pl, frame:fw, read:rd, surface:sf, dossier:doo,
              dooMax: (function(){ var el=document.querySelector('.dossier');
                       return el ? parseFloat(getComputedStyle(el).maxHeight)||0 : null; })(),
              status:st, dock:dk, padTop:padTop, padBot:padBot,
              surfPx: sf ? parseFloat(getComputedStyle(surf).fontSize) : null,
              errs:(window.__errs||[]).slice(0,4) };
  // 相邻两段之间的空档（只在两段都存在时算）
  out.gaps = (function(){
    var seq=[['plaque',pl],['frame',fw],['read',rd],['dossier',doo],['status',st],['dock',dk]];
    var live=seq.filter(function(p){return p[1];});
    var g={};
    for (var i=0;i+1<live.length;i++){
      var a=live[i][1], b=live[i+1][1];
      var v=b.y-a.bottom;
      if (Math.abs(v)>1) g[live[i][0]+'->'+live[i+1][0]]=v;
    }
    return g;
  })();
  return out;
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP || '/tmp', 'cs_' + Date.now())}`,
  '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

const waitFor = async (fn) => {
  const t0 = Date.now();
  for (;;) { try { const r = await fn(); if (r) return r; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 20000) throw new Error('Chrome 调试端口没起来'); await sleep(200); }
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
let __evalErrShown = 0;
const ev = async (e) => {
  const m = await send('Runtime.evaluate',
    { expression: e, returnByValue: true, awaitPromise: true });
  if (m.exceptionDetails && __evalErrShown < 3) {
    __evalErrShown++;
    console.log('  [eval 异常] ' + String(
      (m.exceptionDetails.exception && m.exceptionDetails.exception.description) ||
      m.exceptionDetails.text).slice(0, 400));
  }
  return m.result?.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64'));
};

await send('Page.enable'); await send('Runtime.enable');
// 跳过入馆引导，否则它盖在页面上，量到的和截到的都是那张卡片
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" +
  "var __ce=console.error;console.error=function(){window.__errs.push('CONSOLE:'+Array.prototype.join.call(arguments,' '));__ce.apply(console,arguments)};" });
// 拦判题，免得沙箱里出网失败
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){ var of=window.fetch;
    window.fetch = function(input, init){
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/ask') < 0) return of.apply(this, arguments);
      return Promise.resolve(new Response(JSON.stringify({ ok:true, label:'不是', verdict:'no',
        latency_ms:214, unlocked:[], keys:[], solved:false }),
        { status:200, headers:{'Content-Type':'application/json'} }));
    }; })();` });
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
// 就绪等待：机器一忙（并发跑几个探针）4.5s 可能还没跑完 app.js 的启动，
// 探针在 about:blank 上求值会返回 undefined。等到 .stage 真能量了再进循环。
for (let i = 0; i < 40; i++) {
  const ok = await ev("document.readyState === 'complete' && !!document.querySelector('.stage') && !!document.getElementById('surface')");
  if (ok) break;
  await sleep(500);
}

let f = [];
for (const v of VIEWS) {
  await send('Emulation.setDeviceMetricsOverride', { width: v.W, height: v.H, deviceScaleFactor: 1, mobile: true });
  await sleep(1000);
  let r = null;
  for (let i = 0; i < 12 && !r; i++) { r = await ev(PROBE); if (!r) await sleep(600); }
  if (!r) { f.push(`${v.tag}: 页面没就绪，探针拿不到数据`); continue; }
  const compact = /compact/.test(r.cls);
  console.log(`\n=== ${v.tag}   ${r.cls}  vh=${r.vh}`);
  console.log(`  ${compact ? '紧凑' : '画廊'}   plaque ${r.plaque ? r.plaque.h : '-'} / frame ${r.frame ? r.frame.h : '-'} / read ${r.read ? r.read.h : '-'} / dossier ${r.dossier ? r.dossier.h : '-'} / dock ${r.dock ? r.dock.h : '-'}`);
  console.log(`  汤面在阅读区里的留白: 上 ${r.padTop}  下 ${r.padBot}   汤面字号 ${r.surfPx}px`);
  console.log(`  段间空档: ${JSON.stringify(r.gaps)}`);
  if (r.errs && r.errs.length) console.log('  ⚠ ' + JSON.stringify(r.errs));
  await shot(`cs_${v.W}x${v.H}.png`);

  if (!compact) {
    /* 画廊态也要有底线：底部那摞（记录面板/状态/输入条）是 bottom 锚定的，
       屏幕一矮记录面板就会往上顶汤面 —— 门槛（GALLERY_MIN_PAD）+ 面板保底
       （.stage.tall .dossier 的 max(64px, ...)）是同一道方程，两头不同步就会撞。
       面板空着时量不出问题，这里按 max-height 上限算「长满记录时面板头会顶到哪」：
       capTop = 面板底边 - max-height，必须还压不到汤面底。 */
    if (r.dossier && r.read) {
      var capTop = r.dossier.bottom - (r.dooMax || 0);
      if (capTop < r.read.bottom - 1) {
        f.push(`${v.tag}: 画廊态记录面板(上限 ${r.dooMax}px)长满会压汤面 ${(r.read.bottom - capTop).toFixed(0)}px`);
      }
    }
    if (r.dock && r.read && r.dock.y < r.read.bottom - 1) {
      f.push(`${v.tag}: 画廊态输入条压住汤面 ${(r.read.bottom - r.dock.y).toFixed(0)}px`);
    }
    continue;
  }

  /* 紧凑态的几条不变量 —— 都是踩过坑才定下来的，改 CSS 后跑这一遍：
     1. 六段不许互相压住。负的段间空档就是重叠，手机上会看到两块内容糊在一起。
     2. 画卷得真像一幅画，不能退化成一条横幅（曾经固定 min(38vw,32%)，390 宽只有 148px）。
     3. 汤面字号不许缩回 14px 以下：14px 宋体在手机上偏小，是「汤面字很小」的由来。
     4. 画卷上下的两个 auto 外边距要对分富余（「画卷 + 汤面」作为一整块居中），
        差太多说明有别的元素在抢富余。 */
  for (const [k, val] of Object.entries(r.gaps)) {
    if (val < -1) f.push(`${v.tag}: 段间重叠 ${k} ${val}px`);
  }
  if (r.frame && r.frame.h < r.vh * 0.28) f.push(`${v.tag}: 画卷只剩 ${r.frame.h}px（< 28%vh），退化成横幅了`);
  if (r.surfPx != null && r.surfPx < 16) f.push(`${v.tag}: 汤面字号 ${r.surfPx}px，偏小`);
  const gt = r.gaps['plaque->frame'], gb = r.gaps['read->dossier'];
  if (gt != null && gb != null && Math.abs(gt - gb) > 4) f.push(`${v.tag}: 上下留白不对称（上 ${gt} / 下 ${gb}）`);
  if (r.read && r.read.bottom > r.vh) f.push(`${v.tag}: 汤面越过视口底 ${r.read.bottom - r.vh}px`);
}

console.log('\n---- 汇总 ----');
console.log(f.length ? f.map((x) => '  ! ' + x).join('\n') : '  紧凑态不变量全过');
ws.close(); chrome.kill();
process.exit(0);
