/* 封存 · 环境音与音效
   纯 Web Audio 程序化合成：没有外部音频素材，不增加任何下载体积。
   音乐是"生成式"的——低频长音铺底，偶发单音落在小调五声音阶上，不会循环重复。 */

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
    if (!ctx || !on) return;
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
      if (ctx && on) {
        var f = SCALE[Math.floor(Math.random() * SCALE.length)];
        tone({
          freq: f * (Math.random() < 0.35 ? 2 : 1),
          type: "triangle",
          gain: 0.16,
          dur: 3.4 + Math.random() * 2.6,
          attack: 0.9,
          filter: "lowpass",
          cutoff: 1400,
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
    if (ctx.state === "suspended") ctx.resume();
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
    if (!ctx || !on) return;
    startDrone();
    fade(0.62, 3.5);
    if (!musicTimer) scheduleNote();
  }

  function setOn(v) {
    on = !!v;
    if (!ctx) return;
    if (on) {
      fade(0.62, 1.2);
      startDrone();
      if (!musicTimer) scheduleNote();
    } else {
      fade(0.0001, 0.5);
      if (musicTimer) {
        clearTimeout(musicTimer);
        musicTimer = 0;
      }
    }
  }

  var SFX = {
    slide: function (dir) {
      var d = dir >= 0 ? 1 : -1;
      noise({ dur: 0.46, from: d > 0 ? 420 : 1500, to: d > 0 ? 1500 : 420, gain: 0.16, q: 0.9 });
      noise({ dur: 0.22, from: 2600, to: 900, gain: 0.05, q: 0.5, filter: "highpass" });
      tone({ freq: 92, glide: 62, type: "sine", gain: 0.10, dur: 0.4 });
      // 灯扫过画面的一层薄光
      noise({ dur: 0.75, from: 600, to: 4800, gain: 0.035, q: 1.7, attack: 0.3 });
    },
    drag: function () {
      noise({ dur: 0.1, from: 900, to: 600, gain: 0.035, q: 0.8 });
    },
    stamp: function (verdict) {
      noise({ dur: 0.16, from: 2200, to: 400, gain: 0.20, q: 0.6, attack: 0.004 });
      tone({ freq: 128, glide: 58, type: "sine", gain: 0.26, dur: 0.3, attack: 0.004 });
      if (verdict === "solved") {
        [220, 329.63, 440, 659.25].forEach(function (f, i) {
          tone({ freq: f, type: "triangle", gain: 0.10, dur: 2.6, attack: 0.02, delay: 0.08 + i * 0.09, filter: "lowpass", cutoff: 2200 });
        });
        // 收尾的一记磬
        tone({ freq: 880, type: "sine", gain: 0.07, dur: 3.6, attack: 0.006, delay: 0.5 });
      } else if (verdict === "refuse" || verdict === "unanswerable") {
        tone({ freq: 74, type: "sine", gain: 0.18, dur: 0.55, attack: 0.01 });
      }
    },
    /* 结案那一卷推上来：一记闷锣打底、一层砂纸般的噪声扫过，
       再叠一组从低到高的长音，最后两记轻磬吊在半空。比 stamp(solved) 更长、更"完"。
       放在 stamp 之后再响，听感上就是"盖章 -> 收卷"。 */
    finale: function () {
      tone({ freq: 68, glide: 42, type: "sine", gain: 0.30, dur: 3.4, attack: 0.008 });
      noise({ dur: 1.5, from: 2800, to: 320, gain: 0.15, q: 0.6, attack: 0.03 });
      [146.83, 220, 293.66, 440].forEach(function (f, i) {
        tone({ freq: f, type: "triangle", gain: 0.085, dur: 3.4, attack: 0.05, delay: 0.16 + i * 0.13, filter: "lowpass", cutoff: 2400 });
      });
      [880, 1318.51].forEach(function (f, i) {
        tone({ freq: f, type: "sine", gain: 0.055, dur: 4.2, attack: 0.006, delay: 0.72 + i * 0.17 });
      });
    },
    fill: function () {
      tone({ freq: 1318.5, type: "sine", gain: 0.085, dur: 0.2, attack: 0.003 });
      tone({ freq: 1760, type: "sine", gain: 0.055, dur: 0.3, attack: 0.003, delay: 0.07 });
    },
    board: function (open) {
      noise({ dur: 0.34, from: open ? 1100 : 2500, to: open ? 2600 : 900, gain: 0.1, q: 0.7, filter: "bandpass" });
      tone({ freq: open ? 392 : 294, type: "triangle", gain: 0.06, dur: 0.45, attack: 0.012 });
    },
    hover: function () {
      noise({ dur: 0.06, from: 3600, to: 2300, gain: 0.016, q: 1.8, filter: "highpass" });
    },
    unlock: function () {
      [880, 1174.66, 1567.98].forEach(function (f, i) {
        tone({ freq: f, type: "sine", gain: 0.10, dur: 1.5, attack: 0.006, delay: i * 0.075, bus: sfxBus });
      });
      noise({ dur: 0.3, from: 4200, to: 1800, gain: 0.05, q: 0.7, filter: "highpass" });
      noise({ dur: 0.9, from: 700, to: 3800, gain: 0.03, q: 1.5, attack: 0.35 });
    },
    listen: function () {
      tone({ freq: 1046.5, type: "sine", gain: 0.09, dur: 0.14, attack: 0.004 });
      tone({ freq: 1568, type: "sine", gain: 0.05, dur: 0.2, attack: 0.004, delay: 0.06 });
    },
    release: function () {
      tone({ freq: 620, glide: 415, type: "sine", gain: 0.08, dur: 0.18 });
    },
    click: function () {
      noise({ dur: 0.05, from: 3000, to: 1400, gain: 0.05, q: 1.4, filter: "highpass" });
    },
    think: function () {
      if (!ctx || thinkNode) return;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.connect(sfxBus);
      var osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 58;
      var amp = ctx.createGain();
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 1.7;
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
  };

  function sfx(name, arg) {
    if (!ctx || !on) return;
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
  };
})();
