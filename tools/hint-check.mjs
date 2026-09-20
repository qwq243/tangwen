// 求灯（AI 提示）体检：点下去之后，玩家到底能不能在屏幕上看到、能不能再看一遍。
//
// 背景：紧凑态里 `.stage.compact .hint-line { display: none }` 和
// `.stage.compact .hint { display: none }` 两条一起，把「求灯」的出口全堵了 ——
// app.js 那句 `if (compact) showHint(data.hint, 5200)` 写进的正是一个 display:none 的元素。
// 于是手机上点求灯：状态行闪一下「掌灯……」，然后就什么都没有了，
// 而 promptedSet 已经把这一卷的「孤灯」扣掉了。
//
// 用法：node tools/hint-check.mjs [url] [宽] [高]
// 默认 http://127.0.0.1:8765/ 390 844
// 默认拦掉 /api/hint 与 /api/ask 造假回答（提示是一句可检索的固定文案）。
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
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = args[0] || 'http://127.0.0.1:8765/';
const W = Number(args[1] || 390);
const H = Number(args[2] || 844);
/* 紧凑态的测试高度**不能写死**：门槛是「H >= 1.375w + 180 才用画廊」这道方程
   （web/app.js 的 GALLERY_MIN_RATIO / GALLERY_MIN_PAD），布局常量一改它就变。
   这里原来钉的是 730 —— 门槛从 269 降到 180 之后，390×730 已经是画廊了，
   于是第 3 步一路假红（「已进入紧凑态 ✗ stage tall」）。
   现在按同一道方程算出一个一定进紧凑态、又还是个真实手机比例的高度。
   下面第 3 步仍然断言「已进入紧凑态」，真要是方程又漂了它会立刻喊出来。 */
const COMPACT_H = Math.min(640, Math.round(W * 1.375 + 180) - 76);

// 假提示：一句 30 来字的「掌灯人口吻」，带一个不会跟界面别的文字撞车的水印词
const MARK = '绕开字面';
const FAKE_HINT = `灯下看了看：这一层要${MARK}，先问那个人当时是不是真的在场。`;
// 第二次求灯换一句长的：服务端最多回 48 字，这里用 40 来字逼出「折成两行」那一档
const MARK2 = '门是从里面锁的';
const FAKE_HINT_LONG = `灯下看了看：先问那个人${MARK2}之前，有没有单独回过家，再问那通电话是打给谁的。`;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

