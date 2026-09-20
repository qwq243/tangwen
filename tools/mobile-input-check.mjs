// 手机上点输入框，输入法被弹掉（「卡一下，然后输入不了」）—— 这条探针量的是**焦点能不能站住**。
//
// 真机的输入法在 headless 里没法复现，但「键盘弹起」这件事对页面只有两个可见后果，
// 两个都能量：
//   1. 可视视口变矮（页面靠它判断紧凑态 —— layout 在输入框有焦点时翻，正是 Android / 微信
//      把键盘收掉的那个时机）；
//   2. 页面可能跟着滚动一下（`scrollIntoView` 之类），而输入法弹起的同一瞬间滚动会把键盘顶掉。
//
// 所以这里做三件事，比「肉眼看肉眼看不出」强：
//   - 给 HTMLElement.prototype.focus/blur 打桩，**记录调用栈** —— 谁把焦点弄丢的一目了然；
//   - 用真触屏事件（Input.dispatchTouchEvent）点输入框，不是合成 click（合成 click 不聚焦）；
//   - 点完之后按真机的样子把视口压矮，看焦点还在不在。
//
// 用法：node tools/mobile-input-check.mjs [url] [宽] [高]
// 默认 http://127.0.0.1:8765/ 390 844
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
// 键盘占掉的高度：按真机经验取 45%，上限 420px。
// **不能用「保底 320」那种写法**：横屏 844×390 扣掉 320 只剩 70px 可视区，
// 真机上不存在这种键盘（横屏键盘约 175px），却会把舞台按 3:2 缩成 105 宽、
// 搜剧本输入框塌成 0 —— 量到一个假故障。
const KB_H = Math.round(Math.min(H * 0.45, 420));

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'minput_' + PORT)}`,
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
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// 跳过入馆引导（全屏浮层，不跳掉什么都点不到）
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
// 打桩：焦点事件、scroll、以及 focus/blur 的调用栈
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__ev = [];
  window.__log = function (k, d) {
    window.__ev.push([k, Math.round(performance.now()), String(d == null ? '' : d)]);
  };
  (function () {
    var _focus = HTMLElement.prototype.focus, _blur = HTMLElement.prototype.blur;
    function stack() {
      try { return (new Error().stack || '').split('\\n').slice(2, 4).join(' <- ').replace(/https?:[^ )]*\\//g, '').slice(0, 150); }
      catch (_) { return ''; }
    }
    HTMLElement.prototype.focus = function () { window.__log('focus()', (this.id || this.tagName) + ' @ ' + stack()); return _focus.apply(this, arguments); };
    HTMLElement.prototype.blur = function () { window.__log('blur()', (this.id || this.tagName) + ' @ ' + stack()); return _blur.apply(this, arguments); };
  })();
  document.addEventListener('focusin', function (e) { window.__log('focusin', e.target.id || e.target.tagName); }, true);
  document.addEventListener('focusout', function (e) { window.__log('focusout', e.target.id || e.target.tagName); }, true);
  window.addEventListener('scroll', function () { window.__log('scroll', 'y=' + Math.round(window.scrollY)); }, true);
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.querySelector('.stage');
    if (st) new MutationObserver(function () { window.__log('stage.class', st.className); })
      .observe(st, { attributes: true, attributeFilter: ['class'] });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        window.__log('vv.resize', 'h=' + Math.round(window.visualViewport.height) + ' top=' + Math.round(window.visualViewport.offsetTop));
      });
      window.visualViewport.addEventListener('scroll', function () {
        window.__log('vv.scroll', 'top=' + Math.round(window.visualViewport.offsetTop));
      });
    }
  });
` });

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4200);   // 等 boot 遮罩收掉 + 首卷封面就位

const kb = (open) => send('Emulation.setDeviceMetricsOverride',
  { width: W, height: open ? H - KB_H : H, deviceScaleFactor: 1, mobile: true });

