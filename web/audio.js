/* 封存 · 环境音与音效
   纯 Web Audio 程序化合成：没有外部音频素材，不增加任何下载体积。
   音乐是"生成式"的——低频长音铺底，偶发单音落在小调五声音阶上，不会循环重复。

   2026-09-20 加的两条约束（用户实报「离开页面就不要声音了」「不要单调，增加随机性」）：
     1. **页面在后台就一声不许出**（切标签 / 切 app / 进 bfcache / 冻结），回来再接着响；
     2. **同一件事不许每次都一个样**：形状备 2~3 支、参数再各抖一点，
        高频的那几件（落印、悬停、换卷）另加节流 —— 一个声音连听三十次，
        哪怕只有 0.2 秒，也会烦。 */

window.FengcunAudio = (function () {
  "use strict";

  var ctx = null;
  var master = null;
  var dry = null;
  var reverb = null;
  var sfxBus = null;
  var musicBus = null;
  var drone = null;
  var musicTimer = 0;
  var thinkNode = null;
  var on = true;
  var booted = false;
  /* 页面是不是在后台。初始就按当前可见性取 —— 在后台标签里打开的时候，
     visibilitychange 不会再补一发 hidden 给我。 */
  var pageHidden = document.visibilityState === "hidden";
  var hiddenTimer = 0;

  var SCALE = [146.83, 174.61, 196.00, 220.00, 261.63, 293.66, 349.23];

  function makeImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function init() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch (e) {
      return false;
    }
    master = ctx.createGain();
    master.gain.value = 0.0001;
    master.connect(ctx.destination);

    reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(3.2, 2.4);
    var wet = ctx.createGain();
    wet.gain.value = 0.9;
    reverb.connect(wet);
    wet.connect(master);

    function makeBus(vol, wetAmount) {
      var g = ctx.createGain();
      g.gain.value = vol;
      var send = ctx.createGain();
      send.gain.value = wetAmount;
      g.connect(master);
      g.connect(send);
      send.connect(reverb);
      return g;
    }

    sfxBus = makeBus(0.85, 0.30);
    musicBus = makeBus(1.0, 0.55);
    return true;
  }

  /* ---------- 音色基元 ---------- */

  function tone(opt) {
    if (!ctx) return;
    var t = ctx.currentTime + (opt.delay || 0);
    var osc = ctx.createOscillator();
    osc.type = opt.type || "sine";
    osc.frequency.setValueAtTime(opt.freq, t);
    if (opt.glide) osc.frequency.exponentialRampToValueAtTime(opt.glide, t + opt.dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opt.gain), t + (opt.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opt.dur);
    var node = g;
    if (opt.filter) {
      var f = ctx.createBiquadFilter();
      f.type = opt.filter;
      f.frequency.value = opt.cutoff || 1200;
      f.Q.value = opt.q || 1;
      g.connect(f);
      node = f;
    }
    osc.connect(g);
    node.connect(opt.bus || sfxBus);
    osc.start(t);
    osc.stop(t + opt.dur + 0.05);
  }

  function noise(opt) {
    if (!ctx) return;
    var t = ctx.currentTime + (opt.delay || 0);
    var dur = opt.dur;
    var buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = opt.filter || "bandpass";
    f.Q.value = opt.q || 1.1;
    f.frequency.setValueAtTime(opt.from || 900, t);
    if (opt.to) f.frequency.exponentialRampToValueAtTime(opt.to, t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opt.gain), t + (opt.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(opt.bus || sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /* ---------- 随机与变体：同一件事不许每次都一个样 ----------

     两件事分开做，别混：
       1. **形状变体** —— 一件事备 2~3 支写法（pickVariant 选，而且不连着重复同一支）。
          连点十次听到十个一模一样的声音，比只有一个还容易烦；
       2. **参数抖动** —— 选中之后音高 / 时值再各抖一点（jit / rnd）。
          合成音色听久了发木，十有八九就是一点抖动都没有。

     抖动幅度有讲究：音高 ±10~40 音分（100 音分＝半音），再多就会「跑调」而不是「不一样」；
     时值 ±10~25%，再多节奏就散了。 */

  function rnd(lo, hi) { return lo + Math.random() * (hi - lo); }

  /* 音高抖动：±cents 音分。 */
  function jit(freq, cents) { return freq * Math.pow(2, rnd(-cents, cents) / 1200); }

  var lastPick = {};
  function pickVariant(key, list) {
    if (list.length === 1) return list[0];
    var i = Math.floor(Math.random() * list.length);
    if (i === lastPick[key]) {
      // 抽到跟上一次同一支就往后挪 1~n-1 位：既避开重复，又不是「轮流播放」
      i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    }
    lastPick[key] = i;
    return list[i];
  }

  /* 同一件事最短间隔（毫秒）。高频的那几件必须节流：
     鼠标扫过一排按钮会连着触发 mouseenter、拖动画卷每一帧都可能出音 ——
     不拦的话就是「嗒嗒嗒嗒」一梭子，比不响更烦。 */
  var MIN_GAP = {
    hover: 110, click: 70, drag: 95, fill: 45,
    slide: 180, board: 140, unlock: 200, tour: 140,
    find: 160, seek: 160, wickOn: 140, wickOff: 140,
    pause: 500, resume: 500, hint: 220, open: 600,
  };
  var lastPlay = {};

  function throttled(name) {
    var gap = MIN_GAP[name];
    if (!gap) return false;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (now - (lastPlay[name] || 0) < gap) return true;
    lastPlay[name] = now;
    return false;
  }

  /* ---------- 后台就静音 ----------

     2026-09-20 用户实报「离开页面就不要声音了」。改之前 `on` 只管用户那个开关：
     切到别的标签页、切到别的 app 之后，长音和偶发单音都照响；从别的页面点回来
     （bfcache）也可能带着声音回来。

     三件事：
       1. `visibilitychange` → hidden：淡出，然后把整个 AudioContext `suspend()`；
       2. `pagehide` / `freeze` 同办（bfcache 走的就是 pagehide）；
       3. 后台期间**不再合成任何东西** —— 这条不只是省 CPU：
          suspend 之后 `ctx.currentTime` 是停住的，这时候排下去的音符全挤在同一瞬，
          切回来会「轰」地一起响。所以闸门要下在两处：sfx() 与排程。

     回到前台：开关还开着就 resume + 淡回原音量，排程接着排。 */
  function stopForHidden() {
    if (pageHidden) return;
    pageHidden = true;
    if (!ctx) return;
    if (musicTimer) { clearTimeout(musicTimer); musicTimer = 0; }
    fade(0.0001, 0.2);
    clearTimeout(hiddenTimer);
    hiddenTimer = window.setTimeout(function () {
      // 等淡出走完再 suspend：立刻挂起会把淡出一起冻住，听感是「咔」一下断掉
      if (pageHidden && ctx && ctx.state === "running") {
        try { ctx.suspend(); } catch (e) {}
      }
    }, 280);
  }

  function resumeFromHidden() {
    if (!pageHidden) return;
    pageHidden = false;
    clearTimeout(hiddenTimer);
    if (!ctx || !on) return;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    fade(0.62, 1.4);
    startDrone();
    if (!musicTimer) scheduleNote();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") stopForHidden();
    else resumeFromHidden();
  });
  // pagehide：关闭 / 跳走 / 进 bfcache 都会走这一条
  window.addEventListener("pagehide", stopForHidden);
  // freeze：Chrome 的页面生命周期，冻住之后定时器和音频都不该再动
  window.addEventListener("freeze", stopForHidden);
  /* pageshow：从 bfcache 退回来（按浏览器后退键）那一下补一发 ——
     pagehide 已经把 pageHidden 置上了，不补的话回来是一页**永远静音**的页面，
     玩家只会以为声音坏了。普通加载也会走 pageshow，那时 pageHidden 还是 false，
     resumeFromHidden 自己就早退了，等于空操作。 */
  window.addEventListener("pageshow", function () {
    if (document.visibilityState !== "hidden") resumeFromHidden();
  });

  /* ---------- 音乐 ---------- */

  function startDrone() {
    if (!ctx || drone) return;
    var t = ctx.currentTime;
    var out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(musicBus);
    out.gain.exponentialRampToValueAtTime(0.42, t + 6);

    // 慢速滤波扫动，让长音有呼吸感
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.Q.value = 0.7;
    lp.connect(out);

    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 150;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start(t);

    [55, 82.41, 110, 164.81].forEach(function (f, i) {
      var osc = ctx.createOscillator();
      osc.type = i % 2 ? "triangle" : "sine";
      osc.frequency.value = f * (1 + (i - 1.5) * 0.0016);
      var g = ctx.createGain();
      g.gain.value = [0.34, 0.18, 0.22, 0.07][i];
      osc.connect(g);
      g.connect(lp);
      osc.start(t);
      drone = drone || [];
      drone.push(osc);
    });
    drone.push(out, lfo);
  }

  /* ---------- 环境里的偶发声响：门轴、滴水、远处的脚步 ---------- */
  function ambientTick() {
    if (!ctx || !on || pageHidden) return;
    var r = Math.random();
    if (r < 0.3) {
      noise({ dur: 1.3, from: 260, to: 110, gain: 0.045, q: 0.9, filter: "lowpass", attack: 0.4, bus: musicBus });
      tone({ freq: 66, glide: 49, type: "sine", gain: 0.07, dur: 1.4, attack: 0.3, bus: musicBus });
    } else if (r < 0.62) {
      tone({ freq: 1300 + Math.random() * 1100, glide: 820, type: "sine", gain: 0.045, dur: 0.15, attack: 0.002, bus: musicBus });
      tone({ freq: 640, type: "sine", gain: 0.025, dur: 0.45, delay: 0.15, bus: musicBus });
    } else if (r < 0.82) {
      var steps = 2 + Math.floor(Math.random() * 3);
      for (var i = 0; i < steps; i++) {
        noise({
          dur: 0.1, from: 210, to: 85, gain: 0.03, q: 1.1, filter: "lowpass",
          delay: i * (0.24 + Math.random() * 0.12), bus: musicBus,
        });
      }
    }
  }

  function scheduleNote() {
    musicTimer = window.setTimeout(function () {
      // 后台不排：suspend 之后 currentTime 是停的，这里排下去的全会挤成一坨
      if (ctx && on && !pageHidden) {
        var f = SCALE[Math.floor(Math.random() * SCALE.length)];
        tone({
          freq: jit(f * (Math.random() < 0.35 ? 2 : 1), 8),
          type: Math.random() < 0.22 ? "sine" : "triangle",
          gain: rnd(0.13, 0.18),
          dur: rnd(3.0, 6.2),
          attack: rnd(0.7, 1.2),
          filter: "lowpass",
          cutoff: rnd(1150, 1650),
          bus: musicBus,
        });
        if (Math.random() < 0.4) {
          tone({
            freq: f / 2,
            type: "sine",
            gain: 0.12,
            dur: 4.5,
            attack: 1.4,
            bus: musicBus,
          });
        }
        if (Math.random() < 0.45) ambientTick();
      }
      scheduleNote();
    }, 3400 + Math.random() * 4200);
  }

  /* ---------- 对外 ---------- */

  function boot() {
    if (booted) return;
    if (!init()) return;
    booted = true;
    if (ctx.state === "suspended" && !pageHidden) ctx.resume();
  }

  function fade(target, time) {
    if (!master) return;
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
    master.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), t + time);
  }

  function startMusic() {
    boot();
    if (!ctx || !on || pageHidden) return;
    startDrone();
    fade(0.62, 3.5);
    if (!musicTimer) scheduleNote();
  }

  function setOn(v) {
    on = !!v;
    if (!ctx) return;
    if (!on) {
      fade(0.0001, 0.5);
      if (musicTimer) {
        clearTimeout(musicTimer);
        musicTimer = 0;
      }
      return;
    }
    // 开着开关但页面在后台：只记状态，别出声（回来时 resumeFromHidden 会补上）
    if (pageHidden) return;
    /* 在后台待过又回来、且回来时开关是关着的时候，ctx 还挂在 suspended 上
       （resumeFromHidden 见 on=false 就早退了）。这时候把开关打开必须自己 resume，
       不然是「开关开了却没声音」—— 一个只在「切走→关声音→回来→开声音」这条路上出现的死局。 */
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    fade(0.62, 1.2);
    startDrone();
    if (!musicTimer) scheduleNote();
  }

  /* 落印的尾巴：**七档印 + 结案 + 不能剧透，听感上要分得出来**。
     以前只有「结案」和「不能剧透 / 问清楚点」两支有区别，中间的
     「是 / 不是 / 是也不是 / 部分对 / 接近了 / 无关 / 不重要」全是一模一样的响 ——
     用户说的「单调」有一半是这儿：每一次提问都响，而响来响去一个样。
     每条尾巴都做得很短、很轻（它们要响很多次），并且音高一律过 jit。 */
  var STAMP_TAILS = {
    // 是：轻轻一挑（有时再补一个五度，随机出现 -> 同一档也不总是一个样）
    yes: function () {
      tone({ freq: jit(392, 18), type: "sine", gain: rnd(0.05, 0.07), dur: rnd(0.32, 0.5), attack: 0.01, delay: 0.04 });
      if (Math.random() < 0.5) {
        tone({ freq: jit(587.33, 14), type: "sine", gain: 0.035, dur: rnd(0.5, 0.8), attack: 0.02, delay: rnd(0.1, 0.16) });
      }
    },
    // 不是：闷的短叹，落在下面
    no: function () {
      tone({ freq: jit(98, 22), type: "sine", gain: rnd(0.1, 0.14), dur: rnd(0.4, 0.58), attack: 0.008 });
    },
    // 是也不是：两个音打架（三全音），谁也不让谁
    both: function () {
      [294.66, 415.3].forEach(function (f, i) {
        tone({ freq: jit(f, 12), type: "triangle", gain: 0.05, dur: rnd(0.5, 0.75), attack: 0.02, delay: i * 0.03, filter: "lowpass", cutoff: 1500 });
      });
    },
    // 部分对：半步，对了一半
    partial: function () {
      [329.63, 349.23].forEach(function (f, i) {
        tone({ freq: jit(f, 10), type: "sine", gain: 0.045, dur: 0.5, attack: 0.015, delay: i * 0.12 });
      });
    },
    // 接近了：往上蹭半音 —— 差一点点的那个「差一点」
    close: function () {
      tone({ freq: jit(370, 12), glide: jit(415.3, 12), type: "sine", gain: 0.06, dur: rnd(0.5, 0.7), attack: 0.02 });
    },
    // 无关 / 不重要：一层刷过去的沙声，不带音高（它不是「答案」，只是把问题拂开）
    soft: function () {
      noise({ dur: rnd(0.22, 0.34), from: rnd(1600, 2100), to: 500, gain: 0.05, q: 0.8, filter: "bandpass", attack: 0.02 });
    },
    // 问清楚点：两记干木头叩击（像敲了两下桌面：这话我没法接）
    unanswerable: function () {
      [0, 0.13].forEach(function (d) {
        tone({ freq: jit(196, 30), glide: 150, type: "triangle", gain: 0.06, dur: 0.1, attack: 0.002, delay: d, filter: "lowpass", cutoff: 1100 });
      });
    },
    // 不能剧透：低而硬的一记，加一次关门似的短噪声
    refuse: function () {
      tone({ freq: 74, type: "sine", gain: 0.16, dur: 0.55, attack: 0.01 });
      noise({ dur: 0.14, from: 900, to: 260, gain: 0.07, q: 0.9, filter: "lowpass" });
    },
    // 结案：一组上行 + 一记磬。两条走向随机（也在 pickVariant 那边换），这条是兜底
    solved: function () {
      [220, 329.63, 440, 659.25].forEach(function (f, i) {
        tone({ freq: jit(f, 10), type: "triangle", gain: 0.095, dur: 2.6, attack: 0.02, delay: 0.08 + i * 0.09, filter: "lowpass", cutoff: 2200 });
      });
      tone({ freq: jit(880, 8), type: "sine", gain: 0.07, dur: 3.6, attack: 0.006, delay: 0.5 });
    },
  };
  // 结案的第二种走向：从下往上慢慢堆，收尾换成一记更高的磬
  STAMP_TAILS.solved2 = function () {
    [146.83, 196, 293.66, 440, 587.33].forEach(function (f, i) {
      tone({ freq: jit(f, 10), type: "triangle", gain: 0.07, dur: rnd(2.2, 3.0), attack: 0.03, delay: 0.1 + i * 0.12, filter: "lowpass", cutoff: 2400 });
    });
    tone({ freq: jit(1174.66, 8), type: "sine", gain: 0.055, dur: 4.0, attack: 0.006, delay: 0.72 });
  };

  var SFX = {
    slide: function (dir) {
      var d = dir >= 0 ? 1 : -1;
      var body = pickVariant("slide", [
        function () {
          noise({ dur: rnd(0.4, 0.52), from: d > 0 ? 420 : 1500, to: d > 0 ? 1500 : 420, gain: 0.16, q: rnd(0.75, 1.05) });
          tone({ freq: jit(92, 18), glide: 62, type: "sine", gain: 0.10, dur: 0.4 });
        },
        function () {
          // 更「木」的一支：低频滚过去，高频只留一层薄光
          noise({ dur: rnd(0.3, 0.4), from: 300, to: 900, gain: 0.13, q: 0.7, filter: "lowpass" });
          tone({ freq: jit(110, 20), glide: jit(70, 15), type: "triangle", gain: 0.075, dur: rnd(0.32, 0.44), filter: "lowpass", cutoff: 800 });
        },
        function () {
          // 更「风」的一支：只有气流，没有低频落点（换卷时听起来最轻）
          noise({ dur: rnd(0.5, 0.66), from: d > 0 ? 700 : 1900, to: d > 0 ? 2100 : 600, gain: 0.11, q: rnd(1.0, 1.5), filter: "bandpass", attack: 0.06 });
        },
      ]);
      body();
      noise({ dur: 0.22, from: jit(2600, 200), to: 900, gain: 0.05, q: 0.5, filter: "highpass" });
      // 灯扫过画面的一层薄光
      noise({ dur: rnd(0.6, 0.85), from: 600, to: jit(4800, 300), gain: 0.035, q: 1.7, attack: 0.3 });
    },
    /* 拖动画卷：一层很轻的摩擦。引擎这边节流到 95ms —— 不拦的话每一帧都出一次，
       一卷拖下来能响上百次（这也是「烦」的一大来源）。 */
    drag: function () {
      noise({ dur: rnd(0.07, 0.12), from: jit(900, 120), to: jit(600, 80), gain: rnd(0.025, 0.04), q: 0.8 });
    },
    /* 落印。**听得最多的一件**（每一次提问都响一次），所以这里的变体最值钱：
       底子三选一（金属 / 木头 / 砂面）+ 音高抖动，尾巴按 verdict 分档。 */
    stamp: function (verdict) {
      var body = pickVariant("stamp.body", [
        function () {
          noise({ dur: rnd(0.14, 0.19), from: rnd(2000, 2450), to: 400, gain: 0.19, q: rnd(0.5, 0.8), attack: 0.004 });
          tone({ freq: jit(128, 35), glide: 58, type: "sine", gain: 0.25, dur: 0.3, attack: 0.004 });
        },
        function () {
          // 木头的：低而短，像印章落在纸堆上
          tone({ freq: jit(196, 30), glide: jit(96, 25), type: "triangle", gain: 0.2,
                 dur: rnd(0.16, 0.22), attack: 0.003, filter: "lowpass", cutoff: 900 });
          noise({ dur: 0.09, from: 1500, to: 500, gain: 0.13, q: 1.2, filter: "bandpass" });
        },
        function () {
          // 砂面：短噪声打头，尾巴带一点金属泛音
          noise({ dur: rnd(0.1, 0.15), from: 3200, to: 700, gain: 0.16, q: 0.9, attack: 0.003 });
          tone({ freq: jit(147, 40), type: "sine", gain: 0.16, dur: 0.26, attack: 0.004, delay: 0.01 });
        },
      ]);
      body();
      var tail = verdict === "solved"
        ? (Math.random() < 0.5 ? STAMP_TAILS.solved : STAMP_TAILS.solved2)
        : (STAMP_TAILS[verdict] || STAMP_TAILS.soft);
      tail();
    },
    /* 结案那一卷推上来：一记闷锣打底、一层砂纸般的噪声扫过，
       再叠一组从低到高的长音，最后两记轻磬吊在半空。比 stamp(solved) 更长、更"完"。
       放在 stamp 之后再响，听感上就是"盖章 -> 收卷"。 */
    finale: function () {
      tone({ freq: jit(68, 10), glide: 42, type: "sine", gain: 0.30, dur: 3.4, attack: 0.008 });
      noise({ dur: 1.5, from: 2800, to: 320, gain: 0.15, q: 0.6, attack: 0.03 });
      [146.83, 220, 293.66, 440].forEach(function (f, i) {
        tone({ freq: jit(f, 12), type: "triangle", gain: 0.085, dur: 3.4, attack: 0.05, delay: 0.16 + i * 0.13, filter: "lowpass", cutoff: 2400 });
      });
      // 收尾两记磬：随机是「两记」还是「一记更高更长的」
      var tail = pickVariant("finale.tail", [
        function () {
          [880, 1318.51].forEach(function (f, i) {
            tone({ freq: jit(f, 8), type: "sine", gain: 0.055, dur: 4.2, attack: 0.006, delay: 0.72 + i * 0.17 });
          });
        },
        function () {
          tone({ freq: jit(1567.98, 8), type: "sine", gain: 0.05, dur: 5.0, attack: 0.004, delay: 0.78 });
          tone({ freq: jit(659.25, 10), type: "triangle", gain: 0.04, dur: 4.4, attack: 0.02, delay: 0.86 });
        },
      ]);
      tail();
    },
    fill: function () {
      pickVariant("fill", [
        function () {
          tone({ freq: jit(1318.5, 25), type: "sine", gain: 0.085, dur: 0.2, attack: 0.003 });
          tone({ freq: jit(1760, 25), type: "sine", gain: 0.055, dur: 0.3, attack: 0.003, delay: 0.07 });
        },
        function () {
          // 更近的一支：单音、短、贴耳
          tone({ freq: jit(1046.5, 30), type: "triangle", gain: 0.07, dur: rnd(0.14, 0.2), attack: 0.002, filter: "lowpass", cutoff: 3000 });
        },
      ])();
    },
    board: function (open) {
      noise({ dur: rnd(0.28, 0.4), from: open ? 1100 : 2500, to: open ? 2600 : 900, gain: 0.1, q: 0.7, filter: "bandpass" });
      tone({ freq: jit(open ? 392 : 294, 20), type: Math.random() < 0.4 ? "sine" : "triangle", gain: 0.06, dur: rnd(0.4, 0.55), attack: 0.012 });
    },
    /* 悬停：鼠标扫过一排按钮，这一声会响得最多 —— 所以做三个音色，
       而且必须在 sfx() 里节流（110ms），否则就是「嗒嗒嗒嗒」一梭子。 */
    hover: function () {
      pickVariant("hover", [
        function () {
          noise({ dur: 0.06, from: jit(3600, 200), to: jit(2300, 150), gain: 0.016, q: 1.8, filter: "highpass" });
        },
        function () {
          // 偏木的一支：低一点、短一点
          noise({ dur: rnd(0.05, 0.075), from: 1900, to: 900, gain: 0.02, q: 1.2, filter: "bandpass" });
        },
        function () {
          // 偏气的一支：几乎只是一口气
          noise({ dur: rnd(0.09, 0.14), from: 1200, to: 2600, gain: 0.012, q: 0.8, filter: "bandpass", attack: 0.02 });
        },
      ])();
    },
    unlock: function () {
      pickVariant("unlock", [
        function () {
          [880, 1174.66, 1567.98].forEach(function (f, i) {
            tone({ freq: jit(f, 10), type: "sine", gain: 0.10, dur: 1.5, attack: 0.006, delay: i * 0.075, bus: sfxBus });
          });
        },
        function () {
          // 往下再往上绕一圈：更像「钥匙转到位」
          [1174.66, 880, 1318.51].forEach(function (f, i) {
            tone({ freq: jit(f, 12), type: "triangle", gain: 0.085, dur: rnd(1.1, 1.6), attack: 0.008, delay: i * 0.09, filter: "lowpass", cutoff: 2600 });
          });
        },
        function () {
          // 五声里跳一格：更「东方」的一支
          [659.25, 880, 1046.5].forEach(function (f, i) {
            tone({ freq: jit(f, 14), type: "sine", gain: 0.09, dur: rnd(1.0, 1.4), attack: 0.005, delay: i * 0.06, bus: sfxBus });
          });
        },
      ])();
      noise({ dur: 0.3, from: jit(4200, 300), to: 1800, gain: 0.05, q: 0.7, filter: "highpass" });
      noise({ dur: 0.9, from: 700, to: jit(3800, 400), gain: 0.03, q: 1.5, attack: 0.35 });
    },
    listen: function () {
      tone({ freq: jit(1046.5, 25), type: "sine", gain: 0.09, dur: rnd(0.12, 0.16), attack: 0.004 });
      tone({ freq: jit(1568, 25), type: "sine", gain: 0.05, dur: 0.2, attack: 0.004, delay: 0.06 });
    },
    release: function () {
      tone({ freq: jit(620, 30), glide: jit(415, 20), type: "sine", gain: 0.08, dur: rnd(0.15, 0.22) });
    },
    click: function () {
      pickVariant("click", [
        function () { noise({ dur: 0.05, from: jit(3000, 200), to: 1400, gain: 0.05, q: 1.4, filter: "highpass" }); },
        function () { tone({ freq: jit(784, 30), type: "sine", gain: 0.045, dur: 0.07, attack: 0.002 }); },
      ])();
    },
    think: function () {
      if (!ctx || thinkNode) return;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.connect(sfxBus);
      var osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = jit(58, 4);
      var amp = ctx.createGain();
      var lfo = ctx.createOscillator();
      lfo.frequency.value = rnd(1.5, 1.9);
      var lg = ctx.createGain();
      lg.gain.value = 1;
      lfo.connect(lg);
      lg.connect(amp.gain);
      osc.connect(amp);
      amp.connect(g);
      g.gain.setTargetAtTime(0.045, ctx.currentTime, 0.4);
      osc.start();
      lfo.start();
      thinkNode = { g: g, osc: osc, lfo: lfo };
    },
    silence: function () {
      if (!thinkNode) return;
      var n = thinkNode;
      thinkNode = null;
      try {
        n.g.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        window.setTimeout(function () {
          try { n.osc.stop(); n.lfo.stop(); } catch (e) {}
        }, 900);
      } catch (e) {}
    },

    /* ---------- 2026-09-20 补的声音 ----------
       这几件事原来都是**静音**的（或者借一声鼠标划过代替）：点灯、求到灯、
       开卷第一声、搜剧本、从搜索结果落卷、停表 / 回表、引导翻页。
       安静的地方太多，动起来的那几下反而显得突兀 —— 补上之后整局是有起伏的。 */

    /* 点灯：芯爆一声 + 暖音铺开（跟「灯」这个隐喻对齐）。 */
    wickOn: function () {
      noise({ dur: 0.12, from: rnd(2400, 2800), to: 900, gain: 0.11, q: 1.3, filter: "bandpass", attack: 0.002 });
      tone({ freq: jit(523.25, 20), type: "sine", gain: 0.07, dur: rnd(1.0, 1.5), attack: 0.02, filter: "lowpass", cutoff: 2600 });
      tone({ freq: jit(784, 20), type: "triangle", gain: 0.035, dur: 0.9, attack: 0.03, delay: 0.05 });
    },
    /* 吹灭：一口气 + 低音收掉。 */
    wickOff: function () {
      noise({ dur: rnd(0.22, 0.32), from: 700, to: 180, gain: 0.1, q: 0.7, filter: "lowpass", attack: 0.01 });
      tone({ freq: jit(131, 20), glide: 78, type: "sine", gain: 0.1, dur: 0.35 });
    },
    /* 灯语落地：一记轻磬 + 纸面落定。 */
    hint: function () {
      [1046.5, 1567.98].forEach(function (f, i) {
        tone({ freq: jit(f, 16), type: "sine", gain: i ? 0.05 : 0.075, dur: rnd(1.2, 1.8), attack: 0.005, delay: i * 0.06 });
      });
      noise({ dur: 0.3, from: 1800, to: 700, gain: 0.035, q: 0.8, filter: "bandpass", attack: 0.02 });
    },
    /* 开卷第一声：远处一记钟 + 一层低频抬起（跟音乐一起起，别做成「点击音」）。 */
    open: function () {
      tone({ freq: jit(146.83, 12), type: "sine", gain: 0.12, dur: rnd(3.4, 4.4), attack: 0.06, bus: musicBus });
      tone({ freq: jit(220, 10), type: "triangle", gain: 0.05, dur: 2.6, attack: 0.2, delay: 0.12, bus: musicBus });
      noise({ dur: 1.4, from: 420, to: 1400, gain: 0.02, q: 1.4, attack: 0.5, bus: musicBus });
    },
    /* 搜剧本面板开 / 关：木质一声 + 纸。 */
    find: function (open) {
      tone({ freq: jit(open ? 294 : 247, 20), type: "triangle", gain: 0.05, dur: 0.22, attack: 0.004 });
      noise({ dur: rnd(0.18, 0.3), from: open ? 900 : 1600, to: open ? 2200 : 600, gain: 0.035, q: 0.8, filter: "bandpass" });
    },
    /* 从搜索结果落卷：比 slide 短、有一记落地的「咔」（跳卷和顺着滑是两件事）。 */
    seek: function () {
      noise({ dur: 0.26, from: 1600, to: 300, gain: 0.09, q: 0.6, filter: "lowpass" });
      tone({ freq: jit(110, 18), glide: 70, type: "sine", gain: 0.12, dur: 0.22 });
    },
    /* 停表 / 回表：极轻的一记，别打断思路（停表可能是自动的，响太重会吓人）。 */
    pause: function () { tone({ freq: jit(1318, 30), type: "sine", gain: 0.03, dur: 0.18, attack: 0.004 }); },
    resume: function () { tone({ freq: jit(880, 30), type: "sine", gain: 0.03, dur: 0.22, attack: 0.004 }); },
    /* 引导翻页：纸页。 */
    tour: function () {
      noise({ dur: rnd(0.18, 0.26), from: rnd(1200, 2000), to: rnd(400, 700), gain: 0.05, q: 0.7, filter: "bandpass" });
    },
  };

  function sfx(name, arg) {
    /* 三道闸：没有 ctx（还没被用户手势解锁）/ 用户关了声音 / **页面在后台**。
       第三条是 2026-09-20 加的：不在屏幕上还响，是用户明确报过的毛病。 */
    if (!ctx || !on || pageHidden) return;
    if (throttled(name)) return;
    var fn = SFX[name];
    if (fn) fn(arg);
  }

  return {
    boot: boot,
    startMusic: startMusic,
    setOn: setOn,
    isOn: function () { return on; },
    sfx: sfx,
    get ready() { return !!ctx; },
    /* 两件只读的诊断（探针与排查用，也是「离开页面到底静下来了没」的判据）：
       state  = AudioContext 的状态（running / suspended）
       playing= 此刻该不该有声音（开关开着 + 页面在前台） */
    get state() { return ctx ? ctx.state : "none"; },
    get playing() { return !!ctx && on && !pageHidden; },
  };
})();
