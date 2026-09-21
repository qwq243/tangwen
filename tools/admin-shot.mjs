// 后台界面自查：真登录 -> 断言图表真渲染了 / 数据真落位了 / 布局没溢出去 -> 截图
// 用法: node tools/admin-shot.mjs [url] [key] [outDir]
//
// 为什么后台也要量而不是看一眼：后台的图是手写 SVG，空数据、单日数据、
// 极值、日期标签重叠这几种情况肉眼扫不出来，但都会让图变成一条糊线或一片空白。
// 这里把「有几个点、路径非空、没报错、没横向溢出、悬停提示出得来」钉成断言。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './chrome-port.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// 卷数从卷宗里数，不写死 —— 加卷不该让这条探针假红。
const VOLUMES = JSON.parse(readFileSync(join(ROOT, 'puzzles.json'), 'utf8')).puzzles.length;

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const KEY = process.argv[3] || process.env.ADMIN_KEY || '';
const OUT = process.argv[4] || join(ROOT, 'tmp', '_shot');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWS = [
  { label: 'admin_1440x1000', W: 1440, H: 1000, mobile: false },
  { label: 'admin_phone_390x844', W: 390, H: 844, mobile: true },
];

const fails = [];
function ok(name, cond, extra = '') {
  console.log((cond ? '[OK]  ' : '[FAIL]') + ' ' + name + (extra ? '   ' + extra : ''));
  if (!cond) fails.push(name);
}

const PROBE = `(function(){
  var q = function(s){ return document.querySelector(s); };
  var svg = q('#chartBox svg');
  var line = svg ? svg.querySelectorAll('path') : [];
  var d = line.length ? (line[line.length-1].getAttribute('d')||'') : '';
  var tip = q('#tip');
  var box = q('#chartBox');
  var hit = q('#hit');
  var hovered = null;
  if (hit) {
    var r = hit.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent('mousemove', {clientX: r.left + r.width*0.6, clientY: r.top + r.height/2, bubbles: true}));
    hovered = { shown: tip && tip.style.display !== 'none', text: tip ? tip.textContent : '',
                guide: svg ? !!svg.querySelector('#hLine').getAttribute('x1') : false };
  }
  var doc = document.documentElement;
  return {
    errs: window.__errs || [],
    appHidden: q('#app') ? q('#app').hidden : null,
    loginHidden: q('#login') ? q('#login').hidden : null,
    today: (q('#today')||{}).textContent,
    kpiCount: q('#kpis') ? q('#kpis').children.length : -1,
    kpiValues: q('#kpis') ? Array.prototype.map.call(q('#kpis').querySelectorAll('.v'), function(e){ return e.textContent; }) : [],
    svgExists: !!svg,
    pathCount: line.length,
    pointCount: (d.match(/[ML]/g)||[]).length,
    xLabels: svg ? svg.querySelectorAll('text').length : 0,
    chartW: box ? Math.round(box.getBoundingClientRect().width) : 0,
    hover: hovered,
    puzRows: q('#puzTable') ? q('#puzTable').querySelectorAll('tbody tr').length : -1,
    dayRows: q('#dayTable') ? q('#dayTable').querySelectorAll('tbody tr').length : -1,
    // 模型调用那张卡：五格（判题 / 判题失败 / 讲对了没结案 / 求灯 / 求灯兜底）+ 口径一行 + 模型表
    modTiles: q('#mods') ? [].slice.call(q('#mods').querySelectorAll('.mod')).map(function(e){
      return { k: (e.querySelector('.k')||{}).textContent || '', v: (e.querySelector('.v')||{}).textContent || '' }; }) : [],
    modNote: (q('#modNote')||{}).textContent || '',
    modRows: q('#modTable') ? q('#modTable').querySelectorAll('tbody tr').length : -1,
    modEmpty: !!(q('#modTable') && q('#modTable').querySelector('.empty')),
    vols: q('#vols') ? q('#vols').querySelectorAll('details').length : -1,
    volFirstTitle: q('#vols details .t') ? q('#vols details .t').textContent : '',
    // 卷宗那一排分类 chip（全部 / 汤色三枚 / 难度三枚，带各自卷数）
    volTags: q('#volTags') ? [].slice.call(q('#volTags').querySelectorAll('button')).map(function(b){
      return { t: b.textContent, on: b.classList.contains('on'),
               kind: b.dataset.soup !== undefined ? 'soup' : (b.dataset.diff !== undefined ? 'diff' : 'all') }; }) : [],
    volSub: (q('#volSub')||{}).textContent || '',
    volQuery: q('#volQ') ? q('#volQ').value : null,
    boardOpts: q('#boardPick') ? q('#boardPick').options.length : -1,
    boardRows: q('#boardTable') ? q('#boardTable').querySelectorAll('tbody tr').length : -1,
    pickVal: q('#boardPick') ? q('#boardPick').value : '',
    // 页面里自己记的启动异常（竞态、拿不到元素这类，只在控制台看不出来）
    bootErr: window.__bootErr || '',
    // viewBox 宽度 vs 实际渲染宽度：只有两者相等，svg 里写的 font-size 才是真 px。
    // 后台图表最初的写法是 viewBox 钉死 1000 再整体缩放，390 宽的手机上 12px 刻度被缩成 3.7px。
    vbW: svg ? Math.round(svg.viewBox.baseVal.width) : -1,
    renderW: svg ? Math.round(svg.getBoundingClientRect().width) : -1,
    overflowX: doc.scrollWidth - window.innerWidth,
    vw: window.innerWidth, vh: window.innerHeight
  };
})()`;

