// 移动端体检：模拟软键盘压扁视口，检查
//   a) 各块有没有互相压住（汤面 / 记录 / 识别 / 状态 / 输入条）
//   b) 紧凑态里换卷、声音、排行榜、记录条这些控件还在不在、点得到
//   c) 提问之后回答能不能在可见区里看到（回答只渲染在 .ledger 里）
//   d) 键盘收起之后回画廊，记录面板装满的情况下还压不压
//
// 用法：node tools/mobile-check.mjs [url] [宽] [高]
// 默认 http://127.0.0.1:8765/ 390 844
//
// 关于 --real-ask：判题要出网。沙箱/断网环境里服务端开 socket 会被拒
// （WinError 10013），这时脚本默认拦掉 /api/ask 造假回答，只验证渲染路径。
// 想连真接口就加 --real-ask（要在本机正常联网时跑）。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const OUT = join(PROJ, 'tmp', '_shot');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const REAL_ASK = process.argv.includes('--real-ask');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = args[0] || 'http://127.0.0.1:8765/';
const W = Number(args[1] || 390);
const H = Number(args[2] || 844);
// 键盘占据的高度按经验取 350-420px
const KB_H = Math.max(320, Math.round(H * 0.42));

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

const PROBE = `(function(){
  function box(sel){ var e=document.querySelector(sel); if(!e) return null;
    var cs=getComputedStyle(e);
    if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') return {hidden:true,why:'css'};
    var r=e.getBoundingClientRect();
    if(r.width<1||r.height<1) return {hidden:true,why:'zero'};
    return {x:Math.round(r.x),right:Math.round(r.right),y:Math.round(r.y),bottom:Math.round(r.bottom),
            w:Math.round(r.width),h:Math.round(r.height)}; }
  var sel={plaque:'.plaque',win:'.frame-window',read:'.read',dossier:'.dossier',heard:'.heard',
           status:'.status',dock:'.dock',navPrev:'#prev',navNext:'#next',sound:'#sound',
           boardOpen:'#boardOpen',meter:'.meter',input:'#typed',askBtn:'.ask-btn',mic:'#mic'};
  var b={}; Object.keys(sel).forEach(function(k){ b[k]=box(sel[k]); });
  // .heard 在紧凑态是被有意藏掉的；nav / sound 是画在顶栏背景上的有意包含，
  // 所以它们只查可见性，不参与相交扫描（否则会报假阳性）。
  var watch=['plaque','win','read','dossier','status','dock'];
  var arr=watch.map(function(k){ return [k,b[k]]; }).filter(function(p){ return p[1]&&!p[1].hidden; });
  var overlaps=[];
  for (var i=0;i<arr.length;i++) for (var j=i+1;j<arr.length;j++){
    var a=arr[i][1], c=arr[j][1];
    var vOver = a.bottom > c.y + 1 && a.y < c.bottom - 1;
    var hOver = a.right > c.x + 1 && a.x < c.right - 1;
    if (vOver && hOver) overlaps.push(arr[i][0]+' × '+arr[j][0]);
  }
  var stage=document.querySelector('.stage');
  var chips=[].slice.call(document.querySelectorAll('.ledger li')).map(function(li){
    var q=li.querySelector('.q'), a=li.querySelector('.a');
    var r=li.getBoundingClientRect(), s=stage.getBoundingClientRect();
    return {q:(q&&q.textContent)||'', a:(a&&a.textContent)||'', inView: r.bottom>s.top&&r.top<s.bottom}; });
  return { cls: stage.className, vw: innerWidth, vh: innerHeight,
           title: document.getElementById('title').textContent,
           chips: chips, boxes: b, overlaps: overlaps,
           errs: (window.__errs||[]).slice(0,5) };
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'mob_' + PORT)}`,
  `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

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
  return join(OUT, name);
};
const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });

await send('Page.enable'); await send('Runtime.enable');
// 跳过入馆引导，否则它盖在页面上，量到的和截到的都是那张卡片
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" +
  "var __ce=console.error;console.error=function(){window.__errs.push('CONSOLE:'+Array.prototype.join.call(arguments,' '));__ce.apply(console,arguments)};" });
if (!REAL_ASK) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (function(){ var of = window.fetch; var n = 0; var labels = ['是','不是','是','无关'];
      window.fetch = function(input, init){
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/ask') < 0) return of.apply(this, arguments);
        var label = labels[n++ % labels.length];
        return Promise.resolve(new Response(JSON.stringify({ ok:true, label:label,
          verdict: label === '是' ? 'yes' : label === '不是' ? 'no' : label === '无关' ? 'irrelevant' : 'partial',
          latency_ms: 380 + n * 37, unlocked:[], keys:[], solved:false }),
          { status:200, headers:{'Content-Type':'application/json'} }));
      }; })();` });
}

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};

