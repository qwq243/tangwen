/* 汤问 · 前端 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const strip = $("strip");
  const frame = $("frame");
  const imgPrev = $("imgPrev");
  const imgCurr = $("imgCurr");
  const imgNext = $("imgNext");
  const stampEl = $("stamp");
  const titleEl = $("title");
  const noEl = $("no");
  const diffEl = $("diff");        // 难度标签（浅 / 中 / 深）
  const soupEl = $("soup");        // 汤色标签（清汤 / 红汤 / 黑汤）
  const surfaceEl = $("surface");
  const heardEl = $("heard");
  const statusEl = $("status");
  const mic = $("mic");
  const micCap = $("micCap");
  // 麦克风默认提示语：voiceReset 要还原到这一句；浏览器没有语音识别时换成打字引导
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const micIdleCap = SR ? "按住说话 · 也可打字" : "此浏览器不支持语音 · 打字提问";
  const typeLine = $("typeLine");
  const typed = $("typed");
  const ledgerEl = $("ledger");
  const keysEl = $("keys");
  const boardEl = $("board");
  const askCountEl = $("askCount");
  const elapsedEl = $("elapsed");
  const pauseTagEl = $("pauseTag");
  const lastMsEl = $("lastMs");
  const playerNameEl = $("playerName");
  const soundBtn = $("sound");
  const lampBtn = $("lamp");
  const hintAskBtn = $("hintAsk");
  const hintLineEl = $("hintLine");
  const hintTextEl = $("hintText");
  const hintEl = $("hint");
  const bootEl = $("boot");
  const bootCap = $("bootCap");
  const finder = $("finder");
  const finderBox = finder.querySelector(".finder-box");
  const findInput = $("findInput");
  const findList = $("findList");
  const findClear = $("findClear");
  const findFold = $("findFold");

  const Snd = window.FengcunAudio;
  /* 玩家名池：吉利、端正的二字词 + 两位数字。
     早先那批（夜馆/棺灯/头七/扫墓…）是照着谜面氛围取的，玩家反馈太阴森，换成好意头的词。
     挑词标准：二字、有出处或好意头、读起来像个正经人名/别号，不玩梗、不猎奇。 */
  const NAMES = ["瑞安", "长乐", "清晏", "嘉树", "怀瑾", "知微", "景行", "望舒", "听澜", "云归", "岁和", "鸣谦"];
  /* 老存档里存下的旧名，见到就换掉 */
  const LEGACY_NAMES = ["夜馆", "封存", "棺灯", "鼠步", "虚掩", "头七", "扫墓", "冰锥", "楚歌", "笔仙"];
  const SLIDE_MS = 520;

  let puzzles = [];
  let index = 0;
  let dragX = 0;
  let dragging = false;
  let startX = 0;
  let startT = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let animating = false;
  let listening = false;
  let busy = false;
  let stampTimer = 0;
  let revealTimer = 0;
  let finaleTimer = 0;
  let hintTimer = 0;
  let wheelLock = 0;
  /* 埋点攒批的定时器。必须在这里声明：文件是 "use strict" 的，
     下面 `trackTimer = setInterval(...)` 那行在未声明时会直接抛 ReferenceError，
     把整个 IIFE 从这一行掐断 —— 后面的取卷、布局、换卷、提问全都不会挂上。 */
  let trackTimer = 0;
  let voiceGen = 0;
  let audioBooted = false;
  let soundOn = true;
  let lampOn = false;
  let ledgerSig = "";
  let booted = false;

  const historyMap = new Map();
  /* 每一卷的「手上时间」（毫秒）。不是墙上时间：
     长时间没操作会停表，暂停的那段不计进来，见下面「计时」那一段。 */
  const activeMs = new Map();
  const unlockedMap = new Map();
  /* 「他自己讲出来了的关键点」（结案的两条路之一看它，见 server.py 的 SOLVE_RULE）。
     跟 unlockedMap 一样跨轮累积：服务端会回一份 stated，下一问再带回去 ——
     不带回去的话「一句话讲一个关键点」这种打法永远凑不齐。 */
  const statedMap = new Map();
  const solvedSet = new Set();
  /* 「求过灯」和「灯上写了什么」是两回事：hintedSet 只记前者（排行榜的「孤灯」看它），
     hintMap 记后者。只存 hintedSet 的话，刷新一次提示正文就没了 ——
     玩家已经把孤灯赔进去，却再也读不到那句提示。 */
  const hintedSet = new Set();
  const hintMap = new Map();
  const coverCache = new Map();
  const coverQueue = [];
  let coverInflight = 0;
  let coverIdle = 0;
  let lastSlideDir = 0;
  let player = loadPlayer();
  restoreProgress();

  /* ---------------- 声音 ---------------- */

  try {
    soundOn = localStorage.getItem("fengcun.sound") !== "0";
  } catch (_) {}
  soundBtn.classList.toggle("off", !soundOn);
  if (Snd) Snd.setOn(soundOn);

  function firstGesture() {
    if (audioBooted || !Snd) return;
    audioBooted = true;
    Snd.boot();
    if (soundOn) {
      Snd.startMusic();
      // 开卷第一声：跟环境音一起起，标一下「馆子开了」（这一下之前浏览器不许出声）
      Snd.sfx("open");
    }
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, firstGesture, { once: true, passive: true })
  );

  soundBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    soundOn = !soundOn;
    soundBtn.classList.toggle("off", !soundOn);
    try { localStorage.setItem("fengcun.sound", soundOn ? "1" : "0"); } catch (_) {}
    firstGesture();
    if (Snd) Snd.setOn(soundOn);
    if (soundOn && Snd) Snd.sfx("release");
    showHint(soundOn ? "声音开" : "声音关", 1400);
  });

  try { lampOn = localStorage.getItem("fengcun.lamp") === "1"; } catch (_) {}
  /* 提示行的唯一出口：改这里就够了，灯开关与换卷都走它。
     灯灭必须收起来（关灯就不该再看到提示），灯再开要自己回来 ——
     这句是「关一下灯提示就永久消失」那个 bug 的修补点。

     位置只剩一处：#hintLine，也就是**记录方框的第一行**（2026-09-20 用户定的位置：
     「直接放在我们历史记录方框的上面，但是不要把汤面挡住了」）。
     以前还有一件屏幕正中的浮层，盖在汤面上，已经删了。 */
  function syncHint() {
    const p = puzzles.length ? current() : null;
    const hint = lampOn && p ? (hintMap.get(p.id) || "") : "";
    if (hintTextEl.textContent !== hint) hintTextEl.textContent = hint;
    hintLineEl.hidden = !hint;
  }
  /* 灯刚来那一下：把整行点亮一记（.lit）。这是删掉居中浮层之后「点下去当场有反应」的
     替代 —— 反馈落在提示自己该在的地方，不浮到汤面上盖东西。
     先摘掉再强制回流：连点两次求灯时，第二次也得亮（不然同名动画不会重放）。 */
  function litHint() {
    hintLineEl.classList.remove("lit");
    void hintLineEl.offsetWidth;
    hintLineEl.classList.add("lit");
  }
  function syncLamp() {
    lampBtn.classList.toggle("off", !lampOn);
    lampBtn.setAttribute("aria-pressed", lampOn ? "true" : "false");
    lampBtn.setAttribute("aria-label", lampOn ? "提示开" : "提示关");
    lampBtn.title = lampOn
      ? "提示开 · 求灯在底栏。点关 —— 开过灯的结案不挂孤灯"
      : "提示关 · 开了才能求灯";
    if (!lampOn) {
      hintAskBtn.hidden = true;
      hintLineEl.hidden = true;
      return;
    }
    const p = puzzles.length ? current() : null;
    hintAskBtn.hidden = !p || solvedSet.has(p.id);
    syncHint();
  }
  syncLamp();
  lampBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    lampOn = !lampOn;
    try { localStorage.setItem("fengcun.lamp", lampOn ? "1" : "0"); } catch (_) {}
    syncLamp();
    /* 开灯这句要说清「求灯去哪了」：它 2026-09-20 从「询问记录」面板里挪到了底栏，
       不点一句的话，老玩家会以为这个功能没了。 */
    showHint(lampOn ? "提示开 · 底栏多了「求灯」" : "提示关", 1800);
    /* 开灯 / 关灯各有一声：点灯是芯爆，关灯是吹灭。
       以前借的是一声 hover（鼠标划过那种「嗒」），跟灯这个隐喻一点关系都没有。 */
    sfx(lampOn ? "wickOn" : "wickOff");
  });

  const sfx = (name, arg) => { if (Snd) Snd.sfx(name, arg); };

  /* ---------------- 存档 ---------------- */

  function pickName() {
    return NAMES[Math.floor(Math.random() * NAMES.length)] + String(10 + Math.floor(Math.random() * 89));
  }

  function loadPlayer() {
    try {
      const raw = JSON.parse(localStorage.getItem("fengcun.player") || "null");
      if (raw && raw.id && raw.name) {
        // 名池换过一轮：旧存档里是「头七73」这种，换成新名但保留 id，
        // 免得排行榜上同一个人的成绩裂成两条。
        if (LEGACY_NAMES.indexOf(raw.name.slice(0, 2)) >= 0) {
          raw.name = pickName();
          try { localStorage.setItem("fengcun.player", JSON.stringify(raw)); } catch (_) {}
        }
        return raw;
      }
    } catch (_) {}
    const born = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name: pickName() };
    try { localStorage.setItem("fengcun.player", JSON.stringify(born)); } catch (_) {}
    return born;
  }

  function savePlayer() {
    try { localStorage.setItem("fengcun.player", JSON.stringify(player)); } catch (_) {}
  }

  function restoreProgress() {
    try {
      const raw = JSON.parse(localStorage.getItem("fengcun.progress") || "{}");
      Object.entries(raw.unlocked || {}).forEach(([id, keys]) => unlockedMap.set(id, keys));
      Object.entries(raw.stated || {}).forEach(([id, keys]) => statedMap.set(id, keys));
      (raw.solved || []).forEach((id) => solvedSet.add(id));
      (raw.hinted || []).forEach((id) => hintedSet.add(id));
      Object.entries(raw.hints || {}).forEach(([id, text]) => { if (text) hintMap.set(id, text); });
      Object.entries(raw.active || {}).forEach(([id, ms]) => { if (ms > 0) activeMs.set(id, ms); });
      Object.entries(raw.history || {}).forEach(([id, turns]) => historyMap.set(id, turns));
      window.__bottoms = raw.bottoms || {};
    } catch (_) {}
  }

  function saveProgress() {
    const unlocked = {};
    unlockedMap.forEach((v, k) => { unlocked[k] = v; });
    const stated = {};
    statedMap.forEach((v, k) => { stated[k] = v; });
    const active = {};
    activeMs.forEach((v, k) => { active[k] = Math.round(v); });
    const history = {};
    historyMap.forEach((v, k) => { history[k] = v; });
    const hints = {};
    hintMap.forEach((v, k) => { hints[k] = v; });
    try {
      localStorage.setItem("fengcun.progress", JSON.stringify({
        unlocked,
        stated,
        solved: [...solvedSet],
        hinted: [...hintedSet],
        hints,
        active,
        history,
        bottoms: window.__bottoms || {},
      }));
    } catch (_) {}
  }

  /* ---------------- 埋点 ----------------

     只记「什么事件发生了几次」，不记问题原文、不记 IP、不记设备。
     uid 直接复用排行榜那个 player.id —— 本来就是本地随机生成的，跟人不对应。

     **这里只报 pv 一件。** ask / hint / solve / give 由服务端在各自的接口里
     自己数（/api/ask、/api/hint、/api/giveup 各记一笔，结案在 /api/ask 的判题
     结果里认）—— 服务端当场就知道的事，不该由页面转述。

     ⚠️ 2026-09-20 的事故就是这么来的：这三档原先写在这里，而线上跑着的是**旧的
     app.js**（页面改动要等下一次部署才生效）。那段时间线上后台的提问/求灯/结案
     整天是 0，访问量却照常涨（实况 pv=67 uv=22 ask=0），看起来像后台坏了。
     以后再加事件，先问一句「服务端自己看得见吗」：
       看得见 -> 写进接口（server.py 的 bump_track / Worker 的 bumpTrack）；
       看不见 -> 才写在这里（比如「这一卷在浏览器里真的开出来了」）。

     必须攒批再发：一次开卷发一条的话，云那边一天几千次 KV 写就顶到免费额度了。
     这里攒够 20 秒、或者页面要走了才 flush 一次，一次会话通常只写 1~3 次。
     页面要走了那一次必须走 sendBeacon —— 普通的 fetch 在这个时机会被浏览器直接掐掉。 */
  const trackBuf = new Map();

  function track(kind) {
    if (!player || !player.id) return;
    trackBuf.set(kind, (trackBuf.get(kind) || 0) + 1);
  }

  function trackFlush() {
    if (!trackBuf.size) return;
    const events = [];
    trackBuf.forEach((n, kind) => {
      // 单批同一个事件最多认 40 条，和云那边 240 条的闸一起防刷
      for (let i = 0; i < Math.min(n, 40); i++) events.push({ k: kind });
    });
    trackBuf.clear();
    const body = JSON.stringify({ uid: player.id, events });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }))) return;
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  trackTimer = setInterval(trackFlush, 20000);
  window.addEventListener("pagehide", trackFlush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) trackFlush(); });

  /* ---------------- 工具 ---------------- */

  const pad = (n) => String(n + 1).padStart(2, "0");
  const wrap = (i) => (i + puzzles.length) % puzzles.length;
  const current = () => puzzles[index];

  /* 难度标签（浅 / 中 / 深）：**值在 puzzles.json 的 difficulty 字段里**，
     这里只管显示（口径与分档写在 tools/difficulty.py，改数据不用动代码）。 */
  const DIFF_ORDER = ["浅", "中", "深"];
  const DIFF_TIP = {
    "浅": "浅卷 · 关键点少，一层隐喻就够",
    "中": "中卷 · 几个关键点，得绕一两道弯",
    "深": "深卷 · 关键点多、隐喻成层，慢慢问",
  };
  /* 汤色（清汤 / 红汤 / 黑汤）：**值在 puzzles.json 的 soup 字段里**，
     这里只管显示与筛选（口径写在 tools/soup.py，改数据不用动代码）。
     来源是知乎《海龟汤：一场脑洞大开的推理游戏之旅》第四节的「海龟汤常见分类」，
     原文三句：清汤无恐怖无死亡 / 红汤有尸体命案 / 黑汤重口味血腥惊悚慎玩。
     它跟难度是两个正交的轴 —— 难度是「要问出几件事」，汤色是「要咽下什么」，
     所以挑选一卷时两件事都要看得见，这也是卷面上并排两枚印的原因。 */
  const SOUP_TIP = {
    "清汤": "清汤 · 无恐怖无死亡，轻松脑洞",
    "红汤": "红汤 · 有尸体、命案，偏悬疑",
    "黑汤": "黑汤 · 重口味、血腥、惊悚 · 慎玩",
  };
  const SOUP_ORDER = ["清汤", "红汤", "黑汤"];
  /* 每卷「几人已结案」。服务端单独一张表（排行榜每卷只留前 30 行，行数不等于人数），
     开卷后单独取一次 —— 与那份 18KB 卷宗分开，是为了让它继续走启动缓存。
     取不到就当空，界面照常，别为它把开卷卡住。 */
  let solveCounts = {};

  function loadSolveCounts() {
    fetch("/api/solves")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.ok) return;
        solveCounts = data.solves || {};
        // 列表开着就就地刷新（人数是晚一步才知道的）
        if (findOn || !findList.hidden) renderFind(findInput.value);
        const p = puzzles.length ? current() : null;
        if (p) $("boardSub").textContent = boardHeading(p, solveCounts[p.id] || 0);
      })
      .catch(() => {});
  }

  /* 榜头那一行：卷名 · 汤色 · 难度 · 几人已结案（没有的项不占位） */
  function boardHeading(p, n) {
    const bits = [p.title];
    if (p.soup) bits.push(p.soup);
    if (p.difficulty) bits.push(p.difficulty + "卷");
    if (n > 0) bits.push(n + " 人已结案");
    return bits.join(" · ");
  }

  /* 每秒轮询要写的那几个数字（问 3 / 00:42 / 128ms）走这里。
     1s 的 tick 里直接 `el.textContent = ...` 会**每秒**把文本节点换一遍，
     哪怕新值和旧值一模一样 —— 那会白白触发一次样式重算，手机上尤其亏。
     记住上一次写进去的字符串，值没变就什么都不做。
     注意：同一元素的**所有**写入都要走这里，别在别处直接写，否则这份记忆会失效。 */
  function setText(el, text) {
    if (!el) return;
    if (el.__t === text) return;
    el.__t = text;
    el.textContent = text;
  }

  /* 原图是 2MB 级 PNG，同目录备了一份 webp（约 1/20 体积）。支持就优先用。 */
  const WEBP_OK = (() => {
    try {
      const c = document.createElement("canvas");
      return c.toDataURL("image/webp").startsWith("data:image/webp");
    } catch (_) {
      return false;
    }
  })();
  const COVER_MAX_INFLIGHT = 2;
  /* 空闲补图的范围。桌面上把 34 卷全补上无所谓；手机上「全补」等于把 34 张封面
     一起解进内存 —— 那是这个页面最大的一块占用，也是最容易被系统回收掉的一块。
     所以手机上只补前后各 8 卷：顺着滑、搜索跳卷都还在圈里，常驻内存少掉一大半。 */
  const IDLE_SPAN = window.innerWidth < 760 ? 8 : 34;
  const resolvedSrc = new WeakMap();

  function srcOf(p) {
    if (!p) return "";
    if (resolvedSrc.has(p)) return resolvedSrc.get(p);
    return "./" + (WEBP_OK ? p.image.replace(/\.png$/i, ".webp") : p.image);
  }

  function rememberSrc(p, src) {
    if (p && src) resolvedSrc.set(p, src);
  }

  function saveDataOn() {
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return false;
      if (c.saveData) return true;
      return /2g/i.test(c.effectiveType || "");
    } catch (_) {
      return false;
    }
  }

  function coverRecord(src) {
    let rec = coverCache.get(src);
    if (rec) return rec;
    rec = { img: new Image(), ready: null, ok: false, started: false, resolve: null };
    rec.img.decoding = "async";
    rec.ready = new Promise((resolve) => { rec.resolve = resolve; });
    coverCache.set(src, rec);
    return rec;
  }

  function startCoverFetch(src) {
    const rec = coverRecord(src);
    if (rec.started) return rec.ready;
    rec.started = true;
    coverInflight += 1;
    rec.img.onload = () => {
      rec.ok = rec.img.naturalWidth > 0;
      const done = rec.img.decode ? rec.img.decode() : Promise.resolve();
      done.catch(() => {}).finally(() => {
        rec.resolve(rec.ok);
        coverInflight -= 1;
        pumpCovers();
      });
    };
    rec.img.onerror = () => {
      rec.ok = false;
      rec.resolve(false);
      coverInflight -= 1;
      pumpCovers();
    };
    rec.img.src = src;
    return rec.ready;
  }

  function pumpCovers() {
    while (coverInflight < COVER_MAX_INFLIGHT && coverQueue.length) {
      const src = coverQueue.shift();
      const rec = coverCache.get(src);
      if (!rec || rec.started) continue;
      startCoverFetch(src);
    }
  }

  function enqueueCover(src, urgent) {
    const rec = coverRecord(src);
    if (rec.started) return rec.ready;
    if (urgent) return startCoverFetch(src);
    if (coverQueue.indexOf(src) < 0) coverQueue.push(src);
    pumpCovers();
    return rec.ready;
  }

  function preloadCover(p, urgent) {
    if (!p) return Promise.resolve("");
    const src = srcOf(p);
    return enqueueCover(src, urgent).then((ok) => {
      if (ok) {
        rememberSrc(p, src);
        return src;
      }
      if (/\.webp$/i.test(src)) {
        const png = src.replace(/\.webp$/i, ".png");
        rememberSrc(p, png);
        return enqueueCover(png, true).then(() => png);
      }
      return src;
    });
  }

  function coverReady(src) {
    const rec = coverCache.get(src);
    return !!(rec && rec.ok && rec.img.naturalWidth);
  }

  function assignCover(el, p, urgent) {
    if (!el || !p) return;
    const src = srcOf(p);
    el.alt = p.title || "";
    const ready = coverReady(src);
    if (el.getAttribute("src") !== src) el.src = src;
    el.dataset.src = src;
    el.classList.toggle("pending", !ready && !(el.complete && el.naturalWidth));
    preloadCover(p, urgent !== false).then((finalSrc) => {
      if (el.dataset.src !== src && el.dataset.src !== finalSrc) return;
      if (el.getAttribute("src") !== finalSrc) el.src = finalSrc;
      el.dataset.src = finalSrc;
      el.classList.remove("pending");
    });
  }

  /* 万一某个 webp 没生成出来，显示用的 <img> 再退回 PNG */
  function guardFallback(el) {
    el.addEventListener("error", function onErr() {
      const cur = el.getAttribute("src") || "";
      if (!/\.webp$/i.test(cur)) return;
      const png = cur.replace(/\.webp$/i, ".png");
      el.dataset.src = png;
      el.src = png;
    });
  }

  function restoreCursor() {
    try {
      const id = localStorage.getItem("fengcun.cursor") || "";
      const i = puzzles.findIndex((p) => p.id === id);
      if (i >= 0) index = i;
    } catch (_) {}
  }

  function saveCursor() {
    const p = current();
    if (!p) return;
    try { localStorage.setItem("fengcun.cursor", p.id); } catch (_) {}
  }

  function warmAround(i, dir) {
    if (!puzzles.length) return;
    const save = saveDataOn();
    const ahead = save ? 1 : 3;
    const behind = save ? 1 : 2;
    const order = [0];
    const sign = dir < 0 ? -1 : 1;
    for (let d = 1; d <= ahead; d++) order.push(sign * d);
    for (let d = 1; d <= behind; d++) order.push(-sign * d);
    order.forEach((off, n) => {
      const p = puzzles[wrap(i + off)];
      if (p) preloadCover(p, n < 3);
    });
    if (!save) scheduleIdleFill();
  }

  function scheduleIdleFill() {
    if (coverIdle || saveDataOn() || !puzzles.length) return;
    coverIdle = 1;
    const go = () => {
      coverIdle = 0;
      if (document.hidden || saveDataOn()) return;
      const span = Math.min(puzzles.length, IDLE_SPAN * 2 + 1);
      for (let d = 0; d < span; d++) {
        const p = puzzles[wrap(index + d)];
        if (!p) continue;
        const src = srcOf(p);
        const rec = coverCache.get(src);
        if (!coverReady(src) && !(rec && rec.started)) {
          preloadCover(p, false);
          scheduleIdleFill();
          return;
        }
      }
    };
    if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 2400 });
    else setTimeout(go, 700);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  function showHint(text, ms) {
    hintEl.textContent = text;
    hintEl.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove("show"), ms || 3600);
  }

  /* 这里原来还有一个 showHintCenter()：把求来的那句提示在屏幕正中浮一次再渐隐。
     2026-09-20 删了 —— 用户实报「提示不明显，放记录方框上面，别挡住汤面」，
     而屏幕正中那一浮在手机上正好盖住汤面。提示的常驻位现在是记录方框第一行
     （#hintLine），点下去那一下的即时反馈由 litHint() 给。 */

  /* 等掌灯人那段时间，状态行上写什么。

     1~2 秒是常态，所以头 3 秒只有「…… 」，不拿数字去吵人；
     过了 3 秒带上秒数 —— 网络慢 / 判题排队的时候，玩家能看到它一直在动，
     而不是盯着一个不动的省略号怀疑自己点空了。
     startWait / stopWait 必须成对：stopWait 只在「还在等」的时候才清状态行，
     免得把 catch 里刚写上去的报错信息一起抹掉。 */
  let waitTimer = 0;
  let waiting = false;

  function startWait(prefix) {
    waiting = true;
    const t0 = performance.now();
    statusEl.textContent = prefix;
    clearInterval(waitTimer);
    waitTimer = setInterval(() => {
      if (!waiting) return;
      const s = Math.round((performance.now() - t0) / 1000);
      if (s >= 3) statusEl.textContent = `${prefix} ${s} 秒`;
    }, 1000);
  }

  function stopWait() {
    clearInterval(waitTimer);
    waitTimer = 0;
    if (waiting) {
      waiting = false;
      statusEl.textContent = "";
    }
  }

  /* ---------------- 计时：手上时间 ----------------

     走的是「手上时间」，不是墙上时间。从开这一卷起算，只要**长时间没有任何操作**
     （提问 / 打字 / 拖动画框 / 点按钮 / 从别的 App 切回来）就停表，
     下一次操作自动接着走 —— 暂停的那一段直接丢掉。
     出门吃个饭、手机息屏、切去聊天再回来，用时不会凭空涨掉几千秒，
     排行榜上的「用时」才真的是解这一卷花掉的时间。

     停表必须看得见，而且**两套布局都要有出口**（README 里那条硬约束）：
     画廊态的出口是 `.meter` 里 #elapsed 前面那个「∥」，
     紧凑态 #elapsed 是 display:none，靠 #pauseTag 那枚小签兜住。

     状态只有一个（全局一台表），因为同一时刻只在解一卷，换卷时先结清上一卷。 */
  const IDLE_MS = (() => {
    /* 探针要验「停表」，不可能真等一分钟：localStorage 里塞 fengcun.idleMs 就能改这个阈值
       （和 fengcun.tour 一个路子，只影响本机那台浏览器的这份存档） */
    try {
      const v = Number(localStorage.getItem("fengcun.idleMs"));
      if (v >= 200) return v;
    } catch (_) {}
    return 60 * 1000;
  })();
  const clock = { running: false, id: "", at: 0, lastAct: 0 };

  /* 把「走到现在」的这一段结进账。停表期间 clock.running 是 false，天然不计 */
  function settleClock() {
    if (!clock.running || !clock.id) return;
    const now = Date.now();
    if (now > clock.at) activeMs.set(clock.id, (activeMs.get(clock.id) || 0) + (now - clock.at));
    clock.at = now;
  }

  function elapsedMsOf(id) {
    if (!id) return 0;
    const base = activeMs.get(id) || 0;
    return clock.running && clock.id === id ? base + Math.max(0, Date.now() - clock.at) : base;
  }

  /* 两个标记（#elapsed 的「∥」和 #pauseTag 那枚小签）在同一个动作里一起翻，
     不然停表那一下要等下一次 1s 轮询才看得出变化 */
  function syncPauseTag() {
    const paused = pausedNow();
    pauseTagEl.hidden = !paused;
    elapsedEl.classList.toggle("paused", paused);
    const p = puzzles.length ? current() : null;
    if (p) setText(elapsedEl, elapsedLabel());
  }

  /* 开卷 / 换卷：先把上一卷结清，再给这一卷起表 */
  function startClock(id) {
    if (!id) return;
    settleClock();
    if (!activeMs.has(id)) activeMs.set(id, 0);
    /* 结过案的卷不再起表：成绩已经交过了，时间再涨只会把排行榜上的「用时」泡大
       （用户实报：结案之后表还在走）。 */
    if (solvedSet.has(id)) {
      clock.id = "";
      clock.running = false;
      syncPauseTag();
      return;
    }
    clock.id = id;
    clock.running = true;
    clock.at = Date.now();
    clock.lastAct = clock.at;
    syncPauseTag();
  }

  function pauseClock(why) {
    if (!clock.running) return;
    settleClock();
    clock.running = false;
    syncPauseTag();
    saveProgress();
    /* 停表 / 回表都极轻地响一声：停表可能是自动的（闲置一分钟），
       不响这一下的话玩家回头看到表停了会以为坏了。 */
    sfx("pause");
    if (why === "idle") showHint("停表 · 好一会儿没动，动一下接着计", 3400);
  }

  /* 结案：把表摘下（clock.id 清空），**不是暂停**。
     pauseClock 只是暂停 —— 下一次 pointerdown（点掉结案画卷那一下就是）会被
     touchClock 接回去接着走，这就是「结案了还在记时」。
     摘掉之后 touchClock 认不出这一卷，startClock 也会因为 solvedSet 拒绝起表。 */
  function stopClock() {
    if (!clock.id && !clock.running) return;
    settleClock();
    clock.id = "";
    clock.running = false;
    syncPauseTag();
    saveProgress();
  }

  /* 计时行写什么：**暂停中**（且没结案）才挂「∥」。结案之后的时间是结清的定量，
     不是「暂停中」，所以不挂标记 —— 两个出口（#elapsed 的前缀和 #pauseTag）同一套判据。 */
  function pausedNow() {
    const p = puzzles.length ? current() : null;
    return !!p && !clock.running && !solvedSet.has(p.id);
  }

  function elapsedLabel() {
    const p = puzzles.length ? current() : null;
    if (!p) return "";
    return (pausedNow() ? "∥ " : "") + fmtClock(elapsedMsOf(p.id));
  }

  /* 任何一次操作都算「人还在」：暂停中就把表接回去（暂停那段不计）。
     clock.id 为空 = 还没开卷（启动遮罩 / 入馆规矩那会儿），这时不动表。 */
  function touchClock() {
    clock.lastAct = Date.now();
    if (!clock.id || clock.running) return;
    clock.running = true;
    clock.at = clock.lastAct;
    syncPauseTag();
    sfx("resume");   // 表接回来的一记（引擎那边 500ms 节流，连着点也只响一下）
  }

  function tickClock() {
    if (clock.running && Date.now() - clock.lastAct >= IDLE_MS) pauseClock("idle");
  }

  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, touchClock, { passive: true })
  );
  /* 切走 / 息屏：立刻停表。回来时接上 —— 不然「回来先看两眼」那段会被算进去 */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseClock("hidden");
    else touchClock();
  });
  window.addEventListener("pagehide", () => { settleClock(); saveProgress(); });

  /* ---------------- 搜剧本 ----------------

     34 卷顺着滑太慢，顶上给一条搜索。索引四样：卷名、卷号（02 / 2 都认）、
     汤面正文、汤色（敲「黑汤」就把这一类的都列出来）。
     命中按「卷名 → 卷号 → 正文 → 汤色」排序，同档按卷序；已结案的挂一枚「已结案」。

     面板第一行是汤色筛选（全部 / 清汤 / 红汤 / 黑汤，各带卷数）：挑卷的时候
     「今天想喝什么汤」跟「找哪一卷」是同一件事，所以放进同一个面板，而不是
     另开一个入口。点了某一类、输入框是空的，就把这一类整卷列出来 ——
     这就是「只想看清汤」的走法。

     两种形态、一份 DOM（见 styles.css）：
       宽屏（横版 / 竖版画廊）：输入条常驻在顶墙中央，敲字或按 K 就出面板；
       紧凑态：顶栏那一行没有横向余量再塞一条输入框，收成放大镜，
               点开变成整屏浮层（列表才拉得开），点空白或 Esc 收起。 */
  const FIND_MAX = 24;
  let findOn = false;
  let findSoup = "";               // "" = 全部；否则是「清汤」/「红汤」/「黑汤」
  let findDiff = "";               // "" = 全部；否则是「浅」/「中」/「深」

  /* 每一类各有多少卷。卷目是开卷时一次拉齐的，34 条算一遍不值一提，不缓存。 */
  function soupCounts() {
    const c = {};
    puzzles.forEach((p) => { if (p.soup) c[p.soup] = (c[p.soup] || 0) + 1; });
    return c;
  }

  /* 每一档难度各有多少卷（卷目开卷时一次拉齐，34 条算一遍不值一提） */
  function diffCounts() {
    const c = {};
    puzzles.forEach((p) => { if (p.difficulty) c[p.difficulty] = (c[p.difficulty] || 0) + 1; });
    return c;
  }

  /* 筛选行：**汤色三枚 + 一条细分隔线 + 难度三枚，共用一个「全部」**。
     挑卷的时候「今天想喝什么汤」和「想动多少脑子」是同一件事，
     所以两组放在同一行里，而不是另开一个入口。

     为什么不做成两行：竖版的 `.finder` 只有 62vw（390 宽的屏上是 242px），
     两行会各折成两行、吃掉四条的高度，列表只剩四五条（实测）。
     一行两组折两行就够，而且两组的话本身就分得清（清汤/红汤/黑汤 vs 浅/中/深），
     不用再加「汤色」「难度」两个标签。

     它排在 #findList 里面（见 index.html 那段注释），所以列表空着的时候照样在 ——
     不然「一类都没搜到」的时候连换一类的入口都没有。 */
  function tagsHtml() {
    const sc = soupCounts();
    const dc = diffCounts();
    const chip = (attr, val, label, n, title, on) =>
      `<button type="button" data-${attr}="${val}"${on ? ' class="on"' : ""}`
      + (title ? ` title="${title}"` : "")
      + `>${label}<span class="k">${n}</span></button>`;
    return '<li class="ftags">'
      + chip("soup", "", "全部", puzzles.length, "汤色与难度都不筛", findSoup === "" && findDiff === "")
      + SOUP_ORDER.map((s) => chip("soup", s, s, sc[s] || 0, SOUP_TIP[s] || "", findSoup === s)).join("")
      + '<span class="sep" aria-hidden="true"></span>'
      + DIFF_ORDER.map((d) => chip("diff", d, d, dc[d] || 0, DIFF_TIP[d] || "", findDiff === d)).join("")
      + "</li>";
  }

  function findHits(q) {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/[^\d]/g, "");
    const hits = [];
    puzzles.forEach((p, i) => {
      if (findSoup && p.soup !== findSoup) return;      // 汤色这一关先过
      if (findDiff && p.difficulty !== findDiff) return; // 难度这一关也先过
      let rank = 99;
      // 不敲字就整类都列。刚按 K 打开时筛选行上亮着的是「全部」，下面却写
      // 「没有这一卷」—— 那是自相矛盾的；「全部」这一枚列的就该是全部。
      if (!s) rank = 3;
      else if (p.title && p.title.toLowerCase().indexOf(s) >= 0) rank = 0;
      else if (digits && (digits === pad(i) || digits === String(i + 1))) rank = 1;
      else if (p.surface && p.surface.toLowerCase().indexOf(s) >= 0) rank = 2;
      else if (p.soup && p.soup.toLowerCase().indexOf(s) >= 0) rank = 3;
      // 敲「浅 / 中 / 深」跟敲「红汤」是一个道理：直接列出这一档
      else if (p.difficulty && p.difficulty.indexOf(s) >= 0) rank = 3;
      if (rank < 99) hits.push({ i, p, rank });
    });
    hits.sort((a, b) => a.rank - b.rank || a.i - b.i);
    // 敲了字那是「搜」，够用的先给上来就截住；只筛汤色不敲字那是「翻这一类」，
    // 这一类有几卷就列几卷 —— 让 FIND_MAX 把它们截掉会看着像库里就这么多。
    return s ? hits.slice(0, FIND_MAX) : hits;
  }

  function renderFind(q) {
    const kw = q.trim();
    // 面板什么时候出来：敲了字、筛了汤色、或者刚被 K / 放大镜打开
    // （最后那一条是为了让筛选行在空查询下也能露出来 —— 不然没人找得到它）
    if (!kw && !findSoup && !findOn) {
      findList.hidden = true;
      findList.innerHTML = "";
      return;
    }
    const hits = findHits(kw);
    findList.hidden = false;
    findList.innerHTML = tagsHtml() + (hits.length
      ? hits.map(({ i, p }) => {
        const n = solveCounts[p.id] || 0;
        return `<li data-i="${i}"${i === index ? ' class="now"' : ""}>`
          + `<span class="n">${pad(i)}</span>`
          + (p.difficulty ? `<i class="df" title="${DIFF_TIP[p.difficulty] || ""}">${p.difficulty}</i>` : "<i></i>")
          + (p.soup ? `<i class="sp" data-soup="${p.soup}" title="${SOUP_TIP[p.soup] || ""}">${p.soup}</i>` : "<i></i>")
          + `<span class="t">${escapeHtml(p.title || "")}</span>`
          + (n > 0 ? `<span class="cnt" title="${n} 人已结案">${n} 人</span>` : "<span></span>")
          + (solvedSet.has(p.id) ? '<i class="ok">已结案</i>' : "<i></i>")
          + "</li>";
      }).join("")
      : `<li class="empty">${(findSoup || findDiff) && kw
        ? `${findSoup}${findDiff}里没有「${escapeHtml(kw)}」`
        : "没有这一卷"}</li>`);
  }

  /* 跳卷：直接落，不走推拉动画（搜索是「翻到第几卷」，不是「顺着往下翻」） */
  function jumpTo(i) {
    if (!puzzles.length || i < 0 || i >= puzzles.length) return;
    const moved = i !== index;
    if (moved) {
      lastSlideDir = i > index ? 1 : -1;
      queued = 0;
      index = i;
      paintStrip();
      setOffset(0, false);
      loadSolveCounts();          // 人数晚一步回来，回来再刷列表与榜头
    }
    /* 「跳到第几卷」和「顺着滑一卷」是两件事，声音也分开：
       seek 短促、有一记落地的「咔」；slide 是拖着走的扫掠。
       收面板那一下（closeFind）不再补一声 —— 这一下已经响过了。 */
    sfx("seek");
    closeFind(true);
    showHint(`第 ${pad(i)} 卷 · ${puzzles[i].title}`, 2200);
  }

  /* 「×」什么时候露：有字、或者筛着某一类汤色 / 某一档难度 —— 它一下清掉这几样，
     所以只要还有一样没清，它就得在（这是唯一的清空出口）。 */
  function syncFindClear() {
    findClear.hidden = !findInput.value && !findSoup && !findDiff;
  }

  /* 把面板（连着汤色 / 难度那两行分类）露出来，**不动输入框里的字**。
     跟 openFind() 的分工：「露」是点进来看看有什么可挑的，「重搜一次」才清空 ——
     按 K 是后者，点输入框是前者。返回 true 表示这一下真的从收着变成露出来了。 */
  function revealFind() {
    if (findOn) return false;
    findOn = true;
    stage.classList.add("finding");
    return true;
  }

  function openFind() {
    if (findOn) return;
    revealFind();
    sfx("find", true);
    findInput.value = "";
    syncFindClear();
    // findOn 已经是 true，所以就算查询是空的，面板（连着汤色 / 难度两行筛选）也会出来
    renderFind("");
    setTimeout(() => { try { findInput.focus(); } catch (_) {} }, 40);
  }

  /* 只收界面，不清输入框，也不清汤色筛选：宽屏那条输入框是常驻的，
     点一下别处不该把它抹掉；筛着的汤色是一种「正在浏览哪一类」的状态，
     再按 K 回来时还是那一类才对。两者在面板里都看得见（选中的那枚印是亮的）。

     quiet=true 是不出声地收（跳卷那条路用：那一下已经有 seek 了，再来一声「收面板」
     就成了两件声叠在一起）。 */
  function closeFind(quiet) {
    if (findOn && !quiet) sfx("find", false);
    findOn = false;
    stage.classList.remove("finding");
    findList.hidden = true;
    syncFindClear();
    try { findInput.blur(); } catch (_) {}
  }

  findInput.addEventListener("input", () => {
    syncFindClear();
    renderFind(findInput.value);
  });
  /* 点（或 Tab 进）搜索框，就把面板和下面那两行分类露出来。
     以前只有敲了字 / 按过 K 才出来，光点一下什么都不发生 —— 没人知道下面有分类可挑。
     这里是「露」不是「重搜」：输入框里的字保持不动（openFind() 才会清）。 */
  findInput.addEventListener("focus", () => {
    if (revealFind()) renderFind(findInput.value);
  });
  /* 放大镜那枚 svg 不是按钮，点它不会聚焦到输入框 —— 整条搜索框都点得。
     不拦「×」（它自己有清空 + 聚焦两件事要做），也不拦已经聚焦时的重复点击。 */
  finderBox.addEventListener("click", (e) => {
    if (e.target.closest(".find-clear")) return;
    if (document.activeElement === findInput) return;
    try { findInput.focus(); } catch (_) {}
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeFind(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const hit = findHits(findInput.value)[0];
      if (hit) jumpTo(hit.i);
    }
  });
  findClear.addEventListener("click", (e) => {
    e.stopPropagation();
    findInput.value = "";
    findSoup = "";
    findDiff = "";
    syncFindClear();
    renderFind("");
    findInput.focus();
  });
  findFold.addEventListener("click", (e) => { e.stopPropagation(); openFind(); });
  findList.addEventListener("click", (e) => {
    /* 汤色筛选行排在 #findList 里面（见 index.html），所以它的点击也走这一个代理。
       先判它 —— 那几枚 chip 不带 data-i，落到下面也只会被当成「不是一条结果」。 */
    const tag = e.target.closest("button[data-soup], button[data-diff]");
    if (tag) {
      if (tag.dataset.soup !== undefined) {
        findSoup = tag.dataset.soup || "";
        // 「全部」那一枚是这两组共用的：点它意味着汤色与难度都不筛
        if (!findSoup) findDiff = "";
      } else {
        findDiff = tag.dataset.diff || "";
      }
      syncFindClear();
      renderFind(findInput.value);
      return;
    }
    const li = e.target.closest("li[data-i]");
    if (li) jumpTo(Number(li.dataset.i));
  });
  /* 紧凑态的浮层是整屏的：点空白（= 点到 .finder 自己）就收起 */
  finder.addEventListener("click", (e) => { if (findOn && e.target === finder) closeFind(); });
  /* 点别处收列表。判的是「点在 .finder 之外」，宽屏没有浮层也照样收 */
  document.addEventListener("pointerdown", (e) => {
    if (findList.hidden && !findOn) return;
    if (e.target.closest(".finder")) return;
    closeFind();
  });

  /* ---------------- 侧墙画框的交叉淡入 ---------------- */


  function createPeek(a, b) {
    let cur = a;
    let first = true;
    let gen = 0;
    cur.classList.add("on");
    return function (p) {
      const src = srcOf(p);
      if (!src || cur.dataset.src === src) return;
      const my = ++gen;
      const apply = (el, finalSrc) => {
        el.dataset.src = finalSrc;
        if (el.getAttribute("src") !== finalSrc) el.src = finalSrc;
      };
      if (first) {
        first = false;
        apply(cur, src);
        preloadCover(p, true).then((finalSrc) => {
          if (my !== gen) return;
          apply(cur, finalSrc);
        });
        return;
      }
      const other = cur === a ? b : a;
      const flip = () => {
        if (my !== gen) return;
        other.classList.add("on");
        cur.classList.remove("on");
        cur = other;
      };
      const show = (finalSrc) => {
        if (my !== gen) return;
        apply(other, finalSrc);
        if (other.complete && other.naturalWidth) requestAnimationFrame(flip);
        else {
          other.onload = flip;
          other.onerror = flip;
        }
      };
      if (coverReady(src)) show(src);
      else {
        apply(other, src);
        preloadCover(p, true).then(show);
      }
    };
  }
  const peekL = createPeek($("peekLa"), $("peekLb"));
  const peekR = createPeek($("peekRa"), $("peekRb"));
  [imgPrev, imgCurr, imgNext, $("peekLa"), $("peekLb"), $("peekRa"), $("peekRb")]
    .forEach(guardFallback);

  /* ---------------- 立绘/推拉 ---------------- */

  function paintStrip() {
    if (!puzzles.length) return;
    const prev = puzzles[wrap(index - 1)];
    const curr = puzzles[index];
    const next = puzzles[wrap(index + 1)];
    assignCover(imgPrev, prev, true);
    assignCover(imgCurr, curr, true);
    assignCover(imgNext, next, true);
    peekL(prev);
    peekR(next);
    noEl.textContent = pad(index);
    setText(diffEl, curr.difficulty || "");
    diffEl.hidden = !curr.difficulty;
    diffEl.title = DIFF_TIP[curr.difficulty] || "";
    /* 汤色印。data-soup 不只是给 CSS 上色用的（styles.css 顶上那三行 --sp）——
       它同时是这枚印当前是哪一类的**唯一**来源，别在别处另存一份。 */
    setText(soupEl, curr.soup || "");
    soupEl.hidden = !curr.soup;
    soupEl.dataset.soup = curr.soup || "";
    soupEl.title = SOUP_TIP[curr.soup] || "";
    titleEl.textContent = curr.title;
    const savedBottom = curr.bottom || (window.__bottoms || {})[curr.id];
    if (solvedSet.has(curr.id) && savedBottom) {
      curr.bottom = savedBottom;
      surfaceEl.textContent = savedBottom;
      surfaceEl.classList.add("bottom");
    } else {
      surfaceEl.textContent = curr.surface;
      surfaceEl.classList.remove("bottom");
    }
    hideStamp();
    heardEl.textContent = "";
    startClock(curr.id);
    renderDossier(true);
    $("boardSub").textContent = boardHeading(curr, solveCounts[curr.id] || 0);
    if (!$("boardLayer").hidden) loadBoard();
    saveCursor();
    warmAround(index, lastSlideDir);
  }

  const wingImgs = Array.prototype.slice.call(document.querySelectorAll(".wing img"));

  function setOffset(px, animate, dur) {
    const w = frame.clientWidth || 1;
    strip.style.transition = animate
      ? `transform ${dur || SLIDE_MS}ms cubic-bezier(.16,.84,.28,1)`
      : "none";
    strip.style.transform = `translate3d(${-w + px}px,0,0)`;
    // 侧墙两幅画跟着一起轻轻挪，整条长廊像是同一块在动
    const ratio = Math.max(-1, Math.min(1, px / w));
    const shift = (ratio * 7).toFixed(2) + "%";
    for (let i = 0; i < wingImgs.length; i++) wingImgs[i].style.transform = `translate3d(${shift},0,0)`;
  }

  let snapToken = 0;
  let queued = 0;

  function snapTo(dir) {
    if (!puzzles.length) return;
    cancelDragMove();
    if (animating) {
      queued = dir;
      if (dir) preloadCover(puzzles[wrap(index + lastSlideDir + dir)], true);
      return;
    }
    const w = frame.clientWidth;
    animating = true;
    const token = ++snapToken;
    primedDir = 0;
    if (dir) lastSlideDir = dir;

    if (dir) {
      sfx("slide", dir);
      preloadCover(puzzles[wrap(index + dir)], true);
      preloadCover(puzzles[wrap(index + dir * 2)], false);
    }
    setOffset(dir < 0 ? w : dir > 0 ? -w : 0, true, SLIDE_MS);

    let fired = false;
    const finish = () => {
      if (fired || token !== snapToken) return;
      fired = true;
      strip.removeEventListener("transitionend", finish);
      if (dir) index = wrap(index + dir);
      requestAnimationFrame(() => {
        paintStrip();
        setOffset(0, false);
        void strip.offsetWidth;
        animating = false;
        dragX = 0;
        velocity = 0;
        if (queued) {
          const d = queued;
          queued = 0;
          snapTo(d);
        }
      });
    };
    strip.addEventListener("transitionend", finish);
    setTimeout(finish, SLIDE_MS + 120);
  }

  /* ---------------- 面板 ---------------- */

  function renderDossier(force) {
    const p = current();
    if (!p) return;
    const hist = (historyMap.get(p.id) || []).filter((h) => h.kind === "turn");
    setText(askCountEl, `问 ${hist.length}`);
    /* 停表时前面挂一个「∥」，跟 #pauseTag 是同一件事的两个出口（判据都在 pausedNow） */
    setText(elapsedEl, elapsedLabel());
    const last = hist[hist.length - 1];
    setText(lastMsEl, last && last.ms != null ? `${last.ms}ms` : "");
    const found = new Set(unlockedMap.get(p.id) || []);
    const said = new Set(statedMap.get(p.id) || []);
    const lit = (p.keys || []).filter((k) => found.has(k.id));
    /* 两档进度画在同一排上（口径见 server.py 的 SOLVE_RULE）：
         .on   = 这个关键点他**问到**了
         .said = 这个关键点他**自己讲出来**了（结案的两条路之一看的是它）
       讲到够就当场结案，所以这一排同时是「我离结案还有多远」的读数。
       关键点问到齐、却一个都没自己讲出来 → 末尾挂一枚常驻的下一步提示：
       没有它的话，「chips 全亮了却什么都没发生」看着就像坏了。
       （紧凑态 .keys 整排是 display:none，那边的提示出路是解锁牌那一下。） */
    const allFound = lit.length > 0 && lit.length === (p.keys || []).length;
    const ready = allFound && !solvedSet.has(p.id);
    const keysSig = lit.map((k) => k.id + (said.has(k.id) ? "S" : "")).join(",")
      + (ready ? "|ready" : "");
    if (force || keysEl.dataset.sig !== keysSig) {
      keysEl.dataset.sig = keysSig;
      keysEl.innerHTML = lit.map((k) =>
        `<span class="key-chip on${said.has(k.id) ? " said" : ""}">${escapeHtml(k.label)}</span>`
      ).join("") + (ready ? '<span class="key-chip ready">讲出来就结案</span>' : "");
      keysEl.hidden = lit.length === 0;
    }
    const sig = p.id + "|" + hist.length + "|" + (last ? last.ms : "");
    if (force || sig !== ledgerSig) {
      ledgerSig = sig;
      ledgerEl.innerHTML = hist.slice().reverse().map((h) => `
        <li>
          <div class="q">${escapeHtml(h.question)}</div>
          <div class="a ${escapeHtml(h.verdict || "")}">${escapeHtml(h.label)}</div>
          <div class="ms">${h.ms != null ? h.ms + "ms" : ""}</div>
        </li>`).join("");
    }
    hintAskBtn.hidden = !lampOn || solvedSet.has(p.id);
    syncHint();
  }

  function hideStamp() {
    stampEl.hidden = true;
    stampEl.textContent = "";
    stampEl.className = "stamp";
  }

  function showStamp(label, verdict) {
    stampEl.hidden = false;
    stampEl.textContent = label;
    stampEl.className = "stamp " + (verdict || "");
    shake(verdict === "solved");
    announce(label);
    clearTimeout(stampTimer);
    if (verdict !== "solved") stampTimer = setTimeout(hideStamp, 2400);
  }

  /* 读屏播报口。见 index.html 里 #srVerdict 的说明：印章、记录条、汤底
     全是「看」的，用读屏的人问完一句什么都收不到。 */
  const srVerdictEl = $("srVerdict");
  function announce(text) {
    if (srVerdictEl && text) srVerdictEl.textContent = text;
  }

  function shake(strong) {
    stage.classList.remove("quake", "quake-big");
    void stage.offsetWidth;
    stage.classList.add(strong ? "quake-big" : "quake");
    setTimeout(() => stage.classList.remove("quake", "quake-big"), strong ? 560 : 360);
  }

  /* 空气里的浮尘，纯 CSS 动画驱动 */
  (function motes() {
    const host = $("motes");
    if (!host) return;
    const n = window.innerWidth < 760 ? 11 : 18;
    let html = "";
    for (let i = 0; i < n; i++) {
      const size = (1 + Math.random() * 2.4).toFixed(1);
      const dur = (17 + Math.random() * 21).toFixed(1);
      html += "<i style=\""
        + `left:${(Math.random() * 100).toFixed(1)}%;`
        + `top:${(Math.random() * 100).toFixed(1)}%;`
        + `width:${size}px;height:${size}px;`
        + `--dx:${((Math.random() - 0.5) * 64).toFixed(0)}px;`
        + `--dy:-${(40 + Math.random() * 120).toFixed(0)}px;`
        + `--o:${(0.16 + Math.random() * 0.44).toFixed(2)};`
        + `animation-duration:${dur}s;`
        + `animation-delay:-${(Math.random() * dur).toFixed(1)}s`
        + "\"></i>";
    }
    host.innerHTML = html;
  })();

  /* 关键点解锁：一块带四角铜钉的小铜牌推上来，背后一圈光环散开。
     只用在「不是结案」的时候 —— 结案走 showFinale，场面比这个大一档，
     两个一起弹会把高潮冲淡。 */
  function showReveal(title, count, kicker) {
    const el = $("reveal");
    $("revealKicker").textContent = kicker || "关 键 点";
    $("revealTitle").textContent = title;
    $("revealCount").textContent = count || "";
    el.hidden = false;
    announce("解锁 " + title + (count ? "，" + count : ""));
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  /* 结案：把汤底从「汤面那一栏换行字」升成一场收束 ——
     暗幕落下、画卷自上而下展开、卷名与汤底逐层浮现、右下角盖上朱印。
     轻触、Esc 或 9 秒后自行收起；收起后汤底仍留在汤面栏里（paintStrip 会写回去）。 */
  /* 结案画卷那一行小字。拆成函数是为了「你是第几位结案」——
     那要看 /api/score 的响应，比画卷晚几百毫秒回来，回来时把它补写上去。 */
  let finaleInfo = null;

  function renderFinaleStats() {
    const s = finaleInfo;
    if (!s) return;
    const lone = s.lone;
    $("finaleStats").innerHTML =
      `<span>问 ${s.asks || 0} 次</span><i>·</i><span>用时 ${fmtClock(s.ms || 0)}</span>`
      + (lone ? `<i>·</i><span class="lone">孤灯</span>` : "")
      + (s.difficulty ? `<i>·</i><span>${s.difficulty}卷</span>` : "")
      + (s.soup ? `<i>·</i><span class="sp" data-soup="${s.soup}">${s.soup}</span>` : "")
      + (s.first && s.solves ? `<i>·</i><span>你是第 ${s.solves} 位结案</span>` : "");
  }

  function showFinale(p, stats) {
    const el = $("finale");
    el.classList.remove("out");
    $("finaleTitle").textContent = p.title || "";
    $("finaleBottom").textContent = p.bottom || "";
    finaleInfo = {
      asks: stats && stats.asks != null ? stats.asks : 0,
      ms: stats && stats.ms != null ? stats.ms : 0,
      lone: !!(stats && stats.lone),
      difficulty: p.difficulty || "",
      soup: p.soup || "",
      solves: Number((stats && stats.solves) || 0) || 0,
      first: !!(stats && stats.first),
    };
    renderFinaleStats();
    el.hidden = false;
    sfx("finale");
    // 汤底是这一局唯一「非看不可」的正文，读屏也得念出来
    announce("结案。" + (p.title || "") + "。" + (p.bottom || ""));
    clearTimeout(finaleTimer);
    finaleTimer = setTimeout(hideFinale, 9000);
  }

  function hideFinale() {
    const el = $("finale");
    clearTimeout(finaleTimer);
    if (!el || el.hidden || el.classList.contains("out")) return;
    el.classList.add("out");
    finaleTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("out");
      showHint("汤底已封存", 3000);
    }, 420);
  }

  /* ---------------- 提问 ---------------- */

  async function ask(question) {
    const p = current();
    if (!p || busy || !question) return;
    busy = true;
    stage.classList.add("busy");
    startWait("……");
    sfx("think");
    const hist = historyMap.get(p.id) || [];
    const apiHistory = hist
      .filter((h) => h.kind === "turn")
      .flatMap((h) => [
        { role: "player", text: h.question },
        { role: "host", text: h.label },
      ]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          puzzle_id: p.id,
          question,
          history: apiHistory,
          unlocked: unlockedMap.get(p.id) || [],
          /* 已经自己讲出来的关键点一起带上（结案的路 (1) 看它，见 server.py 的 SOLVE_RULE）：
             服务端只判「这一句」，攒齐是客户端的事。 */
          stated: statedMap.get(p.id) || [],
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "无回音");
      showStamp(data.label, data.verdict);
      sfx("stamp", data.verdict);
      hist.push({
        kind: "turn",
        question,
        label: data.label,
        verdict: data.verdict,
        ms: data.latency_ms,
      });
      historyMap.set(p.id, hist);
      const before = new Set(unlockedMap.get(p.id) || []);
      const beforeSaid = new Set(statedMap.get(p.id) || []);
      if (data.unlocked) unlockedMap.set(p.id, data.unlocked);
      if (data.stated) statedMap.set(p.id, data.stated);
      if (data.keys) p.keys = data.keys.map((k) => ({ id: k.id, label: k.label }));
      const newlySaid = (data.stated || []).filter((id) => !beforeSaid.has(id));
      if (newlySaid.length && !data.solved) {
        /* 他自己讲出了一个关键点 —— 这是**结案进度**（路 (1)），值得单独说一声：
           不然玩家不知道「说出来」这件事有分量，只会继续一句句问。 */
        const labels = (p.keys || []).filter((k) => newlySaid.includes(k.id)).map((k) => k.label);
        const total = (p.keys || []).length;
        const got = (statedMap.get(p.id) || []).length;
        showReveal(labels.join(" · ") || "说出来了一个", `已讲出 ${got} / ${total}`, "讲 出 来 了");
        sfx("unlock");
      }
      const newly = (data.unlocked || []).filter((id) => !before.has(id));
      if (newly.length && !data.solved && !newlySaid.length) {
        const labels = (p.keys || []).filter((k) => newly.includes(k.id)).map((k) => k.label);
        const total = (p.keys || []).length;
        const found = (unlockedMap.get(p.id) || []).length;
        /* 关键点问齐了，但还没结案 —— 现在这两件事是分开的（见 server.py 的 SOLVE_RULE）：
           问齐只说明料凑够了，得他自己把关键点讲出来（或把整个流程讲一遍）才对得上
           「结案」那枚印。所以最后一块拼图落下时，牌子要换个说法告诉他下一步干什么，
           不然玩家会以为游戏卡住了（这也是「替玩家结案」那个旧口径的替代）。 */
        if (total > 0 && found >= total) {
          showReveal("把关键点讲出来", "关键点齐了 · 讲出来就结案", "关 键 点 齐 了");
        } else {
          showReveal(labels.join(" · ") || "新线索", total ? `已解锁 ${found} / ${total}` : "");
        }
        sfx("unlock");
      }
      saveProgress();
      renderDossier(true);
      if (data.solved && data.bottom) {
        solvedSet.add(p.id);
        /* 结案就停表：这一卷已经算完了，表再走只会把成绩里的「用时」泡大。
           要在 submitScore 之前停 —— 那条成绩读的就是 elapsedMsOf()。 */
        stopClock();
        p.bottom = data.bottom;
        window.__bottoms = window.__bottoms || {};
        window.__bottoms[p.id] = data.bottom;
        surfaceEl.textContent = data.bottom;
        surfaceEl.classList.add("bottom");
        saveProgress();
        /* 交成绩**在推画卷之前**：画卷里那句「你是第 N 位结案」要用它的回值
           （solves / first）。本地几毫秒就回来了，线上一般也就一两百毫秒，
           都落在「印章先落、画卷后推」那 480ms 之内。
           但网络要是卡住，不能让画卷陪着一起等 —— 给成绩 2.5 秒上限，
           超了就先推画卷（少那一句），成绩回来再补写。 */
        const scoreReq = submitScore(p, hist.length);
        const scoreInfo = await Promise.race([
          scoreReq,
          new Promise((r) => setTimeout(() => r(null), 2500)),
        ]);
        if (findOn || !findList.hidden) renderFind(findInput.value);
        setTimeout(() => {
          showFinale(p, {
            asks: hist.length,
            ms: elapsedMsOf(p.id),
            lone: !hintedSet.has(p.id),
            solves: scoreInfo ? Number(scoreInfo.solves || 0) || 0 : 0,
            first: !!(scoreInfo && scoreInfo.first),
          });
        }, 480);
        if (!scoreInfo) {
          // 成绩比画卷还慢：回来时把「第几位结案」补上去
          scoreReq.then((late) => {
            if (!late || !finaleInfo || finaleInfo.solves) return;
            finaleInfo.solves = Number(late.solves || 0) || 0;
            finaleInfo.first = !!late.first;
            if (!$("finale").hidden) renderFinaleStats();
          });
        }
        loadBoard();
      }
      stopWait();
    } catch (err) {
      stopWait();
      showStamp("无回音", "refuse");
      sfx("stamp", "refuse");
      statusEl.textContent = err.message || "";
      announce("无回音。" + (err.message || ""));
      if (!typed.value) typed.value = question;
    } finally {
      sfx("silence");
      busy = false;
      stage.classList.remove("busy");
      stopWait();
    }
  }

  /* ---------------- 语音：浏览器原生识别 ----------------
     原先服务端跑 sherpa-onnx（模型十几兆、挑 Python 版本、每次还要把 PCM 传上去）。
     现在用浏览器自带的 SpeechRecognition：零依赖、零上传、边说边出字。
     代价是识别在厂商的云上做——Chrome 走 Google，大陆网络常常连不上；
     连不上时 onerror 报 network，这里就明确引导玩家打字，别让人对着麦克风较劲。 */
  let rec = null;
  let recGen = 0;
  let recFinal = "";
  let recInterim = "";
  let recDone = false;

  function voiceReset() {
    rec = null;
    recFinal = "";
    recInterim = "";
    listening = false;
    stage.classList.remove("listening");
    micCap.textContent = micIdleCap;
  }

  // 收尾只走一次：正常由 onend 触发，个别实现不派发 end 时由兜底定时器触发
  function finishVoice(gen) {
    if (gen !== voiceGen || recDone) return;
    recDone = true;
    const q = (recFinal + recInterim).trim();
    voiceReset();
    if (q) fillFromVoice(q);
    else if (!statusEl.textContent) statusEl.textContent = "没听清，按住再说，或者直接打字";
  }

  function startVoice() {
    if (busy || animating || listening) return;
    if (!SR) {
      statusEl.textContent = "这个浏览器不支持语音，直接打字吧";
      typed.focus();
      return;
    }
    const gen = ++voiceGen;
    recGen = gen;
    recFinal = "";
    recInterim = "";
    recDone = false;
    hideStamp();
    heardEl.textContent = "";
    listening = true;
    stage.classList.add("listening");
    micCap.textContent = "正在听 · 松手结束";
    statusEl.textContent = "";
    sfx("listen");
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }

    const r = new SR();
    rec = r;
    r.lang = "zh-CN";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      if (gen !== voiceGen) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0] ? res[0].transcript : "";
        if (res.isFinal) recFinal += txt;
        else interim += txt;
      }
      recInterim = interim;
      const live = (recFinal + recInterim).trim();
      // 边说边把字落进输入框，玩家能立刻看到识别对不对
      if (live) { typed.value = live; heardEl.textContent = live; }
    };

    r.onerror = (e) => {
      if (gen !== voiceGen) return;
      const tip = {
        "not-allowed": "麦克风被拒绝了，检查一下浏览器权限",
        "service-not-allowed": "浏览器没开放语音服务",
        "audio-capture": "没找到麦克风",
        "network": "语音服务连不上",
        "no-speech": "没听到声音，按住再说",
        "aborted": "",
      };
      const msg = Object.prototype.hasOwnProperty.call(tip, e.error) ? tip[e.error] : ("识别出错：" + e.error);
      if (msg) {
        statusEl.textContent = msg;
        announce(msg);
      }
      if (e.error === "network" || e.error === "service-not-allowed") {
        showHint("语音服务连不上，先打字吧", 4600);
      }
    };

    r.onend = () => finishVoice(gen);

    try {
      r.start();
    } catch (err) {
      voiceReset();
      statusEl.textContent = "语音没启动起来，直接打字吧";
    }
  }

  function stopVoice() {
    const r = rec;
    if (!r) return;
    listening = false;
    stage.classList.remove("listening");
    micCap.textContent = "识别中…";
    sfx("release");
    try { r.stop(); } catch (_) {}
    const gen = recGen;
    setTimeout(() => { if (rec === r) { try { r.abort(); } catch (_) {} finishVoice(gen); } }, 1500);
  }

  /* 听写先落进输入框，玩家确认或改完再按「问」——
     识别偶尔跑偏时不用重说，也免得一句话直接替你发出去了。
     （2026-09-20：后台润色 /api/refine 已删，听写原句直接进输入框。） */
  function fillFromVoice(raw) {
    typed.value = raw;
    heardEl.textContent = raw;
    statusEl.textContent = "已填入输入框 · 按「问」发送";
    announce("已填入输入框。" + raw + "。按问发送。");
    sfx("fill");
    if (window.innerHeight < window.innerWidth * 1.1) {
      typed.focus();
      try { typed.setSelectionRange(raw.length, raw.length); } catch (_) {}
    }
  }

  /* ---------------- 手势 ---------------- */

  const NO_DRAG = ".mic, .nav, .type-line, .dossier, .dock, .read, .player, .board-layer, .board-open, .sound, .lamp, .hint-ask, .wing, .finder";

  function onPointerDown(e) {
    if (e.target.closest(NO_DRAG)) return;
    if (animating) return;
    dragging = true;
    stage.classList.add("dragging");
    startX = e.clientX;
    startT = performance.now();
    lastX = e.clientX;
    lastT = startT;
    velocity = 0;
    dragX = 0;
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  }

  let primedDir = 0;

  /* 拖动时 pointermove 一帧可能来好几下（高刷屏、以及浏览器把多个移动事件合并着派发），
     而每个 setOffset 要写 8 个元素的 transform（三张立绘 + 侧墙几幅画）。
     这里收成「一帧最多落一次 DOM」：位置先只记在 dragX 上，rAF 到点再写。
     松手 / 开始推拉动画前必须 cancel，否则排队的那一帧会在动画起来之后
     把 transform 又按拖动中的位置写一遍（transition 也被改成 none）。 */
  let dragRaf = 0;
  function queueDragMove() {
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      setOffset(dragX, false);
    });
  }
  function cancelDragMove() {
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0 && dt < 140) velocity = velocity * 0.4 + ((e.clientX - lastX) / dt) * 0.6;
    lastX = e.clientX;
    lastT = now;
    dragX = e.clientX - startX;
    queueDragMove();
    /* 拖动时的一层轻摩擦（引擎里节流到 95ms）：不响的话画面在动、耳朵是静的，
       手感会「飘」。阈值 8px 是为了滤掉按下时指尖那点抖动 —— 那不是拖。 */
    if (Math.abs(dragX) > 8) sfx("drag");
    const w = frame.clientWidth || 1;
    if (Math.abs(dragX) > w * 0.08) {
      const dir = dragX < 0 ? 1 : -1;
      if (dir !== primedDir) {
        primedDir = dir;
        preloadCover(puzzles[wrap(index + dir)], true);
      }
    }
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    cancelDragMove();
    stage.classList.remove("dragging");
    const w = frame.clientWidth;
    const dt = Math.max(1, performance.now() - startT);
    const v = dragX / dt;
    const speed = Math.abs(velocity) > Math.abs(v) ? velocity : v;
    const far = Math.abs(dragX) > w * 0.18;
    const fast = Math.abs(speed) > 0.5 && Math.abs(dragX) > 12;
    if (far || fast) {
      let dir;
      if (far) dir = dragX < 0 ? 1 : -1;
      else dir = speed < 0 ? 1 : -1;
      snapTo(dir);
    } else {
      primedDir = 0;
      setOffset(0, true, 380);
    }
  }

  /* ---------------- 排行榜 ---------------- */

  let boardToken = 0;
  async function loadBoard() {
    const p = current();
    if (!p) return;
    $("boardSub").textContent = boardHeading(p, solveCounts[p.id] || 0);
    if ($("boardLayer").hidden) return;
    const my = ++boardToken;
    try {
      const res = await fetch("/api/board?puzzle_id=" + encodeURIComponent(p.id));
      if (!res.ok) throw new Error("board " + res.status);
      const data = await res.json();
      if (my !== boardToken) return;
      if (!data.ok) throw new Error(data.error || "board failed");
      const rows = data.rows || [];
      const n = Number(data.solves || 0) || 0;
      solveCounts[p.id] = n;
      $("boardSub").textContent = boardHeading(p, n);
      boardEl.innerHTML = rows.slice(0, 12).map((r, i) =>
        `<li class="${r.id === player.id ? "me" : ""}"><span>${i + 1}</span><span>${escapeHtml(r.name)}${r.used_hint ? "" : '<i class="badge-lone" title="全程未开提示">孤灯</i>'}</span><span>${r.asks}问 ${fmtClock(r.ms)}</span></li>`
      ).join("") || "<li><span></span><span>尚无结案</span><span></span></li>";
    } catch (_) {
      if (my !== boardToken) return;
      /* 「取不到」和「还没有人结案」是两回事：以前两种都显示「尚无结案」，
         断网的时候看榜会以为榜是空的。这里给一句明确的。 */
      boardEl.innerHTML = '<li><span></span><span>榜没取到 · 稍后再看</span><span></span></li>';
    }
  }

  /* 交成绩。**返回值有用**：服务端会告诉我们这一卷现在有几人结案、自己算不算新人
     （结案画卷里那句「你是第 N 位结案」用的就是它）。取不到就返回 null，界面照常。 */
  async function submitScore(p, asks) {
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          puzzle_id: p.id,
          id: player.id,
          name: player.name,
          asks,
          ms: elapsedMsOf(p.id),
          used_hint: hintedSet.has(p.id),
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.ok) return null;
      solveCounts[p.id] = Number(data.solves || 0) || 0;
      return data;
    } catch (_) {
      return null;
    }
  }

  async function giveUp() {
    const p = current();
    if (!p || busy) return;
    /* 这条以前没有兜错：断网时 fetch 直接 reject，界面上什么都不会发生，
       按了「?」的玩家只会以为这个键不好使。 */
    try {
      const res = await fetch("/api/giveup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ puzzle_id: p.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "汤底打不开");
      showStamp("汤底", "refuse");
      sfx("stamp", "refuse");
      surfaceEl.textContent = data.bottom;
      surfaceEl.classList.add("bottom");
      announce("汤底。" + (data.bottom || ""));
    } catch (err) {
      statusEl.textContent = err.message || "汤底打不开";
    }
  }

  /* ---------------- 屏幕方向 ---------------- */

  /* ---------------- 紧凑态：键盘弹起 / 屏幕太矮 ----------------
     竖屏原布局是两套锚点：上半（卷号标题 85vw、汤面 102vw）按宽度走，
     下半（识别结果 25vh、记录 10.5vh、输入条 4vh）按高度走。
     可用高度一缩这两套就对不上 —— 实测 390×560 时识别结果压在汤面上，
     390×480 时汤面又钻进输入条里，也就是手机上打字时糊成一片的原因。
     撑得开画廊的门槛见下面 GALLERY_MIN_RATIO 的推导，所以这里两件事一起管：
     键盘弹起、或者屏幕本来就太矮（记录面板都塞不下），都切到 .stage.compact 的 flex 六段式。

     两个坑：
     1. 不能只看 window.innerHeight —— 有的浏览器只是把键盘浮在页面上、布局视口压根不缩，
        这时候 100vh 偏大，底下那段会藏到键盘后面，必须直接读 visualViewport；
     2. 键盘压扁视口后不能重判横竖 —— 390×420 按宽高比会被算成「横向」，
        一弹键盘整页就翻成横版布局。所以方向只在非键盘态更新。 */
  const vview = window.visualViewport;
  let compactOn = false;
  let tallOn = null;

  /* 矮到撑不开画廊的比例阈值。实测（tools 里 _ratio 探针扫 14 种竖屏尺寸）：
       320×520(1.63) / 400×600(1.50) / 480×720(1.50) / 820×1180(1.44) 两套锚点会撞；
       360×640(1.78) / 412×732(1.78) / 390×700(1.80) 及以上都干净。
     真机竖屏基本都 >=1.77，平板在 1.33~1.44 这一段，中间是空的 ——
     手机保住画廊观感，平板和矮窗口才换紧凑态。
     （这里原有一个 `MIN_GALLERY_RATIO = 1.7` 的死常量：它的用意就是下面那个 1.375，
     但从来没被读过 —— 门槛早改成从布局常量反解了。已删。） */

  /* 矮到撑不开画廊的门槛，直接从布局自己的数字解出来（不用拍脑袋的比例）：
       汤面：top 102vw、max-height min(30vw, 24vh)   => 最低会触到 132vw
       底部那一摞固定占：输入条 4vh + 48、状态 52、识别 74、气口 8 = 4vh + 100px 起
       记录面板保底 64px（面板头 + 一条记录，再往下滚）——保底再小面板就没法看了
     解：H - 0.04H - 100 - 132vw - 64 - 8 >= 0  =>  H >= 1.375w + 180
     （竖屏都满足 24vh >= 30vw，所以 min() 恒取 30vw 那支。）

     2026-09-20 从 269 降到 180：原值按「面板至少 150px」推的，把 354×676、
     390×725、535×912 这类窄高窗全推给了紧凑态（全幅无框卡片），
     用户实抓对比 440×956 画廊后判定「画廊才是对的」——小屏也要画框。
     降门槛的同时把 .stage.tall .dossier 的 max-height 保底从 96px 降到 64px
     （两者是同一道方程：保底 64 => 门槛 +180；不同时改必有一边压住汤面）。
     已知会撞车的尺寸仍然进不来：360×640 / 375×667 / 412×732 / 400×600 /
     480×720 / 320×520 / 820×1180 算出来都 < 门槛，跟 _ratio 探针当年的结论一致。
     改这几行 CSS 常量时记得回来对一下。 */
  const GALLERY_MIN_RATIO = 1.375;
  const GALLERY_MIN_PAD = 180;

  function visualH() {
    return Math.round(vview ? vview.height : window.innerHeight);
  }

  /* 键盘是否吃掉大半屏。竖屏正常态的可视高度不会低于 ~500，掉到 480 以下基本就是键盘占了。
     但**宽度明显大于高度时一定不是键盘**（软键盘只会把高度压下去，不会让宽超过高）——
     以前漏了这条判断，手机横过来（844×390）会被当成键盘态：方向不再重判、
     于是停在 .stage.tall 上走紧凑布局，画卷变成 844×172 的一条横幅，
     16:9 的封面被裁得只剩两成（tools/frame-fit.mjs 里 B3 那一条钉的就是它）。
     横屏要走的是横版画廊，那条路是拿 1536×1024 的背景摊平铺的。 */
  function keyboardOpen() {
    const h = visualH();
    if (window.innerWidth > h * 1.15) return false;
    return (window.innerHeight || h) - h > 120 || h < 480;
  }

  let lastFrameW = 0;

  /* 可视视口的 resize / scroll 事件在软键盘弹起、地址栏收放时会**成串**地来，
     每次都完整跑一遍 syncLayout 是白烧：里面要读 frame.clientWidth（强制重排），
     还要写两个 CSS 变量。收成「一帧最多算一次」，键盘动画那几百毫秒里就只算几帧。
     这是「点输入框卡一下」里「卡一下」那一半。 */
  let layoutRaf = 0;
  function queueSyncLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      syncLayout();
    });
  }

  /* 手机上点输入框，「卡一下，然后输入不了」是怎么来的 —— 两件事，都在这两个函数里。

     一、翻布局会把**正在输入的那个框藏起来**。紧凑态把搜索框收进了浮层
     （`.stage.compact .finder .finder-box { display: none }`），而从画廊切进紧凑态
     正好发生在「输入法弹起、可视视口变矮」那一瞬间 —— 于是聚焦中的输入框被
     display:none 藏掉，浏览器随即失焦、输入法收键盘。
     tools/mobile-input-check.mjs 量到的现场：`focusin findInput` 之后紧跟 `stage.class` 变化 +
     `focusout findInput`，activeElement 变 BODY。**先揭出口、再翻**，这个「被藏起来」就不会发生。

     二、就算没被藏起来，真机上翻布局那一下也可能把焦点抖掉（焦掉了输入法就再也不出来）。
     所以翻完再看一眼：真掉了就接回来。

     ⚠️ 原来这里试过「在 pointerdown 里提前把紧凑态切好」，**那条路是错的**：
     切布局会让手指底下那个输入框当场挪位置，等 touchend 合成 click 时坐标已经不在它身上了 ——
     点击直接落空，比原来的毛病还坏（探针里第 1、3 组就是这么红的）。 */
  function revealFocusOutlet() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    if (el.id === "findInput") {
      // 只揭浮层，不动输入框里的字（openFind() 会清空它 —— 那是「重新搜一次」的语义）
      // **揭了就得渲染**：findOn 为真而列表还收着是个死状态 —— 之后 openFind()
      // 会因为 `if (findOn) return` 直接返回，放大镜怎么点都打不开（紧凑态实测踩过）。
      if (revealFind()) renderFind(findInput.value);
    }
  }

  function keepFocus(el) {
    if (!el || el === document.body || document.activeElement === el) return;
    try { el.focus({ preventScroll: true }); } catch (_) {}
  }

  /* 紧凑态里哪些输入框还有出口？
     有出口的可以翻（翻之前先把出口揭开）；**没出口的不能翻** —— 翻过去它就被
     display:none 藏了，浏览器当场失焦、输入法收键盘，玩家一个字母都敲不进去。

       #typed      在 .dock 里，两套布局都留着                -> 可以翻
       #findInput  在浮层里，翻之前先加 .finding 揭出来        -> 可以翻
       #playerName 在 .dossier .player 里，紧凑态整行 display:none，没有出口
                   -> 正在改名字的时候不翻（改完失焦，下一次 resize 再翻）

     加新输入框时先回答这个问题：**它在紧凑态落在哪？** 答不上来就别加进这张表。 */
  const COMPACT_INPUT_OUTLET = { typed: true, findInput: true };

  function syncLayout() {
    const kb = keyboardOpen();
    if (tallOn === null) {
      // 进来先定一次方向：按窗口比例，判不出来就按「可视高度 >= 宽度」兜底
      tallOn = window.innerHeight >= window.innerWidth * 1.1 || visualH() >= window.innerWidth;
      stage.classList.toggle("tall", tallOn);
    } else if (!kb) {
      // 键盘压扁的时候不重判方向，否则 390×420 会被算成横向、整页翻成横版
      const tall = window.innerHeight >= window.innerWidth * 1.1;
      if (tall !== tallOn) {
        tallOn = tall;
        stage.classList.toggle("tall", tall);
      }
    }
    /* 两个 CSS 变量只在真的变了才写：setProperty 会作废样式，
       而这两个值在键盘动画期间每一帧都可能被写一次（= 一直重排）。 */
    const vhPx = visualH() + "px";
    if (stage.style.getPropertyValue("--vp-h") !== vhPx) stage.style.setProperty("--vp-h", vhPx);
    const topPx = Math.round((vview && vview.offsetTop) || 0) + "px";
    if (stage.style.getPropertyValue("--vp-top") !== topPx) stage.style.setProperty("--vp-top", topPx);
    // 横版布局不需要紧凑态（它是把画廊摊平在宽屏上的，不存在两套锚点打架）
    const tooShort = tallOn === true && visualH() < window.innerWidth * GALLERY_MIN_RATIO + GALLERY_MIN_PAD;
    const want = tallOn === true && (kb || tooShort);
    let changed = want !== compactOn;
    if (changed && want) {
      const el = document.activeElement;
      const typing = !!(el && el.matches && el.matches("input, textarea"));
      if (typing) {
        if (COMPACT_INPUT_OUTLET[el.id] === true) revealFocusOutlet();
        else changed = false;   // 没出口的输入框：这一轮不翻，别把它的键盘顶掉
      }
    }
    if (changed) {
      const el = document.activeElement;
      compactOn = want;
      stage.classList.toggle("compact", compactOn);
      keepFocus(el);
    }
    // 画卷宽度就是三张立绘的滑动步长。宽度一变（或者换了布局）就得重算推拉偏移，
    // 否则 strip 还停在旧步长上，画框里会同时露出上一张的半边 —— 一条竖着的接缝。
    // 只在「宽度」变化时才补这一下：可视高度在手机上会因为地址栏收放频繁抖动，
    // 每次抖都 setOffset 会把玩家正在拖的那一下打断。
    const fw = frame.clientWidth;
    if (changed || fw !== lastFrameW) {
      lastFrameW = fw;
      requestAnimationFrame(() => {
        lastFrameW = frame.clientWidth;
        setOffset(0, false);
      });
    }
  }

  /* ---------------- 绑定 ---------------- */

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);

  $("prev").addEventListener("click", () => snapTo(-1));
  $("next").addEventListener("click", () => snapTo(1));
  $("wingL").addEventListener("click", (e) => { e.stopPropagation(); snapTo(-1); });
  $("wingR").addEventListener("click", (e) => { e.stopPropagation(); snapTo(1); });
  $("wingL").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); snapTo(-1); } });
  $("wingR").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); snapTo(1); } });

  setInterval(() => {
    /* 页面在后台就别醒了：切走的那一刻表已经停过（visibilitychange -> pauseClock），
       记录也没人看。原来这条 1s 的轮询在后台一直跑，手机上就是白白耗电。 */
    if (document.hidden) return;
    tickClock(); // 一分钟没动就停表（见「计时」那一段）
    if (puzzles.length) renderDossier(false);
  }, 1000);

  window.addEventListener("resize", queueSyncLayout);
  window.addEventListener("orientationchange", () => setTimeout(syncLayout, 120));
  // visualViewport 才是键盘弹起/收起的准确信号（window.resize 在部分浏览器不跟着动）。
  // 这两个事件在键盘动画期间来得很密，走 rAF 节流的那条路。
  if (vview) {
    vview.addEventListener("resize", queueSyncLayout);
    vview.addEventListener("scroll", queueSyncLayout);
  }

  window.addEventListener("keydown", (e) => {
    if (!$("tour").hidden) {
      if (e.key === "ArrowRight") { e.preventDefault(); tourStep(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); tourStep(-1); }
      else if (e.key === "Enter" || e.key === " ") {
        // 焦点落在 sheet 内的按钮上时，让原生 click 自己触发——
        // 跳过 / 圆点 / 主按钮各有各的去处；这里再 preventDefault 会一次进两步
        if (!(e.target instanceof Element && e.target.closest(".tour-sheet button"))) {
          e.preventDefault();
          tourPrimary();
        }
      }
      else if (e.key === "Escape") { e.preventDefault(); closeTour(); }
      return;
    }
    if (!$("finale").hidden) {
      if (e.key === "Escape") hideFinale();
      return;
    }
    if (e.target === typed || e.target === playerNameEl) {
      if (e.key === "Escape") typed.blur();
      return;
    }
    // 搜索框里打字不能触发下面的单键快捷键（m / h / ? / k 都可能出现在词里）
    if (e.target === findInput) {
      if (e.key === "Escape") closeFind();
      return;
    }
    if (e.key === "ArrowLeft") snapTo(-1);
    if (e.key === "ArrowRight") snapTo(1);
    if (e.key === "/") { e.preventDefault(); typed.focus(); }
    if (e.key === "k" || e.key === "K") { e.preventDefault(); openFind(); }
    if (e.key === "Escape") closeFind();
    if (e.key === "?") giveUp();
    if (e.key === "m" || e.key === "M") soundBtn.click();
    if (e.key === "h" || e.key === "H") lampBtn.click();
  });

  typeLine.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = typed.value.trim();
    if (!q) return;
    typed.value = "";
    heardEl.textContent = q;
    ask(q);
  });

  typed.addEventListener("input", () => {
    if (/按「问」发送/.test(statusEl.textContent)) statusEl.textContent = "";
  });

  playerNameEl.value = player.name;
  playerNameEl.addEventListener("change", () => {
    const name = playerNameEl.value.trim().slice(0, 8) || player.name;
    player.name = name;
    playerNameEl.value = name;
    savePlayer();
  });
  /* 正在改「名」时给 stage 挂 .naming：矮屏（含键盘弹起）的媒体查询会把整个记录面板
     藏掉，而输入框就在里面 —— 藏掉就是失焦 + 输入法收键盘。
     同时 syncLayout 也不翻布局（#playerName 在紧凑态没有出口，见 COMPACT_INPUT_OUTLET）。 */
  playerNameEl.addEventListener("focus", () => stage.classList.add("naming"));
  playerNameEl.addEventListener("blur", () => stage.classList.remove("naming"));

  mic.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { mic.setPointerCapture(e.pointerId); } catch (_) {}
    startVoice();
  });
  mic.addEventListener("pointerup", (e) => { e.stopPropagation(); stopVoice(); });
  mic.addEventListener("pointercancel", () => stopVoice());
  mic.addEventListener("click", (e) => e.preventDefault());
  if (!SR) {
    mic.classList.add("unsupported");
    micCap.textContent = micIdleCap;
    mic.title = "浏览器不支持语音识别，请打字提问";
  }

  /* 排行榜是全屏遮罩：开的时候把导航箭头和声音开关收起来，
     否则它们会在暗罩后面透出半个影子，看着像坏掉了。 */
  function setBoard(open) {
    sfx("board", open);
    /* **先揭层，再取数。** loadBoard() 开头就有一条「层关着就直接返回」，
       原来顺序是反的（先 loadBoard 后揭层），于是**第一次打开排行榜永远是空的**：
       取数被那句早退拦掉，面板里什么都不会渲染。只有「开着面板换卷」
       （paintStrip 里那一次 loadBoard）才会填上。
       用户看到的就是「结案了，榜上没有我」—— 而成绩其实早就写进服务端了。 */
    $("boardLayer").hidden = !open;
    stage.classList.toggle("boarded", open);
    if (open) loadBoard();
  }

  $("tourGo").addEventListener("click", (e) => {
    e.stopPropagation();
    tourPrimary();
  });
  $("tourSkip").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTour();
  });
  $("tourDots").addEventListener("click", (e) => {
    const dot = e.target.closest(".tour-dot");
    if (dot) { e.stopPropagation(); tourShow(Number(dot.dataset.i)); }
  });
  $("tour").addEventListener("click", (e) => {
    if (e.target.id === "tour") closeTour();
  });
  // 卡面上左右滑也能翻步（松手判定 42px）；从按钮上起手的滑动不算
  const tourSheetEl = document.querySelector(".tour-sheet");
  let tourSwipeX = null;
  tourSheetEl.addEventListener("pointerdown", (e) => {
    tourSwipeX = e.target.closest("button") ? null : e.clientX;
  });
  tourSheetEl.addEventListener("pointerup", (e) => {
    if (tourSwipeX == null) return;
    const dx = e.clientX - tourSwipeX;
    tourSwipeX = null;
    if (Math.abs(dx) >= 42) tourStep(dx < 0 ? 1 : -1);
  });
  // 手势取消 / 指尖滑出卡面就作废起点，不然下一次 pointerup 会拿旧起点算位移
  tourSheetEl.addEventListener("pointercancel", () => { tourSwipeX = null; });
  tourSheetEl.addEventListener("pointerleave", () => { tourSwipeX = null; });

  hintAskBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const p = current();
    if (!p || !lampOn || busy || solvedSet.has(p.id)) return;
    busy = true;
    stage.classList.add("busy");
    hintAskBtn.disabled = true;
    startWait("掌灯……");
    const hist = historyMap.get(p.id) || [];
    try {
      const res = await fetch("/api/hint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          puzzle_id: p.id,
          history: hist.filter((h) => h.kind === "turn"),
          /* 求灯要指「还没点亮的方向」，而**他自己讲出来的也算点亮了** ——
             指着一个他刚说过的关键点让他想，是明显的蠢事。所以这一路给的是两者的并集；
             给 /api/ask 的那份仍然只带 unlocked（那边的两档语义分开用）。 */
          unlocked: [...new Set([...(unlockedMap.get(p.id) || []),
                                 ...(statedMap.get(p.id) || [])])],
          /* 已经给过的那句一起带上：不然连点两次求灯会拿到近乎同一句话
             （服务端固定指「第一个还没解锁的方向」，温度 0.4 下措辞也差不多）。 */
          prev: hintMap.get(p.id) || "",
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "灯灭了");
      hintedSet.add(p.id);
      hintMap.set(p.id, data.hint || "");
      syncHint();
      litHint();
      sfx("hint");
      announce("提示。" + (data.hint || ""));
      saveProgress();
      /* 提示的出口现在只有一处：`.hint-line`，记录方框的第一行（常驻、刷新后还在、
         能反复读）。点下去那一下的即时反馈由 litHint() 给 ——
         以前这里还有「屏幕正中浮一次」和画廊态 toast 两件，前者盖在汤面上（用户实报），
         后者在紧凑态是 display:none（写了等于没写）。 */
      showHint("灯来了", 1400);
    } catch (err) {
      stopWait();
      statusEl.textContent = err.message || "灯灭了";
    } finally {
      // 成功那条路也在这里收：等待行（可能已经带上了秒数）只在「还在等」时才清
      stopWait();
      busy = false;
      stage.classList.remove("busy");
      hintAskBtn.disabled = false;
    }
  });

  $("boardOpen").addEventListener("click", (e) => {
    e.stopPropagation();
    setBoard(true);
  });
  $("boardClose").addEventListener("click", () => setBoard(false));
  $("boardLayer").addEventListener("click", (e) => {
    if (e.target.id === "boardLayer") setBoard(false);
  });

  /* 结案画卷是模态：它盖着的时候别让底下的拖拽/滚轮换卷接走事件，
     轻触任意处收起（画卷自己也吃 click，不然点在字上不关）。 */
  (function finaleLayer() {
    const el = $("finale");
    ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"].forEach((ev) =>
      el.addEventListener(ev, (e) => e.stopPropagation()));
    el.addEventListener("click", hideFinale);
  })();

  /* hover 音效只在真有指针的设备上挂，免得手机上乱响 */
  if (window.matchMedia && window.matchMedia("(hover: hover)").matches) {
    ["prev", "next", "boardOpen", "boardClose", "sound", "lamp", "hintAsk", "wingL", "wingR"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("mouseenter", () => sfx("hover"));
    });
  }

  stage.addEventListener("wheel", (e) => {
    if (e.target.closest(".read, .dossier, .type-line, .dock, .player, .board-layer, .finale, .lamp, .hint-ask, .finder")) return;
    const now = performance.now();
    if (now - wheelLock < 640) return;
    if (animating) return;
    const ax = Math.abs(e.deltaX);
    const ay = Math.abs(e.deltaY);
    if (ax < 28 || ax < ay * 1.35) return;
    wheelLock = now;
    snapTo(e.deltaX > 0 ? 1 : -1);
  }, { passive: true });

  /* 手机上软键盘弹出时，把输入框顶到看得见的地方。
     紧凑态里输入条本来就贴在可视区底部，再 scrollIntoView 只会把可视视口顶跑
     （而且那一下滚动正好落在输入法弹起的时刻，真机上会把键盘顶掉）。

     这里原来判的是 `stage.classList.contains("kb")` —— **`.kb` 这个类根本没人加**
     （全项目搜不到 classList.add("kb")，CSS 里也没有 .kb 规则），于是这个守卫恒为假、
     每次都真的去滚一下。tools/mobile-input-check.mjs 量到过：点完输入框 320ms 后
     有一次 scroll 事件，就是它。现在按真正的那件事判 —— 紧凑态。 */
  typed.addEventListener("focus", () => {
    if (compactOn) return;
    setTimeout(() => {
      if (compactOn) return;
      typed.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 260);
  });

  /* ---------------- 启动 ---------------- */

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleIdleFill();
  });

  function tourSeen() {
    try { return localStorage.getItem("fengcun.tour") === "1"; } catch (_) { return true; }
  }

  /* 分步引导：步数由 HTML 里 .tour-card 的张数决定，别在 JS 里再写死一个数 */
  let tourIdx = 0;
  let tourN = 1;
  /* 引导翻页的纸声：第一屏（刚摊开那一下）不出声 —— 那时候的状态是「开卷」，
     翻页才是「翻页」。摊开时把开关置回 false，之后每次切卡都响。 */
  let tourSoundArmed = false;

  function tourShow(i) {
    if (tourSoundArmed) sfx("tour");
    tourIdx = Math.max(0, Math.min(tourN - 1, i));
    tourSoundArmed = true;
    const cards = document.querySelectorAll("#tourBody .tour-card");
    const dots = document.querySelectorAll("#tourDots .tour-dot");
    cards.forEach((c, k) => { c.hidden = k !== tourIdx; });
    dots.forEach((d, k) => {
      d.classList.toggle("on", k === tourIdx);
      d.setAttribute("aria-current", k === tourIdx ? "step" : "false");
    });
    $("tourCount").textContent = (tourIdx + 1) + " / " + tourN;
    $("tourGo").textContent = tourIdx === tourN - 1 ? "进馆" : "下一步";
    $("tourGo").focus();
  }
  function tourStep(d) { tourShow(tourIdx + d); }
  function tourPrimary() {
    if (tourIdx >= tourN - 1) closeTour();
    else tourStep(1);
  }

  function closeTour() {
    const el = $("tour");
    if (!el || el.hidden) return;
    el.hidden = true;
    tourIdx = 0;
    try { localStorage.setItem("fengcun.tour", "1"); } catch (_) {}
    showHint(window.innerHeight >= window.innerWidth * 1.1
      ? "左右滑动换卷 · 按住麦克风发问"
      : "拖动画框或左右滑动换卷 · 问一句是非", 4200);
  }

  function maybeTour() {
    if (tourSeen()) return;
    if (historyMap.size || solvedSet.size) {
      try { localStorage.setItem("fengcun.tour", "1"); } catch (_) {}
      return;
    }
    const el = $("tour");
    if (!el) return;
    const cards = document.querySelectorAll("#tourBody .tour-card");
    tourN = Math.max(1, cards.length);
    const dotsEl = $("tourDots");
    dotsEl.innerHTML = "";
    for (let i = 0; i < tourN; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tour-dot";
      b.dataset.i = String(i);
      b.setAttribute("aria-label", "第 " + (i + 1) + " 步");
      dotsEl.appendChild(b);
    }
    el.hidden = false;
    tourSoundArmed = false;   // 第一屏不出声：摊开不是翻页
    tourShow(0);
  }

  function hideBoot() {
    if (booted) return;
    booted = true;
    bootEl.classList.add("done");
    scheduleIdleFill();
    setTimeout(() => { bootEl.style.display = "none"; }, 800);
    setTimeout(maybeTour, 720);
  }

  syncLayout();

  fetch("/api/puzzles")
    .then((r) => r.json())
    .then((data) => {
      puzzles = data.puzzles || [];
      if (!puzzles.length) throw new Error("empty");
      // 卷宗拉到了才算一次「访问」：开卷失败的那些不该记进来
      track("pv");
      restoreCursor();
      bootCap.textContent = "共 " + puzzles.length + " 卷";
      paintStrip();
      setOffset(0, false);
      const first = puzzles[index];
      const ready = first ? preloadCover(first, true) : Promise.resolve();
      Promise.race([ready, new Promise((r) => setTimeout(r, 1800))]).then(hideBoot);
    })
    .catch(() => {
      titleEl.textContent = "无回音";
      bootCap.textContent = "开卷失败 · 稍后再试";
      setTimeout(hideBoot, 1600);
    });
})();
