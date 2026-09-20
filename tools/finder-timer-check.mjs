// 搜剧本 + 计时（停表）的自查。两件事都在 `app.js`，也都在三套布局里各有出口，
// 所以必须两套布局各验一遍 —— 请求里那句「出口不许 display:none 掉」就是为此写的。
//
// 断言:
//   A 宽屏（横版 1440×900）
//     A1 搜剧本常驻在顶部（顶栏区、不压印章 / 画卷 / 记录面板）
//     A2 敲卷名出结果，点结果跳到那一卷（标题 + 卷号都变），列表收起
//     A3 敲卷号也能搜到（02 / 2 都认）
//     A4 已结案的卷在列表里带「已结案」
//   B 紧凑态（360×640；门槛降到 +180 后 390×725 已是画廊）
//     B1 收成顶栏一枚放大镜（不是把功能藏了：按钮可见、点得到、在顶栏那一行）
//     B2 点开是整屏浮层，输入框可见并聚焦，Esc / 点空白能收
//     B3 浮层里点结果照样跳卷，并且收起
//   C 计时
//     C1 长时间没操作 -> 停表：画廊态 #elapsed 带「∥」、紧凑态 #pauseTag 那枚小签出来
//     C2 停表那段**不计**：动一下接着走，用时不会因为暂停而涨
//     C3 恢复之后标记收起（两套布局都要）
//   D 汤色（清汤 / 红汤 / 黑汤）
//     D1 每卷都带汤色，且只在三档里（跟 /api/puzzles 对）
//     D2 卷面那枚印跟接口对得上（**翻四卷各看一次** —— 只看第一卷的话
//        「换了卷印没跟着换」这种错就漏了）
//     D3 K 打开面板，第一行是汤色筛选四枚；点「清汤」只列清汤、行行挂清汤印
//     D4 筛选行**没把 .finder 撑高**（A1 量的就是它的高度与压不压画卷）
//     D5 汤色与敲字能合用；筛空了说清是「清汤里没有圣诞」，不是「没有这一卷」
//     D6 汤色进了搜索索引：直接敲「黑汤」也能筛出这一类
//     D7 紧凑态浮层里筛选行不横向溢出，且照样能筛
//
// 用法: node tools/finder-timer-check.mjs [url]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tmp', '_shot');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9844;

