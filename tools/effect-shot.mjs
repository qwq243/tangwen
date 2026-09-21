// 结案 / 关键点解锁的观感自查：把两种反馈定格成图，顺带断言结构、文案、可关闭性。
// 用法: node tools/effect-shot.mjs [url] [outDir]
//
// 判题要出网，沙箱/断网环境里服务端开 socket 会被拒（WinError 10013），
// 所以这里一律拦住 /api/ask 喂脚本化的回答，只验证展示层。
// 注意：汤底是「服务端私有字段」，只随 /api/ask 的响应下发，
// 所以这里必须自己造一条足够长的汤底，才能验出画卷在手机上会不会滚。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.mjs';
import { freePort } from './chrome-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const OUT = process.argv[3] || join(PROJ, 'tmp', '_shot');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = await freePort();
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 对齐 puzzles.json 里最长的那条汤底（信 / 248 字）—— 画卷要不要滚，全看这一条
const LONG_BOTTOM =
  '妹妹确实死在那间房里，但不是被谁推进去的——她是自己锁上门，把钥匙攥在手心里，' +
  '坐在床脚等药效上来的。哥哥在门外敲了整夜，她一句都没应。' +
  '她留下的那封信里只写了一行：别让爸妈知道我是故意的，就说我是睡着了。' +
  '所以这间房后来一直锁着，不是怕人进去，是怕里面的那股味道散掉——' +
  '那是她最后一点还在的证据。哥哥每年这天都会来坐一会儿，不开灯，也不说话，' +
  '就当她还坐在床脚，等他敲完这一夜。后来房东把这间房租给了别人，' +
  '新住客说夜里总听见有人敲门，敲得很轻，像是怕吵醒谁。';

const KEYS = [
  { id: 'k1', label: '妹妹是自己锁的门' },
  { id: 'k2', label: '房里没有第二个人' },
  { id: 'k3', label: '她留了一封信' },
  { id: 'k4', label: '哥哥知道真相' },
];

const UNLOCK = {
  ok: true, label: '是', verdict: 'yes', solved: false, latency_ms: 412,
  unlocked: ['k1'], keys: KEYS,
};
const SOLVED = {
  ok: true, label: '结案', verdict: 'solved', solved: true, latency_ms: 508,
  unlocked: ['k1', 'k2', 'k3', 'k4'], keys: KEYS, bottom: LONG_BOTTOM,
};

const VIEWS = [
  { label: 'desktop_1440x900', W: 1440, H: 900, mobile: false },
  { label: 'phone_390x844', W: 390, H: 844, mobile: true },
  // 730 高是微信 / QQ 里打开时的真实可用高度，会落到紧凑态 —— 顺带把紧凑态也过一遍
  { label: 'phone_compact_390x730', W: 390, H: 730, mobile: true },
];

/* 掌灯人可能落下的每一枚印。加/改判题档位时，这里跟着补一条，
   展示层（印章 + 记录条）漏了哪一档会立刻报出来。 */
const VERDICTS = [
  ['yes', '是'],
  ['no', '不是'],
  ['both', '是也不是'],
  ['partial', '部分对'],
  ['close', '接近了'],
  ['irrelevant', '无关'],
  ['unimportant', '不重要'],
  ['unanswerable', '问清楚点'],
  ['refuse', '不能剧透'],
  ['solved', '结案'],
];

const HOOK = `(function(){
  var of = window.fetch;
  window.__next = [];
  window.__served = 0;
  window.fetch = function(input, init){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/ask') < 0) return of.apply(this, arguments);
    window.__served += 1;
    var r = window.__next.shift() ||
      { ok:true, label:'无关', verdict:'irrelevant', solved:false, unlocked:[], keys:[], latency_ms:280 };
    return Promise.resolve(new Response(JSON.stringify(r),
      { status:200, headers:{ 'Content-Type':'application/json' } }));
  };
})();`;

