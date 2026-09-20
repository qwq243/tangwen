// 搜剧本「点一下出分类」+ 求灯「提示落在记录方框第一行、当场亮一记」的自查。
//
// 为什么单开一条，跟 finder-timer-check / hint-check 不重叠：
//   finder-timer-check 测的是「敲字之后」那条路（它自己先 el.value= 再派 input 事件），
//   hint-check 测的是 `.hint-line` 这个出口「看不看得见、刷新后还在不在」。这两条谁都没覆盖：
//
//   1. 点一下搜索框（或放大镜那枚图标），下面那两行分类（汤色 / 难度）就要出来。
//      以前只有敲字 / 按 K 才出来，光点一下什么都不发生 —— 没人知道下面有分类可挑。
//   2. 求灯那句提示**放在哪儿、点下去当场有没有反应**。
//      2026-09-20 用户实报：「提示的内容不明显，可以直接放在我们历史记录方框的上面，
//      但是不要把汤面挡住了」。原来它是屏幕正中一件浮层（#hintCenter）—— 手机上正好压着
//      汤面 —— 现在删了，提示只在记录方框第一行，点下去靠那一行自己亮一记（.lit）。
//      这里就钉三条：**在记录方框第一行**、**不压汤面**、**点下去真的亮**。
//
// ⚠️ 点搜索框**必须用真鼠标事件**（CDP 的 Input.dispatchMouseEvent）。
//    `el.click()` 不会让输入框获得焦点，于是 focus 那条路根本不走 ——
//    拿它测「点搜索框出分类」会假红：实现是对的，探针是假的（踩过一次）。
//
// 用法：node tools/finder-hint-check.mjs [url] [宽] [高]
// 默认 http://127.0.0.1:8765/ 1440 900（分段里自己切到紧凑态 390×640）。
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
/* 画廊态那个尺寸；紧凑态那一段自己切到 390×640（390×640 一定落在紧凑态）。 */
const W = Number(args[1] || 1440);
const H = Number(args[2] || 900);
const COMPACT_W = 390, COMPACT_H = 640;

// 假提示：一句「掌灯人口吻」，带一个不会跟界面别的文字撞车的水印词
const MARK = '绕开字面';
const FAKE_HINT = `灯下看了看：这一层要${MARK}，先问那个人当时是不是真的在场。`;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

/* 一个探针里要量的东西都在这儿。提示那几条量的是**位置关系**：
   它在记录方框里、在记录列表之上、跟汤面与底栏都不相交 —— 「别挡住汤面」是用户的原话，
   所以这里不是「大概没挡」，是矩形相交判定。 */
