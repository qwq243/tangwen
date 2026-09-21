/* 汤问 · 后台
   零依赖。图是手写 SVG —— 为了三个折线柱状引一整个图表库不划算。
   会话 token 放 sessionStorage：关掉标签页就失效，不给「留在公用电脑上」的机会。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = "tangwen.admin.token";
  var METRIC = { pv: "访问", uv: "访客", ask: "提问", hint: "求灯", solve: "结案", new: "新增", give: "放弃" };

  var token = "";
  var days = 30;
  var metric = "pv";
  var stats = null;
  var vols = [];
  var boardPid = "";
  var toastTimer = 0;
  /* 卷宗核对的筛选状态。q 是搜索词（空格分开＝都要命中），soup / diff 是分类。
     两个分类是**并列**的（可以同时是「黑汤 + 深」，跟正馆那个搜剧本一个手感）。 */
  var volQ = "";
  var volSoup = "";
  var volDiff = "";

  /* ---------------- 基础 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function n(v) {
    var x = Number(v || 0);
    return x.toLocaleString("zh-CN");
  }

  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 2200);
  }

  async function api(path, opts) {
    var o = opts || {};
    var headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (o.body) headers["Content-Type"] = "application/json";
    var res = await fetch(path, {
      method: o.method || "GET",
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) { signOut(); throw new Error("会话过期了，重新进一次"); }
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data || {};
  }

  /* ---------------- 登录 / 退出 ---------------- */

  function showApp(on) {
    $("login").hidden = on;
    $("app").hidden = !on;
  }

  function signOut(msg) {
    token = "";
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
    showApp(false);
    $("key").value = "";
    $("loginErr").textContent = msg || "";
  }

  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var key = $("key").value;
    if (!key) return;
    $("loginErr").textContent = "";
    $("loginGo").disabled = true;
    try {
      var res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key }),
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (!res.ok || !data.ok) {
        var msg = data.error || ("进不去（" + res.status + "）");
        if (typeof data.left === "number" && data.left > 0) msg += "，还能试 " + data.left + " 次";
        $("loginErr").textContent = msg;
        return;
      }
      token = data.token;
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
      $("key").value = "";
      showApp(true);
      await loadAll();
      startAuto();
      toast("进了");
    } catch (err) {
      $("loginErr").textContent = String(err.message || err);
    } finally {
      $("loginGo").disabled = false;
    }
  });

  $("logout").addEventListener("click", function () { signOut("已退出"); });

  /* ---------------- 取数 ---------------- */

  /* 先卷宗后统计，串行。
     并行会撞上一个只在慢机器上才现形的坑：统计先回来的话，填排行榜下拉时
     卷宗还是空的，下拉和表就一直是空的 —— 而没人会再触发一次填充。
     实测 390 宽的手机视图下必现，1440 的桌面上偶尔能赢这个竞态，所以差点漏过去。
     多一个来回换掉这个不确定性，值。 */
  async function loadAll() {
    await loadVolumes();
    await loadStats();
  }

  async function loadStats(quiet) {
    try {
      stats = await api("/api/admin/stats?days=" + days);
      render();
      fillBoardPick();
    } catch (err) {
      window.__bootErr = "stats:" + String(err.message || err);
      // 自动刷新那一路不弹提示：网络抖一下就每 30 秒弹一次，吵得没法看数
      if (!quiet) toast(String(err.message || err));
    }
  }

  async function loadVolumes() {
    try {
      var data = await api("/api/admin/puzzles");
      vols = data.puzzles || [];
      renderVolumes();
    } catch (err) {
      toast(String(err.message || err));
    }
  }

  $("refresh").addEventListener("click", function () { loadAll().then(function () { toast("刷新了"); }); });

  /* 自己转起来：每 30 秒拉一次统计。
     以前只有「进页面」和「点刷新」两个时刻会取数 —— 玩家提问之后不点一下，
     看到的就是几分钟前的数，很容易误判成「后台没在记」。切走（隐藏）就停，
     回来立刻补一次；不给看不见的标签页白转，也不让切回来时看到旧值。

     只刷统计，不刷卷宗：卷宗那份要摊开 34 条 <details>，重画会把展开的收回去、
     把滚动位置顶掉，而它本来就随包发布、不会变。 */
  var autoTimer = 0;
  function startAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      if (document.visibilityState !== "visible" || !token) return;
      loadStats(true);
    }, 30000);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && token) loadStats(true);
  });

  $("range").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-d]");
    if (!b) return;
    days = Number(b.dataset.d);
    [].forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    loadStats();
  });

  $("metric").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-m]");
    if (!b) return;
    metric = b.dataset.m;
    [].forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    renderChart();
  });

  /* ---------------- 渲染：概览 ---------------- */

  function render() {
    if (!stats) return;
    var rows = stats.days || [];
    var today = rows[rows.length - 1] || {};
    var t = stats.totals || {};
    $("today").textContent = stats.today || "";

    var cards = [
      ["今日访问", today.pv, "区间合计 " + n(t.pv), true],
      ["今日访客", today.uv, "区间合计 " + n(t.uv), false],
      ["今日新增", today.new, "区间合计 " + n(t.new), false],
      ["今日提问", today.ask, "区间合计 " + n(t.ask), false],
      ["今日求灯", today.hint, "区间合计 " + n(t.hint), false],
      ["今日结案", today.solve, "区间合计 " + n(t.solve), false],
    ];
    $("kpis").innerHTML = cards.map(function (c) {
      return '<div class="kpi' + (c[3] ? " hot" : "") + '">' +
        '<div class="k">' + c[0] + '</div>' +
        '<div class="v">' + n(c[1]) + '</div>' +
        '<div class="d">' + esc(c[2]) + '</div></div>';
    }).join("");

    $("chartSub").textContent = "近 " + days + " 日";
    $("puzSub").textContent = "近 " + days + " 日 · " + (stats.puzzles || []).length + " 卷有人问过";
    renderChart();
    renderModels();
    renderPuzTable();
    renderDayTable();
  }

  /* ---------------- 渲染：模型调用 ----------------

     两条链路各算各的账（口径见 README「模型调用统计」）：
       判题 = TypeSafe + jev-latest，**每次提问必发一次** —— 所以「判题调用次数」
              就等于提问数，另记一笔「判题失败」看它有没有在挂（密钥/额度/上游），
              再记一笔「讲对了没结案」看结案判据有没有又在拿语气当判据；
       求灯 = Workers AI 免费额度，按「这一句是谁答的」分开记（day.m），
              链上全挂回兜底的那一档单独算（hintfallback）。
     这些都是接口自己记的（server.py / Worker 的 bump_track），页面只负责摆出来。 */
  function renderModels() {
    if (!stats) return;
    var t = stats.totals || {};
    var today = (stats.days || []).slice(-1)[0] || {};
    var models = stats.models || [];
    var judge = stats.judge_model || "";
    $("modelSub").textContent = "近 " + days + " 日";

    var tile = function (label, nowV, sumV, warn) {
      return '<div class="mod' + (warn ? " warn" : "") + '">' +
        '<div class="k">' + label + '</div>' +
        '<div class="v">' + n(nowV) + '</div>' +
        '<div class="d">今日 · 区间 ' + n(sumV) + '</div></div>';
    };
    $("mods").innerHTML =
      tile("今日判题调用", today.ask, t.ask, false) +
      tile("判题失败", today.judgefail, t.judgefail, Number(today.judgefail || 0) > 0) +
      tile("讲对了没结案", today.nearmiss, t.nearmiss, Number(today.nearmiss || 0) > 0) +
      tile("今日求灯调用", today.hint, t.hint, false) +
      tile("求灯兜底", today.hintfallback, t.hintfallback, Number(today.hintfallback || 0) > 0);

    $("modNote").innerHTML =
      "判题走 <span class=\"mono\">" + esc(judge || "?") + "</span>（写死的，十档阈值照它量的）；" +
      "提问一次必发一次判题，所以「判题调用」＝提问数 —— 它和「判题失败」对不上的时候，" +
      "差的就是模型调用没回来的那些。<b>「讲对了没结案」这个数应当恒为 0</b>：" +
      "它是结案判据自己的故障灯（机制说对了、却没落结案），涨起来就说明判据又在拿语气当判据。" +
      "求灯走 Workers AI 的模型链，哪一句是谁答的看下表。";

    var total = models.reduce(function (s, r) { return s + Number(r.n || 0); }, 0);
    if (!models.length) {
      $("modTable").innerHTML = '<div class="empty">' +
        (Number(t.hint || 0) > 0 ? "这个区间的求灯全部退到了兜底（AI 没绑上，或模型链全挂了）" : "这个区间还没有人求灯") +
        '</div>';
    } else {
      $("modTable").innerHTML = '<table><thead><tr>' +
        '<th>求灯模型</th><th class="num">次数</th><th class="num">占比</th>' +
        '</tr></thead><tbody>' +
        models.map(function (r) {
          var pct = total ? Math.round((Number(r.n || 0) / total) * 1000) / 10 : 0;
          return '<tr><td class="mono">' + esc(r.model) + '</td>' +
            '<td class="num">' + n(r.n) + '</td>' +
            '<td class="num">' + pct + '%</td></tr>';
        }).join("") + '</tbody></table>';
    }
  }

  function renderPuzTable() {
    var rows = (stats && stats.puzzles) || [];
    if (!rows.length) {
      $("puzTable").innerHTML = '<div class="empty">这个区间还没有人提问</div>';
      return;
    }
    $("puzTable").innerHTML = '<table><thead><tr>' +
      '<th>卷宗</th><th class="num">提问</th><th class="num">求灯</th><th class="num">结案</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(r.title) + ' <span class="faint mono">' + esc(r.id) + '</span></td>' +
          '<td class="num">' + n(r.ask) + '</td>' +
          '<td class="num">' + n(r.hint) + '</td>' +
          '<td class="num">' + n(r.solve) + '</td></tr>';
      }).join("") + '</tbody></table>';
  }

  function renderDayTable() {
    var rows = ((stats && stats.days) || []).slice(-7).reverse();
    if (!rows.length) {
      $("dayTable").innerHTML = '<div class="empty">还没有数据</div>';
      return;
    }
    $("dayTable").innerHTML = '<table><thead><tr>' +
      '<th>日期</th><th class="num">访问</th><th class="num">访客</th><th class="num">新增</th>' +
      '<th class="num">提问</th><th class="num">结案</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td class="mono">' + esc(r.date) + '</td>' +
          '<td class="num">' + n(r.pv) + '</td>' +
          '<td class="num">' + n(r.uv) + '</td>' +
          '<td class="num">' + n(r.new) + '</td>' +
          '<td class="num">' + n(r.ask) + '</td>' +
          '<td class="num">' + n(r.solve) + '</td></tr>';
      }).join("") + '</tbody></table>';
  }

  /* ---------------- 渲染：折线图（手写 SVG） ---------------- */

  function niceCeil(v) {
    if (!(v > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var r = v / mag;
    var step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
    return step * mag;
  }

  /* 窗口变宽变窄要重画：viewBox 是按容器实测宽度定的，不重画就会拉伸变形。
     手机上旋转屏幕 / 展开侧栏都会走到这里，防抖 160ms。 */
  var chartResizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(renderChart, 160);
  });

  function renderChart() {
    var box = $("chartBox");
    if (!box) return;
    var rows = (stats && stats.days) || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">还没有数据</div>';
      return;
    }
    /* viewBox 用真实像素，字号就是真字号。
       之前把 viewBox 钉在 1000 宽再让 SVG 整体缩放，390 宽的手机上 12px 的刻度
       被缩成 3.7px —— 等于没有刻度。所以改成按容器实测宽度画，宽度变了就重画。 */
    var W = Math.max(260, Math.round(box.clientWidth || 900));
    var H = Math.round(Math.max(180, Math.min(320, W * 0.34)));
    var PL = W < 480 ? 38 : 56, PR = 12, PT = 14, PB = 30;
    var FS = W < 480 ? 10 : 12;
    var iw = W - PL - PR, ih = H - PT - PB, base = PT + ih;
    var vals = rows.map(function (r) { return Number(r[metric] || 0); });
    var top = niceCeil(Math.max(1, Math.max.apply(null, vals)));
    var px = function (i) { return rows.length === 1 ? PL + iw / 2 : PL + (i * iw) / (rows.length - 1); };
    var py = function (v) { return base - (v / top) * ih; };

    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="' + METRIC[metric] + '趋势">');
    parts.push('<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#d7a15a" stop-opacity="0.26"/>' +
      '<stop offset="100%" stop-color="#d7a15a" stop-opacity="0"/></linearGradient></defs>');

    // 横向网格 + 纵轴刻度
    for (var g = 0; g <= 4; g++) {
      var yy = py((top / 4) * g);
      parts.push('<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (PL + iw) + '" y2="' + yy.toFixed(1) +
        '" stroke="#d7a15a" stroke-opacity="' + (g === 0 ? 0.3 : 0.11) + '" stroke-width="1"/>');
      parts.push('<text x="' + (PL - 8) + '" y="' + yy.toFixed(1) + '" fill="#6d6152" font-size="' + FS + '" ' +
        'font-family="ui-monospace,Consolas,monospace" text-anchor="end" dominant-baseline="middle">' +
        (top / 4) * g + '</text>');
    }

    // 横轴日期：窄屏最多 4 个、宽屏最多 8 个，免得标签挤成一团
    var step = Math.max(1, Math.ceil(rows.length / (W < 480 ? 4 : 8)));
    for (var i = 0; i < rows.length; i += step) {
      parts.push('<text x="' + px(i).toFixed(1) + '" y="' + (base + 18) + '" fill="#6d6152" font-size="' + FS + '" ' +
        'font-family="ui-monospace,Consolas,monospace" text-anchor="middle">' + esc(rows[i].date.slice(5)) + '</text>');
    }

    var line = vals.map(function (v, i) { return (i ? "L" : "M") + px(i).toFixed(1) + " " + py(v).toFixed(1); }).join(" ");
    parts.push('<path d="' + line + " L" + px(vals.length - 1).toFixed(1) + " " + base + " L" + px(0).toFixed(1) + " " + base +
      ' Z" fill="url(#ag)"/>');
    parts.push('<path d="' + line + '" fill="none" stroke="#d7a15a" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>');

    if (rows.length <= 45 && W >= 420) {
      vals.forEach(function (v, i) {
        parts.push('<circle cx="' + px(i).toFixed(1) + '" cy="' + py(v).toFixed(1) + '" r="2.6" fill="#d7a15a"/>');
      });
    }

    // 悬停十字线：先埋好，mousemove 时改 x / d
    parts.push('<g id="hover" style="display:none">' +
      '<line id="hLine" y1="' + PT + '" y2="' + base + '" stroke="#d7a15a" stroke-opacity="0.42" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<circle id="hDot" r="4" fill="#070605" stroke="#d7a15a" stroke-width="2"/></g>');
    parts.push('<rect id="hit" x="' + PL + '" y="' + PT + '" width="' + iw + '" height="' + ih + '" fill="transparent"/>');
    parts.push("</svg>");
    box.innerHTML = parts.join("") + '<div class="tipbox" id="tip" style="display:none"></div>';

    var svg = box.querySelector("svg");
    var hit = svg.querySelector("#hit");
    var hg = svg.querySelector("#hover");
    var tip = $("tip");
    hit.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      var vx = ((e.clientX - rect.left) / rect.width) * W;
      var ratio = rows.length === 1 ? 0 : (vx - PL) / iw;
      var idx = Math.min(rows.length - 1, Math.max(0, Math.round(ratio * (rows.length - 1))));
      var cx = px(idx), cy = py(vals[idx]);
      hg.style.display = "";
      svg.querySelector("#hLine").setAttribute("x1", cx);
      svg.querySelector("#hLine").setAttribute("x2", cx);
      var dot = svg.querySelector("#hDot");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      var sy = rect.height / H;
      tip.style.display = "";
      tip.style.left = Math.min(rect.width - 60, Math.max(60, cx * (rect.width / W))) + "px";
      tip.style.top = Math.max(30, cy * sy - 8) + "px";
      tip.innerHTML = esc(rows[idx].date) + "<br />" + METRIC[metric] + " <b>" + n(vals[idx]) + "</b>";
    });
    hit.addEventListener("mouseleave", function () {
      hg.style.display = "none";
      tip.style.display = "none";
    });
  }

  /* ---------------- 排行榜管理 ---------------- */

  function fillBoardPick() {
    /* 卷宗没到就别填。这里是上面那个竞态的守门人：真要是空着进来了，
       至少留个记号，下一次打开看 __bootErr 就知道是顺序问题不是数据问题。 */
    if (!vols.length) { window.__bootErr = "pick:卷宗还没到就填下拉了"; return; }
    var sel = $("boardPick");
    if (!sel) { window.__bootErr = "pick:找不到 #boardPick"; return; }
    var want = boardPid;
    if (!want) {
      var hot = (stats && stats.puzzles && stats.puzzles[0]) || null;
      var withBoard = vols.filter(function (p) { return p.keys_count; });
      want = (hot && hot.id) || (withBoard[0] && withBoard[0].id) || (vols[0] && vols[0].id) || "";
    }
    sel.innerHTML = vols.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.title) + "（" + esc(p.id) + "）</option>";
    }).join("");
    boardPid = want;
    if (sel.value !== want) sel.value = want;
    loadBoard();
  }

  function renderBoard(data) {
    var rows = (data && data.rows) || [];
    if (!rows.length) {
      $("boardTable").innerHTML = '<div class="empty">这一卷还没有结案记录</div>';
      return;
    }
    $("boardTable").innerHTML = '<table><thead><tr>' +
      '<th class="num">#</th><th>名</th><th class="num">问</th><th class="num">用时</th><th>提示</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r, i) {
        var sec = Math.round(Number(r.ms || 0) / 1000);
        var clock = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
        return '<tr><td class="num">' + (i + 1) + '</td>' +
          '<td>' + esc(r.name) + ' <span class="faint mono">' + esc(String(r.id).slice(0, 8)) + '</span></td>' +
          '<td class="num">' + n(r.asks) + '</td>' +
          '<td class="num">' + clock + '</td>' +
          '<td>' + (r.used_hint ? '<span class="faint">用了</span>' : '<span class="mono">孤灯</span>') + '</td>' +
          '<td class="num"><button class="btn tiny danger" data-del="' + esc(r.id) + '" type="button">删</button></td></tr>';
      }).join("") + '</tbody></table>';
  }

  async function loadBoard() {
    if (!boardPid) { $("boardTable").innerHTML = '<div class="empty">先选一卷</div>'; return; }
    try {
      renderBoard(await api("/api/admin/board?puzzle_id=" + encodeURIComponent(boardPid)));
    } catch (err) {
      toast(String(err.message || err));
    }
  }

  $("boardPick").addEventListener("change", function () { boardPid = this.value; loadBoard(); });
  $("boardReload").addEventListener("click", loadBoard);

  $("boardTable").addEventListener("click", async function (e) {
    var b = e.target.closest("button[data-del]");
    if (!b) return;
    try {
      renderBoard(await api("/api/admin/board/delete", {
        method: "POST",
        body: { puzzle_id: boardPid, id: b.dataset.del },
      }));
      loadStats();
      toast("删了一条");
    } catch (err) {
      toast(String(err.message || err));
    }
  });

  $("boardClear").addEventListener("click", async function () {
    if (!boardPid) return;
    var title = (vols.filter(function (p) { return p.id === boardPid; })[0] || {}).title || boardPid;
    if (!window.confirm("清空《" + title + "》的全部排行榜记录？这一步不能撤回。")) return;
    try {
      renderBoard(await api("/api/admin/board/clear", { method: "POST", body: { puzzle_id: boardPid } }));
      loadStats();
      toast("清空了");
    } catch (err) {
      toast(String(err.message || err));
    }
  });

  /* ---------------- 卷宗核对 ----------------

     2026-09-20 加：搜索 + 分类。44 卷摊开之后，想找「那卷讲丧尸的」「所有黑汤深卷」
     只能靠眼睛扫 —— 核对汤底/汤色/难度本来就是这一栏的活，得能筛。
     搜索覆盖整卷正文（卷名 / 卷号 / 汤面 / 汤底 / 关键点的标题与问法）：
     核对的场景常常是「我记得有个词，在哪一卷来着」，只搜标题是不够的。 */

  function volTerms() {
    return volQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  function volHay(p) {
    return [p.title, p.id, p.soup, p.difficulty, p.surface, p.bottom]
      .concat((p.keys || []).map(function (k) { return (k.label || "") + " " + (k.prompt || ""); }))
      .join(" ").toLowerCase();
  }

  function volMatched() {
    var terms = volTerms();
    return vols.filter(function (p) {
      if (volSoup && p.soup !== volSoup) return false;
      if (volDiff && p.difficulty !== volDiff) return false;
      if (!terms.length) return true;
      var hay = volHay(p);
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }

  function volFiltered() {
    return !!(volTerms().length || volSoup || volDiff);
  }

  /* 分类那排 chip。跟正馆那个搜剧本一样：一枚共用的「全部」把两类都清掉，
     汤色三枚 / 难度三枚各自可切（再点一下取消）。卷数按**全库**算 ——
     问「清汤有几卷」和当前筛着什么无关。 */
  function renderVolTags() {
    var countBy = function (key, val) {
      return vols.filter(function (p) { return p[key] === val; }).length;
    };
    var chip = function (attrs, label, n, on) {
      return '<button type="button" ' + attrs + ' class="' + (on ? "on" : "") + '">' +
        esc(label) + '<span class="k">' + n + '</span></button>';
    };
    var all = volFiltered() ? "" : " on";
    var html = chip('data-all="1"', "全部", vols.length, !!all);
    html += ['清汤', '红汤', '黑汤'].map(function (s) {
      return chip('data-soup="' + s + '"', s, countBy("soup", s), volSoup === s);
    }).join("");
    html += '<i class="sep"></i>';
    html += ['浅', '中', '深'].map(function (d) {
      return chip('data-diff="' + d + '"', d, countBy("difficulty", d), volDiff === d);
    }).join("");
    $("volTags").innerHTML = html;
  }

  function renderVolumes() {
    var list = volMatched();
    var filtered = volFiltered();
    $("volSub").textContent = filtered
      ? list.length + " / " + vols.length + " 卷"
      : vols.length + " 卷";
    $("volClear").hidden = !volQ;
    renderVolTags();
    if (!vols.length) { $("vols").innerHTML = '<div class="empty">没拿到卷宗</div>'; return; }
    if (!list.length) {
      $("vols").innerHTML = '<div class="empty">没有符合条件的卷 —— 换个词，或点「全部」把分类清掉</div>';
      return;
    }
    $("vols").innerHTML = list.map(function (p) {
      /* 卷号取全库里的序号，不是筛完的名次：核对时说的「第 07 卷」得是同一个卷 */
      var i = vols.indexOf(p);
      return '<details class="vol"><summary>' +
        '<span class="idx">' + String(i + 1).padStart(2, "0") + '</span>' +
        '<span class="t">' + esc(p.title) + '</span>' +
        '<span class="tag">' + esc(p.id) + '</span>' +
        (p.soup ? '<span class="tag soup" data-soup="' + esc(p.soup) + '">' + esc(p.soup) + '</span>' : '') +
        (p.difficulty ? '<span class="tag">' + esc(p.difficulty) + '</span>' : '') +
        '<span class="tag">' + p.keys_count + ' 点</span>' +
        '</summary><div class="body">' +
        '<dl>' +
        '<dt>汤面</dt><dd class="surface">' + esc(p.surface) + '</dd>' +
        '<dt>汤底</dt><dd class="bottom">' + esc(p.bottom) + '</dd>' +
        '</dl>' +
        '<dl><dt>关键点（' + p.keys_count + '）</dt><dd><ol>' +
        p.keys.map(function (k) {
          return '<li><b>' + esc(k.label) + '</b>　' + esc(k.prompt) + '</li>';
        }).join("") + '</ol></dd></dl>' +
        '</div></details>';
    }).join("");
  }

  $("volQ").addEventListener("input", function () {
    volQ = this.value || "";
    renderVolumes();
  });
  $("volClear").addEventListener("click", function () {
    volQ = "";
    $("volQ").value = "";
    renderVolumes();
    $("volQ").focus();
  });
  $("volTags").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    var ds = b.dataset;
    if (ds.all !== undefined) { volSoup = ""; volDiff = ""; }
    else if (ds.soup !== undefined) { volSoup = volSoup === ds.soup ? "" : ds.soup; }
    else if (ds.diff !== undefined) { volDiff = volDiff === ds.diff ? "" : ds.diff; }
    renderVolumes();
  });

  /* ---------------- 导出 ---------------- */

  $("export").addEventListener("click", function () {
    if (!stats) return;
    var blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(),
      window_days: days,
      stats: stats,
    }, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tangwen-stats-" + (stats.today || "export") + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    try {
      var probe = await fetch("/api/admin/probe").then(function (r) { return r.json(); });
      if (probe && probe.configured === false) {
        $("loginTip").textContent = "服务器上还没配后台密钥（ADMIN_KEY），先配上再进。";
      }
    } catch (_) {}
    try { token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch (_) { token = ""; }
    if (!token) return;
    showApp(true);
    await loadAll();
    startAuto();
  })();
})();
