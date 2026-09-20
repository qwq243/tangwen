// 首访「夜馆规矩」分步引导体检（2026-09-20 晚改版：单卡七条 → 四卡翻页）。
//
// 这次改版要钉住的点：
// 1. 首访真的会弹，四张卡，圆点 / 计数 / 按钮文案跟着步子走；
// 2. 翻页四条路都通：主按钮 / 左右方向键 / 圆点直达 / 卡面左右滑动；
// 3. 「跳过」必须是显式入口（旧版只能点空白处或 Esc，不可发现）；
// 4. 走完 / 跳过 / Esc 三条出路都落 fengcun.tour=1，刷新不再弹（老玩家不受打扰）；
// 5. 紧凑态 390×730：整卡放进视口、卡内不需要滚动、没有横向溢出；
//    翻页全程卡面高度不跳（.tour-body 的 min-height 必须真撑住）。
//
// 注意：本探针【不能】注入 seed.mjs —— 它的职责就是把引导跳掉，
// 而引导本身就是这里的被测对象。这里只注入「关声音」那一半。
//
// 用法：node tools/tour-check.mjs [url]   （默认 http://127.0.0.1:8765/，1280×800 起步）
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './chrome-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const OUT = join(PROJ, 'tmp', '_shot');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = (process.argv.slice(2).filter((a) => !a.startsWith('--'))[0]) || 'http://127.0.0.1:8765/';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

// 只关声音，不跳引导 —— 引导本身就是被测对象
const SEED_SOUND_ONLY = `(function(){ try { localStorage.setItem('fengcun.sound','0'); } catch(_){} })();`;

const PROBE = `(function(){
  function vis(e){ var cs=getComputedStyle(e);
    if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) return false;
    var r=e.getBoundingClientRect(); return r.width>=1 && r.height>=1; }
  var tour=document.getElementById('tour');
  var sheet=document.querySelector('.tour-sheet');
  var body=document.getElementById('tourBody');
  var cards=[].slice.call(document.querySelectorAll('#tourBody .tour-card'));
  var dots=[].slice.call(document.querySelectorAll('#tourDots .tour-dot'));
  var sr=sheet.getBoundingClientRect(), br=body.getBoundingClientRect();
  return {
    open: !!(tour && tour.hidden===false),
    sheet: {w:Math.round(sr.width), h:Math.round(sr.height), top:Math.round(sr.top),
            bottom:Math.round(sr.bottom), scrollH:sheet.scrollHeight, clientH:sheet.clientHeight},
    bodyH: Math.round(br.height),
    cardOn: cards.findIndex(function(c){ return !c.hidden; }),
    nCards: cards.length,
    nDots: dots.length,
    count: (document.getElementById('tourCount')||{}).textContent,
    go: ((document.getElementById('tourGo')||{}).textContent||'').trim(),
    goShown: vis(document.getElementById('tourGo')),
    skipShown: vis(document.getElementById('tourSkip')),
    dotOn: dots.findIndex(function(d){ return d.classList.contains('on'); }),
    seen: (function(){ try { return localStorage.getItem('fengcun.tour'); } catch(_){ return '?'; } })(),
    hint: (document.getElementById('hint')||{}).textContent,
    vw: innerWidth, vh: innerHeight,
    docScrollW: document.documentElement.scrollWidth,
    errs: (window.__errs||[]).slice(0,4)
  };
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'tour_' + PORT)}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

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
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED_SOUND_ONLY });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" });

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};
const openPage = async (w, h) => {
  await size(w, h);
  await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
  await sleep(4200);
};
const key = (k) => ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`);
const swipe = async (from, to) => {
  await ev(`document.querySelector('.tour-sheet').dispatchEvent(new PointerEvent('pointerdown',{clientX:${from},bubbles:true}))`);
  await ev(`document.querySelector('.tour-sheet').dispatchEvent(new PointerEvent('pointerup',{clientX:${to},bubbles:true}))`);
  await sleep(350);
};
const bodyH = () => ev(`Math.round(document.getElementById('tourBody').getBoundingClientRect().height)`);

console.log('\n=== 1. 首访（1280×800）：引导要弹，四卡翻页 ===');
await openPage(1280, 800);
let r = await ev(PROBE);
console.log(`  open=${r.open} cardOn=${r.cardOn}/${r.nCards} dots=${r.nDots} count=${r.count} go=${r.go}`);
check(r.open === true, '首访弹引导');
check(r.nCards === 4 && r.nDots === 4, '四张卡、四个圆点', `cards=${r.nCards} dots=${r.nDots}`);
check(r.cardOn === 0 && r.dotOn === 0, '默认停在第一步');
check(r.count === '1 / 4', '计数 1 / 4', r.count);
check(r.go === '下一步', '按钮文案是「下一步」', r.go);
check(r.skipShown === true, '「跳过」是显式入口（看得见点得到）');
const h0 = await bodyH();
await shotTo('tour_1_desktop.png');