async function run(v) {
  const PORT = await freePort();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP || '/tmp', 'adminshot_' + PORT)}`,
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
    const ev = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true });
      return res && res.result ? res.result.value : undefined;
    };
    await send('Page.enable'); await send('Runtime.enable');

    // 先要一个真 token：走登录接口，别在页面上模拟打字
    const login = await fetch(URL.replace(/\/$/, '') + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    }).then((r) => r.json());
    if (!login.token) throw new Error('登录没拿到 token: ' + JSON.stringify(login));

    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{sessionStorage.setItem('tangwen.admin.token', ${JSON.stringify(login.token)});}catch(e){}`,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||'')+' @'+(e.filename||'')+':'+(e.lineno||0))});" +
        "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" +
        "var __ce=console.error;console.error=function(){window.__errs.push('CONSOLE:'+Array.prototype.join.call(arguments,' '));__ce.apply(console,arguments)};",
    });
    await send('Emulation.setDeviceMetricsOverride', { width: v.W, height: v.H, deviceScaleFactor: 1, mobile: v.mobile });

    const url = URL.replace(/\/$/, '') + '/admin/';
    const SET_TOKEN = `sessionStorage.setItem('tangwen.admin.token', ${JSON.stringify(login.token)});`;
    await send('Page.navigate', { url: url + '?_cb=' + Date.now() });
    await sleep(2500);

    /* 兜底：addScriptToEvaluateOnNewDocument 里那句 sessionStorage.setItem 偶尔会
       落在 about:blank 阶段被浏览器拒掉（外面套了 try 吞掉，不报错），页面就停在
       登录页 —— 表现是「桌面视图过了、手机视图挂了」这种随机红。实测踩过一次。
       既然探针的目的是量后台界面，就别让结论依赖这个偶然：发现没登进去就
       在页面上直接写一次再重载。 */
    const logged = await send('Runtime.evaluate', {
      expression: "!!(document.getElementById('app') && !document.getElementById('app').hidden)",
      returnByValue: true,
    });
    if (!(logged.result && logged.result.value)) {
      await send('Runtime.evaluate', { expression: SET_TOKEN, returnByValue: true });
      await send('Page.reload', {});
      await sleep(2500);
    }
    await sleep(1000);

    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const out = r.result && r.result.value;
    console.log('=== ' + v.label + ' ===');
    console.log(JSON.stringify(out, null, 1));

    ok(`${v.label} 无 JS 报错`, Array.isArray(out.errs) && out.errs.length === 0, JSON.stringify(out.errs).slice(0, 300));
    ok(`${v.label} 已登录（看得到后台、看不到登录页）`, out.appHidden === false && out.loginHidden === true);
    ok(`${v.label} 六张 KPI 且数值非空`, out.kpiCount === 6 && out.kpiValues.every((s) => s && s !== '0'),
      JSON.stringify(out.kpiValues));
    ok(`${v.label} 折线图真渲染（点数 >= 5）`, out.svgExists && out.pointCount >= 5,
      `paths=${out.pathCount} points=${out.pointCount} labels=${out.xLabels} w=${out.chartW}`);
    ok(`${v.label} 悬停出提示框`, !!(out.hover && out.hover.shown && out.hover.text),
      JSON.stringify(out.hover));
    ok(`${v.label} 分卷表有行`, out.puzRows > 0, `rows=${out.puzRows}`);
    ok(`${v.label} 近 7 日明细 7 行`, out.dayRows === 7, `rows=${out.dayRows}`);
    ok(`${v.label} 模型调用五格都在（判题 / 判题失败 / 讲对了没结案 / 求灯 / 求灯兜底）`,
      out.modTiles.length === 5 && out.modTiles.every((t) => t.k && t.v !== '')
      && out.modTiles.some((t) => /讲对了没结案/.test(t.k)),
      JSON.stringify(out.modTiles));
    ok(`${v.label} 模型调用带口径一行`, /判题/.test(out.modNote) && /求灯/.test(out.modNote),
      out.modNote.slice(0, 60));
    /* 模型表：suit 造的假数据里有两个求灯模型，所以这里该是**真有行**，
       而且占比加起来 ≈100%（只塞一个模型的话这一列永远 100%，等于没测）。 */
    const modRows = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('#modTable tbody tr'));
      return rows.map(function(tr){ var td=tr.querySelectorAll('td');
        return { model: td[0] ? td[0].textContent : '', n: td[1] ? td[1].textContent : '',
                 pct: td[2] ? parseFloat(td[2].textContent) : 0 }; }); })()`);
    ok(`${v.label} 模型表按模型分解（假数据里两个模型都在）`,
      out.modRows >= 2 && modRows.every((r) => r.model && Number(r.n.replace(/,/g, '')) > 0),
      JSON.stringify(modRows));
    ok(`${v.label} 占比加起来 ≈100%`,
      Math.abs(modRows.reduce((s, r) => s + r.pct, 0) - 100) <= 0.5,
      `合计 ${modRows.reduce((s, r) => s + r.pct, 0).toFixed(1)}%`);
    ok(`${v.label} 卷宗核对列全了 ${VOLUMES} 卷`, out.vols === VOLUMES,
      `vols=${out.vols} 期望=${VOLUMES} 首卷=${out.volFirstTitle}`);
    /* 分类 chips：一枚共用的「全部」+ 汤色三枚 + 难度三枚 = 7 枚，
       默认停在「全部」上，各自带卷数（总和要等于全库卷数）。 */
    ok(`${v.label} 卷宗分类七枚、默认停在「全部」`,
      out.volTags.length === 7
      && out.volTags.filter((t) => t.kind === 'all' && t.on).length === 1
      && out.volTags.filter((t) => t.kind === 'soup').length === 3
      && out.volTags.filter((t) => t.kind === 'diff').length === 3,
      JSON.stringify(out.volTags.map((t) => t.t)));
    const volCounts = out.volTags.filter((t) => t.kind !== 'all')
      .map((t) => Number(String(t.t).replace(/\D+/g, '')));
    ok(`${v.label} 分类 chip 上的卷数加起来 = ${VOLUMES}×2（汤色一组 + 难度一组，各是整库）`,
      volCounts.reduce((s, x) => s + x, 0) === VOLUMES * 2,
      `chip 数=${JSON.stringify(volCounts)}`);
    ok(`${v.label} 排行榜下拉有选项`, out.boardOpts > 20, `opts=${out.boardOpts}`);
    ok(`${v.label} 排行榜表自动装上了（进来看不用手点）`, out.boardRows > 0, `rows=${out.boardRows}`);

    /* 卷宗核对的搜索与分类：真敲进去、真点一下。
       44 卷摊开靠眼睛扫是核不了对的 —— 这两下就是用户要的那两件。 */
    const volProbe = async () => ev(`(function(){
      var q=function(s){return document.querySelector(s);};
      var rows=[].slice.call(document.querySelectorAll('#vols details'));
      var diffTags=function(d){
        var t=[].slice.call(d.querySelectorAll('summary .tag')).filter(function(x){
          return /^[浅中深]$/.test((x.textContent||'').trim()); });
        return t.length ? t[0].textContent.trim() : ''; };
      return { n: rows.length,
               idx: rows.length ? (rows[0].querySelector('.idx')||{}).textContent : '',
               allHit: window.__volWord ? rows.every(function(d){
                 return (d.textContent||'').indexOf(window.__volWord) >= 0; }) : null,
               soups: rows.map(function(d){
                 var t=d.querySelector('.tag.soup'); return t ? t.textContent : ''; }),
               diffs: rows.map(diffTags),
               sub:(q('#volSub')||{}).textContent || '',
               empty:!!q('#vols .empty') }; })()`);
    const typeVol = async (text) => {
      await ev(`(function(){ var e=document.getElementById('volQ');
        e.value=${JSON.stringify(text)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
      await sleep(250);
    };

    // 搜汤底里的词（只搜标题是不够的：核对的场景常常是「我记得有个词，在哪一卷来着」）
    await ev(`window.__volWord = '丧尸'`);
    await typeVol('丧尸');
    let vv = await volProbe();
    ok(`${v.label} 搜索命中汤底里的词，且命中的每一卷都真的含它`,
      vv.n >= 1 && vv.n < VOLUMES && vv.allHit === true,
      `n=${vv.n} allHit=${vv.allHit} sub=${vv.sub}`);
    ok(`${v.label} 搜索时卷尾计数写成「N / ${VOLUMES} 卷」`, /\/\s*\d+\s*卷/.test(vv.sub), vv.sub);
    const andCount = vv.n;
    await typeVol('丧尸 电话');
    vv = await volProbe();
    ok(`${v.label} 连空格分词也能搜（「丧尸 电话」两个词都要在）`,
      vv.n >= 1 && vv.n <= andCount, `AND：n=${vv.n} <= ${andCount}`);

    await typeVol('');
    let tags = (await ev(PROBE)).volTags;
    const soupChip = tags.filter((t) => t.kind === 'soup')[0];
    const soupName = String(soupChip.t).replace(/\d+/g, '');
    const soupWant = Number(String(soupChip.t).replace(/\D+/g, ''));
    await ev(`document.querySelector('#volTags button[data-soup="${soupName}"]').click()`);
    await sleep(250);
    vv = await volProbe();
    ok(`${v.label} 点汤色分类只列这一类，且条数与 chip 上的数一致`,
      vv.n === soupWant && vv.soups.every((s) => s === soupName),
      `点「${soupName}」得 ${vv.n} 卷 / chip ${soupWant} / 首行 ${vv.soups[0]}`);

    // 难度可以叠在汤色上（两类是并列的）。逐档试一遍：至少要有一档与刚选的汤色有交集 ——
    // 否则「叠加」可能只是永远返回空表，而空表也「是子集」，什么也没证明。
    let overlap = null;
    for (const d of ['浅', '中', '深']) {
      await ev(`document.querySelector('#volTags button[data-diff="${d}"]').click()`);
      await sleep(200);
      const x = await volProbe();
      if (x.n > 0 && !overlap) overlap = { d, x };
      await ev(`document.querySelector('#volTags button[data-diff="${d}"]').click()`);   // 再点一下取消
      await sleep(150);
    }
    ok(`${v.label} 汤色 + 难度能叠加（有交集，且落下来的每一卷两头都对得上）`,
      !!overlap && overlap.x.soups.every((s) => s === soupName)
      && overlap.x.diffs.every((d) => d === overlap.d),
      overlap ? `${soupName}+${overlap.d} = ${overlap.x.n} 卷` : `三档难度与「${soupName}」都没有交集`);

    await ev(`document.querySelector('#volTags button[data-all="1"]').click()`);
    await sleep(250);
    vv = await volProbe();
    ok(`${v.label} 点「全部」把两类一起清掉，回到 ${VOLUMES} 卷`, vv.n === VOLUMES, `n=${vv.n}`);
    ok(`${v.label} 清掉之后卷号还是全库的号（01 起）`, vv.idx === '01', `首行 idx=${vv.idx}`);

    ok(`${v.label} 启动没留下异常记号`, out.bootErr === '', out.bootErr);
    ok(`${v.label} 没有横向溢出`, out.overflowX <= 1, `overflowX=${out.overflowX} vw=${out.vw}`);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(OUT, `admin_${v.label}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('SHOT ' + file);
    ws.close();
  } catch (e) {
    ok(`${v.label} 整体跑通`, false, e.message);
  } finally { try { chrome.kill(); } catch {} }
}

for (const v of VIEWS) { await run(v); await sleep(300); }
console.log('');
if (fails.length) { console.log(`[FAIL] ${fails.length} 项没过：` + fails.join(' / ')); process.exit(1); }
console.log('[OK] 后台界面全部通过');
process.exit(0);
