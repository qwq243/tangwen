// 音效自查：**离开页面就静音**、**同一个声音不总是同一个样**、**高频音不刷屏**。
//
// 背景（2026-09-20 用户实报）：
//   「离开页面就不要声音了。可以加一些其他的音效，不要太单调，增加随机性，
//     否则用户会很烦躁。」三件事对应三条断言组：
//     1) 切标签 / 切 app / 跳走 / 冻结之后一声都不许出，回来再接着响；
//     2) 同一件事连做十次，听到的不能是十次一模一样的声音；
//     3) 鼠标扫过、拖动画卷这类高频动作必须节流（不拦就是「嗒嗒嗒嗒」一梭子）。
//
// 怎么量的（不往引擎里塞测试开关）：进页面前把 WebAudio 的三个工厂函数包一层，
// 记下每一次合成的「零件」——振荡器的类型/频率、噪声的滤波器类型与起点频率。
// 于是每次出音都有一条签名，可以分开看它「形状」和「精确参数」两件事：
//   形状不变而参数在飘 = 抖动在起作用；形状变了 = 变体在起作用。
// 静音那三条走的是真事件（visibilitychange / pagehide / freeze）——
// visibilityState 用 defineProperty 覆盖（Chromium 允许），事件是真的派发。
//
// 用法：node tools/audio-check.mjs [url]
// 默认 http://127.0.0.1:8765/
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

/* 注入两件事：
   1. 声音开着（SEED 默认关声音，这里覆盖一下）+ 跳掉入馆引导；
   2. WebAudio 的工厂钩子 —— 必须在页面脚本之前挂上，audio.js 建完 ctx 才用得上。 */