const PROBE = `(function(){
  function box(sel){ var e=document.querySelector(sel); if(!e) return null;
    var cs=getComputedStyle(e);
    if(cs.display==='none'||e.hidden) return {hidden:true};
    var r=e.getBoundingClientRect();
    return {x:Math.round(r.x),y:Math.round(r.y),right:Math.round(r.right),
            bottom:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)}; }
  var body=document.querySelector('.finale-body');
  return {
    reveal:{ hidden:document.getElementById('reveal').hidden,
             kicker:document.getElementById('revealKicker').textContent,
             title:document.getElementById('revealTitle').textContent,
             count:document.getElementById('revealCount').textContent,
             plate:box('.reveal-plate') },
    stamp:{ text:document.getElementById('stamp').textContent,
            cls:document.getElementById('stamp').className, box:box('#stamp') },
    finale:{ hidden:document.getElementById('finale').hidden,
             cls:document.getElementById('finale').className,
             title:document.getElementById('finaleTitle').textContent,
             bottomLen:(document.getElementById('finaleBottom').textContent||'').length,
             stats:document.getElementById('finaleStats').textContent,
             scroll:box('#finaleScroll'), chop:box('.finale-chop'), tip:box('.finale-tip'),
             body: body ? {h:body.clientHeight, scrollH:body.scrollHeight} : null,
             bodyBox:box('.finale-body') },
    keys: [].slice.call(document.querySelectorAll('.key-chip')).map(function(c){return c.textContent;}),
    keyCls: [].slice.call(document.querySelectorAll('.key-chip')).map(function(c){return c.className;}),
    served: window.__served || 0,
    queued: (window.__next || []).length,
    errs:(window.__errs||[]).slice(0,5)
  };
})()`;