const PROBE = `(function(){
  function cs(e){ return getComputedStyle(e); }
  function vis(e){ var s=cs(e);
    if(s.display==='none'||s.visibility==='hidden') return false;
    var r=e.getBoundingClientRect(); return r.width>=1 && r.height>=1; }
  function op(e){ return parseFloat(cs(e).opacity); }
  function box(sel){ var e=document.querySelector(sel); if(!e) return null; var r=e.getBoundingClientRect();
    return {shown:vis(e)&&op(e)>0.05, op:+op(e).toFixed(2), disp:cs(e).display,
            x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
            bottom:Math.round(r.bottom), text:(e.textContent||'').slice(0,48)}; }
  function rect(e){ return e? e.getBoundingClientRect():null; }
  function hit(a,b){ return !!(a&&b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top); }
  var list=document.getElementById('findList');
  var ftags=document.querySelector('#findList li.ftags');
  var soupBtns=[].slice.call(document.querySelectorAll('#findList button[data-soup]'));
  var diffBtns=[].slice.call(document.querySelectorAll('#findList button[data-diff]'));
  var rows=[].slice.call(document.querySelectorAll('#findList li[data-i]'));
  var line=document.getElementById('hintLine');
  var read=document.querySelector('.read');
  var dossier=document.querySelector('.dossier');
  var dock=document.querySelector('.dock');
  var ledger=document.getElementById('ledger') || document.querySelector('.ledger');
  /* 屏幕上写着这句提示的每一件（只留最深的那个元素，免得把 body / .stage 也算进来） */
  function places(needle){
    var out=[];
    var all=document.querySelectorAll('body *');
    for (var i=0;i<all.length;i++){
      var e=all[i], t=e.textContent||'';
      if (t.indexOf(needle)<0) continue;
      if (e.classList && e.classList.contains('sr-verdict')) continue;   // 读屏专用那件不算看得见
      var deeper=false;
      for (var j=0;j<e.children.length;j++){ if((e.children[j].textContent||'').indexOf(needle)>=0){ deeper=true; break; } }
      if (deeper) continue;
      if (!vis(e)) continue;
      var r=e.getBoundingClientRect();
      out.push({cls:(e.className||e.tagName)+'', x:Math.round(r.x), y:Math.round(r.y),
                w:Math.round(r.width), h:Math.round(r.height),
                inLine: !!(e.closest && e.closest('#hintLine')),
                overRead: hit(r, rect(read)), overDock: hit(r, rect(dock)) });
    }
    return out;
  }
  var lineR = rect(line);
  return {
    cls:(document.querySelector('.stage')||{}).className, vw:innerWidth, vh:innerHeight,
    listHidden:list? list.hidden : null,
    /* 分类 chip 的个数：汤色那组含一枚共用的「全部」（data-soup=""），难度那组没有 ——
       所以是 4 + 3 = 7。断言里别写成 6。 */
    ftagCount: soupBtns.length + diffBtns.length,
    ftagShown: !!ftags && vis(ftags),
    soupVals: soupBtns.map(function(b){ return b.dataset.soup; }),
    diffVals: diffBtns.map(function(b){ return b.dataset.diff; }),
    rowCount: rows.length,
    rowsAllMatch: rows.every(function(li){
      var sp=li.querySelector('i.sp'); return sp && sp.textContent==='清汤'; }),
    inputValue: (document.getElementById('findInput')||{}).value,
    inputFocused: document.activeElement===document.getElementById('findInput'),
    hintLine: box('#hintLine'),
    /* 那句提示自己的那一格。**不要拿 #hintLine 的 textContent 去比这句话** ——
       那条牌子上还有一枚小灯图标和「灯语」两个字（常设的），提示正文在 #hintText 里。 */
    hintText: (document.getElementById('hintText')||{}).textContent || '',
    /* 提示行与三块地方的关系：在记录方框里、在记录列表之上、不碰汤面、不碰底栏 */
    inDossier: !!(lineR && hit(lineR, rect(dossier))),
    aboveLedger: !!(lineR && rect(ledger) && lineR.bottom <= rect(ledger).top + 1),
    overRead: !!(lineR && hit(lineR, rect(read))),
    overDock: !!(lineR && hit(lineR, rect(dock))),
    lit: !!(line && line.classList.contains('lit')),
    anims: (line && line.getAnimations) ? line.getAnimations().map(function(a){ return a.animationName || '?'; }) : null,
    places: places(${JSON.stringify(MARK)}),
    dockShown: !!rect(dock) && vis(dock),
    errs:(window.__errs||[]).slice(0,4)
  };
})()`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'newui_' + PORT)}`,
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

/* 真鼠标事件打的是「那个坐标上最顶上的元素」——启动遮罩（#boot，z-index 40）还在的时候，
   点在搜索框坐标上其实点在遮罩上，什么都不发生。程序化 `click()` 不看这些，
   所以这个坑只在真鼠标 + 环境吃紧（套件里前面刚跑完一堆 headless Chrome）时才炸：
   固定 sleep 4500 在单跑时够、在套件里不够 —— 实测就是这么假红过一次。
   所以点了不算数，**先等到那一点真能点到**。 */
const waitClickable = async (sel, tries = 50) => {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return {why:'没有这个元素'};
      var b=e.getBoundingClientRect();
      if(b.width<2||b.height<2) return {why:'它自己没有尺寸', w:Math.round(b.width), h:Math.round(b.height),
        disp:getComputedStyle(e).display, box:e.closest('.finder-box')?getComputedStyle(e.closest('.finder-box')).display:'?'};
      var t=document.elementFromPoint(Math.round(b.x+b.width/2), Math.round(b.y+b.height/2));
      if(!t) return {why:'那一点上没有元素'};
      if(t===e || e.contains(t) || t.contains(e)) return {ok:true};
      var boot=document.getElementById('boot'), tour=document.querySelector('.tour');
      return {why:'被别的元素盖着', top:(t.getAttribute&&t.getAttribute('class'))||t.id||t.tagName,
        rect:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)},
        vw:innerWidth, vh:innerHeight,
        boot: boot? getComputedStyle(boot).display : '(无)',
        bootVis: boot? getComputedStyle(boot).visibility : '(无)',
        bootCap: (document.getElementById('bootCap')||{}).textContent || '',
        tour: tour? getComputedStyle(tour).display : '(无)',
        /* 那次 /api/puzzles 到底发生没有、花了多久 —— 判断「遮罩没落」是
           请求没回来，还是 fetch 根本没发出去（后者说明是注入的桩把链子弄断了） */
        api: (function(){ try{ return performance.getEntriesByType('resource')
            .filter(function(r){ return r.name.indexOf('/api/')>=0; })
            .map(function(r){ return r.name.split('/').pop().split('?')[0] + ':' + Math.round(r.duration) + 'ms'; })
            .join(' '); }catch(_){ return '(取不到)'; } })(),
        errs:(window.__errs||[]).slice(0,5),
        cb:(location.href.match(/_cb=(\\d+)/)||[])[1] || '(没有 _cb)'}; })()`);
    if (r && r.ok) return true;
    last = r;
    await sleep(300);
  }
  console.log('    （等不到可点，最后一次探到的现场：' + JSON.stringify(last) + '）');
  return false;
};

