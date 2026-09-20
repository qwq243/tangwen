// 结案自查：结案之后**真的结算了吗** —— 成绩有没有落库、榜上有没有我、表停没停。
//
// 背景（2026-09-20 用户实报：「提前结案了但还是没有进行结算，没有到排行榜，还在记时」）：
//   1. `setBoard()` 里先 `loadBoard()` 再揭层，而 `loadBoard()` 开头有一条
//      「层关着就直接返回」—— 于是**第一次打开排行榜永远是空的**。
//      成绩其实早就写进服务端了，玩家看到的是空榜，就以为没结算。
//   2. 结案从不停表：`pauseClock()` 只是暂停，点一下（点掉结案画卷那一下）
//      就被 `touchClock` 接回去接着走。现在结案走 `stopClock()`（把表摘下），
//      并且 `startClock()` 不再给结过案的卷起表。
//
// 这条探针就是照这两条写的：拦掉 /api/ask 回一个「结案」，其余全走真接口
// （/api/score 真写、/api/board 真读），所以它同时验客户端和服务端两头。
//
// 用法：node tools/solve-check.mjs [url] [宽] [高]
// 默认 http://127.0.0.1:8765/ 390 844
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const OUT = join(PROJ, 'tmp', '_shot');

// 卷数从卷宗里数，不写死 —— 加卷不该让这条探针假红。
const VOLUMES = JSON.parse(readFileSync(join(PROJ, 'puzzles.json'), 'utf8')).puzzles.length;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = args[0] || 'http://127.0.0.1:8765/';
const W = Number(args[1] || 390);
const H = Number(args[2] || 844);
const SOLVED_BOTTOM = '（探针汤底）她其实没有死，坠楼的是她的替身，为的是让追她的人收手。';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'solve_' + PORT)}`,
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
/* 每次用全新的 player id：结案画卷那句「你是第 N 位结案」只在 first=true 时才写，
   不清 id 的话第二次跑就是「重复结案」，那句话永远测不到。
   （清掉之后 App 会自己生成一串新 id 和一个新名字。） */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { localStorage.removeItem('fengcun.player'); } catch (_) {}" });
// 只拦 /api/ask（造假「结案」）；/api/score 与 /api/board 走真接口，顺便记下请求与响应
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__errs = [];
  window.addEventListener('error', function (e) { window.__errs.push('ERR:' + (e.message || '')); });
  window.addEventListener('unhandledrejection', function (e) { window.__errs.push('REJ:' + String((e.reason && e.reason.message) || e.reason)); });
  window.__score = [];
  (function () {
    var of = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var self = this, args = arguments;
      if (url.indexOf('/api/score') >= 0) {
        var rec = { payload: null, status: null, row: null, resp: null, err: null };
        try { rec.payload = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
        window.__score.push(rec);
        return of.apply(self, args).then(function (r) {
          rec.status = r.status;
          return r.clone().json().then(function (j) {
            rec.resp = j || null;        // 整份响应（solves / first 都在里面）
            var rows = (j && j.rows) || [];
            rec.row = rows.filter(function (x) { return x.id === rec.payload.id; })[0] || null;
            return r;
          }, function () { return r; });
        }, function (e) { rec.err = String(e); throw e; });
      }
      if (url.indexOf('/api/ask') >= 0) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true, label: '结案', verdict: 'solved', solved: true, latency_ms: 200,
          unlocked: ['k1', 'k2'],
          keys: [{ id: 'k1', label: '甲', found: true }, { id: 'k2', label: '乙', found: true }],
          bottom: ${JSON.stringify(SOLVED_BOTTOM)} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return of.apply(self, args);
    };
  })();` });

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 800 });
await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
await sleep(4200);

const fails = [];
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(what);
};
const snap = () => ev(`(function(){
  var el = document.getElementById('elapsed'), tag = document.getElementById('pauseTag');
  var st = document.getElementById('stamp');
  return {
    elapsed: el ? el.textContent : '-',
    pausedCls: el ? el.classList.contains('paused') : null,
    pauseTag: tag ? (tag.hidden ? '隐藏' : tag.textContent) : '-',
    finale: !document.getElementById('finale').hidden,
    bottomText: (document.getElementById('finaleBottom')||{}).textContent || '',
    stamp: st ? st.textContent : '',
    lock: document.getElementById('lock') ? 1 : 0,
    score: window.__score, errs: window.__errs,
    solvedKeys: (document.querySelector('.stage')||{}).className,
  }; })()`);