const PROBE = `(function(){
  function vis(e){ var cs=getComputedStyle(e);
    if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) return false;
    var r=e.getBoundingClientRect(); return r.width>=1 && r.height>=1; }
  function box(sel){ var e=document.querySelector(sel); if(!e) return null;
    var r=e.getBoundingClientRect();
    return {shown:vis(e), hidden:e.hidden===true, display:getComputedStyle(e).display,
            x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
            text:(e.textContent||'').slice(0,60)}; }
  // 谁在屏幕上真写着这句提示？（只看最深的那个元素，免得把 body/html 也算进来）
  function findText(needle){
    var hits=[];
    var all=document.querySelectorAll('body *');
    for (var i=0;i<all.length;i++){
      var e=all[i], t=e.textContent||'';
      if (t.indexOf(needle)<0) continue;
      /* 读屏专用那一件（#srVerdict）是 1×1 + clip-path 裁干净的「看不见的元素」，
         量出来 h=1 会被当成一个可见出口 —— 把它算进来的话，就算真正的提示行
         被藏了，这条断言也会因为读屏文案而假绿。跳过它。 */
      if (e.classList && e.classList.contains('sr-verdict')) continue;
      var deeper=false;
      for (var j=0;j<e.children.length;j++){ if((e.children[j].textContent||'').indexOf(needle)>=0){ deeper=true; break; } }
      if (deeper) continue;
      if (!vis(e)) continue;
      var r=e.getBoundingClientRect();
      hits.push({cls:(e.className||e.tagName)+'', y:Math.round(r.y), h:Math.round(r.height)});
    }
    return hits;
  }
  var stage=document.querySelector('.stage');
  return { cls: stage.className, vw: innerWidth, vh: innerHeight,
           toast: box('#hint'), line: box('#hintLine'), ask: box('#hintAsk'),
           board: box('#boardOpen'), dock: box('.dock'), dossier: box('.dossier'),
           read: box('.read'), frame: box('.frame-window'),
           hits: findText(${JSON.stringify(MARK)}),
           hits2: findText(${JSON.stringify(MARK2)}),
           ledger: [].slice.call(document.querySelectorAll('.ledger li')).length,
           errs: (window.__errs||[]).slice(0,4) };
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'hint_' + PORT)}`,
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
};
const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){ var of=window.fetch; var hintCalls=0;
    window.__hintCalls=function(){ return hintCalls; };
    window.fetch=function(input, init){
      var url = typeof input==='string' ? input : (input&&input.url)||'';
      if (url.indexOf('/api/hint')>=0){ hintCalls++;
        var body = window.__longHint ? ${JSON.stringify(FAKE_HINT_LONG)} : ${JSON.stringify(FAKE_HINT)};
        return Promise.resolve(new Response(JSON.stringify({ ok:true, hint: body }),
          { status:200, headers:{'Content-Type':'application/json'} })); }
      if (url.indexOf('/api/ask')>=0){
        return Promise.resolve(new Response(JSON.stringify({ ok:true, label:'不是', verdict:'no',
          latency_ms:300, unlocked:[], keys:[], solved:false }),
          { status:200, headers:{'Content-Type':'application/json'} })); }
      return of.apply(this, arguments);
    }; })();` });

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};

const lamp = async (want) => {
  const on = await ev("document.getElementById('lamp').getAttribute('aria-pressed')==='true'");
  if (on !== want) { await ev("document.getElementById('lamp').click()"); await sleep(300); }
};
const asked = async () => {
  await ev("document.getElementById('hintAsk').click()");
  for (let i = 0; i < 24; i++) { await sleep(250); if (await ev("document.getElementById('hintLine').textContent.length>0")) break; }
  await sleep(400);
};

await size(W, H);
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4500);
await lamp(true);

console.log(`\n=== 1. 画廊态 ${W}×${H}：求灯要看得见 ===`);
let r = await ev(PROBE);
console.log(`  ${r.cls}  toast=${JSON.stringify(r.toast)}  line=${JSON.stringify(r.line)}`);
check(r.ask && r.ask.shown, '灯亮了，求灯按钮在');
await asked();
r = await ev(PROBE);
console.log(`  求灯后  toast.display=${r.toast.display} line.shown=${r.line.shown}  hits=${JSON.stringify(r.hits)}`);
check(r.hits.length >= 1, '画廊态：屏幕上真出现了提示文字', JSON.stringify(r.hits));
check(r.line.shown === true, '画廊态：.hint-line 常驻可见');
await shotTo('hn_1_gallery.png');

console.log('\n=== 2. 画廊态：toast 淡出之后还读得到吗 ===');
await sleep(7000);
r = await ev(PROBE);
check(r.hits.length >= 1, 'toast 淡出后提示仍在（常驻位）', JSON.stringify(r.hits));
check(r.toast.display === 'none' || !r.toast.shown, 'toast 自己按时收了', `display=${r.toast.display}`);

console.log(`\n=== 3. 紧凑态 ${W}×${COMPACT_H}（手机常态）：求灯要看得见 ===`);
await size(W, COMPACT_H);
await sleep(1200);
r = await ev(PROBE);
check(/compact/.test(r.cls) || W > H, '已进入紧凑态',
  W > H ? `${W}×${COMPACT_H} 是横版视口，紧凑态只存在于竖屏 —— 这一步跳过（想验紧凑态请用竖屏尺寸，如 390 844）` : r.cls);
check(r.ask && r.ask.shown, '紧凑态里求灯按钮在（点得到）');
/* 同一屏里做 A/B：把提示行临时藏起来量一次，再放回去量一次。
   目的是分开看两件事 —— 提示行有没有真的占位（记录条该变高），
   以及多出来的高度是不是被 auto 外边距吸收掉了（画卷高度该纹丝不动）。 */
const noHint = await ev(`(function(){
  var el=document.getElementById('hintLine'); var prev=el.hidden; el.hidden=true;
  var doo=document.querySelector('.dossier').getBoundingClientRect();
  var fw=document.querySelector('.frame-window').getBoundingClientRect();
  el.hidden=prev;
  return { dossier: Math.round(doo.height), frame: Math.round(fw.height) };
})()`);
console.log(`  求灯前（提示行藏起来）画卷 ${noHint.frame} / 记录条 ${noHint.dossier}`);
await asked();
r = await ev(PROBE);
const gap = Math.round(r.dossier.y - (r.read.y + r.read.h));
console.log(`  求灯后  toast.display=${r.toast.display} line.display=${r.line.display} hits=${JSON.stringify(r.hits)}`);
console.log(`  求灯后  画卷 ${r.frame.h} / 记录条 ${r.dossier.h} / 汤面底 ${r.read.y + r.read.h} / 记录条顶 ${r.dossier.y}（留白 ${gap}）`);
check(r.hits.length >= 1, '紧凑态：屏幕上真出现了提示文字', JSON.stringify(r.hits));
/* 提示是记录条那条横带的第二行，所以它一出现，记录条就变高 —— 多出来的高度
   必须由两个 auto 外边距吸收，不能去压汤面、更不能挤画卷。这一组断言就是钉这个的。 */
check(r.dossier.h - noHint.dossier >= 15, '提示行确实占在记录条里（不是浮在上面）',
  `无提示 ${noHint.dossier} -> 有提示 ${r.dossier.h}`);
check(r.frame.h === noHint.frame, '画卷高度纹丝不动（富余被 auto 外边距吸收，没去挤画卷）',
  `${noHint.frame} -> ${r.frame.h}`);
check(r.read.y + r.read.h <= r.dossier.y + 1, '记录条没压上汤面');
check(r.dossier.y + r.dossier.h <= r.dock.y + 1, '记录条没压上输入条');
check(r.frame.h >= r.vh * 0.28, '加了提示行，画卷也没退化成横幅', `画卷 ${r.frame.h} / 门槛 ${Math.round(r.vh * 0.28)}`);
await shotTo('hn_2_compact.png');
console.log('  --- 等 8s（假提示的 toast 是 5200ms）再扫一次 ---');
await sleep(8000);
r = await ev(PROBE);
console.log(`  hits=${JSON.stringify(r.hits)}`);
check(r.hits.length >= 1, '紧凑态：过一会儿还读得到（提示不该一闪就没）');

console.log('\n=== 4. 刷新之后（提示该跟着存档回来）===');
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4500);
await lamp(true);
r = await ev(PROBE);
console.log(`  line.shown=${r.line.shown} line.text=${JSON.stringify((r.line||{}).text)} hits=${JSON.stringify(r.hits)}`);
check(r.hits.length >= 1, '刷新后提示还在（已存档）', JSON.stringify(r.hits));
check(await ev('window.__hintCalls()') <= 2, '刷新没有额外打接口', `hint 调用 ${await ev('window.__hintCalls()')} 次`);

console.log('\n=== 5. 灯关掉：求灯入口和提示一起收起来 ===');
await lamp(false);
await sleep(400);
r = await ev(PROBE);
check(r.ask && r.ask.hidden === true && r.ask.shown === false, '灯灭后求灯按钮藏起来');
check(r.line.hidden === true && r.line.shown === false, '灯灭后提示也藏起来');
await lamp(true);
await sleep(400);
r = await ev(PROBE);
check(r.ask && r.ask.shown === true, '再开灯求灯按钮回来');
check(r.line.shown === true, '再开灯提示也回来（不用重新求）', JSON.stringify((r.line || {}).text));

console.log('\n=== 6. 换一卷求一句长的（服务端最多 48 字），看折成两行还压不压得住 ===');
await ev("document.getElementById('next').click()");
await sleep(1600);
check((await ev("document.getElementById('hintLine').textContent")).length === 0, '换卷后提示行是空的（提示按卷存）');
await ev('window.__longHint = true');   // 让桩这次回长句
await asked();
r = await ev(PROBE);
console.log(`  提示 ${r.line.text.length} 字 / 行高 ${r.line.h} / 记录条 ${r.dossier.h} / 画卷 ${r.frame.h}`);
check(r.hits2.length >= 1, '紧凑态：长提示也看得见', JSON.stringify(r.hits2));
check(r.line.h >= 30, '长提示确实折成了两行', `行高 ${r.line.h}`);
check(r.read.y + r.read.h <= r.dossier.y + 1, '长提示没压上汤面');
check(r.dossier.y + r.dossier.h <= r.dock.y + 1, '长提示没压上输入条');
check(r.frame.h >= r.vh * 0.28, '长提示下画卷仍没退化', `画卷 ${r.frame.h} / 门槛 ${Math.round(r.vh * 0.28)}`);
await shotTo('hn_3_long.png');

check((r.errs || []).length === 0, '全程无 JS 报错', JSON.stringify(r.errs));

console.log('');
if (fails.length) { console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`); }
else { console.log('[OK] 全部通过'); }
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