/* **必须用真鼠标事件**：`el.click()` 不会让输入框获得焦点，于是 focus 那条路根本不走 ——
   拿它测「点搜索框出分类」会假红（实现是对的，探针是假的）。 */
const realClick = async (sel) => {
  if (!(await waitClickable(sel))) throw new Error('等不到可点：' + sel + '（被遮罩盖着？）');
  const r = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)});
    if(!e) return null; var b=e.getBoundingClientRect();
    return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)}; })()`);
  if (!r) throw new Error('点不到：' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const shotTo = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64'));
};
const size = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: 1, mobile });

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
await send('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
  "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){ var of=window.fetch;
    window.fetch=function(input, init){
      var url = typeof input==='string' ? input : (input&&input.url)||'';
      if (url.indexOf('/api/hint')>=0){
        return Promise.resolve(new Response(JSON.stringify({ ok:true, hint: ${JSON.stringify(FAKE_HINT)} }),
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

await size(W, H, false);
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });

/* 等页面**真的就绪**，判据是 app.js 自己写的那个信号：`#bootCap` 变成「共 N 卷」——
   它只在 `/api/puzzles` 回来之后才写（web/app.js 的 hideBoot 那一段）。
   比「等启动遮罩消失」本质：遮罩落不下去的原因只有两种，而那两种要分开看。

   为什么要重载一次：套件里前面刚跑完一串 headless Chrome 时，实测会遇到某个实例的
   `/api/puzzles` 一直不 settle，于是遮罩永远落不下去（`#boot` 还是 grid、
   `.boot.done` 没加上）。那跟被测的这两条界面行为无关 —— 项目自己在
   tools/chrome-port.mjs 的注释里记过同一类「单独跑就过、跟着全套跑就挂」。
   所以：**没就绪就重载一次再等**，仍然没就绪就把现场（含 /api/ 的 resource timing、
   window 上的报错）打出来当硬失败 —— 只重试「没就绪」，不重试任何断言。 */
const waitAppReady = async (tries) => {
  for (let i = 0; i < tries; i++) {
    const r = await ev("(function(){ var c=document.getElementById('bootCap');"
      + " var b=document.getElementById('boot');"
      + " return {cap: c? c.textContent : '', disp: b? getComputedStyle(b).display : '(无)'}; })()");
    if (r && /共\s*\d+\s*卷/.test(r.cap || '')) return true;
    await sleep(300);
  }
  return false;
};
if (!(await waitAppReady(50))) {
  console.log('    （首次进入 15 秒没就绪：/api/puzzles 没回来 —— 重载一次再等）');
  await send('Page.reload');
  if (!(await waitAppReady(60))) {
    const d = await ev("(function(){ var b=document.getElementById('boot');"
      + " return { boot: b? getComputedStyle(b).display : '(无)',"
      + " bootCap: (document.getElementById('bootCap')||{}).textContent || '',"
      + " api: (function(){ try{ return performance.getEntriesByType('resource')"
      + "   .filter(function(r){ return r.name.indexOf('/api/')>=0; })"
      + "   .map(function(r){ return r.name.split('/').pop().split('?')[0]+':'+Math.round(r.duration)+'ms'; })"
      + "   .join(' '); }catch(_){ return '(取不到)'; } })(),"
      + " errs: (window.__errs||[]).slice(0,5), href: location.href }; })()");
    console.log('    （重载后仍未就绪，现场：' + JSON.stringify(d) + '）');
    throw new Error('页面始终没就绪（/api/puzzles 没回来）：这条不是被测行为的问题，看上面的现场');
  }
}
await waitClickable('#findInput');

console.log('\n=== 1. 画廊态 1440×900：点搜索框，分类要出来 ===');
let r = await ev(PROBE);
console.log(`  ${r.cls}`);
check(r.listHidden === true, '一开始列表是收着的（还没点）');
check(!r.ftagShown, '一开始连分类行都看不到');

