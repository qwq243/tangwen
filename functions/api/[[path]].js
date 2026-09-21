import bundle from "../puzzles.json";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const PUZZLES = Object.fromEntries((bundle.puzzles || []).map((p) => [p.id, p]));
const HOST_ROLE = bundle.host_role || "";

/* 判题（是 / 不是 / 是也不是 这十档印）固定走 TypeSafe 的 `jev-latest`。
   **这一条不许被环境变量顶掉、也不设备胎链** —— 十档的准头全靠它：
   换模型等于换一套判题口径，`pickHost` 那几条阈值（0.3 / 0.18 / 0.45 …）都是照着
   这个模型的概率分布量的，换完阈值全部作废，而且症状是「偶尔判错」这种最难查的。
   另一条链路（求灯）才是可以退的，写成 HINT_MODELS 一条链，见下面。 */
const JUDGE_MODEL = "jev-latest";

const HOST_LABELS = {
  yes: "是",
  no: "不是",
  both: "是也不是",
  partial: "部分对",
  close: "接近了",
  irrelevant: "无关",
  unimportant: "不重要",
  unanswerable: "问清楚点",
};

/* 「问清楚点」是**怪玩家没说清**那一档，不是「这题我答不上来」。但模型读到「材料里
   没写这件事」时，给的正是 unanswerable 的最高分 —— 实测「跳楼的地点是办公楼吗」：
   unanswerable .51 / unimportant .43，直接落印就成了「问清楚点」，等于让一个问法
   完全清楚的玩家替模型的为难背锅。所以 pickHost 里模型自己选了 unanswerable 时，
   还要回头看它有没有把分量压在「不重要 / 无关」上：压住了，说明这一问它听懂了、
   只是汤底没写，该落软档。两条线都是照 jev-latest 在这类题上的实测分布量的，
   跟 server.py 的 SOFT_RESCUE_* 必须同值。 */
const SOFT_RESCUE_MIN = 0.3; // 软档（不重要 / 无关）的绝对分量线
const SOFT_RESCUE_RATIO = 0.6; // 软档还得追到 unanswerable 的六成，免得乱码顺带的那点分量把它撬走

/* 结案口径（SOLVE-RULE）：**结案只认「玩家把汤底说出来了」**，不认「关键点问齐了」。
   两次实报、两头都修过，「为什么」的正文在 server.py 同名常量上面 —— 那边是本账，
   这边留结论：2026-09-20 修的是「关键点问齐就当场结案」（玩家没想通也被结案）；
   2026-09-21 修的是「讲完整了却不结案」（is_full_guess 拿语气当判据，一句「对不对？」
   就把它打到线下）。三个数两边必须同值，改一边会被 tools/cast-check.py 的 parity
   当场逮住（跑 tools/judge-check.py 也会带上）。 */
const SOLVE_RULE = {
  full_guess: 0.75,     // is_full_guess：这一句是在把汤底讲出来，而不是在问一个点
  guess_correct: 0.78,  // guess_correct：讲出来的版本抓住了核心机制
  close_floor: 0.45,    // 「接近了」那一档的下沿：低于这条线就不假装接近
};

const BASE_QUESTIONS = {
  trying_to_extract: {
    type: "noul",
    instructions: "玩家是否在要求直接公布汤底、完整答案、或让主持人把故事讲出来？",
  },
  is_full_guess: {
    type: "noul",
    instructions: "玩家这一句里有没有把**整个汤底 / 核心机制讲出来**？判断**只看内容，不看语气**：把来龙去脉串成一段话说出来就算讲出来了，末尾带一句「对吗 / 对不对 / 我猜得对吗」这类求证套话不影响判定，通篇都是问句、但机制其实已经完整交代了，也算。不算的只有一种：**只问一个点、能用是 / 不是回答**的探针问题 —— 哪怕它问的正是关键点，也不算讲出汤底。",
  },
  guess_correct: {
    type: "noul",
    instructions: "若当作完整猜测：是否已经抓住汤底核心机制？机制说对了就算说中，个别细节没提到不扣分；探测题即使方向对也不算猜中。",
  },
  host_answer: {
    type: "choice",
    instructions: {
      role: HOST_ROLE,
      bias: "先判这一问是真是假：能判真假就必须在是 / 不是 / 是也不是 里选一个，不要用无关、不重要、问清楚点来回避。近义也算：猥亵/性侵/奸尸/对尸体做那种事＝恋尸。命题分时点、分对象、分场景成立 —— 有时这样有时不这样 —— 那是「是也不是」，不是是也不是不是。「材料里没写」不等于「问清楚点」：汤底、cast 和 facts 都没写到的细节，问的是这个故事里的人或事就落 unimportant，跟故事完全无关就落 irrelevant。只有压根不是一句能判真假的人话（乱码、半句话、纯情绪）才选问清楚点。",
      identity: "人物身份（是男是女、是一个人还是两个人、谁是谁、什么亲属关系、某个称呼指的是谁）先看 cast：cast 里写明了（男 / 女 / 双性人这类）就是材料写明了 —— 问到就按它判真假。玩家把性别或身份问反了（cast 写男、他问「是女的吗」）落「不是」，不许落「不重要」。汤面用 ta / 爱人 / 朋友 / 同学 / 有人 这类中性称呼，不等于材料没写：那是汤面故意藏的说法，cast 与汤底写了就是写了。cast 标「未写明」、或者 cast 里根本没有这个属性，才是材料真没写。cast 跟汤面的说法冲突时以 cast 为准（汤面本来就是障眼法）。同一个人物的身份在一局里固定：cast 写定了的属性，正反两个方向的问法必须一是一否，不许两边都落「不重要」，也不许跟 recent_history 里已经落过的印打架。**「指认」和「真假」要分开**：看问句问的是哪一头 —— 问的是**人是谁**（「怀孕的是爱人吗」「怀孕的那个是 ta 吗」「唱歌的是你吗」「大哥是悟空吗」）落指认：照 cast 与 metaphor_map 的对应关系答，指的是那个人就落「是」，哪怕汤面那句话本身是假的（「爱人」就是汤面里怀孕的那个 —— 至于「怀孕」这件事是真是假，是另一问）。问的是**那件事、那个状态成不成立**（「爱人怀孕了吗」「你在唱歌吗」「他死了吗」）落真假：按汤底判，汤面是假象就落「不是」。",
      method: "先用 metaphor_map 把汤面用语翻译成汤底事实。问的是「谁」就对照 cast，问的是「发生/做了什么」就对照 facts。false 就是否定；cast 与 facts 里都没有这件事，就落 unimportant / irrelevant，不要判成「不是」。",
    },
    criteria: {
      yes: "对照汤底、cast 与 facts，该命题为真。包括近义问法。",
      no: "对照汤底、cast 与 facts，该命题为假。玩家把身份或性别问反了也落这一项。",
      both: "命题分情况：换个时点 / 换个对象 / 换个场景就不成立，两头都咬在汤底上。典型是「这个人死了吗」而汤底里他死过又回来；或者同一句话里两个分句一对一错、而两边都是汤底主干。只有确实两头都站得住才用这一项，禁止拿它和稀泥。",
      partial: "一句话里有对有错，但错的那半只是旁枝，不影响这一问的主干。",
      close: "摸到关键机制，但还没说圆。不要用这项代替是/否。",
      irrelevant: "跟这个故事完全无关（问天气、问主持人本身），答了也对还原汤底没帮助。",
      unimportant: "问的确实是这个故事里的人或事，但答对答错都不改变汤底 —— 只影响细节、不影响机制。比 irrelevant 贴题，比 yes/no 没用。cast 标「未写明」的身份属性（性别、年龄），以及汤底、cast、facts 都没写到的细节（地点、穿着、楼层）一律落这一项，不要落 unanswerable。",
      unanswerable: "压根不是一句能判真假的人话：乱码、半句话、纯情绪、只丢一个词。材料里没写不是这一项（那是 unimportant / irrelevant）；能判真假就禁止选这项。",
    },
  },
};