console.log(`视口 ${W}×${H}`);
console.log('\n=== 1. 问一句，服务端被拦成「结案」 ===');
await ev(`(function(){ var el=document.getElementById('typed'); el.value='她是被替身代替了吗';
  document.getElementById('typeLine').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1; })()`);
await sleep(3200);

let s = await snap();
check(s.stamp === '结案', '印章落在「结案」上', JSON.stringify(s.stamp));
check(s.finale, '结案画卷推上来了');
check(s.bottomText === SOLVED_BOTTOM, '画卷里是汤底正文', `${s.bottomText.length} 字`);
check(s.score.length >= 1, '结算请求真的打出去了（POST /api/score）', `共 ${s.score.length} 次`);
const rec = s.score[0] || {};
check(rec.status === 200, '服务端收下了（HTTP 200）', JSON.stringify(rec.status));
check(!!rec.row, '服务端把这一行写进了榜（响应里带回来）',
  rec.row ? JSON.stringify(rec.row) : JSON.stringify(rec));
check(rec.payload && rec.payload.asks >= 1 && rec.payload.ms >= 1, '成绩里的问数与用时是有效值',
  JSON.stringify({ asks: rec.payload && rec.payload.asks, ms: rec.payload && rec.payload.ms }));
/* 「几人结案」不能拿榜上的行数当（每卷只留前 30 行），服务端另有一张人数表 ——
   这里钉住：响应带人数与 first，且人数 ≥ 1（刚交的这份算一个人）。 */
const recSolves = Number((rec.resp || {}).solves || 0);
check(recSolves >= 1, '服务端回了这一卷「几人结案」', `solves=${recSolves} first=${(rec.resp || {}).first}`);
check(typeof (rec.resp || {}).first === 'boolean', '并说明这一份算不算新人（first）', JSON.stringify((rec.resp || {}).first));

console.log('\n=== 2. 结案之后表该停（而且不是「暂停」，是不再走）===');
const t1 = s.elapsed;
await sleep(6000);
s = await snap();
check(s.elapsed === t1, '等 6 秒，计时没动', `${t1} -> ${s.elapsed}`);
check(s.pauseTag === '隐藏' && s.pausedCls === false,
  '不挂「停表」标记（结案是结清，不是暂停中）', `pauseTag=${s.pauseTag} paused类=${s.pausedCls}`);

console.log('\n=== 3. 点掉画卷、换一卷再换回来，表也不该再走 ===');
await ev("document.getElementById('finale').click()");
await sleep(700);
await ev("document.getElementById('next').click()");
await sleep(1200);
await ev("document.getElementById('prev').click()");
await sleep(1200);
const back1 = await ev("document.getElementById('elapsed').textContent");
await sleep(4000);
const back2 = await ev("document.getElementById('elapsed').textContent");
check(back1 === back2, '回到结过案的那一卷，表仍然不走', `${back1} -> ${back2}`);
check(back1 === t1, '而且显示的还是结案时那个定量', `结案 ${t1} / 回来 ${back1}`);

console.log('\n=== 4. 打开排行榜：第一次打开就该看到自己那一行 ===');
await ev("document.getElementById('boardOpen').click()");
await sleep(1600);
const board = await ev(`(function(){
  var lis = [].slice.call(document.querySelectorAll('#board li'));
  var me = lis.filter(function (li) { return li.classList.contains('me'); });
  return { sub: (document.getElementById('boardSub')||{}).textContent,
           count: lis.length,
           rows: lis.slice(0, 6).map(function (li) { return li.textContent.replace(/\\s+/g,' ').trim(); }),
           mine: me.map(function (li) { return li.textContent.replace(/\\s+/g,' ').trim(); }) }; })()`);