const HOOK = `
  try { localStorage.setItem('fengcun.sound', '1'); } catch (_) {}
  window.__audio = { nodes: [] };
  (function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var co = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      var o = co.apply(this, arguments);
      var rec = { kind: 'osc', type: o.type, freq: null, glide: null };
      window.__audio.nodes.push(rec);
      var sv = o.frequency.setValueAtTime;
      o.frequency.setValueAtTime = function (v) { if (rec.freq === null) rec.freq = Number(v); return sv.apply(o.frequency, arguments); };
      var er = o.frequency.exponentialRampToValueAtTime;
      o.frequency.exponentialRampToValueAtTime = function (v) { if (rec.glide === null) rec.glide = Number(v); return er.apply(o.frequency, arguments); };
      return o;
    };
    var cb = AC.prototype.createBufferSource;
    AC.prototype.createBufferSource = function () {
      var s = cb.apply(this, arguments);
      window.__audio.nodes.push({ kind: 'noise', ftype: null, from: null });
      return s;
    };
    var cf = AC.prototype.createBiquadFilter;
    AC.prototype.createBiquadFilter = function () {
      var f = cf.apply(this, arguments);
      /* 挂到「最近一件还没配滤波器的零件」上：tone()/noise() 都是建完源再建滤波器。
         ⚠️ 类型要在**第一次设频率**那一刻才读 —— audio.js 是先建滤波器、再写
         f.type = opt.filter 的，建出来那一瞬它还是默认的 lowpass，
         在这里读会把所有噪声都记成 lowpass（探针踩过这个坑，形状全撞在一起）。 */
      for (var i = window.__audio.nodes.length - 1; i >= 0; i--) {
        var n = window.__audio.nodes[i];
        if (n.ftype === null) {
          var sv = f.frequency.setValueAtTime;
          f.frequency.setValueAtTime = function (v) {
            if (n.from === null) { n.from = Number(v); n.ftype = f.type; }
            return sv.apply(f.frequency, arguments);
          };
          break;
        }
      }
      return f;
    };
  })();
  window.__errs = [];
  window.addEventListener('error', function (e) { window.__errs.push('ERR:' + (e.message || '')); });
`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'audio_' + PORT)}`,
  '--window-size=1180,800', 'about:blank'], { stdio: 'ignore' });

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
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (x) => (x.error ? rej(new Error(m + ' ' + JSON.stringify(x.error))) : res(x.result)));
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4200);

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};

/* 一次出音的签名。两把尺子：
   shape 只看「用了哪些零件」（振荡器类型 / 噪声的滤波器类型）—— 它变，说明形状变体在工作；
   sig   连频率一起看（10Hz 一档、滤波起点 50Hz 一档）—— 它变，说明参数在抖。 */
const MARK = `window.__mark = window.__audio.nodes.length`;
const TAKEN = `(function(){
  var list = window.__audio.nodes.slice(window.__mark);
  var shape = list.map(function(r){ return r.kind === 'osc' ? 'o:' + r.type : 'n:' + (r.ftype || '-'); }).join(',');
  var sig = list.map(function(r){
    return r.kind === 'osc'
      ? 'o' + r.type + Math.round((r.freq || 0) / 10) * 10 + '/' + Math.round((r.glide || 0) / 10) * 10
      : 'n' + (r.ftype || '-') + Math.round((r.from || 0) / 50) * 50; }).join(',');
  return { n: list.length, shape: shape, sig: sig }; })()`;

/* 看一眼 / 摸一下：mark 之后调 fn，再取签名。fn 是页面里的表达式。
   gap 要给得比那一件的节流窗更长，否则量到的「空签名」其实是被节流吃掉的。 */
const hear = async (fn, gap) => {
  await ev(MARK);
  await ev(fn);
  await sleep(gap || 60);
  return ev(TAKEN);
};
const hearMany = async (fn, times, gap) => {
  const out = [];
  for (let i = 0; i < times; i++) out.push(await hear(fn, gap));
  return out;
};

console.log('\n=== 1. 第一下手势：浏览器解锁音频，开卷那一声 ===');
const beforeGesture = await ev('({ ready: !!window.FengcunAudio.ready, playing: window.FengcunAudio.playing })');
check(beforeGesture.ready === false, '还没动手势之前没有 AudioContext（浏览器不给）', JSON.stringify(beforeGesture));
await ev(`(function(){ window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return 1; })()`);
await sleep(500);
const afterGesture = await ev('({ ready: !!window.FengcunAudio.ready, playing: window.FengcunAudio.playing, state: window.FengcunAudio.state, on: window.FengcunAudio.isOn() })');
check(afterGesture.ready === true && afterGesture.state === 'running', '手势之后音频起来了', JSON.stringify(afterGesture));
check(afterGesture.playing === true && afterGesture.on === true, '开关开着、页面在前台 → playing=true');
const openSig = await ev(`(function(){
  return window.__audio.nodes.length; })()`);
check(openSig > 0, '开卷那一声真的合成出来了（环境音也起了）', `零件数=${openSig}`);

console.log('\n=== 2. 离开页面就静音：visibilitychange → hidden ===');
await ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'hidden'; } });
  document.dispatchEvent(new Event('visibilitychange')); 1`);
await sleep(120);
const hidden = await ev('({ playing: window.FengcunAudio.playing, paused: document.hidden })');
check(hidden.playing === false, 'hidden 之后立刻 playing=false（不再出声）', JSON.stringify(hidden));
const whileHidden = await hear(`window.FengcunAudio.sfx('stamp', 'yes')`);
check(whileHidden.n === 0, '后台期间调 sfx 一个零件都不合成', `零件数=${whileHidden.n}`);
await sleep(500);
const suspended = await ev('window.FengcunAudio.state');
check(suspended === 'suspended', '淡出走完之后 AudioContext 挂起（真的停了，不是只把音量拧到 0）', `state=${suspended}`);