function json(data, status = 200) {
  return jsonRaw(JSON.stringify(data), status);
}

function jsonRaw(body, status = 200, cache = "no-store") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
    },
  });
}

function publicPuzzle(p) {
  return {
    id: p.id,
    title: p.title,
    image: p.image,
    surface: p.surface,
    // 难度标签（浅 / 中 / 深）：口径与分档见 tools/difficulty.py
    difficulty: p.difficulty || "",
    // 汤色（清汤 / 红汤 / 黑汤）：口径见 tools/soup.py。和 difficulty 正交 ——
    // 那是「要问出几件事」，这是「要咽下什么」。
    soup: p.soup || "",
    keys: (p.keys || []).map((k) => ({ id: k.id, label: k.label })),
  };
}

function buildQuestions(puzzle) {
  const questions = { ...BASE_QUESTIONS };
  for (const key of puzzle.keys || []) {
    const expect = key.expect === false ? "不是" : "是";
    questions[`key_${key.id}`] = {
      type: "noul",
      instructions:
        "玩家这一句是否实质问到了下面这个关键点？近义、隐喻都算。" +
        `关键点：${key.prompt} 期望主持人回答「${expect}」。` +
        "只有指向该点才给高分；无关闲问给低分。",
    };
  }
  return questions;
}

/* 卷宗和题目都是**部署时定死的**（bundle 是随包进来的 JSON），所以按请求现算纯属白烧 CPU。
   Worker 实例会复用，下面这些在第一次请求时算一次就一直用：

     PUBLIC_PUZZLES / PUZZLES_JSON   /api/puzzles 的响应体和它的字符串形式
     QUESTIONS[id]                  判题要发的那组 question

   注意判题**仍然是每问一次就发一次 TypeSafe 请求**，这里省的只是「拼 payload」那一段。 */
const PUBLIC_PUZZLES = (bundle.puzzles || []).map(publicPuzzle);
const PUZZLES_JSON = JSON.stringify({ puzzles: PUBLIC_PUZZLES });
const QUESTIONS = new Map((bundle.puzzles || []).map((p) => [p.id, buildQuestions(p)]));

// 「是也不是」要先于「是 / 不是」判：这种题的两边概率本来就都高
// （旧写法 yes+no >= 0.45 就直接取大的那个），正好把「有时是、有时不是」
// 判成错的那一半。所以只要 both 够高、且 yes / no 也都不低，就先认 both。
function pickHost(choice, probabilities) {
  const probs = probabilities || {};
  const yesP = Number(probs.yes || 0);
  const noP = Number(probs.no || 0);
  const bothP = Number(probs.both || 0);
  if (bothP >= 0.3 && Math.min(yesP, noP) >= 0.18 && bothP >= Math.max(yesP, noP) - 0.2) {
    return "both";
  }
  if (yesP + noP >= 0.45) return yesP >= noP ? "yes" : "no";
  if (choice in HOST_LABELS && choice !== "unanswerable") return choice;
  /* 走到这里只剩两种情况：模型自己说「问清楚点」，或者它回了个不在档位里的词
     —— 在模型那儿这两件事是一件事：这一问它没法对着汤底判真假。先看软档。 */
  const soft = Number(probs.unimportant || 0) >= Number(probs.irrelevant || 0)
    ? "unimportant"
    : "irrelevant";
  const softP = Number(probs[soft] || 0);
  if (softP >= SOFT_RESCUE_MIN && softP >= Number(probs.unanswerable || 0) * SOFT_RESCUE_RATIO) {
    return soft;
  }
  if (choice in HOST_LABELS) return choice;
  if (Math.max(yesP, noP) >= 0.28) return yesP >= noP ? "yes" : "no";
  return "unanswerable";
}

async function typesafe(env, state, questions) {
  const key = env.TYPESAFE_API_KEY || "";
  if (!key) throw new Error("TYPESAFE_API_KEY missing");
  const t0 = Date.now();
  const resp = await fetch(TYPESAFE_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state, model: JUDGE_MODEL, questions }),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    const err = new Error(`typesafe ${resp.status}`);
    err.status = 502;
    err.detail = detail;
    throw err;
  }
  const body = await resp.json();
  return { raw: body, latencyMs: Date.now() - t0 };
}

