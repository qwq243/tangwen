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
    vols: q('#vols') ? q('#vols').querySelectorAll('details').length : -1,
    volFirstTitle: q('#vols details .t') ? q('#vols details .t').textContent : '',
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
    ok(`${v.label} 卷宗核对列全了 ${VOLUMES} 卷`, out.vols === VOLUMES,
      `vols=${out.vols} 期望=${VOLUMES} 首卷=${out.volFirstTitle}`);
    ok(`${v.label} 排行榜下拉有选项`, out.boardOpts > 20, `opts=${out.boardOpts}`);
    ok(`${v.label} 排行榜表自动装上了（进来看不用手点）`, out.boardRows > 0, `rows=${out.boardRows}`);
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