let fails = 0;
const check = (ok, what, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

async function run(v) {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP || '/tmp', 'fx_' + PORT)}`,
    `--window-size=${v.W},${v.H}`, 'about:blank'], { stdio: 'ignore' });

  const waitFor = async (fn) => {
    const t0 = Date.now();
    for (;;) { try { const r = await fn(); if (r) return r; } catch { /* 还没起来 */ }
      if (Date.now() - t0 > 20000) throw new Error('Chrome 调试端口没起来'); await sleep(200); }
  };

  console.log(`\n=== ${v.label} ===`);
  try {
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
    const ev = async (e) => (await send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const f = join(OUT, name);
      writeFileSync(f, Buffer.from(s.data, 'base64'));
      console.log('  SHOT ' + name);
    };

    await send('Page.enable'); await send('Runtime.enable');
    // 跳过入馆引导，否则它盖在卷面上，截图全废
    await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
    await send('Page.addScriptToEvaluateOnNewDocument', { source:
      // 每个视口开页前清掉**进度存档**：三个视口共用同一个 --user-data-dir
      // （PORT 在模块加载时定一次），上一轮解锁 / 讲出的关键点会被这一轮 restore 回来 ——
      // 症状是「这一轮才讲出来」那类断言只在第一个视口过（1b 假红过一次）。
      // 只清 progress，不动 SEED 塞的 tour / sound。
      "try{localStorage.removeItem('fengcun.progress')}catch(e){};" +
      "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('ERR:'+(e.message||''))});" +
      "window.addEventListener('unhandledrejection',function(e){window.__errs.push('REJ:'+String(e.reason&&e.reason.message||e.reason))});" +
      "var __ce=console.error;console.error=function(){window.__errs.push('CONSOLE:'+Array.prototype.join.call(arguments,' '));__ce.apply(console,arguments)};" });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await send('Emulation.setDeviceMetricsOverride', { width: v.W, height: v.H, deviceScaleFactor: 1, mobile: v.mobile });
    await send('Page.navigate', { url: URL + '?_cb=' + Date.now() });
    /* 等「app 真的开卷了」再开始喂回答 —— 不要写死 sleep(4500)。
       每个探针都起一个全新的 Chrome（冷缓存），第一组用例起得最慢；
       套件里脚本一多、机器一忙，4500ms 就可能还没等到 /api/puzzles 回来，
       于是十档全测成空的（印章文案 ""、记录条 null）—— 假红，看着却像功能坏了。
       判据是 #boot 收掉（hideBoot() 加的 done 类），那时 paintStrip 已经跑过一遍。 */
    /* 加硬上限：页面正在导航时 Runtime.evaluate 有可能**永不返回**，
       那样 waitFor 会一直挂着，整个探针吊死、套件只报「超时」什么线索都没有。
       所以用 Promise.race 兜一层，最多等 12 秒就往下走。 */
    await Promise.race([
      waitFor(async () => await ev(
        "!!document.getElementById('boot') && document.getElementById('boot').classList.contains('done')")),
      sleep(12000),
    ]);
    await sleep(800);

    const askScripted = async (resp) => {
      await ev(`(function(){ window.__next.push(${JSON.stringify(resp)});
        var el=document.getElementById('typed'); el.value='她是怎么死的';
        document.getElementById('typeLine').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
        return 1; })()`);
    };

    // ---- 0. 每一档回答都要能落下来 ----
    // 判题会回「是也不是 / 不重要」这类中间态（题目复杂时只答是 / 不是 会判错），
    // 所以先把十档挨个喂一遍，确认印章文案、CSS 类、记录条 chip 都没漏。
    const sweep = [];
    for (const [verdict, label] of VERDICTS) {
      await askScripted({ ok: true, label, verdict, solved: false, unlocked: [], keys: [], latency_ms: 210 });
      await sleep(140);
      sweep.push(await ev(`(function(){
        var s = document.getElementById('stamp');
        var a = document.querySelector('.ledger li .a');
        return { v:${JSON.stringify(verdict)}, want:${JSON.stringify(label)},
                 stamp:s.textContent, cls:s.className, color:getComputedStyle(s).color,
                 chip:a ? a.textContent : null, chipCls:a ? a.className : null,
                 chipColor:a ? getComputedStyle(a).color : null }; })()`));
    }
    const badStamp = sweep.filter((s) => s.stamp !== s.want || !new RegExp('\\b' + s.v + '\\b').test(s.cls));
    const badChip = sweep.filter((s) => s.chip !== s.want || !new RegExp('\\b' + s.v + '\\b').test(s.chipCls || ''));
    await shot(`fx_${v.label}_0_verdicts.png`);
    check(badStamp.length === 0, '十档印章文案 / 类名齐全',
      badStamp.map((s) => `${s.v}→"${s.stamp}"/${s.cls}`).join(' ') || '全过');
    check(badChip.length === 0, '十档在记录条里都留了 chip',
      badChip.map((s) => `${s.v}→"${s.chip}"/${s.chipCls}`).join(' ') || '全过');
    // 新增的两档必须各占一个别人没用的颜色：撞色会让玩家分不清
    // 「是也不是」和「接近了」这类相邻档（老几档本来就有意分组同色，不在这里管）
    const collide = ['both', 'unimportant'].map((newV) => {
      const me = sweep.find((s) => s.v === newV);
      const other = sweep.find((s) => s.v !== newV && s.color === me.color);
      return other ? `${newV} 与 ${other.v} 同色 ${me.color}` : '';
    }).filter(Boolean);
    check(collide.length === 0, '新增档（是也不是 / 不重要）配色不与他人相撞',
      collide.join(' ') || sweep.filter((s) => s.v === 'both' || s.v === 'unimportant')
        .map((s) => `${s.v}=${s.color}`).join(' '));

    // ---- 1. 关键点解锁 ----
    await askScripted(UNLOCK);
    await sleep(260);
    let r = await ev(PROBE);
    await shot(`fx_${v.label}_1_unlock.png`);
    check(r.reveal.hidden === false, '解锁时揭示牌弹出来');
    check(r.reveal.kicker === '关 键 点', 'kicker = 关 键 点', JSON.stringify(r.reveal.kicker));
    check(/已解锁\s*1\s*\/\s*4/.test(r.reveal.count), '计数 = 已解锁 1 / 4', JSON.stringify(r.reveal.count));
    check(/妹妹是自己锁的门/.test(r.reveal.title), '标题是解锁的关键点', JSON.stringify(r.reveal.title));
    check(!!r.reveal.plate && !r.reveal.plate.hidden, '揭示牌有实体盒子', JSON.stringify(r.reveal.plate));
    check(r.keys.length === 1, '记录面板里落了 1 枚 chip', JSON.stringify(r.keys));

    // ---- 1b. 他自己讲出来了：chips 的第二档 + 「讲出来了」那张牌 ----
    /* 结案有两条路（见 server.py 的 SOLVE_RULE）：除了「整个流程讲一遍」，
       **关键点自己讲出来到够**也算。所以这一档要有自己看得见的样子 ——
       不然玩家不知道「说出来」这句话是有分量的，只会一条条接着问下去。 */
    await sleep(2600); // 等上一张揭示牌退场（不然两张叠在一起，量到的是旧的）
    await askScripted({ ok: true, label: '是', verdict: 'yes', solved: false, latency_ms: 380,
      unlocked: ['k1', 'k2', 'k3'], stated: ['k1'], keys: KEYS });
    await sleep(300);
    r = await ev(PROBE);
    await shot(`fx_${v.label}_1b_said.png`);
    check(r.reveal.hidden === false && r.reveal.kicker === '讲 出 来 了',
      '讲出来了弹揭示牌（kicker = 讲 出 来 了）', JSON.stringify(r.reveal.kicker));
    check(/已讲出\s*1\s*\/\s*4/.test(r.reveal.count), '计数 = 已讲出 1 / 4', JSON.stringify(r.reveal.count));
    check(r.keyCls.filter((c) => /\bsaid\b/.test(c)).length === 1,
      '自己讲出来的那枚 chip 标了 .said（只是问到的那两枚不标）', JSON.stringify(r.keyCls));
    check(r.keyCls.length === 3 && r.keyCls.every((c) => /\bon\b/.test(c)),
      '三枚 chip 都还亮着（问到 = 亮，讲出来 = 亮 + 说）', JSON.stringify(r.keyCls));
    console.log(`     诊断 served=${r.served} queued=${r.queued} reveal="${r.reveal.kicker}"/"${r.reveal.count}"`);

    // ---- 2. 结案：印章 ----
    await sleep(2600); // 等揭示牌退场
    await askScripted(SOLVED);
    await sleep(300);
    r = await ev(PROBE);
    await shot(`fx_${v.label}_2_stamp.png`);
    check(r.stamp.cls.indexOf('solved') > 0, '印章带 solved 类', JSON.stringify(r.stamp.cls));
    check(r.stamp.text === '结案', '印章文案 = 结案', JSON.stringify(r.stamp.text));
    check(r.finale.hidden === true, '这一拍画卷还没上来（先落印）');

    // ---- 3. 结案：画卷展开 ----
    await sleep(520);
    await shot(`fx_${v.label}_3_unroll.png`);
    await sleep(1500);
    r = await ev(PROBE);
    await shot(`fx_${v.label}_4_finale.png`);
    check(r.finale.hidden === false, '画卷推上来了');
    check(r.finale.title.length > 0, '画卷有卷名', JSON.stringify(r.finale.title));
    check(r.finale.bottomLen >= 200, '画卷有完整汤底', 'len=' + r.finale.bottomLen);
    check(/问\s*\d+\s*次/.test(r.finale.stats) && /用时\s*\d\d:\d\d/.test(r.finale.stats),
      '战绩行完整', JSON.stringify(r.finale.stats));
    check(!!r.finale.scroll && r.finale.scroll.w > 0 && r.finale.scroll.h > 0, '卷轴有实体盒子', JSON.stringify(r.finale.scroll));
    check(!!r.finale.chop && !r.finale.chop.hidden, '落款朱印可见', JSON.stringify(r.finale.chop));
    check(!!r.finale.tip && !r.finale.tip.hidden, '收起提示可见', JSON.stringify(r.finale.tip));
    const body = r.finale.body;
    console.log(`     汤底滚动区 h=${body.h} scrollH=${body.scrollH}` + (body.scrollH > body.h + 1 ? '  (需要滚)' : '  (一屏放得下)'));
    check(r.finale.scroll.bottom <= v.H, '卷轴没超出屏幕下沿', `${r.finale.scroll.bottom} <= ${v.H}`);
    // 汤底要滚的时候，朱印最容易压到正文最后几行上 —— 钉一条几何断言
    check(r.finale.chop.y >= r.finale.bodyBox.bottom - 1,
      '朱印落在正文区之下（不压字）',
      `chop.y=${r.finale.chop.y} >= body.bottom=${r.finale.bodyBox.bottom}`);

    // 展示层级：解锁是一条通知，结案才是标题 —— 字号必须是「解锁 < 结案」
    const sizes = await ev(`(function(){
      var a=parseFloat(getComputedStyle(document.querySelector('.reveal-title')).fontSize);
      var b=parseFloat(getComputedStyle(document.querySelector('.finale-title')).fontSize);
      return { reveal:a, finale:b, ok:a < b }; })()`);
    check(sizes.ok, '解锁牌字号 < 结案卷名字号', `${sizes.reveal}px < ${sizes.finale}px`);

    // ---- 4. 收起 ----
    await ev("document.getElementById('finale').click()");
    await sleep(700);
    r = await ev(PROBE);
    await shot(`fx_${v.label}_5_dismissed.png`);
    check(r.finale.hidden === true, '轻触后画卷收起');
    check(r.errs.length === 0, '无 JS 报错', JSON.stringify(r.errs));

    ws.close();
  } catch (e) {
    console.log(`  [FAILED] ${e.message}`);
    fails++;
  } finally {
    try { chrome.kill(); } catch {}
  }
}

console.log(`url = ${URL}\nout = ${OUT}`);
for (const v of VIEWS) { await run(v); await sleep(400); }
console.log(fails ? `\n[FAIL] ${fails} 项没过` : '\n[OK] 全部通过');
process.exit(fails ? 1 : 0);