// 模拟真手指：点的是输入框本身
await realClick('#findInput');
await sleep(500);
r = await ev(PROBE);
console.log(`  点完 listHidden=${r.listHidden} ftagCount=${r.ftagCount} soup=${JSON.stringify(r.soupVals)} diff=${JSON.stringify(r.diffVals)}`);
check(r.inputFocused === true, '点一下，输入框拿到了焦点（键盘能接着打字）');
check(r.listHidden === false, '点一下搜索框，列表就展开了');
check(r.ftagShown === true, '下面的分类行（汤色 + 难度）露出来了');
check(r.ftagCount === 7, '汤色四枚（含共用的「全部」）+ 难度三枚', `实得 ${r.ftagCount} 枚`);
check(r.soupVals.join('/') === '/清汤/红汤/黑汤', '汤色三档都在（外加那枚「全部」）', r.soupVals.join('/'));
check(r.diffVals.join('/') === '浅/中/深', '难度三档都在', r.diffVals.join('/'));
check(r.rowCount === 44, '不敲字也把整库列出来（不是「没有这一卷」）', `${r.rowCount} 条`);
check(r.inputValue === '', '点开没有往输入框里塞字');
await shotTo('newui_1_gallery_open.png');

console.log('\n=== 2. 画廊态：点「清汤」真的筛 ===');
await realClick('#findList button[data-soup="清汤"]');
await sleep(500);
r = await ev(PROBE);
console.log(`  筛完 rowCount=${r.rowCount} rowsAllMatch=${r.rowsAllMatch}`);
check(r.rowCount === 3, '清汤就 3 卷（跟 chip 上的数一致）', `${r.rowCount} 卷`);
check(r.rowsAllMatch, '列出来的每一条都是清汤');
await shotTo('newui_2_soup_filter.png');

console.log('\n=== 3. 画廊态：点放大镜图标也能打开（整条框都点得）===');
await ev("document.getElementById('findInput').blur()");
await realClick('.finder-box svg');
await sleep(400);
r = await ev(PROBE);
check(r.inputFocused === true, '点图标 = 点输入框（聚焦了）');
check(r.listHidden === false, '列表还在（没有被收起）');
/* 筛着的汤色是「正在浏览哪一类」的状态，closeFind() 都刻意不清它 ——
   所以这里该还是那 3 卷，不是 44。 */
check(r.rowCount === 3, '筛着的「清汤」保留着（这是刻意的，再按 K 回来还是这一类）', `${r.rowCount} 条`);

console.log('\n=== 4. 画廊态：求灯那一下 —— 提示落在记录方框第一行，且不压汤面 ===');
await lamp(true);
/* 点下去那一下的即时反馈靠的是 .lit 那一记动画，而动画只有 1.4s ——
   所以这一小段不能用 askHint()（它要等文本 + 300ms，慢机器上就错过了），
   自己点、自己每 100ms 扫一次。 */
await ev("document.getElementById('hintAsk').click()");
let lit = null;
for (let i = 0; i < 30; i++) {
  await sleep(100);
  const s = await ev(`(function(){ var e=document.getElementById('hintLine');
    return { lit: !!(e && e.classList.contains('lit')), text: e? e.textContent : '',
             anims: (e && e.getAnimations) ? e.getAnimations().map(function(a){ return a.animationName||'?'; }) : null }; })()`);
  if (s && s.lit) { lit = s; break; }
}
r = await ev(PROBE);
console.log(`  hintLine=${JSON.stringify(r.hintLine)}`);
console.log(`  在记录方框里=${r.inDossier} 在记录列表之上=${r.aboveLedger} 压汤面=${r.overRead} 压底栏=${r.overDock}`);
console.log(`  亮过=${r.lit} 动画=${JSON.stringify(r.anims)} 这句提示出现在 ${r.places.length} 处`);
check(!!r.hintLine && r.hintLine.shown, '提示行出现了');
check(r.hintText.indexOf(MARK) >= 0, '它写的正是那句提示', r.hintText);
check(!!lit, '点下去当场亮一记（.lit 动画，不是静静冒出来）', JSON.stringify(lit && lit.anims));
check(r.inDossier === true, '提示在记录方框里面（用户要的位置：方框上面那条）');
check(r.aboveLedger === true, '而且排在问答记录**上面**（不是埋在记录底下）');
check(r.overRead === false, '提示不压汤面（这是用户原话里那条硬约束）');
check(r.overDock === false, '提示不压底栏（输入条和麦克风照旧能点）');
await shotTo('newui_3_gallery_hint_line.png');

