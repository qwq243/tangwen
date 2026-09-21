// 给文档和 GitHub 出实机截图：真起 Chrome、真加载页面、真驱动界面，
// 然后把 webp 写进 docs/screenshots/。
//
// 用法：
//     node tools/shots.mjs [url] [outDir]
//
// 这个脚本要一个**已经跑着的服务**（它自己不负责起）。判题会被脚本拦成照剧本回话的桩，
// 所以离线替身或真判题都无所谓，但别指到线上 —— 结案那一步会真写一行成绩进排行榜。
// 指本机的临时数据目录最稳：
//     DATA_DIR=tmp/_shotsrv JUDGE_MODE=offline PORT=8795 python server.py &
//     node tools/shots.mjs http://127.0.0.1:8795/
//
// 为什么要专门一个脚本，而不是从 tools/probe.mjs 的截图里挑：
// probe 的图是「量布局时顺手拍的」，多半停在首页，看不出这个游戏在干什么 ——
// 记录里有几条问答、关键点点亮了几格、结案画卷长什么样，这些才是别人点进来想看的。
// 所以这里要**驱动界面**走到那几个状态再拍。
//
// 截图要的是稳定画面，所以 /api/ask 被换成一个照剧本回话的桩（下面的 SCENES）：
// 否则出图依赖真模型或替身的措辞，换个卷宗就变了。其余接口全走真的
// （关键点的 label 就是从真 /api/puzzles 里取的，别在这儿再抄一份卷宗）。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const OUT = process.argv[3] || join(process.cwd(), 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2 倍渲染再交给 Chrome 编 webp：文字边缘干净，体积也还在几百 KB。
const DSF = Number(process.env.SHOT_DSF || 2);
const QUALITY = Number(process.env.SHOT_Q || 82);

// 照剧本回话：第 n 次提问回第 n 条。落印与解锁都按真响应的形状写，
// 所以界面上看到的是真反馈（印章、记录条、chips 点亮、结案画卷）。
const SCENES = [
  { q: '她是被人推下去的吗', label: '不是', verdict: 'no', say: '不是。', unlocked: [] },
  { q: '世界是丧尸病毒爆发之后吗', label: '是', verdict: 'yes', say: '是。',
    unlocked: ['outbreak'] },
  { q: '她是最后一个活着的人吗', label: '是也不是', verdict: 'both', say: '是也不是。',
    unlocked: ['outbreak', 'not_last'] },
  { q: '那通电话说明了什么？是被谁害了吗', label: '接近了', verdict: 'close', say: '接近了。',
    unlocked: ['outbreak', 'not_last'] },
];

const SOLVED_BOTTOM =
  '丧尸病毒爆发，女人身边的人都变成了丧尸。她以为自己是世界上仅存的人类，绝望跳楼。' +
  '跳下的瞬间电话响起，说明还有其他活人。后悔已经来不及。';

// 每个场景一张图（视口 / 走到哪个状态 / 文件名）。
// 状态推进是累积的：按顺序跑，前面的问答会留在记录里，后面的图才有人味。
const SHOTS = [
  { name: 'gallery', w: 1440, h: 900, mobile: false, until: -1, note: '夜馆画廊：首页原样，一卷没动' },
  { name: 'puzzle', w: 1440, h: 900, mobile: false, until: 3, note: '问了几轮：印章、记录、关键点 chips' },
  { name: 'solve', w: 1440, h: 900, mobile: false, until: 3, thenSolve: true, note: '结案画卷' },
  { name: 'finder', w: 1440, h: 900, mobile: false, until: 3, thenFinder: true, note: '搜剧本：分类筛选行 + 结果' },
  { name: 'mobile', w: 390, h: 844, mobile: true, until: 2, note: '手机紧凑态' },
];

function bootStub() {
  return `(function(){
    var scenes = ${JSON.stringify(SCENES)};
    var solved = ${JSON.stringify(SOLVED_BOTTOM)};
    var n = 0, PUZ = null, CUR = null;
    var of = window.fetch;

    // 关键点的 label 从真的 /api/puzzles 里取 —— 别在脚本里再抄一份卷宗，
    // 抄了就一定会跟 puzzles.json 脱节（chips 会显示 undefined）。
    function keyViews(pid, unlocked, stated) {
      var list = [];
      try {
        var all = (PUZ && PUZ.puzzles) || [];
        for (var i = 0; i < all.length; i++) if (all[i].id === pid) list = all[i].keys || [];
      } catch (_) {}
      return list.map(function (k) {
        return { id: k.id, label: k.label,
                 found: unlocked.indexOf(k.id) >= 0, said: stated.indexOf(k.id) >= 0 };
      });
    }
    function uniq(a) { return a.filter(function (v, i, s) { return s.indexOf(v) === i; }); }
    function json(o) {
      return new Response(JSON.stringify(o),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    window.fetch = function (url, opts) {
      url = String(url || '');
      var p = of.apply(window, arguments);
      if (url.indexOf('/api/puzzles') >= 0) {
        p.then(function (r) {
          r.clone().json().then(function (j) { PUZ = j; window.__PUZ = j; }, function () {});
        }, function () {});
        return p;
      }
      if (url.indexOf('/api/ask') >= 0) {
        var body = {};
        try { body = JSON.parse((opts || {}).body || '{}'); } catch (_) {}
        CUR = body.puzzle_id || 'jumper';
        var s = scenes[Math.min(n, scenes.length - 1)];
        n++;
        var unlocked = uniq((body.unlocked || []).concat(s.unlocked));
        var stated = body.stated || [];
        return Promise.resolve(json({
          ok: true, label: s.label, verdict: s.verdict, say: s.say, solved: false,
          near_miss: false, unlocked: unlocked, stated: stated,
          keys: keyViews(CUR, unlocked, stated),
          latency_ms: 640,
          judge: { choice: s.verdict, confidence: 0.9, probabilities: {}, extract: 0,
                   full_guess: 0.08, guess_ok: 0.1, said: {}, model: 'shots-stub' },
        }));
      }
      return p;
    };
  })();`;
}

