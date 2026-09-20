// 多视口量布局：元素坐标 / 重叠间隙 / motes 数 / JS 报错 + 截图，一次跑完
// 用法: node tools/probe.mjs [url] [outDir]
// 只读，不改任何文件；量出来的数就是改 CSS 的依据（别靠肉眼估）
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const OUT = process.argv[3] || join(process.cwd(), 'tmp', '_shot');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWS = [
  { label: 'desktop_1440x900', W: 1440, H: 900, mobile: false },
  { label: 'laptop_1280x800', W: 1280, H: 800, mobile: false },
  { label: 'phone_390x844', W: 390, H: 844, mobile: true },
];

const PROBE = `(function(){
  function box(s){ var e=document.querySelector(s); if(!e) return null; var r=e.getBoundingClientRect();
    return {x:Math.round(r.x),y:Math.round(r.y),right:Math.round(r.right),bottom:Math.round(r.bottom),
            w:Math.round(r.width),h:Math.round(r.height)}; }
  function gap(a, b, axis){ if(!a||!b) return null;
    // 只在两个盒子在该轴之外的另一轴上真的并排时，横向/纵向间距才有意义，
    // 否则会算出「隔着半个屏幕的负重叠」这种误导性的数
    var overlapOther = axis==='x' ? (a.bottom > b.y && a.y < b.bottom) : (a.right > b.x && a.x < b.right);
    if (!overlapOther) return null;
    return axis==='x' ? (b.x - a.right) : (b.y - a.bottom); }
  var out = {
    title: (document.getElementById('title')||{}).textContent,
    seal: (document.querySelector('.seal')||{}).textContent,
    stageClass: (document.querySelector('.stage')||{}).className,
    vw: innerWidth, vh: innerHeight,
    stage: box('.stage'),
    win: box('.frame-window'),          // 中央金框内窗
    dossier: box('.dossier'),
    plaque: box('.plaque'),
    read: box('.read'),
    dock: box('.dock'),
    mic: box('#mic'),
    prev: box('#prev'), next: box('#next'),
    sound: box('#sound'),
    wingL: box('.wing.left'), wingR: box('.wing.right'),
    motes: document.getElementById('motes') ? document.getElementById('motes').children.length : -1,
    micCap: (document.getElementById('micCap')||{}).textContent,
    srSupport: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    errs: window.__errs || []
  };
  var w = out.win;
  if (w) {
    out.gaps = {
      prevToWin: gap(out.prev, w, 'x'),      // 左箭头右沿 -> 金框内窗左沿（不是壳，壳还要宽 --frame-pad）
      winToNext: gap(w, out.next, 'x'),
      nextToDossier: gap(out.next, out.dossier, 'x'),
      soundToSeal: out.sound && out.seal ? (out.sound.y - (document.querySelector('.seal').getBoundingClientRect().bottom)) : null
    };
  }
  return out;
})()`;

async function run(v) {
  const PORT = await freePort();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP || '/tmp', 'probe_' + PORT)}`,
    `--window-size=${v.W},${v.H}`, 'about:blank'], { stdio: 'ignore' });
  const waitFor = async (fn) => { const t0 = Date.now(); for (;;) { try { const r = await fn(); if (r) return r; } catch {} if (Date.now() - t0 > 20000) throw new Error('chrome 启动超时'); await sleep(200); } };
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let seq = 0; const pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const send = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (x) => (x.error ? rej(new Error(m + ' ' + JSON.stringify(x.error))) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); });
    await send('Page.enable'); await send('Runtime.enable');
    // 跳过入馆引导，否则它盖在卷面上，截图全废
    await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||'')+' @'+(e.filename||'')+':'+(e.lineno||0))});" +
        "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" +
        "var __ce=console.error;console.error=function(){window.__errs.push('CONSOLE:'+Array.prototype.join.call(arguments,' '));__ce.apply(console,arguments)};",
    });
    await send('Emulation.setDeviceMetricsOverride', { width: v.W, height: v.H, deviceScaleFactor: 1, mobile: v.mobile });
    await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + '_cb=' + Date.now() });
    await sleep(4500);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    console.log('=== ' + v.label + ' ===');
    console.log(JSON.stringify(r.result?.value ?? r.result, null, 1));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `probe_${v.label}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('SHOT ' + file);
    ws.close();
  } catch (e) {
    console.log('=== ' + v.label + ' FAILED: ' + e.message);
  } finally { try { chrome.kill(); } catch {} }
}

for (const v of VIEWS) { await run(v); await sleep(300); }
process.exit(0);