console.log('\n=== 2. 翻页四条路：按钮 / 方向键 / 圆点 / 滑动 ===');
await ev("document.getElementById('tourGo').click()"); await sleep(350);
r = await ev(PROBE);
check(r.cardOn === 1 && r.count === '2 / 4', '主按钮 -> 第二步', `cardOn=${r.cardOn} count=${r.count}`);
await key('ArrowRight'); await sleep(350);
r = await ev(PROBE);
check(r.cardOn === 2 && r.count === '3 / 4', '方向键右 -> 第三步', `cardOn=${r.cardOn} count=${r.count}`);
check(((await ev(`(document.querySelectorAll('#tourBody .tour-card')[2]||{}).textContent||''`)) || '').indexOf('不重要') >= 0,
  '第三步保留七档回答清单（判题档位改版时的同步点）');
await key('ArrowLeft'); await sleep(350);
r = await ev(PROBE);
check(r.cardOn === 1, '方向键左退回第二步');
await ev("document.querySelectorAll('#tourDots .tour-dot')[3].click()"); await sleep(350);
r = await ev(PROBE);
check(r.cardOn === 3 && r.dotOn === 3 && r.count === '4 / 4', '点圆点直达第四步', `count=${r.count}`);
check(r.go === '进馆', '最后一步按钮变「进馆」', r.go);
const h3 = await bodyH();
check(Math.abs(h3 - h0) <= 2, '翻页全程卡面高度不跳（min-height 撑住了）', `${h0} -> ${h3}`);
await ev("document.querySelectorAll('#tourDots .tour-dot')[0].click()"); await sleep(350);
await swipe(300, 238);
r = await ev(PROBE);
check(r.cardOn === 1, '卡面左滑 -> 翻到第二步（42px 阈值）', `cardOn=${r.cardOn}`);

console.log('\n=== 3. 走完 / 跳过 / Esc 三条出路 ===');
await ev("document.getElementById('tourGo').click()"); await sleep(300);   // 2 -> 3
await ev("document.getElementById('tourGo').click()"); await sleep(300);   // 3 -> 4
await ev("document.getElementById('tourGo').click()"); await sleep(300);   // 进馆
r = await ev(PROBE);
check(r.open === false, '走完四步关掉');
check(r.seen === '1', 'fengcun.tour=1 已落存档', 'seen=' + r.seen);
check((r.hint || '').length > 0, '关掉后给了一句操作提示', JSON.stringify(r.hint));
await openPage(1280, 800);
r = await ev(PROBE);
check(r.open === false && r.seen === '1', '刷新后不再弹（老玩家不受打扰）');
// 「跳过」
await ev("try{localStorage.clear()}catch(_){}");
await openPage(1280, 800);
r = await ev(PROBE);
check(r.open === true, '清存档后重新弹（给跳过测试用）');
await ev("document.getElementById('tourSkip').click()"); await sleep(300);
r = await ev(PROBE);
check(r.open === false && r.seen === '1', '「跳过」一键关掉并记档');
// Esc
await ev("try{localStorage.clear()}catch(_){}");
await openPage(1280, 800);
await key('Escape'); await sleep(300);
r = await ev(PROBE);
check(r.open === false && r.seen === '1', 'Esc 也能关');

console.log('\n=== 4. 紧凑态 390×730：整卡进屏、不内部滚动、不横向溢出 ===');
await ev("try{localStorage.clear()}catch(_){}");
await openPage(390, 730);
r = await ev(PROBE);
console.log(`  sheet=${JSON.stringify(r.sheet)} vw=${r.vw} vh=${r.vh}`);
check(r.open === true, '手机首访照样弹');
check(r.sheet.bottom <= r.vh && r.sheet.top >= 0, '整卡放进视口（上下不出界）', `bottom ${r.sheet.bottom} / vh ${r.vh}`);
check(r.sheet.scrollH <= r.sheet.clientH + 1, '卡内不需要滚动（旧版七条在这里必滚动）', `scrollH ${r.sheet.scrollH} / clientH ${r.sheet.clientH}`);
check(r.docScrollW <= r.vw, '页面没有横向溢出', `doc ${r.docScrollW} / vw ${r.vw}`);
check(r.skipShown && r.goShown, '跳过 / 主按钮在紧凑态都点得到');
await shotTo('tour_2_compact.png');
await swipe(300, 238);
r = await ev(PROBE);
check(r.cardOn === 1, '紧凑态：卡面左滑翻页也通', `cardOn=${r.cardOn}`);

check((r.errs || []).length === 0, '全程无 JS 报错', JSON.stringify(r.errs));

console.log('');
if (fails.length) { console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`); }
else { console.log('[OK] 全部通过'); }
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