/* 真触屏点一下。合成的 .click() 不会聚焦输入框，必须走 Input 域 */
async function tap(sel) {
  const r = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)});
    if(!e) return null; var b=e.getBoundingClientRect();
    return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:Math.round(b.width), h:Math.round(b.height)}; })()`);
  if (!r) return null;
  const pt = { x: r.x, y: r.y, radiusX: 2, radiusY: 2, force: 1 };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return r;
}

const state = () => ev(`(function(){ var a=document.activeElement;
  var st=document.querySelector('.stage');
  return { active: (a&&(a.id||a.tagName))||'(none)', cls: st.className,
           scrollY: Math.round(window.scrollY),
           vv: window.visualViewport ? Math.round(window.visualViewport.height) : -1 }; })()`);

/* 聚焦的那个输入框看得见吗？看不见就报清楚是谁把它藏了 —— 
   「有焦点的输入框被 display:none 藏掉」正是浏览器失焦、输入法收键盘的触发条件。 */
const visInfo = (sel) => ev(`(function(){
  var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return {ok:false, why:'找不到元素'};
  var r=e.getBoundingClientRect(), cs=getComputedStyle(e), why=[];
  if(cs.display==='none') why.push('自身 display:none');
  if(cs.visibility==='hidden') why.push('visibility:hidden');
  if(r.width<1||r.height<1) why.push('尺寸 ' + Math.round(r.width) + '×' + Math.round(r.height));
  var n=e.parentElement, hidden=[];
  while(n && n!==document.documentElement){
    var c=getComputedStyle(n);
    if(c.display==='none'||c.visibility==='hidden') hidden.push((n.className||n.tagName)+' 的 display:'+c.display);
    n=n.parentElement;
  }
  if(hidden.length) why.push('祖先藏了: '+hidden.slice(0,3).join(' , '));
  /* 失败时要能一眼看出「是哪一层塌成了 0」：整条链一起量出来 */
  var st=document.querySelector('.stage'), f=document.querySelector('.finder'), fb=document.querySelector('.finder-box'), geo=[];
  [[st,'stage'],[f,'finder'],[fb,'finder-box'],[e,'它就是它']].forEach(function(p){
    if(!p[0]) return; var r2=p[0].getBoundingClientRect();
    geo.push(p[1]+'='+Math.round(r2.width)+'×'+Math.round(r2.height));
  });
  return {ok: why.length===0, why: why.join(' / '), geo: geo.join('  '),
          cls: st.className,
          vv: window.visualViewport ? Math.round(window.visualViewport.width)+'×'+Math.round(window.visualViewport.height) : '-'}; })()`);

const drain = async () => ev(`(function(){ var a=window.__ev; window.__ev=[]; return a; })()`);

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};
const show = (label, evs) => {
  console.log(`    ${label} 的事件（毫秒 / 事件 / 详情）:`);
  if (!evs.length) console.log('      （无）');
  for (const [k, t, d] of evs.slice(0, 12)) console.log(`      ${String(t).padStart(5)}  ${k.padEnd(12)} ${d}`);
};

/* 一个输入框走一遍：点它（真触屏）-> 键盘弹起（视口压矮）-> 键盘收起。
   要盯的是三件事，只要有一件不成立，真机上就是「卡一下，然后输入不了」：
     1. 点得进去（焦点落在它身上）；
     2. 键盘弹起（布局可能就翻了）之后焦点还在它身上；
     3. 全程它都是**看得见**的 —— 有焦点的输入框被藏起来，浏览器就会失焦。 */
async function caseStudy(label, sel) {
  console.log(`\n=== ${label}  ${sel} ===`);
  // 每组都从干净状态开始：上一组可能留下「搜索浮层开着」之类的状态（会漏到下一组去）
  await kb(false);
  await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
  await sleep(4200);
  await drain();

  const id = sel.replace('#', '');
  const box = await tap(sel);
  if (!box) { check(false, `${sel} 在页面上找得到`, '找不到元素'); return; }
  await sleep(700);
  let s = await state();
  check(s.active === id, `点一下就能聚焦到 ${sel}`, `active=${s.active}`);
  let v = await visInfo(sel);
  check(v.ok, `聚焦时 ${sel} 是看得见的`, v.why);
  const afterTap = await drain();
  show('点完', afterTap);

  // 键盘弹起：真机上就是可视视口变矮（页面靠它判紧凑态）
  await kb(true);
  await sleep(1000);
  s = await state();
  const afterKb = await drain();
  const flipped = afterKb.some(([k]) => k === 'stage.class');
  v = await visInfo(sel);
  console.log(`    键盘弹起后：active=${s.active}  stage=${s.cls}  vv=${s.vv}  布局翻转=${flipped}`);
  check(s.active === id, `键盘弹起后焦点还在 ${sel} 上`, `active=${s.active}`);
  check(v.ok, `键盘弹起、布局若翻转之后 ${sel} 仍然看得见`, v.why);
  const blurs = afterKb.filter(([k]) => k === 'blur()');
  check(blurs.length === 0, '键盘弹起来的过程中没人 blur 这个输入框',
    blurs.map(([, t, d]) => t + ': ' + d).join(' | ') || '无');
  // 焦点丢过又没接回来 = 输入法已经收了。这里看的是最终态，接回来的不算失败。
  const lost = afterKb.filter(([k, , d]) => k === 'focusout' && String(d).indexOf(id) >= 0);
  check(lost.length === 0 || s.active === id,
    '焦点即使被抖掉过，最后也接回来了', lost.length ? `${lost.length} 次 focusout，最终 active=${s.active}` : '没丢过');
  show('键盘弹起后', afterKb);

  await kb(false);
  await sleep(500);
  s = await state();
  console.log(`    键盘收起后：active=${s.active}  scrollY=${s.scrollY}`);
  await drain();
}

console.log(`视口 ${W}×${H}  键盘按 ${KB_H}px 算，压到 ${H - KB_H}px`);
await caseStudy('1. 底部问句输入框', '#typed');
await caseStudy('2. 顶部搜剧本输入框', '#findInput');
await caseStudy('3. 卷宗里的「名」输入框', '#playerName');

// 4. 紧凑态（矮屏）下的对照组：布局本来就不需要翻，焦点应该一路站得住
const H4 = 640;
const KB4 = Math.round(Math.min(H4 * 0.45, 420));
const kb4 = (open) => send('Emulation.setDeviceMetricsOverride',
  { width: W, height: open ? H4 - KB4 : H4, deviceScaleFactor: 1, mobile: true });
console.log(`\n=== 4. 对照组：紧凑态（${W}×${H4}）底部输入框 ===`);
await kb4(false);
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4200);
await drain();
const b4 = await tap('#typed');
if (!b4) check(false, '#typed 在紧凑态找得到', '找不到');
else {
  await sleep(700);
  let s = await state();
  check(s.active === 'typed', '紧凑态下点一下就能聚焦', `active=${s.active} cls=${s.cls}`);
  show('紧凑态点完', await drain());
  await kb4(true);
  await sleep(1000);
  s = await state();
  check(s.active === 'typed', '紧凑态下键盘弹起焦点还在', `active=${s.active} vv=${s.vv}`);
  const v4 = await visInfo('#typed');
  check(v4.ok, '紧凑态下输入框一直看得见', v4.why);
  const e4 = await drain();
  show('紧凑态键盘弹起后', e4);
  const bad4 = e4.filter(([k]) => k === 'blur()');
  check(bad4.length === 0, '紧凑态下没人 blur', bad4.map(([, t, d]) => t + ': ' + d).join(' | ') || '无');
  await kb4(false);
  await sleep(400);
}

console.log('');
if (fails.length) {
  console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`);
} else {
  console.log('[OK] 四个输入框：点得进、键盘弹起不丢焦点、全程可见、没人偷偷 blur');
}
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