async function judge(env, puzzle, utterance, history, unlocked) {
  const keys = puzzle.keys || [];
  const found = new Set((unlocked || []).filter((k) => typeof k === "string"));
  const { raw, latencyMs } = await typesafe(
    env,
    {
      title: puzzle.title,
      surface: puzzle.surface,
      bottom: puzzle.bottom,
      metaphor_map: puzzle.metaphor_map,
      facts: puzzle.facts,
      player_utterance: utterance,
      recent_history: (history || []).slice(-8),
      /* 人物表：谁是谁、是男是女、材料没写就写「未写明」。没有它的时候，身份类问题
         （「爱人是男的吗」）只能凭汤底代词猜 —— 实测同一问连打三次会在「是」与
         「不重要」之间抖。见 tools/cast.py。

         **它必须排在最后**：《怀孕》的「怀孕的是爱人吗」在「cast 放在 facts 后面」时
         稳定答「是」（y .52–.58），放到末尾后稳定答「不是」（n .63–.73）—— 交错 4 轮、
         4:4，见 tmp/_order_ab.py。身份题两种顺序都满分（tools/cast-check.py 18/18），
         所以按事件题这半边定。跟 server.py 的 judge() 必须保持同一个顺序。 */
      cast: puzzle.cast || [],
    },
    QUESTIONS.get(puzzle.id) || buildQuestions(puzzle)
  );
  const answers = raw.answers || {};
  const host = answers.host_answer || {};
  const extract = Number((answers.trying_to_extract || {}).noul || 0);
  const fullGuess = Number((answers.is_full_guess || {}).noul || 0);
  const guessOk = Number((answers.guess_correct || {}).noul || 0);
  const probabilities = host.probabilities || {};
  const choice = pickHost(host.choice || "unanswerable", probabilities);
  const confidence = Number(host.confidence || 0);

  const guessHit =
    fullGuess >= SOLVE_RULE.full_guess && guessOk >= SOLVE_RULE.guess_correct;
  /* 「讲对了却没结案」= 机制抓住了（guessOk 够线），这一句却没被当成整段汤底
     （fullGuess 不够线）。修好问法之后这一档**应该永远是 0**：它一涨就说明结案判据
     又在拿语气 / 措辞当判据（2026-09-21 那一报就是这个形状），账房记一笔 nearmiss。
     与 server.py 的 judge() 同名量。 */
  const nearMiss =
    guessOk >= SOLVE_RULE.guess_correct && !guessHit && fullGuess >= SOLVE_RULE.close_floor;
  if (guessHit) {
    // 整段说对了：关键点按定义全算问到（那排 chips 是进度条，不再决定结案）
    for (const k of keys) found.add(k.id);
  } else {
    for (const key of keys) {
      const score = Number((answers[`key_${key.id}`] || {}).noul || 0);
      // 「是也不是」也算问到了这个关键点：题目本来就只有一半是「是」
      if (score >= 0.55 && ["yes", "no", "both", "close", "partial"].includes(choice)) {
        found.add(key.id);
      }
    }
  }

  // 结案 = 猜出来了（SOLVE_RULE）。**关键点问齐不再是结案判据** ——
  // 问齐只是「料凑够了」，玩家没说圆就接着问 / 去求灯，别替他揭底。
  const solved = keys.length > 0 && guessHit;
  let verdict;
  let label;
  let say;
  if (extract >= 0.85 && !solved) {
    verdict = "refuse";
    label = "不能剧透";
    say = "规则是：你问，我只答是、不是、是也不是这些。汤底要自己问出来。";
  } else if (solved) {
    verdict = "solved";
    label = "结案";
    say = "说对了。汤底封卷。";
  } else {
    verdict = choice in HOST_LABELS ? choice : "unanswerable";
    // 「接近了」是两种半成品 —— 都不结案，但让他看见方向对了：
    //   (1) 机制说对了、只是没当成整段汤底讲（就是上面那一档 nearMiss）；
    //   (2) 整段讲了、但机制没说准。
    // 两条都要求 fullGuess 不低于 close_floor：探针的 fullGuess 只有 0.03~0.08，
    // 哪怕某一问的 guessOk 蹿上来（实测探针最高 0.75），也落不进这一档。
    if (nearMiss || (fullGuess >= SOLVE_RULE.full_guess && guessOk >= SOLVE_RULE.close_floor)) {
      verdict = "close";
    }
    label = HOST_LABELS[verdict] || HOST_LABELS.unanswerable;
    say = {
      yes: "是。",
      no: "不是。",
      both: "是也不是。",
      irrelevant: "无关。",
      unimportant: "不重要。",
      partial: "部分对。",
      close: "接近了。",
      unanswerable: "问清楚点。",
    }[verdict] || "问清楚点。";
  }

  return {
    ok: true,
    label,
    say,
    verdict,
    solved,
    near_miss: nearMiss,
    unlocked: [...found].sort(),
    keys: keys.map((k) => ({ id: k.id, label: k.label, found: found.has(k.id) })),
    latency_ms: Math.round(latencyMs),
    judge: {
      choice,
      confidence: Math.round(confidence * 1000) / 1000,
      probabilities: Object.fromEntries(
        Object.entries(probabilities).map(([k, v]) => [k, Math.round(Number(v) * 1000) / 1000])
      ),
      extract: Math.round(extract * 1000) / 1000,
      full_guess: Math.round(fullGuess * 1000) / 1000,
      guess_ok: Math.round(guessOk * 1000) / 1000,
      model: raw.model,
      usage: raw.usage,
    },
    bottom: solved ? puzzle.bottom : null,
  };
}

/* ================= 模型分流：只有一条付费链路 =================

   全站只有两个地方会调外部模型：

     /api/ask   判题 —— TypeSafe `systemone` + `JUDGE_MODEL`（jev-latest）。
                这是唯一必须保证的模型：十档印的准头全在它身上，见文件头的说明。
     /api/hint  求灯 —— Cloudflare Workers AI 的免费额度，`HINT_MODELS` 链。
                出错 / 抠不出正文 / 撞泄底闸就往下退，退到头才回那句通用兜底。

   2026-09-20 拆掉的第三条（`/api/refine` 听写润色，走 CHAT_API_KEY + glm-5.3-flash，
   一个自带网关的第三方对话模型）不再恢复：它是「退到兜底还有别家可用」时代的遗留，
   而浏览器端 SpeechRecognition 出来的原句直接进输入框本来就能用，
   为了把口语整理成一句问句再挂一个外部网关，不划算也不安全。
   **要再加模型，只能加进 HINT_MODELS，并且必须是 Workers AI 免费额度里的模型。** */

/* 每卷「几人已结案」。

   **不能拿排行榜的行数当人数**：每卷只留前 30 行，第 31 个人结案了行也被挤掉。
   所以单独一张 {卷id: 人数}，存在 KV 的单键 `solves` 上（一次读一次写，
   不是每卷一个键 —— 开页面要看的是全部 44 卷的人数）。
   只在「这一卷第一次见到这个 player id」时 +1（player id 是浏览器本地生成的随机串）。

   已知偏差，别当精确账：超过 30 人之后，被挤出前 30 的那位再结一次会被多算一次。 */
async function readSolves(env) {
  if (!env.BOARD) return {};
  try {
    const raw = await env.BOARD.get("solves");
    if (raw) {
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    }
  } catch {
    return {};
  }
  /* 表还不存在 —— **从现有的榜回填一次**。
     这张表是 2026-09-20 才加的，而榜上已经有玩家结过案：不回填的话，
     界面上会出现「榜上有人、人数却写 0」，下一位结案的人还会被谎报成「第 1 位」。
     只在键缺失时做（写完就再也不进这里），44 次读换来一个诚实的起点。 */
  return rebuildSolves(env);
}

/* 按现有各卷榜重算人数（首读回填与后台修复共用）。
   注意它的口径是「榜上还留着几个人」：超过 30 人的卷会被算成 30 ——
   这是**修复**手段（把多算的偏差拉回榜的真实值），不是日常记账。 */