console.log(`  榜头《${board.sub}》 共 ${board.count} 行`);
for (const r of board.rows) console.log('    ' + r);
check(board.count > 0, '面板里真的渲染出了行（不是空榜）', `${board.count} 行`);
check(board.mine.length === 1, '榜上有「我」那一行（.me 高亮）', JSON.stringify(board.mine));
check(/问/.test(board.mine[0] || ''), '那一行带着问数与用时', JSON.stringify(board.mine[0]));
check(/[浅中深]卷/.test(board.sub || ''), '榜头带难度标签', JSON.stringify(board.sub));
check(new RegExp(recSolves + ' 人已结案').test(board.sub || ''), '榜头写的是服务端那张表的人数',
  `榜头「${board.sub}」/ 服务端 solves=${recSolves}`);

console.log('\n=== 5. 难度标签与人数：卷面 / 搜索列表 / 结案画卷 ===');
const tags = await ev(`(function(){
  var d = document.getElementById('diff');
  return { plaque: d ? d.textContent : null, hidden: d ? d.hidden : null, tip: d ? d.title : '',
           finale: (document.getElementById('finaleStats')||{}).textContent || '' }; })()`);
check(!!tags.plaque && !tags.hidden, '卷面上有难度小印', `「${tags.plaque}」`);
check(/[浅中深]卷/.test(tags.finale), '结案画卷里报了难度', JSON.stringify(tags.finale));
if ((rec.resp || {}).first) {
  check(new RegExp('你是第 ' + recSolves + ' 位结案').test(tags.finale),
    '画卷里写了「你是第几位结案」', JSON.stringify(tags.finale));
} else {
  check(!/第 \d+ 位结案/.test(tags.finale),
    '重复结案不谎报名次（first=false 就不写「第几位」）', JSON.stringify(tags.finale));
}