// 探针不真等一分钟：app.js 认 localStorage 里这个阈值（见 IDLE_MS 那段注释）
const IDLE_TEST_MS = 600;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'ftc_' + Date.now())}`,
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
const open = async (extra) => {
  if (extra) await ev(extra);
  await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
  await sleep(4200);
};
const type = async (text) => ev(`(function(){
  var el=document.getElementById('findInput'); el.focus(); el.value=${JSON.stringify(text)};
  el.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
const box = (sel) => `(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  var cs=getComputedStyle(e); var r=e.getBoundingClientRect();
  return { disp:cs.display, vis:cs.visibility, op:cs.opacity, x:Math.round(r.x), y:Math.round(r.y),
           right:Math.round(r.right), bottom:Math.round(r.bottom), w:Math.round(r.width), h:Math.round(r.height) }; })()`;

const fails = [];
let checks = 0;
const check = (ok, what, detail) => {
  checks++;
  if (!ok) fails.push(what + (detail ? ' — ' + detail : ''));
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
};
const shown = (b) => !!b && b.disp !== 'none' && b.vis !== 'hidden' && b.op !== '0' && b.w > 1 && b.h > 1;
const overlap = (a, b) => a && b && a.bottom > b.y + 1 && a.y < b.bottom - 1 && a.right > b.x + 1 && a.x < b.right - 1;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" });

/* ---------------- A. 宽屏 ---------------- */
console.log('\n=== A. 宽屏 1440×900：顶部常驻搜索 ===');
await size(1440, 900);
await open();
// 卷目要在 navigate 之后才拉得到（about:blank 上没有同源接口）
const puzzles = await ev("fetch('/api/puzzles').then(r=>r.json()).then(d=>d.puzzles.map((p,i)=>({i:i,id:p.id,title:p.title})))");
check(Array.isArray(puzzles) && puzzles.length > 7, '拿到卷目', `${puzzles && puzzles.length} 卷`);
let f = await ev(box('.finder'));
let fb = await ev(box('.finder-box'));
let seal = await ev(box('.seal'));
let win = await ev(box('.frame-window'));
let dossier = await ev(box('.dossier'));
console.log(`  finder ${JSON.stringify(f)}`);
check(shown(fb), '搜索输入条常驻可见');
check(f.y < 900 * 0.2, '落在顶部一条带里', `y=${f.y}`);
check(!overlap(f, seal), '不压左上角的「汤问」印');
check(!overlap(f, win), '不压中央画卷');
check(!overlap(f, dossier), '不压右侧询问记录');

await type('期末');
await sleep(400);
/* 取结果行一律用 `li[data-i]`：`#findList` 里还住着两个不是结果的 li ——
   第一行的汤色筛选行（li.ftags）和空态那句（li.empty）。
   原先这里写的是 `#findList li`，加了筛选行之后取到的是筛选行本身，
   于是 A2/A3/A4/B3 一起变红 —— 红得对（选择器选错了东西），行为其实没坏。 */
let hits = await ev("Array.from(document.querySelectorAll('#findList li[data-i]')).map(li=>li.textContent)");
check(hits.length >= 1 && hits[0].indexOf('期末考试') >= 0, '敲卷名出结果', JSON.stringify(hits.slice(0, 3)));
await shotTo('finder_1_wide_list.png');
await ev("document.querySelector('#findList li[data-i]').click()");
await sleep(900);
let now = await ev("({no:document.getElementById('no').textContent, title:document.getElementById('title').textContent, listHidden:document.getElementById('findList').hidden})");
check(now.title === '期末考试', '点结果跳到那一卷', JSON.stringify(now));

const target = puzzles[6]; // 第 07 卷
await type(String(target.i + 1));
await sleep(400);
hits = await ev("Array.from(document.querySelectorAll('#findList li[data-i]')).map(li=>li.textContent)");
check(hits.length >= 1 && hits[0].indexOf(target.title) >= 0, '敲卷号也能搜到', `07 -> ${JSON.stringify(hits[0])}`);
await ev("document.querySelector('#findList li[data-i]').click()");
await sleep(900);
now = await ev("({no:document.getElementById('no').textContent, title:document.getElementById('title').textContent})");
check(now.title === target.title, '卷号结果能跳卷', JSON.stringify(now));

/* 已结案标记：往存档里塞一条 solved 再进来。
   必须在新文档里注入（Page.addScriptToEvaluateOnNewDocument）—— 直接在旧页面写
   localStorage 是白写：离开页面时 pagehide 会拿内存里的存档覆盖一次，注入的那条就没了。 */
const solvedSeed = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){ try { var p=JSON.parse(localStorage.getItem('fengcun.progress')||'{}');
    p.solved=[${JSON.stringify(puzzles[4].id)}]; localStorage.setItem('fengcun.progress', JSON.stringify(p)); } catch(_){} })();` });
await open();
console.log(`  （注入 solved=[${puzzles[4].id}]，进页面时读到的存档 solved=${await ev("JSON.parse(localStorage.getItem('fengcun.progress')||'{}').solved")}）`);
await type(puzzles[4].title.slice(0, 2));
await sleep(400);
const badge = await ev("(function(){ var li=document.querySelector('#findList li[data-i]'); return li? {t:li.textContent, html:li.outerHTML, ok:!!li.querySelector('.ok')} : null; })()");
check(badge && badge.ok, '已结案的卷挂「已结案」', JSON.stringify(badge));
await shotTo('finder_2_wide_solved.png');
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: solvedSeed.identifier });

/* ---------------- B. 紧凑态 ---------------- */
/* 2026-09-20 画廊门槛从 +269 降到 +180，390×725 变成画廊了，
   紧凑态样本换 360×640（1.375*360+180=675 > 640，仍是紧凑态）。 */
console.log('\n=== B. 紧凑态 360×640：收成放大镜，点开是浮层 ===');
await size(360, 640);
await open();
const cls0 = await ev("document.querySelector('.stage').className");
check(/compact/.test(cls0), '360×640 走紧凑态', cls0);
f = await ev(box('.finder'));
fb = await ev(box('.finder-box'));
let fold = await ev(box('.find-fold'));
let titleBox = await ev(box('#title'));
console.log(`  finder ${JSON.stringify(f)}  fold ${JSON.stringify(fold)}`);
check(!shown(fb), '折叠态不摆整条输入框');
check(shown(fold), '顶栏有那枚放大镜（功能没被藏掉）');
check(f.y < 60 && f.right <= 360, '放大镜在顶栏那一行', `y=${f.y} right=${f.right}`);
check(!overlap(f, titleBox), '不压卷名', `finder ${f.x}-${f.right}  title ${titleBox.x}-${titleBox.right}`);
await shotTo('finder_3_compact_fold.png');

await ev("document.getElementById('findFold').click()");
await sleep(500);
const opened = await ev("({finding:document.querySelector('.stage').classList.contains('finding'), " +
  "input:getComputedStyle(document.getElementById('findInput')).display, " +
  "focused:document.activeElement===document.getElementById('findInput')})");
f = await ev(box('.finder'));
const typedBox = await ev(box('.finder-box'));
check(opened.finding, '点开进入浮层态');
check(shown(typedBox) && opened.input !== 'none', '浮层里输入框可见');
check(opened.focused, '浮层自动聚焦（手机上点开就能打字）');
check(f.y <= 1 && f.h >= 600, '浮层铺满可视区', JSON.stringify({ y: f.y, h: f.h }));
await shotTo('finder_4_compact_layer.png');

await type('歌声');
await sleep(400);
hits = await ev("Array.from(document.querySelectorAll('#findList li[data-i]')).map(li=>li.textContent)");
const listBox = await ev(box('.find-list'));
check(hits.length >= 1 && hits[0].indexOf('歌声') >= 0, '浮层里能搜到', JSON.stringify(hits.slice(0, 2)));
check(shown(listBox), '浮层里列表可见', JSON.stringify(listBox));
const titleBefore = await ev("document.getElementById('title').textContent");
await ev("document.querySelector('#findList li[data-i]').click()");
await sleep(900);
const after = await ev("({title:document.getElementById('title').textContent, finding:document.querySelector('.stage').classList.contains('finding'), fold:getComputedStyle(document.querySelector('.find-fold')).display})");
check(after.title !== titleBefore && after.title === '歌声', '浮层里点结果能跳卷', `${titleBefore} -> ${after.title}`);
check(!after.finding, '跳完自动收起浮层');

/* Esc 与点空白也要能收 */
await ev("document.getElementById('findFold').click()");
await sleep(400);
await ev("document.querySelector('.finder').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
await sleep(300);
check(!(await ev("document.querySelector('.stage').classList.contains('finding')")), '点空白收起浮层');
await ev("document.getElementById('findFold').click()");
await sleep(300);
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
await sleep(300);
check(!(await ev("document.querySelector('.stage').classList.contains('finding')")), 'Esc 收起浮层');

/* ---------------- D. 汤色 ---------------- */
/* 汤色（清汤 / 红汤 / 黑汤）来自知乎《海龟汤：一场脑洞大开的推理游戏之旅》第四节的
   「海龟汤常见分类」（原文三句：清汤无恐怖无死亡 / 红汤有尸体命案 / 黑汤重口味血腥惊悚慎玩）。
   取值与口径在 puzzles.json 的 soup 字段和 tools/soup.py。
   这里钉四件事：每卷都带汤色、卷面那枚印跟接口对得上、筛选行能按类列卷、
   以及**筛选行不把 .finder 撑高** —— A1 量的就是 .finder 的高度和它压不压画卷，
   所以 D 里再量一次前后高度，别让新加的那一行把它顶下去。 */
console.log('\n=== D. 汤色（清汤 / 红汤 / 黑汤）===');
await size(1440, 900);
await open();
const soupOf = await ev("fetch('/api/puzzles').then(r=>r.json()).then(d=>d.puzzles.map(p=>p.soup))");
const soupCount = soupOf.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});
check(soupOf.length > 30 && soupOf.every((s) => s === '清汤' || s === '红汤' || s === '黑汤'),
  '每一卷都带汤色（且只在三档里）', JSON.stringify(soupCount));

// 卷面那枚印跟接口对得上。翻四卷各看一次 —— 只看第一卷的话「换了卷印没跟着换」这种错就漏了
// 起点不能假设是第 01 卷：open() 会 restoreCursor()，恢复到上一组停在的那一卷。
// 所以先读 #no 把当前卷序读出来，再拿它去索引接口给的 soup 数组。
let plateOk = true; const plateSeen = [];
const idx0 = Number(await ev("document.getElementById('no').textContent")) - 1;
for (let i = 0; i < 4; i++) {
  const v = await ev("(function(){ var s=document.getElementById('soup');" +
    " return { t:s.textContent, a:s.dataset.soup, hidden:s.hidden, title:s.getAttribute('title') }; })()");
  const want = soupOf[(idx0 + i) % soupOf.length];
  plateSeen.push(v.t + (v.t === want ? '' : '≠' + want));
  if (v.hidden || v.t !== want || v.a !== want || !v.title) plateOk = false;
  await ev("document.getElementById('next').click()");
  await sleep(700);
}
check(plateOk, `卷面的汤色印跟 /api/puzzles 的 soup 对得上（从第 ${idx0 + 1} 卷起翻四卷）`, JSON.stringify(plateSeen));
await shotTo('soup_1_wide_plate.png');

// 筛选行：面板的第一行，四枚
await open();
await ev("document.getElementById('findFold').click()");
await sleep(400);
const tagRow = await ev("(function(){ var b=document.querySelectorAll('#findList button[data-soup]');" +
  " var r=document.querySelector('#findList li.ftags');" +
  " return { n:b.length, labels:Array.from(b).map(x=>x.textContent.trim())," +
  "   row: r ? { disp:getComputedStyle(r).display, h:Math.round(r.getBoundingClientRect().height) } : null }; })()");
check(tagRow.n === 4 && !!tagRow.row && tagRow.row.disp !== 'none',
  'K 打开面板，第一行是汤色筛选（四枚：全部 / 清汤 / 红汤 / 黑汤）', JSON.stringify(tagRow.labels));
// 刚打开时亮着的是「全部」，那下面就该列全部 —— 写「没有这一卷」是自相矛盾的
const openedN = await ev("document.querySelectorAll('#findList li[data-i]').length");
check(openedN === soupOf.length, '空查询打开＝「全部」，列的就是全部卷', `${openedN} 卷`);
await shotTo('soup_2_wide_tags.png');

const finderH0 = (await ev(box('.finder'))).h;
await ev(`document.querySelector('#findList button[data-soup="清汤"]').click()`);
await sleep(400);
const qing = await ev("(function(){ var rows=Array.from(document.querySelectorAll('#findList li[data-i]'));" +
  " return { n:rows.length, marks:Array.from(document.querySelectorAll('#findList li[data-i] .sp')).map(e=>e.textContent)," +
  "   on:Array.from(document.querySelectorAll('#findList button.on')).map(e=>e.dataset.soup) }; })()");
check(qing.n === soupCount['清汤'] && qing.marks.length === qing.n && qing.marks.every((m) => m === '清汤')
  && qing.on.join() === '清汤',
  '点「清汤」只列清汤（行行挂清汤印）', JSON.stringify({ 卷数: qing.n, 选中: qing.on }));
check((await ev(box('.finder'))).h === finderH0, '筛选行没把 .finder 撑高（不压画卷那条断言还站得住）', `h=${finderH0}`);
await shotTo('soup_3_wide_qing.png');

// 汤色 + 敲字一起用
await ev(`document.querySelector('#findList button[data-soup="黑汤"]').click()`);
await sleep(300);
await type('圣诞');
await sleep(400);
const hei = await ev("Array.from(document.querySelectorAll('#findList li[data-i]')).map(li=>li.querySelector('.t').textContent)");
check(hei.length > 0 && hei.every((t) => t.indexOf('圣诞') >= 0),
  '黑汤里搜「圣诞」只剩黑汤里的那几卷', JSON.stringify(hei));

// 筛空了不能只说「没有这一卷」—— 得说清是汤色筛掉的，不然人以为是库里没有
await ev(`document.querySelector('#findList button[data-soup="清汤"]').click()`);
await sleep(300);
const empty = await ev("(document.querySelector('#findList li.empty')||{}).textContent");
check((empty || '').indexOf('清汤') >= 0 && (empty || '').indexOf('圣诞') >= 0,
  '筛空了说清是「清汤里没有圣诞」', JSON.stringify(empty));

// 汤色也进了搜索索引：直接敲「黑汤」两个字就该筛出这一类
await ev(`document.querySelector('#findList button[data-soup=""]').click()`);
await sleep(300);
await type('黑汤');
await sleep(400);
const byWord = await ev("document.querySelectorAll('#findList li[data-i]').length");
check(byWord === soupCount['黑汤'], '敲「黑汤」也能筛到这一类', `${byWord} 卷`);

/* 紧凑态的筛选行：浮层里也是同一个 #findList，量一下它在窄屏上有没有横向溢出 */
await size(360, 640);
await open();
await ev("document.getElementById('findFold').click()");
await sleep(500);
const cTags = await ev("(function(){ var r=document.querySelector('#findList li.ftags');" +
  " var b=document.querySelector('#findList button[data-soup]');" +
  " return r ? { w:Math.round(r.getBoundingClientRect().width), right:Math.round(r.getBoundingClientRect().right)," +
  "   h:Math.round(r.getBoundingClientRect().height), btn: b?Math.round(b.getBoundingClientRect().width):null } : null; })()");
check(!!cTags && cTags.right <= 360, '紧凑态浮层里筛选行不横向溢出', JSON.stringify(cTags));
await ev(`document.querySelector('#findList button[data-soup="黑汤"]').click()`);
await sleep(400);
const cHei = await ev("document.querySelectorAll('#findList li[data-i]').length");
check(cHei === soupCount['黑汤'], '紧凑态里也能按汤色筛', `${cHei} 卷`);
await shotTo('soup_4_compact_tags.png');

/* ---------------- C. 计时 ---------------- */
console.log(`\n=== C. 计时（把阈值临时压到 ${IDLE_TEST_MS}ms 才验得动停表）===`);
const seedIdle = `(function(){ localStorage.setItem('fengcun.idleMs','${IDLE_TEST_MS}'); return 1; })()`;
const tap = "window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))";
const toSec = (s) => { const m = s.replace('∥ ', '').split(':'); return Number(m[0]) * 60 + Number(m[1]); };

async function clockCase(label, w, h, shot) {
  await size(w, h);
  await open(seedIdle);
  // 阈值只有 600ms，光加载就不止 600ms 了 —— 所以先点一下「起表」，再看它自己停
  await ev(tap);
  await sleep(300);
  const a = await ev("({tag:document.getElementById('pauseTag').hidden, elapsed:document.getElementById('elapsed').textContent})");
  check(a.tag === true && a.elapsed.indexOf('∥') < 0, `${label} 一操作表就在走`, JSON.stringify(a));

  await sleep(2400); // 这段时间一次操作都没有
  const b = await ev("({tag:document.getElementById('pauseTag').hidden, tagText:document.getElementById('pauseTag').textContent, elapsed:document.getElementById('elapsed').textContent, elapsedDisp:getComputedStyle(document.getElementById('elapsed')).display, toast:document.querySelector('.hint').textContent, toastOn:document.querySelector('.hint').classList.contains('show')})");
  check(b.tag === false, `${label} 久没操作就停表（标记出来）`, JSON.stringify({ tag: b.tag, 签: b.tagText, 表: b.elapsed }));
  check(b.elapsed.indexOf('∥') === 0, `${label} 画廊态 #elapsed 带「∥」`, b.elapsed);
  if (b.toastOn) check(b.toast.indexOf('停表') >= 0, `${label} 有「停表」提示`, b.toast);
  else check(true, `${label} 提示 toast 已过期（画廊态出口是 #elapsed 的「∥」，不影响判定）`, b.toast);
  await shotTo(shot);

  await sleep(2200); // 停表期间再空转 2.2 秒
  await ev(tap);
  await sleep(300);
  const c = await ev("({tag:document.getElementById('pauseTag').hidden, elapsed:document.getElementById('elapsed').textContent})");
  check(c.tag === true, `${label} 一动就接着走（标记收起）`, JSON.stringify(c));
  const gain = toSec(c.elapsed) - toSec(b.elapsed);
  check(gain <= 1, `${label} 停表那 2.2 秒没被算进去`, `${b.elapsed} -> ${c.elapsed}（涨 ${gain}s）`);
}