console.log('\n=== 5. 画廊态：这句话只出现在一个地方（浮层删干净了）===');
check(r.places.length === 1, '屏幕上写着这句提示的只有一件', JSON.stringify(r.places.map((p) => p.cls)));
check(r.places.every((p) => p.inLine && !p.overRead && !p.overDock),
  '那一件就是记录方框里的提示行，且既没压汤面也没压底栏', JSON.stringify(r.places));
check(r.dockShown === true, '底栏照常在（没被顶掉）');
await sleep(4000);
r = await ev(PROBE);
check(r.places.length === 1, '几秒后提示还在（它是常驻件，不是一闪而过的浮层）',
  JSON.stringify(r.places.map((p) => p.cls)));

console.log('\n=== 6. 紧凑态 390×640：分类要出得来 ===');
/* 先把搜索收起再切紧凑态。上面第 3 步点开过搜索框，`.finder` 一直是展开的
   （原来是被「点屏幕收提示浮层」那一下顺带关掉的，那件浮层已经删了）——
   带着卡片态切过去的话，紧凑态那枚放大镜是 display:none，`realClick` 会等不到它。 */
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
await sleep(400);
await size(COMPACT_W, COMPACT_H, true);
await sleep(1500);
r = await ev(PROBE);
console.log(`  ${r.cls}`);
check(/compact/.test(r.cls || ''), '确实进了紧凑态', r.cls);
check(r.listHidden !== false, '切进紧凑态时搜索是收着的（放大镜那枚点得到）', `listHidden=${r.listHidden}`);

// 紧凑态搜索收成放大镜，点开才是浮层
await ev("document.getElementById('findInput').blur()");
await realClick('#findFold');
await sleep(600);
r = await ev(PROBE);
console.log(`  listHidden=${r.listHidden} ftagCount=${r.ftagCount} rows=${r.rowCount} focused=${r.inputFocused}`);
check(r.listHidden === false && r.ftagShown === true, '点开放大镜，分类照样出来');
check(r.ftagCount === 7, '紧凑态两类分类齐全（含「全部」）', `${r.ftagCount} 枚`);
check(r.inputFocused === true, '点开就聚焦（手机上点开就能打字）');
await shotTo('newui_4_compact_find.png');

// 点「全部」把上一段筛着的汤色复位 —— 紧凑态里这一枚也得点得到
await realClick('#findList button[data-soup=""]');
await sleep(500);
r = await ev(PROBE);
console.log(`  复位后 rows=${r.rowCount}`);
check(r.rowCount === 44, '点「全部」复位成整库', `${r.rowCount} 条`);
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
await sleep(400);

console.log('\n=== 7. 紧凑态：`.hint` 是 display:none，反馈只可能来自记录方框第一行 ===');
const beforeShow = await ev("getComputedStyle(document.querySelector('.hint')).display");
console.log(`  .hint 的 display=${beforeShow}（紧凑态本来就藏起来）`);
await ev("document.getElementById('hintAsk').click()");
await sleep(600);
r = await ev(PROBE);
console.log(`  hintLine=${JSON.stringify(r.hintLine)}  在方框里=${r.inDossier} 在记录上=${r.aboveLedger}`);
console.log(`  压汤面=${r.overRead} 压底栏=${r.overDock} 亮过=${r.lit} 出现在 ${r.places.length} 处`);
check(!!r.hintLine && r.hintLine.shown, '紧凑态里提示行看得见（手机上点求灯终于有反馈）');
check(r.hintText.indexOf(MARK) >= 0, '写的还是那句提示', r.hintText);
check(r.inDossier === true && r.aboveLedger === true,
  '紧凑态里它也是记录方框的第一行（在问答记录那条 chips 带之上）');
check(r.overRead === false, '紧凑态也不压汤面（这一屏最怕的就是它）');
check(r.overDock === false, '也不压底栏');
check(r.hintLine.y >= 0 && r.hintLine.bottom <= r.vh, '整行都在可视区里，没被顶到屏幕外',
  `y=${r.hintLine.y} bottom=${r.hintLine.bottom} vh=${r.vh}`);
check(r.places.length === 1, '紧凑态里也只有一个地方写着这句提示',
  JSON.stringify(r.places.map((p) => p.cls)));
await shotTo('newui_5_compact_hint_line.png');

console.log('\n=== 8. 全程无 JS 报错 ===');
r = await ev(PROBE);
check(r.errs.length === 0, '没有 JS 报错', JSON.stringify(r.errs));

console.log(`\n${fails.length ? '✗ ' + fails.length + ' 项没过：\n  - ' + fails.join('\n  - ') : '✓ 全部通过'}`);
ws.close();
chrome.kill();
process.exit(fails.length ? 1 : 0);