// 搜索列表：卷号 · 难度 · 卷名 · 人数 · 已结案
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k'}))");
await sleep(500);
await ev(`(function(){ var el=document.getElementById('findInput'); el.value='跳楼'; el.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(500);
const row = await ev(`(function(){ var li=document.querySelector('#findList li[data-i]');
  if(!li) return null;
  return { text: li.textContent.replace(/\\s+/g,' ').trim(),
           df: li.querySelector('.df') ? li.querySelector('.df').textContent : null,
           cnt: li.querySelector('.cnt') ? li.querySelector('.cnt').textContent : null,
           cls: [].slice.call(li.children).map(function(c){ return c.className || c.tagName; }),
           cells: li.children.length }; })()`);
console.log('  搜索首行:', JSON.stringify(row));
check(!!row && !!row.df, '搜索结果每行带难度', JSON.stringify(row && row.df));
check(!!row && new RegExp(recSolves + ' 人').test(row.cnt || ''), '搜索结果带「几人已结案」',
  JSON.stringify(row && row.cnt));
/* 行的格子恒定：卷号 · 难度 · 汤色 · 卷名 · 人数 · 已结案（缺项也要占位）——
   少一格的话后面的格子会往前挪一列，整列就错位了。
   （汤色 n→df→sp→t 里的 sp 是并行加的「清汤/红汤/黑汤」，跟难度是两回事。） */
check(!!row && row.cls.length === 6, '列表行恒定六格（缺项也占位）', JSON.stringify(row && row.cls));
check(!!row && row.cls.indexOf('n') === 0 && row.cls.indexOf('df') > 0
  && row.cls.indexOf('t') > row.cls.indexOf('df') && row.cls.indexOf('cnt') > row.cls.indexOf('t'),
  '列顺序：卷号 → 难度 → … → 卷名 → 人数', JSON.stringify(row && row.cls));
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");

console.log('\n=== 6. 难度筛选（跟汤色同一行，中间一条细分隔线） ===');
// 先把排行榜关掉：它是全屏遮罩，开着的时候筛选行虽然在 DOM 里（点得到），
// 屏幕上却什么都看不见 —— 那样量出来的「能用」是假的。
await ev("document.getElementById('boardClose').click()");
await sleep(500);
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k'}))");
await sleep(500);
const fts = await ev(`(function(){
  var list = document.getElementById('findList');
  var vis = function(e){ if (!e) return false; var r = e.getBoundingClientRect();
    var cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width >= 1 && r.height >= 1; };
  return { listShown: vis(list),
           rows: [].slice.call(document.querySelectorAll('#findList li.ftags')).map(function(li){
    return { lb: li.querySelector('.lb') ? li.querySelector('.lb').textContent : null,
             shown: vis(li),
             chips: [].slice.call(li.querySelectorAll('button')).map(function(b){
               return { t: (b.textContent||'').trim(), on: b.classList.contains('on'), shown: vis(b),
                        kind: b.dataset.soup !== undefined ? 'soup' : 'diff' }; }) };
  }) }; })()`);
const ftsRows = fts.rows;
const ftsAllShown = fts.listShown && ftsRows.every((r) => r.shown && r.chips.every((c) => c.shown));
console.log('  筛选行:', JSON.stringify(ftsRows));
console.log('  面板与 chip 都看得见:', ftsAllShown);
check(ftsRows.length === 1, '筛选只有一行（竖版这面板只有 62vw，做两行会折满）', `${ftsRows.length} 行`);
check(ftsAllShown, '筛选行真的在屏幕上（不是只在 DOM 里）', `list=${fts.listShown} 行=${ftsRows.map((r) => r.shown)}`);
const fchips = (ftsRows[0] || { chips: [] }).chips;
check(fchips.filter((c) => c.kind === 'diff').length === 3, '难度三枚（浅 / 中 / 深）',
  JSON.stringify(fchips.filter((c) => c.kind === 'diff').map((c) => c.t)));
check(fchips.filter((c) => c.kind === 'soup').length === 4, '汤色那四枚（全部 + 三类）还在',
  JSON.stringify(fchips.map((c) => c.t)));
check(fchips.some((c) => c.on && c.t.indexOf('全部') >= 0), '默认停在共用的「全部」上',
  JSON.stringify(fchips.filter((c) => c.on)));
check(!!(await ev("!!document.querySelector('#findList li.ftags .sep')")), '两组之间有一条细分隔线');

// 点「深」：只该列深卷，条数还要跟 chip 上写的数一样（chip 上的数是从卷目算的）
await ev(`(function(){ var b=document.querySelector('#findList button[data-diff="深"]'); if (b) b.click(); return 1; })()`);
await sleep(500);
const deep = await ev(`(function(){
  var lis = [].slice.call(document.querySelectorAll('#findList li[data-i]'));
  var chip = document.querySelector('#findList button[data-diff="深"]');
  return { n: lis.length,
           allDeep: lis.length > 0 && lis.every(function(li){ var d = li.querySelector('.df'); return d && d.textContent === '深'; }),
           on: !!(chip && chip.classList.contains('on')),
           cnt: chip && chip.querySelector('.k') ? Number(chip.querySelector('.k').textContent) : -1 }; })()`);
check(deep.n > 0 && deep.allDeep, '点「深」列出来的每一条都是深卷', `n=${deep.n} allDeep=${deep.allDeep}`);
check(deep.on, '选中的那一档亮着');
check(deep.cnt === deep.n, '筛出来的卷数与 chip 上的数一致', `chip=${deep.cnt} 列表=${deep.n}`);
const shotDeep = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'solve_diff_filter.png'), Buffer.from(shotDeep.data, 'base64'));

// 回到「全部」：全库卷数都回来（「全部」是两组共用的一枚，点它汤色与难度都不筛）
await ev(`(function(){ var b=document.querySelector('#findList button[data-soup=""]'); if (b) b.click(); return 1; })()`);
await sleep(500);
const all = await ev("document.querySelectorAll('#findList li[data-i]').length");
check(all === VOLUMES, `回到「全部」就是 ${VOLUMES} 卷（这一枚把两道筛选一起清掉）`, String(all));
await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");

s = await snap();
check(s.errs.length === 0, '全程无 JS 报错', JSON.stringify(s.errs));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, 'solve_after_solve.png'), Buffer.from(shot.data, 'base64'));

console.log('');
if (fails.length) {
  console.log(`[FAIL] ${fails.length} 项没过：${fails.join(' / ')}`);
} else {
  console.log('[OK] 结案 → 结算落库 → 榜上有我 → 表停，四件事全对');
}
ws.close(); chrome.kill();
process.exit(fails.length ? 1 : 0);