await clockCase('画廊态 390×844', 390, 844, 'timer_1_paused_gallery.png');
console.log('  — 紧凑态 360×640：#elapsed 本来就是 display:none，停表出口只剩 #pauseTag —');
await size(360, 640);
await open(seedIdle);
await ev(tap);
await sleep(2400);
const cp = await ev("({tag:document.getElementById('pauseTag').hidden, elapsedDisp:getComputedStyle(document.getElementById('elapsed')).display, cls:document.querySelector('.stage').className})");
check(/compact/.test(cp.cls), '360×640 走紧凑态', cp.cls);
check(cp.tag === false, '紧凑态停表有出口（#pauseTag 出来了）', JSON.stringify(cp));
check(cp.elapsedDisp === 'none', '（对照：#elapsed 在紧凑态本来就藏着）', cp.elapsedDisp);
await shotTo('timer_3_paused_compact.png');
await ev(tap);
await sleep(300);
check((await ev("document.getElementById('pauseTag').hidden")) === true, '紧凑态一动也接着走');

const errs = await ev("window.__errs||[]");
check(errs.length === 0, '全程无 JS 报错', JSON.stringify(errs));

console.log('');
if (fails.length) {
  console.log(`[FAIL] ${fails.length} / ${checks} 项没过：`);
  fails.forEach((x) => console.log('   - ' + x));
} else {
  console.log(`[OK] 全部通过（${checks} 项断言）`);
}
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