await size(W, H);
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4500);

console.log(`\n=== 1. 画廊态 ${W}×${H} ===`);
let r = await ev(PROBE);
console.log(`  ${r.cls}  重叠=${JSON.stringify(r.overlaps)}`);
check(r.overlaps.length === 0, '画廊态无重叠', JSON.stringify(r.overlaps));
check(/compact/.test(r.cls) === false, '这个大屏不需要紧凑态');
await shotTo('mobile_1_gallery.png');

console.log(`\n=== 2. 键盘弹起 ${W}×${H - KB_H} ===`);
await size(W, H - KB_H);
await sleep(1100);
r = await ev(PROBE);
console.log(`  ${r.cls}  重叠=${JSON.stringify(r.overlaps)}`);
check(/compact/.test(r.cls), '键盘态切到紧凑布局');
check(r.overlaps.length === 0, '键盘态无重叠', JSON.stringify(r.overlaps));
const shown = ['navPrev', 'navNext', 'sound', 'boardOpen', 'input', 'askBtn', 'mic', 'meter'];
const missing = shown.filter((k) => !r.boxes[k] || r.boxes[k].hidden);
check(missing.length === 0, '换卷/声音/排行榜/输入区都还在', missing.length ? '缺: ' + missing.join(',') : '');
const inView = shown.filter((k) => r.boxes[k] && r.boxes[k].hidden !== true);
for (const k of inView) console.log(`     ${k.padEnd(10)} ${JSON.stringify(r.boxes[k])}`);
await shotTo('mobile_2_keyboard.png');

console.log('\n=== 3. 键盘态换卷 ===');
const before = r.title;
await ev("document.getElementById('next').click()");
await sleep(1500);
r = await ev(PROBE);
check(r.title !== before, '换卷生效', `${before} -> ${r.title}`);
check(r.overlaps.length === 0, '换卷后仍无重叠', JSON.stringify(r.overlaps));

console.log('\n=== 4. 键盘态提问，回答要看得见 ===');
const askQ = async (text, want) => {
  await ev(`(function(){ var el=document.getElementById('typed'); el.value=${JSON.stringify(text)}; el.focus();
    document.getElementById('typeLine').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1; })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const rr = await ev(PROBE);
    if (rr.chips.length >= want) return rr;
  }
  return await ev(PROBE);
};
r = await askQ('妹妹是被杀的吗', 1);
r = await askQ('她死在房间里吗', 2);
console.log(`  记录=${JSON.stringify(r.chips.map((c) => c.q + ' -> ' + c.a))}`);
check(r.chips.length >= 2, '回答落到记录条上');
check(r.chips.length > 0 && r.chips[0].inView, '最新一条在可见区里');
check(r.overlaps.length === 0, '提问后无重叠', JSON.stringify(r.overlaps));
check(r.errs.length === 0, '无 JS 报错', JSON.stringify(r.errs));
await shotTo('mobile_4_asked.png');

console.log(`\n=== 5. 收起键盘回画廊（记录面板已装满）${W}×${H} ===`);
await size(W, H);
await sleep(1100);
r = await ev(PROBE);
console.log(`  ${r.cls}  重叠=${JSON.stringify(r.overlaps)}  记录区高=${(r.boxes.dossier || {}).h}`);
check(/compact/.test(r.cls) === false, '回到画廊布局');
check(r.overlaps.length === 0, '记录装满后画廊仍无重叠', JSON.stringify(r.overlaps));
await shotTo('mobile_5_back.png');

console.log('');
if (fails.length) { console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`); }
else { console.log('[OK] 全部通过'); }
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