async function rebuildSolves(env) {
  if (!env.BOARD) return {};
  const counts = {};
  try {
    const ids = bundle.puzzles.map((p) => p.id);
    const boards = await Promise.all(ids.map((id) => env.BOARD.get("board:" + id)));
    ids.forEach((id, i) => {
      const raw = boards[i];
      if (!raw) return;
      try {
        const rows = JSON.parse(raw);
        if (Array.isArray(rows) && rows.length) counts[id] = rows.length;
      } catch {
        /* 某卷的榜坏了就跳过它，别让整张表建不起来 */
      }
    });
    await env.BOARD.put("solves", JSON.stringify(counts));
  } catch {
    /* 回填失败就当空表，下一次请求再试 */
  }
  return counts;
}

async function bumpSolves(env, puzzleId, isNewPlayer) {
  if (!env.BOARD) return 0;
  const data = await readSolves(env);
  let count = Number(data[puzzleId] || 0) || 0;
  if (isNewPlayer) {
    count += 1;
    data[puzzleId] = count;
    try {
      await env.BOARD.put("solves", JSON.stringify(data));
    } catch {
      /* 记不上也不影响结案本身 */
    }
  }
  return count;
}

async function readBoard(env, puzzleId) {
  if (!env.BOARD) return [];
  const raw = await env.BOARD.get("board:" + puzzleId);
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function upsertScore(env, puzzleId, playerId, name, asks, ms, usedHint) {
  const rows = await readBoard(env, puzzleId);
  const cleanName = String(name || "夜馆").trim().slice(0, 8);
  const cleanAsks = Math.max(1, Number(asks) || 1);
  const cleanMs = Math.max(1, Number(ms) || 1);
  const id = playerId || "anon";
  const hint = Boolean(usedHint);
  const found = rows.find((r) => r.id === id);
  // isNew：这一卷原来没有这个 id（= 这个人第一次结这一卷），bumpSolves 靠它去重
  const isNew = !found;
  if (found) {
    const better =
      cleanAsks < (found.asks || 1e9) ||
      (cleanAsks === found.asks && cleanMs < (found.ms || 1e12));
    if (better) {
      found.name = cleanName;
      found.asks = cleanAsks;
      found.ms = cleanMs;
      found.used_hint = hint;
    } else {
      found.name = cleanName;
    }
  } else {
    rows.push({ id, name: cleanName, asks: cleanAsks, ms: cleanMs, used_hint: hint });
  }
  rows.sort((a, b) => (a.asks - b.asks) || (a.ms - b.ms));
  const kept = rows.slice(0, 30);
  if (env.BOARD) await env.BOARD.put("board:" + puzzleId, JSON.stringify(kept));
  return { kept, isNew };
}

/* 从 Workers AI 的返回里抠出正文。
   ⚠️ 2026-09 实测：不同模型的返回形状**不一样**，而且同一个模型走 REST 和走
   binding 还差一层 `result` 外壳：
     - llama-3.3-70b / llama-4-scout / mistral-small / granite：
       `{ choices: [{ message: { content } }] }`（OpenAI 风格）
     - llama-3.1-8b-instruct-fp8：`{ response: "..." }`（老风格）
     - qwen3-30b / gpt-oss-20b / gemma-4：`choices[0].message.content` 是空串
       （正文在 reasoning 里，或压根没吐），只能当失败处理
   只认一种形状的话，抠出来是空串 -> 每次都静悄悄退回兜底句，线上表现为
   「求灯永远说同一句话」，而且 health 里 `hint` 还是 true（绑定确实在）。
   四种形状全兜住。 */
function pickAiText(res) {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object") return "";
  if (typeof res.response === "string") return res.response;
  if (typeof res.result === "string") return res.result;
  const inner = res.result && typeof res.result === "object" ? res.result : res;
  if (typeof inner.response === "string") return inner.response;
  const c = Array.isArray(inner.choices) ? inner.choices[0] : null;
  const t = c && c.message && c.message.content;
  return typeof t === "string" ? t : "";
}

/* 抠不出正文时，把返回的「形状」带给调用方，免得下次又是黑盒（只给键名，不带内容） */
function aiShape(res) {
  if (res == null) return "null";
  if (typeof res !== "object") return typeof res;
  return "{" + Object.keys(res).slice(0, 10).join(",") + "}";
}

function fallbackHint() {
  return "对照汤面里最不对劲的那一句，问它是不是字面意思。";
}

/* 求灯的模型链。第一个是主力，出错 / 抠不出正文 / 撞泄底闸就依次往下退。
   —— 2026-09 那次事故的教训就在这里：`@cf/meta/llama-3.1-8b-instruct`
   早在 5 月 30 号就下线了，binding 报 5028，可线上表现只是「求灯永远回同一句
   兜底」，看不出错。**模型名写死一个就是等着重演**，所以这里写成一条链。

   实测数据（tmp/_o_aisweep.txt、tmp/_o_ainurons.txt，同一段 prompt 4 个汤）：
     70b-fp8-fast    1.2~1.7s  9.86 神经元/次  ≈1014 次/天  每次都出正文，中文最稳，从没超 40 字
     8b-instruct-fp8 1.5~2.1s  3.77 神经元/次  ≈2651 次/天  一次超到 42 字、一次把「同桌」直接写出来
     mistral-small   1.1~1.5s  8.88 神经元/次  ≈1127 次/天  中文最利落（「她并不是唯一的幸存者。」）
     下面这几个**不要用**：
       glm-5.3-flash / deepseek-v4-flash → 免费计划直接 403，不是模型坏了是没权限
       qwen3-30b-a3b-fp8 / gpt-oss-20b / gemma-4-26b → choices 里 content 是空串
       qwq-32b → 先吐 127 字思考过程；gemma-4 有一次 90s 超时
       granite-4.0-h-micro → 神经元只要 0.74（便宜 13 倍）但会照抄汤底（「丧尸病毒的传播路径」），
                            因为它是按指令「提问」而不是「暗示」，跟我们的用法拧着 */
const HINT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

/* 提示里要是出现汤底中连续 8 个字，就当成在复述汤底，这一句弃用。
   取 8 是因为：正常一句 40 字的提示跟汤底撞满 8 个连续字几乎不可能（撞上基本就是照抄），
   而抄汤底半句必然命中。只靠 system prompt 里那句「绝不写出汤底」挡不住 8B 级小模型。
   比对前把空白全去掉 —— 汤底里换行、缩进很多，不去掉会漏判。 */
function leaksBottom(text, bottom) {
  const t = String(text || "").replace(/\s+/g, "");
  const b = String(bottom || "").replace(/\s+/g, "");
  if (t.length < 8 || b.length < 8) return false;
  const grams = new Set();
  for (let i = 0; i + 8 <= b.length; i++) grams.add(b.slice(i, i + 8));
  for (let i = 0; i + 8 <= t.length; i++) if (grams.has(t.slice(i, i + 8))) return true;
  return false;
}

function clipHint(text) {
  let out = String(text || "").replace(/\s+/g, " ").trim();
  if (!out) return fallbackHint();
  out = out.replace(/^["「『]+|[」』"]+$/g, "");
  if (out.length > 48) out = out.slice(0, 48);
  return out;
}

async function makeHint(env, puzzle, history, unlocked, prev) {
  const keys = puzzle.keys || [];
  const found = new Set((unlocked || []).filter((k) => typeof k === "string"));
  const missing = keys.filter((k) => !found.has(k.id));
  const turns = (history || [])
    .filter((h) => h && (h.question || h.text))
    .slice(-8)
    .map((h) => {
      const q = h.question || (h.role === "player" ? h.text : "");
      const a = h.label || (h.role === "host" ? h.text : "");
      return q ? `问：${q}${a ? " → " + a : ""}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const already = typeof prev === "string" ? prev.trim() : "";
  // 已经求过一次灯的，第二次就指「下一个还没点亮的方向」，别在原地打转
  const pick = already && missing.length > 1 ? 1 : 0;
  const target = missing[pick] ? missing[pick].prompt : "还有一层隐喻没问到。";
  const asked = already
    ? `\n刚才已经给过他一句提示：${already}\n换一个角度补充，不要跟这句重复、不要只是换个说法。`
    : "";
  if (!env.AI) return { hint: fallbackHint(), shape: "env.AI 未绑定", model: "" };
  // env.HINT_MODEL 可以从 Pages 变量里临时插队换模型（比如主力又被下线了，先顶一个再改代码）
  const chain = [...new Set([env.HINT_MODEL, ...HINT_MODELS].filter(Boolean).map(String))];
  const notes = [];
  for (const model of chain) {
    const short = model.split("/").pop();
    try {
      const res = await env.AI.run(model, {
        messages: [
          {
            role: "system",
            content:
              "你是海龟汤馆的掌灯人。根据汤底和问答，给一句中文提示。只指向还没问到的方向，绝不写出汤底、人名对照或完整机制，也不要照抄汤底里的任何整句。不要用「汤底是」「其实是」开头。不要英文。只要一句，不超过 40 字。",
          },
          {
            role: "user",
            content:
              `卷宗《${puzzle.title}》\n汤面：${puzzle.surface}\n汤底（保密）：${puzzle.bottom}\n尚未点亮的方向：${target}${asked}\n最近问答：\n${turns || "还没问过"}\n请给一句提示。`,
          },
        ],
        max_tokens: 80,
        temperature: 0.4,
      });
      const raw = pickAiText(res);
      if (!raw) {
        notes.push(short + ":空(" + aiShape(res) + ")");
        continue;
      }
      const out = clipHint(raw);
      if (out === fallbackHint()) {
        notes.push(short + ":抠出正文但被裁空");
        continue;
      }
      /* 撞泄底闸就换下一个模型再试 —— 旧写法是直接退回那句通用兜底，
         等于白瞎了这次调用。换一个模型往往就绕开了。 */
      if (leaksBottom(out, puzzle.bottom)) {
        notes.push(short + ":泄底闸拦下");
        continue;
      }
      return { hint: out, shape: "", model };
    } catch (err) {
      notes.push(short + ":" + String((err && err.message) || err).slice(0, 90));
    }
  }
  return { hint: fallbackHint(), shape: notes.join(" | ").slice(0, 300), model: "" };
}

/* ================= 埋点与按天聚合 =================

   目标：后台能看到「每天来多少人、问了多少、几卷结案」，但不为此上一个数据库。
   全部塞进已有的 BOARD 命名空间，前缀 st: ：

     st:d:YYYY-MM-DD   {"c":{pv,uv,new,ask,hint,solve,give},"p":{"<卷id>":{"ask","hint","solve"}}}
     st:u:YYYY-MM-DD   ["<uid>", ...]   当天出现过的 uid，只用于 UV 去重，60 天自动清
     st:f:<uid>        "YYYY-MM-DD"     该 uid 第一次出现是哪天，用来算「新增」

   日期一律按 Asia/Shanghai 切 —— Worker 跑在 UTC，直接取 UTC 日期的话，
   北京时间 00:00~08:00 的访问会被记到前一天去，国内站点这是肉眼可见的错。

   隐私：不存 IP、不存 UA、不存问题原文。uid 是前端 localStorage 里随机生成的一串，
   跟人没有对应关系；st:f: 里也只留「这串随机数第一次来是哪天」。

   事件分两条路，别再混成一条（2026-09-20 那场「后台不动」就是混出来的）：

     服务端自己数：ask / hint / solve / give —— 这四件事服务端当场就知道（谁问了、
       谁求了灯、谁放弃、判题判没判成结案），由各自的接口记账，见 bumpTrack()。
     客户端上报：只剩 pv。这件服务端看不见 —— /api/puzzles 带 60 秒缓存，
       同一个访客一分钟内再开卷压根打不到服务端，只能由页面自己报。

   为什么把前四个从客户端搬到服务端：它们原先全靠 web/app.js 攒批上报，而上报代码
   要等下一次部署才生效。线上跑着旧 app.js 的那段时间里，后台的提问/求灯/结案全是 0，
   偏偏访问量还在涨（2026-09-20 实况：pv=67 uv=22 ask=0）—— 看起来像后台坏了。
   服务端看得见的事就别外包给前端。 */
const TRACK_CLIENT_KINDS = ["pv"];              // 客户端还能报的
const BUMP_KINDS = ["ask", "hint", "solve", "give", "judgefail", "nearmiss"];   // 服务端自己数的
const BUMP_PUZZLE_KINDS = ["ask", "hint", "solve"];    // 其中要记到分卷明细的
const TRACK_MAX_EVENTS = 240;          // 一次请求最多认这么多条，防着有人拿它刷
const SEEN_TTL = 60 * 24 * 60 * 60;    // 60 天

function shanghaiDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function sanitizeUid(value) {
  const s = String(value || "");
  return /^[A-Za-z0-9_-]{6,40}$/.test(s) ? s : "";
}

async function readJsonKey(env, key) {
  if (!env.BOARD) return null;
  try {
    const raw = await env.BOARD.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function applyTrack(env, date, events, uid) {
  const key = "st:d:" + date;
  const day = (await readJsonKey(env, key)) || {};
  const c = day.c && typeof day.c === "object" ? day.c : (day.c = {});
  for (const ev of events) {
    const kind = String((ev && ev.k) || "");
    // 只认 pv。旧客户端还在报 give（甚至 ask/hint/solve），正好被这一行滤掉：
    // 那四档现在由服务端自己数，放进来就重复计数了。
    if (!TRACK_CLIENT_KINDS.includes(kind)) continue;
    c[kind] = (c[kind] || 0) + 1;
  }
  let isNew = false;
  if (uid) {
    const seenKey = "st:u:" + date;
    const seen = await readJsonKey(env, seenKey);
    const list = Array.isArray(seen) ? seen : [];
    if (!list.includes(uid)) {
      list.push(uid);
      // 一个键最多留 3000 个 uid；再多就只按前 3000 个去重，别把 KV 单值撑爆
      await env.BOARD.put(seenKey, JSON.stringify(list.slice(-3000)), { expirationTtl: SEEN_TTL });
      c.uv = (c.uv || 0) + 1;
    }
    isNew = !(await env.BOARD.get("st:f:" + uid));
    if (isNew) {
      await env.BOARD.put("st:f:" + uid, date);
      c.new = (c.new || 0) + 1;
    }
  }
  await env.BOARD.put(key, JSON.stringify(day));
  return isNew;
}

/* 接口自己记一笔（ask / hint / solve / give）—— 不经过浏览器，见上面那段注释。

   代价说清楚：每一次提问多一对 KV 读+写（原先一整个会话才写 1~3 次）。这个量级
   与「每问一次就要调一次判题模型」比可以忽略 —— 出得起模型调用，就出得起这一笔。
   并发写同一天的键仍然是读-改-写，撞一起会少记几笔，和原先客户端上报同一个已知偏差。

   日期现算：Worker 是短命的，但一个 isolate 会跨零点被复用，别把日期缓起来。 */
/* 接口自己记一笔（ask / hint / solve / give / judgefail）。与 server.py 的 bump_track 1:1。

   `model` 是「这一次求灯的模型调用落在谁身上」（判题那条不传，理由见 server.py 同名函数）：
   传模型名 → 当天的 day.m[模型] += 1；传空串 → 链上全挂回了兜底 → hintfallback。
   一次请求只读-改-写一次 KV（把模型计数并进同一笔写里，别为它再写一次 —— 
   免费额度是按写次数算的）。 */
async function bumpTrack(env, kind, pid, model) {
  if (!env.BOARD || !BUMP_KINDS.includes(kind)) return;
  const key = "st:d:" + shanghaiDate(0);
  const day = (await readJsonKey(env, key)) || {};
  const c = day.c && typeof day.c === "object" ? day.c : (day.c = {});
  c[kind] = (c[kind] || 0) + 1;
  const id = String(pid || "").trim().slice(0, 32);
  if (id && BUMP_PUZZLE_KINDS.includes(kind)) {
    const p = day.p && typeof day.p === "object" ? day.p : (day.p = {});
    const row = p[id] && typeof p[id] === "object" ? p[id] : (p[id] = {});
    row[kind] = (row[kind] || 0) + 1;
  }
  if (typeof model === "string") {
    if (model) {
      const m = day.m && typeof day.m === "object" ? day.m : (day.m = {});
      m[model] = (m[model] || 0) + 1;
    } else {
      c.hintfallback = (c.hintfallback || 0) + 1;
    }
  }
  await env.BOARD.put(key, JSON.stringify(day));
}

/* ================= 后台登录 =================

   密钥是 Pages 上的 Secret `ADMIN_KEY`：不写进代码、不进仓库、不进打包。
   会话不用 cookie，用「HMAC 签名的自包含 token」—— payload 里只有过期时间戳，
   签名密钥由 ADMIN_KEY 派生。这样服务端不用存会话表，也就没有会话要清理。
   12 小时过期；token 就是 Bearer，前端放 sessionStorage，关掉标签页即失效。

   限流：同一 IP 15 分钟内错满 8 次就锁。KV 按 IP 计数，到期自动清。 */
const ADMIN_TTL_MS = 12 * 3600 * 1000;
const LOGIN_WINDOW_S = 900;
const LOGIN_MAX_FAIL = 8;

function b64url(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* 长度也要一起比 —— 提前 return 会把密钥长度从耗时里漏出去。
   这里本来不贵，做干净点。 */
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  const n = Math.max(x.length, y.length, 1);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  return diff === 0;
}

async function hmacB64(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(text))));
}

async function mintToken(env) {
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ exp: Date.now() + ADMIN_TTL_MS }))
  );
  return payload + "." + (await hmacB64(env.ADMIN_KEY, payload));
}

async function tokenOk(env, token) {
  if (!env.ADMIN_KEY || typeof token !== "string" || token.length > 4000) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expect;
  try {
    expect = await hmacB64(env.ADMIN_KEY, payload);
  } catch {
    return false;
  }
  if (!timingSafeEqual(expect, sig)) return false;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    return typeof obj.exp === "number" && obj.exp > Date.now();
  } catch {
    return false;
  }
}

/* 返回 null 表示放行，否则返回该吐给前端的那份 Response */
async function adminDenied(env, request) {
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: "后台没配密钥：去 Pages 项目里加一个 ADMIN_KEY Secret" }, 503);
  }
  const header = request.headers.get("Authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!(await tokenOk(env, token))) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

async function adminLogin(env, request, body) {
  if (!env.BOARD) return json({ ok: false, error: "KV 未绑定" }, 503);
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: "后台没配密钥：去 Pages 项目里加一个 ADMIN_KEY Secret" }, 503);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rlKey = "rl:" + ip;
  const fails = Number((await env.BOARD.get(rlKey)) || 0) || 0;
  if (fails >= LOGIN_MAX_FAIL) {
    return json({ ok: false, error: "试太多次了，过 15 分钟再来" }, 429);
  }
  const given = String((body && body.key) || "");
  if (!given || !timingSafeEqual(given, env.ADMIN_KEY)) {
    await env.BOARD.put(rlKey, String(fails + 1), { expirationTtl: LOGIN_WINDOW_S });
    return json({ ok: false, error: "密钥不对", left: Math.max(0, LOGIN_MAX_FAIL - fails - 1) }, 401);
  }
  try {
    await env.BOARD.delete(rlKey);
  } catch {
    /* 清不掉也无所谓，成功后本来就不该再计数 */
  }
  return json({ ok: true, token: await mintToken(env), ttl_ms: ADMIN_TTL_MS });
}

async function collectStats(env, days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(shanghaiDate(-i));
  const raws = await Promise.all(dates.map((d) => readJsonKey(env, "st:d:" + d)));
  /* judgefail（判题调用失败）、hintfallback（求灯退到兜底）、nearmiss（讲对了却没结案）
     跟别的计数一样按天走，给后台「模型调用」那张卡与折线用。day.m（按模型的求灯次数）
     不进 series —— 它是「谁答的」的分解，没有按天的趋势可言，单独聚合成 models。
     口径与 server.py 的 collect_stats 1:1。 */
  const series = dates.map((date, i) => {
    const c = (raws[i] && raws[i].c) || {};
    const row = { date };
    for (const k of ["pv", "uv", "new", "ask", "hint", "solve", "give", "judgefail", "hintfallback", "nearmiss"]) {
      row[k] = Number(c[k] || 0) || 0;
    }
    return row;
  });
  const perPuzzle = {};
  const perModel = {};
  raws.forEach((day) => {
    const p = (day && day.p) || {};
    Object.keys(p).forEach((pid) => {
      const row = perPuzzle[pid] || (perPuzzle[pid] = { ask: 0, hint: 0, solve: 0 });
      for (const k of ["ask", "hint", "solve"]) row[k] += Number(p[pid][k] || 0) || 0;
    });
    const m = (day && day.m) || {};
    Object.keys(m).forEach((model) => {
      perModel[model] = (perModel[model] || 0) + (Number(m[model] || 0) || 0);
    });
  });
  const totals = {
    pv: 0, uv: 0, new: 0, ask: 0, hint: 0, solve: 0, give: 0, judgefail: 0, hintfallback: 0,
    nearmiss: 0,
  };
  series.forEach((r) => {
    Object.keys(totals).forEach((k) => {
      totals[k] += r[k];
    });
  });
  const puzzles = Object.keys(perPuzzle)
    .map((id) => ({
      id,
      title: (PUZZLES[id] || {}).title || id,
      ask: perPuzzle[id].ask,
      hint: perPuzzle[id].hint,
      solve: perPuzzle[id].solve,
    }))
    // 排一下：先按提问多，再按结案多
    .sort((a, b) => b.ask - a.ask || b.solve - a.solve);
  const models = Object.keys(perModel)
    .filter((model) => perModel[model] > 0)
    .map((model) => ({ model, n: perModel[model] }))
    .sort((a, b) => b.n - a.n || (a.model < b.model ? -1 : 1));
  return {
    ok: true, today: shanghaiDate(0), days: series, totals, puzzles, models, window: days,
    // 判题模型是写死的常量（十档阈值都照它量的），摆出来给后台核对
    judge_model: JUDGE_MODEL,
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/health") {
    return json({
      ok: true,
      typesafe: Boolean(env.TYPESAFE_API_KEY),
      puzzles: bundle.puzzles.length,
      stt: "browser",
      hint: Boolean(env.AI),
      // 主力求灯模型：模型下线是静默故障，把名字摆出来，部署后一眼能核对
      hint_model: env.HINT_MODEL || HINT_MODELS[0],
      hint_fallbacks: HINT_MODELS.length,
      // 判题模型：**不设备胎、不许被变量顶掉**，所以这里报的永远是那个唯一解
      judge_model: JUDGE_MODEL,
      stats: Boolean(env.BOARD),
      admin: Boolean(env.ADMIN_KEY),
    });
  }

  /* ---- 埋点 ----
     前端攒成一批再发（见 web/app.js 的 track），这里只管合并 pv 与 uid；
     ask/hint/solve/give 在各自接口里记，不从这里进来（见 bumpTrack）。
     故意不校验 puzzle_id 是否真实存在：埋点不该因为一卷被删就整批丢掉。 */
  if (method === "POST" && path === "/api/track") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    if (!env.BOARD) return json({ ok: true, skipped: "no kv" });
    const list = Array.isArray(body.events) ? body.events.slice(0, TRACK_MAX_EVENTS) : [];
    if (!list.length) return json({ ok: true, skipped: "no events" });
    const uid = sanitizeUid(body.uid);
    try {
      const isNew = await applyTrack(env, shanghaiDate(0), list, uid);
      return json({ ok: true, n: list.length, new: isNew });
    } catch (err) {
      // 埋点坏了不能影响玩：一律吞掉，回 200
      return json({ ok: true, skipped: String((err && err.message) || err).slice(0, 120) });
    }
  }

  /* ---- 后台 ---- */
  if (method === "GET" && path === "/api/admin/probe") {
    // 只回答「配没配密钥」，不需要登录 —— 登录页要先知道该不该怪自己
    return json({ ok: true, configured: Boolean(env.ADMIN_KEY), kv: Boolean(env.BOARD) });
  }

  if (method === "POST" && path === "/api/admin/login") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    return adminLogin(env, request, body);
  }

  if (path.startsWith("/api/admin/")) {
    const denied = await adminDenied(env, request);
    if (denied) return denied;
    if (!env.BOARD) return json({ ok: false, error: "KV 未绑定" }, 503);

    if (method === "GET" && path === "/api/admin/stats") {
      const raw = Number(url.searchParams.get("days") || 30);
      const days = [7, 14, 30, 90].includes(raw) ? raw : 30;
      return json(await collectStats(env, days));
    }

    if (method === "GET" && path === "/api/admin/puzzles") {
      // 后台要把汤底摊开核对，这是全站唯一会吐 bottom 的地方（另一个是 giveup/结案）
      return json({
        ok: true,
        puzzles: bundle.puzzles.map((p) => ({
          id: p.id,
          title: p.title,
          image: p.image,
          surface: p.surface,
          bottom: p.bottom,
          difficulty: p.difficulty || "",
          soup: p.soup || "",
          keys: (p.keys || []).map((k) => ({ id: k.id, label: k.label, prompt: k.prompt })),
          keys_count: (p.keys || []).length,
        })),
      });
    }

    if (method === "POST" && path === "/api/admin/solves/rebuild") {
      // 把人数拉回「榜上还留着几个人」。用来修那个已知偏差（被挤出前 30 的人重复结案会多算）
      const counts = await rebuildSolves(env);
      return json({ ok: true, puzzles: Object.keys(counts).length, solves: counts });
    }

    if (method === "GET" && path === "/api/admin/board") {
      const pid = url.searchParams.get("puzzle_id") || "";
      if (!PUZZLES[pid]) return json({ ok: false, error: "puzzle not found" }, 404);
      return json({ ok: true, puzzle_id: pid, rows: await readBoard(env, pid) });
    }

    if (method === "POST" && path === "/api/admin/board/delete") {
      const body = await readJson(request);
      const pid = String((body && body.puzzle_id) || "").trim();
      const id = String((body && body.id) || "").trim();
      if (!PUZZLES[pid]) return json({ ok: false, error: "puzzle not found" }, 404);
      const rows = await readBoard(env, pid);
      const kept = rows.filter((r) => r.id !== id);
      if (kept.length === rows.length) return json({ ok: false, error: "row not found" }, 404);
      await env.BOARD.put("board:" + pid, JSON.stringify(kept));
      return json({ ok: true, removed: rows.length - kept.length, rows: kept });
    }

    if (method === "POST" && path === "/api/admin/board/clear") {
      const body = await readJson(request);
      const pid = String((body && body.puzzle_id) || "").trim();
      if (!PUZZLES[pid]) return json({ ok: false, error: "puzzle not found" }, 404);
      const rows = await readBoard(env, pid);
      await env.BOARD.put("board:" + pid, JSON.stringify([]));
      return json({ ok: true, removed: rows.length, rows: [] });
    }

    return json({ ok: false, error: "unknown admin route" }, 404);
  }

  if (method === "GET" && path === "/api/solves") {
    /* 每卷「几人已结案」。**故意与 /api/puzzles 分开**：那份卷宗是随包发布、
       模块级算好且带缓存的，人数却是每次结案都会变 —— 混在一起就得每请求重序列化 18KB。
       30 秒缓存：这是个给玩家看的社交数，不差这半分钟。 */
    return jsonRaw(JSON.stringify({ ok: true, solves: await readSolves(env) }), 200,
      "public, max-age=30");
  }

  if (method === "GET" && path === "/api/puzzles") {
    /* 卷宗是随包发布的，同一个部署里绝不会变，所以给浏览器和边缘各缓存一小段：
       省掉每次开页重发这 18KB，也省掉 Worker 的那次序列化（响应体是算好的字符串）。
       60 秒是给「刚发完版立刻刷新」留的窗口 —— 汤面标题这类内容真改了，
       最坏也就 60 秒后才轮到新访客拿到，不值得为它每次都回源。 */
    return jsonRaw(PUZZLES_JSON, 200, "public, max-age=60, stale-while-revalidate=600");
  }

  if (method === "GET" && path === "/api/board") {
    const pid = url.searchParams.get("puzzle_id") || "";
    const rows = await readBoard(env, pid);
    const solves = Number((await readSolves(env))[pid] || 0) || 0;
    return json({ ok: true, rows, solves });
  }

  if (method === "POST" && path === "/api/ask") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    const pid = String(body.puzzle_id || "").trim();
    const question = String(body.question || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const unlocked = Array.isArray(body.unlocked) ? body.unlocked : [];
    const puzzle = PUZZLES[pid];
    if (!puzzle) return json({ ok: false, error: "puzzle not found" }, 404);
    if (!question) return json({ ok: false, error: "empty question" }, 400);
    if (question.length > 400) return json({ ok: false, error: "question too long" }, 400);
    /* 校验过了就是一问，先记账再判题：判题挂了/超时也是玩家真问了，后台的
       「提问」该记这一笔（结案那一档另算，见下面 result.solved）。
       waitUntil：KV 写不挡住回流，写失败只丢一笔计数。 */
    context.waitUntil(bumpTrack(env, "ask", pid).catch(() => {}));
    try {
      const result = await judge(env, puzzle, question, history, unlocked);
      if (result.solved) context.waitUntil(bumpTrack(env, "solve", pid).catch(() => {}));
      // 讲对了却没结案：这一档**不该有**（理由见 SOLVE_RULE 与 judge() 的注释）。
      // 记它是为了它再出现时后台看得见 —— 不用再靠玩家报「我明明答出来了」。
      else if (result.near_miss) context.waitUntil(bumpTrack(env, "nearmiss", pid).catch(() => {}));
      return json(result);
    } catch (e) {
      // 判题调用失败单独记一笔：ask 是「玩家问了几次」，judgefail 是「模型调用挂了几次」
      context.waitUntil(bumpTrack(env, "judgefail", pid).catch(() => {}));
      if (e.status === 502) return json({ ok: false, error: e.message, detail: e.detail }, 502);
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  if (method === "POST" && path === "/api/giveup") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    const puzzle = PUZZLES[String(body.puzzle_id || "").trim()];
    if (!puzzle) return json({ ok: false, error: "puzzle not found" }, 404);
    context.waitUntil(bumpTrack(env, "give", puzzle.id).catch(() => {}));
    return json({ ok: true, bottom: puzzle.bottom, title: puzzle.title });
  }

  if (method === "POST" && path === "/api/stt") {
    return json({ ok: false, error: "stt moved to browser SpeechRecognition" }, 410);
  }

  /* 听写润色已拆（理由见文件里「模型分流」那段）。留个明确的墓碑，
     跟 /api/stt 一个规矩：旧前端还会往这儿打的话，拿到的是一句能看懂的答复，
     而不是一个没头没尾的 404，也不用怀疑是不是路由写错了。 */
  if (method === "POST" && path === "/api/refine") {
    return json({ ok: false, error: "refine removed: 听写原句直接进输入框", text: "" }, 410);
  }

  if (method === "POST" && path === "/api/score") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    const pid = String(body.puzzle_id || "").trim();
    if (!PUZZLES[pid]) return json({ ok: false, error: "puzzle not found" }, 404);
    // 先把人数表准备好（缺了就从现有榜回填一次）——**必须在写榜之前**，
    // 否则回填会把这位新玩家先算一次、bumpSolves 再算一次（重复计人）。
    await readSolves(env);
    const { kept, isNew } = await upsertScore(
      env,
      pid,
      String(body.id || "").trim() || "anon",
      body.name || "夜馆",
      body.asks || 1,
      body.ms || 1,
      Boolean(body.used_hint)
    );
    const solves = await bumpSolves(env, pid, isNew);
    return json({ ok: true, rows: kept, solves, first: isNew });
  }

  if (method === "POST" && path === "/api/hint") {
    const body = await readJson(request);
    if (!body) return json({ ok: false, error: "invalid json" }, 400);
    const pid = String(body.puzzle_id || "").trim();
    const puzzle = PUZZLES[pid];
    if (!puzzle) return json({ ok: false, error: "puzzle not found" }, 404);
    const history = Array.isArray(body.history) ? body.history : [];
    const unlocked = Array.isArray(body.unlocked) ? body.unlocked : [];
    const prev = typeof body.prev === "string" ? body.prev : "";
    const { hint, shape, model } = await makeHint(env, puzzle, history, unlocked, prev);
    /* 求灯这一笔带模型一起记（一次 KV 写）：model 非空 → 当天那个模型 +1，
       空串（链上全挂、回了兜底）→ hintfallback +1。要等 makeHint 回来才知道记谁，
       所以这笔账挪到它后面；makeHint 自己吞掉每个模型的异常，真抛了这一次不记账。 */
    context.waitUntil(bumpTrack(env, "hint", pid, model || "").catch(() => {}));
    /* model 是这次真正出正文的那个模型，shape 只在「一个都没出正文」时才有值。
       两个都带上，是为了让「模型被下线」这类静默故障下次一眼可见：
       老写法写死一个模型名，它 5 月 30 号就下线了，而线上只表现为「求灯永远同一句话」。
       都不含汤底，泄漏面为零。 */
    const out = { ok: true, hint, model: model || "" };
    if (shape) out.shape = shape;
    return json(out);
  }

  return json({ ok: false, error: "not found" }, 404);
}
