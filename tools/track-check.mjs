// 埋点自查：玩家真问的一句，后台真的记下了吗。
//
// 背景（2026-09-20 用户实报：「后台好像不能正常更新相关数据，比如提问之类的，
// 好像没有正常记录」）：ask / hint / solve / give 原先全靠 web/app.js 攒批上报，
// 而线上跑着的是**旧的 app.js** —— 页面改动要等下一次部署才生效。那段时间线上
// 后台 pv=67 uv=22 而 ask=0，看起来像后台坏了。
//
// 现在这四档改成服务端在各自的接口里自己数（server.py 的 bump_track /
// Worker 的 bumpTrack），客户端只报 pv。这条探针钉住三件事：
//   1) 页面上真问一句 -> 后台的 ask **当场** +1（不等 20 秒的攒批），分卷明细也有；
//   2) 问完之后再走客户端那批上报，ask 不会变成 2（两处都记就是记双）；
//   3) 页面要走时 pv 照样报得出去（sendBeacon 那条路没断）。
//
// 判题是真打的（走 /api/ask）。判题失败也算数 —— 这一问照样该记账，
// 所以本探针不依赖外网，也不断言判成了哪一档。
//
// 用法：node tools/track-check.mjs [url] [key] [宽] [高]
// 默认 url=http://127.0.0.1:8765/，密钥取 ADMIN_KEY 环境变量或第 2 个参数。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { freePort } from './chrome-port.mjs';
import { SEED } from './seed.mjs';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = process.argv[2] || 'http://127.0.0.1:8765/';
const KEY = process.argv[3] || process.env.ADMIN_KEY || '';
const W = Number(process.argv[4] || 390);
const H = Number(process.argv[5] || 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
function ok(name, cond, extra = '') {
  console.log((cond ? '[OK]  ' : '[FAIL]') + ' ' + name + (extra ? '   ' + extra : ''));
  if (!cond) fails.push(name);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/* 后台取数：跟后台页面走同一个接口、同一份 token 规则。
   UA 不能省 —— Cloudflare 会把 Node 自带的 UA 当爬虫直接 403，
   对着线上跑时那条错会伪装成「密钥不对」。 */
async function admin(path, opts = {}) {
  const res = await fetch(new URL(path, URL_), {
    method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' },
      opts.token ? { Authorization: 'Bearer ' + opts.token } : {},
      opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data: data || {} };
}

function today(stats) {
  const rows = stats.days || [];
  return rows[rows.length - 1] || {};
}
function askTotal(stats) {
  return (stats.puzzles || []).reduce((n, r) => n + Number(r.ask || 0), 0);
}

if (!KEY) {
  console.log('[FAIL] 没有后台密钥：usage: node tools/track-check.mjs <url> <key>');
  process.exit(2);
}

console.log('埋点端到端 · ' + URL_);
const login = await admin('/api/admin/login', { method: 'POST', body: { key: KEY } });
if (!login.data.token) {
  console.log('[FAIL] 后台登录失败：HTTP ' + login.status + ' ' + (login.data.error || ''));
  process.exit(2);
}
const token = login.data.token;

const before = (await admin('/api/admin/stats?days=7', { token })).data;
const b = today(before);
console.log(`问之前：ask=${b.ask || 0} pv=${b.pv || 0} 分卷 ask 合计=${askTotal(before)}`);

const PORT = await freePort();
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(process.env.TEMP || '/tmp', 'track_' + PORT)}`,
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

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
  // 记下 /api/track 的实际请求体与 /api/ask 的发出次数 —— 只看得见，不拦不改
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__errs = [];
    window.addEventListener('error', function (e) { window.__errs.push('ERR:' + (e.message || '')); });
    window.__tracks = [];
    window.__asks = 0;
    (function () {
      var of = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/ask') >= 0) window.__asks++;
        if (url.indexOf('/api/track') >= 0 && init && init.body) window.__tracks.push(String(init.body));
        return of.apply(this, arguments);
      };
      var beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      if (beacon) {
        navigator.sendBeacon = function (url, data) {
          try {
            if (String(url).indexOf('/api/track') >= 0) {
              if (data && data.text) data.text().then(function (t) { window.__tracks.push(t); });
              else window.__tracks.push(String(data));
            }
          } catch (_) {}
          return beacon(url, data);
        };
      }
    })();
  ` });

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 800 });
  await send('Page.navigate', { url: URL_ + '?_cb=' + Date.now() });

  /* 等页面**真的就绪**，判据是 app.js 自己写的那个信号：`#bootCap` 变成「共 N 卷」
     —— 它只在 `/api/puzzles` 回来之后才写（web/app.js 的 hideBoot 那一段）。

     为什么必须有这一步（2026-09-20 全套里假红过一次）：`#title` 的初值是 HTML 里写死的
     「妹妹的房间」，`#typed` 更是静态标签 —— 拿它们当「页面开起来了」是假绿。
     套件里连着跑一串 headless Chrome 时会遇到某个实例的 `/api/puzzles` 不 settle
     （`finder-hint-check.mjs` 记过同一类），这时 app.js 还没跑完初始化，
     **submit 监听都没挂上**，于是下面第一问量出来就是「asks=0 印章=""」，
     后面七条跟着一起红 —— 看着像记账坏了，其实是页面还没起来。
     只重试「没就绪」，不重试任何断言。 */
  const ready = async (tries) => {
    for (let i = 0; i < tries; i++) {
      const cap = await ev("(document.getElementById('bootCap')||{}).textContent || ''");
      if (/共\s*\d+\s*卷/.test(cap || '')) return true;
      await sleep(300);
    }
    return false;
  };
  if (!(await ready(50))) {
    console.log('    （首次进入 15 秒没就绪：/api/puzzles 没回来 —— 重载一次再等）');
    await send('Page.reload');
    if (!(await ready(60))) { ok('页面开起来了', false, '等待 /api/puzzles 超时（布局初始化没跑完）'); }
  }

  const boot = await ev(`(function(){ return { title: (document.getElementById('title')||{}).textContent,
    typed: !!document.getElementById('typed') }; })()`);
  ok('页面开起来了', !!boot && !!boot.typed, JSON.stringify(boot));

  // 1. 真问一句（判题是真打的）
  await ev(`(function(){ var el = document.getElementById('typed');
    el.value = '这件事跟他家里人有关系吗';
    document.getElementById('typeLine').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 1; })()`);
  await sleep(6000);
  const asked = await ev(`(function(){ return { asks: window.__asks, stamp: (document.getElementById('stamp')||{}).textContent,
    errs: window.__errs }; })()`);
  ok('这一问真的发出去了（POST /api/ask）', asked.asks >= 1, `asks=${asked.asks} 印章=${JSON.stringify(asked.stamp)}`);

  const mid = (await admin('/api/admin/stats?days=7', { token })).data;
  const m = today(mid);
  ok('后台当场就记下这一问（不等攒批 / 不等刷新）',
    Number(m.ask || 0) === Number(b.ask || 0) + 1,
    `ask ${b.ask || 0} -> ${m.ask || 0}`);
  ok('分卷明细也记上了（旧版客户端在这栏留空）',
    askTotal(mid) === askTotal(before) + 1,
    `分卷 ask 合计 ${askTotal(before)} -> ${askTotal(mid)}`);
  ok('这一问没被判成结案（探针只验记账，判成结案也不影响）',
    Number(m.solve || 0) - Number(b.solve || 0) <= 1, `solve ${b.solve || 0} -> ${m.solve || 0}`);

  // 2. 逼客户端现在就 flush（正常路径是 20 秒定时器或页面要走了）
  await ev(`(function(){ window.dispatchEvent(new Event('pagehide')); return 1; })()`);
  await sleep(1800);
  const flushed = await ev(`(function(){ return window.__tracks.slice(); })()`);
  const after = (await admin('/api/admin/stats?days=7', { token })).data;
  const a = today(after);

  const kinds = [];
  for (const body of flushed || []) {
    try {
      const parsed = JSON.parse(body);
      for (const e of (parsed.events || [])) kinds.push(String((e && e.k) || ''));
    } catch (_) { kinds.push('<坏 JSON>'); }
  }
  ok('攒批上报真的发出去了', (flushed || []).length >= 1, `批次=${(flushed || []).length} 事件=${kinds.join(',')}`);
  ok('客户端那批里只有 pv（ask 由服务端数，两处都报就是记双）',
    kinds.length > 0 && kinds.every((k) => k === 'pv'), kinds.join(','));
  /* 这里只断言「涨了」，不断言「恰好 +1」：pv 与 uv 都是全局计数，别的探针残留的
     页面过 20 秒补发一次也会加进来（solve-check 跑完紧接着就是本探针，实测撞到 +2）。
     要钉的是「本页这一批被服务端收下了」——报文体里只有一个 pv 加本页 uid，
     而它真的发出去了（上一条）。 */
  ok('这一批被服务端收下了（pv / uv 都跟着涨）',
    Number(a.pv || 0) > Number(m.pv || 0) && Number(a.uv || 0) > Number(m.uv || 0),
    `pv ${m.pv || 0} -> ${a.pv || 0} / uv ${m.uv || 0} -> ${a.uv || 0}`);
  ok('上报之后 ask 不会变成 2（没有重复计数）',
    Number(a.ask || 0) === Number(b.ask || 0) + 1, `ask ${b.ask || 0} -> ${a.ask || 0}`);
  ok('页面没留下 JS 报错', !(asked.errs || []).length, (asked.errs || []).join(' | '));
} catch (e) {
  ok('整体跑通', false, e.message);
} finally {
  try { ws.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
}

console.log('');
if (fails.length) {
  console.log(`[FAIL] ${fails.length} 项没过：` + fails.join(' / '));
  process.exit(1);
}
console.log('[OK] 埋点端到端全部通过');
process.exit(0);