// 结案那一下：把 /api/ask 换成回「结案」，然后问最后一句。
// 关键点全部按「问到 + 自己讲出来」标记，画卷与 chips 才是满的。
// label 仍然从 window.__PUZ（bootStub 存下来的真 /api/puzzles）里取。
function solveStub() {
  return `(function(){
    var of = window.fetch;
    function json(o) {
      return new Response(JSON.stringify(o),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    function keyViews(pid) {
      var list = [];
      try {
        var all = (window.__PUZ && window.__PUZ.puzzles) || [];
        for (var i = 0; i < all.length; i++) if (all[i].id === pid) list = all[i].keys || [];
      } catch (_) {}
      return list.map(function (k) {
        return { id: k.id, label: k.label, found: true, said: true };
      });
    }
    window.fetch = function (url, opts) {
      url = String(url || '');
      if (url.indexOf('/api/ask') >= 0) {
        var body = {};
        try { body = JSON.parse((opts || {}).body || '{}'); } catch (_) {}
        var kv = keyViews(body.puzzle_id || 'jumper');
        var ids = kv.map(function (k) { return k.id; });
        return Promise.resolve(json({
          ok: true, label: '结案', verdict: 'solved', say: '说对了。汤底封卷。',
          solved: true, near_miss: false, unlocked: ids, stated: ids, keys: kv,
          latency_ms: 880,
          judge: { choice: 'solved', confidence: 0.95, probabilities: {}, extract: 0,
                   full_guess: 0.96, guess_ok: 0.94, said: {}, model: 'shots-stub' },
          bottom: ${JSON.stringify(SOLVED_BOTTOM)},
        }));
      }
      return of.apply(window, arguments);
    };
  })();`;
}

async function shoot(v, extra) {
  const PORT = await freePort();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--font-render-hinting=none', '--force-color-profile=srgb',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP || '/tmp', 'shots_' + PORT)}`,
    `--window-size=${v.w},${v.h}`, 'about:blank'], { stdio: 'ignore' });
  const waitFor = async (fn) => {
    const t0 = Date.now();
    for (;;) {
      try { const r = await fn(); if (r) return r; } catch {}
      if (Date.now() - t0 > 20000) throw new Error('chrome 启动超时');
      await sleep(200);
    }
  };
  let ws;
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(t.webSocketDebuggerUrl);
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
    const ev = async (e) => (await send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

    await send('Page.enable'); await send('Runtime.enable');
    // 跳掉首访入馆引导，否则它是个全屏浮层，拍出来全是那张卡
    await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: bootStub() });
    await send('Emulation.setDeviceMetricsOverride',
      { width: v.w, height: v.h, deviceScaleFactor: DSF, mobile: v.mobile });
    await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + '_cb=' + Date.now() });
    await sleep(4500);

    await extra({ ev, send, sleep });

    // 让 Chrome 直接编 webp，省掉一道外部转码
    const shot = await send('Page.captureScreenshot',
      { format: 'webp', quality: QUALITY, captureBeyondViewport: false });
    const file = join(OUT, `${v.name}.webp`);
    const buf = Buffer.from(shot.data, 'base64');
    writeFileSync(file, buf);
    console.log(`  -> ${file}  ${Math.round(buf.length / 1024)}KB`);
    return [v.name, file, buf.length];
  } finally {
    try { ws && ws.close(); } catch {}
    try { chrome.kill(); } catch {}
  }
}

async function ask(ev, text) {
  await ev(`(function(){
    var el = document.getElementById('typed');
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('typeLine').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 1; })()`);
  await sleep(2600);
}

const done = [];
for (const v of SHOTS) {
  console.log(`\n=== ${v.name}  ${v.w}×${v.h}  —— ${v.note}`);
  const r = await shoot(v, async ({ ev, send }) => {
    for (let i = 0; i < v.until; i++) await ask(ev, SCENES[i].q);
    if (v.thenSolve) {
      await ev(solveStub());
      await ask(ev, '外面爆发了丧尸病毒，她以为自己是唯一活下来的人，才跳楼的；跳下去那瞬间电话响了，说明还有别的活人。');
      await sleep(2200);
    }
    if (v.thenFinder) {
      await ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k'}))");
      await sleep(900);
    }
  }).catch((e) => { console.log('  ! ' + v.name + ' 失败: ' + e.message); return null; });
  if (r) done.push(r);
  await sleep(300);
}

if (done.length) {
  const total = done.reduce((a, x) => a + x[2], 0);
  console.log(`\n出了 ${done.length} 张，合计 ${Math.round(total / 1024)}KB`);
  for (const [name, file, bytes] of done) console.log(`  ${name.padEnd(10)} ${Math.round(bytes / 1024)}KB`);
  console.log('\n想更小/更清晰就调 SHOT_DSF 或 SHOT_Q 再来一遍（见文件头）。');
} else {
  console.log('\n一张都没出成功 —— 服务起着吗？先 curl 一下 /api/health。');
  process.exit(1);
}