console.log('\n=== 3. 回到前台：接着响 ===');
await ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'visible'; } });
  document.dispatchEvent(new Event('visibilitychange')); 1`);
await sleep(500);
const back = await ev('({ playing: window.FengcunAudio.playing, state: window.FengcunAudio.state })');
check(back.playing === true && back.state === 'running', '回来之后 resume 了', JSON.stringify(back));
const afterBack = await hear(`window.FengcunAudio.sfx('stamp', 'yes')`);
check(afterBack.n > 0, '回来之后 sfx 又能出声了', `零件数=${afterBack.n}`);

console.log('\n=== 4. pagehide / freeze 两条路也要静音（跳走、进 bfcache、被冻结）===');
await ev(`window.dispatchEvent(new Event('pagehide')); 1`);
await sleep(120);
check((await ev('window.FengcunAudio.playing')) === false, 'pagehide 之后 playing=false');
const afterHide = await hear(`window.FengcunAudio.sfx('wickOn')`);
check(afterHide.n === 0, 'pagehide 之后也不再合成', `零件数=${afterHide.n}`);
await ev(`document.dispatchEvent(new Event('visibilitychange')); 1`);   // 假装回来
await sleep(200);
await ev(`window.dispatchEvent(new Event('freeze')); 1`);
await sleep(120);
check((await ev('window.FengcunAudio.playing')) === false, 'freeze 之后 playing=false');
await ev(`document.dispatchEvent(new Event('visibilitychange')); 1`);
await sleep(300);

console.log('\n=== 4a. 从 bfcache 退回来（浏览器后退键）：不能是一页永远静音的页面 ===');
/* pagehide 把 pageHidden 置上了，正常路径靠 visibilitychange 或 pageshow 把它清掉。
   少了 pageshow 那一条，从 bfcache 退回来就是「页面好好的、一点声音都没有」——
   玩家只会以为声音坏了。 */
await ev(`window.dispatchEvent(new Event('pagehide')); 1`);
await sleep(120);
check((await ev('window.FengcunAudio.playing')) === false, 'pagehide（进 bfcache）之后静音');
await ev(`window.dispatchEvent(new Event('pageshow')); 1`);
await sleep(400);
const restored = await ev('({ playing: window.FengcunAudio.playing, state: window.FengcunAudio.state })');
check(restored.playing === true && restored.state === 'running',
  'pageshow 退回来之后又响了', JSON.stringify(restored));
const afterRestore = await hear(`window.FengcunAudio.sfx('click')`);
check(afterRestore.n > 0, '退回来之后 sfx 也能出声', `零件数=${afterRestore.n}`);

console.log('\n=== 4b. 切走 → 关声音 → 回来 → 开声音：不许卡成「开着却没声」 ===');
/* 这条路是真会走到的：切到别的标签页、顺手把声音关了、回来再开。
   回来那一下引擎见 on=false 就不 resume，ctx 停在 suspended 上 ——
   要是「开声音」时不自己 resume，就成了「开关亮着、一点声音都没有」的死局。 */
await ev(`document.getElementById('sound').click()`);
await sleep(200);
await ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'hidden'; } });
  document.dispatchEvent(new Event('visibilitychange')); 1`);
await sleep(500);
await ev(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'visible'; } });
  document.dispatchEvent(new Event('visibilitychange')); 1`);
await sleep(300);
await ev(`document.getElementById('sound').click()`);
await sleep(300);
const revived = await ev('({ playing: window.FengcunAudio.playing, state: window.FengcunAudio.state, on: window.FengcunAudio.isOn() })');
check(revived.on === true && revived.playing === true && revived.state === 'running',
  '开关打开之后真的能出声（ctx 自己 resume 回来了）', JSON.stringify(revived));
const afterRevive = await hear(`window.FengcunAudio.sfx('click')`);
check(afterRevive.n > 0, '而且真的合成得出来', `零件数=${afterRevive.n}`);

console.log('\n=== 5. 不单调之一：形状变体（同一件事备了不止一支写法）===');
const stamps = await hearMany(`window.FengcunAudio.sfx('stamp', 'yes')`, 10);
const stampShapes = new Set(stamps.map((r) => r.shape));
const stampSigs = new Set(stamps.map((r) => r.sig));
check(stampShapes.size >= 2, '落印十次，形状不止一种（三支底子在那里换）',
  `${stampShapes.size} 种形状 / ${stampSigs.size} 条签名`);
check(stampSigs.size >= 4, '十次的精确签名各不相同（变体 + 抖动一起在起作用）', `${stampSigs.size} 条`);
check(stamps.every((r) => r.n > 0), '每一次都真的出了声（没被节流误伤）', JSON.stringify(stamps.map((r) => r.n)));

/* hover 有 110ms 节流：间隔要给够，不然量到的「空签名」是被节流吃掉的，
   形状集合里会多出一个空串，断言就变成在数错的东西。 */
const hovers = await hearMany(`window.FengcunAudio.sfx('hover')`, 8, 160);
const hoverShapes = hovers.map((r) => r.shape).filter(Boolean);
check(hovers.every((r) => r.n > 0), '八次悬停都落下来了（间隔给够了）', JSON.stringify(hovers.map((r) => r.n)));
check(new Set(hoverShapes).size >= 2, '悬停也有多种音色（不是一声「嗒」打天下）',
  JSON.stringify([...new Set(hoverShapes)]));

console.log('\n=== 6. 不单调之二：参数抖动（同一支写法也不给两个一模一样的）===');
const listens = await hearMany(`window.FengcunAudio.sfx('listen')`, 6);
const listenShapes = new Set(listens.map((r) => r.shape));
const listenFreqs = new Set(listens.map((r) => r.sig));
check(listenShapes.size === 1, '先确认 listen 只有一支写法（形状是固定的）', JSON.stringify([...listenShapes]));
check(listenFreqs.size >= 4, '同一支写法连响六次，频率每次都不一样（抖动在工作）', `${listenFreqs.size} 条签名`);

console.log('\n=== 7. 高频音必须节流（鼠标扫过一排按钮那种）===');
const burst = await hear(`(function(){ for (var i = 0; i < 12; i++) window.FengcunAudio.sfx('hover'); return 1; })()`);
check(burst.n > 0 && burst.n <= 6, '12 次同步 hover 只落下一两次，不是十二声',
  `零件数=${burst.n}（一次 hover 是 1 个零件）`);
await sleep(150);
const burst2 = await hear(`(function(){ window.FengcunAudio.sfx('drag'); window.FengcunAudio.sfx('drag'); window.FengcunAudio.sfx('drag'); return 1; })()`);
check(burst2.n <= 2, '拖动同样节流（拖一卷不会响上百次）', `零件数=${burst2.n}`);

console.log('\n=== 8. 补的那些声音真的接上去了（点灯 / 搜索 / 换卷）===');
const lamp = await hear(`document.getElementById('lamp').click()`);
check(lamp.n > 0 && lamp.shape.indexOf('o:sine') >= 0, '点灯有芯爆与暖音（wickOn 接上了）', JSON.stringify(lamp));
await sleep(200);
const lampOff = await hear(`document.getElementById('lamp').click()`);
check(lampOff.n > 0, '关灯也有一声（wickOff）', JSON.stringify(lampOff));
await sleep(200);
const findOpen = await hear(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))`);
check(findOpen.n > 0, '搜剧本面板打开有声音', JSON.stringify(findOpen));
await sleep(200);
const findClose = await hear(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
check(findClose.n > 0, '收面板也有一声', JSON.stringify(findClose));
await sleep(250);
const seek = await hear(`document.getElementById('next').click()`);
check(seek.n > 0, '换卷有声音（slide）', JSON.stringify(seek));

console.log('\n=== 9. 全程无 JS 报错 ===');
check(((await ev('window.__errs')) || []).length === 0, '没有 JS 报错', JSON.stringify(await ev('window.__errs')));

console.log('');
if (fails.length) { console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`); }
else { console.log('[OK] 离开页面静音 / 声音不单调 / 高频不刷屏，三件都对'); }
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
