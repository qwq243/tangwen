# 架构

## 一句话

一套静态前端，两条可以互换的后端实现，共享同一份判题口径。**汤底只存在服务端**，
玩家猜中之前一个字节都不会下发。

```
浏览器  web/index.html + styles.css + app.js + audio.js
   │    纯静态，无构建步骤；部署 Pages 时直接发布 web/ 这个目录
   │
   ├── GET  /api/puzzles    卷宗（不含汤底）
   ├── POST /api/ask        ★ 判题：玩家这句话落哪一枚印
   ├── POST /api/hint       求灯（AI 提示，可选功能）
   ├── POST /api/score      结案交成绩
   ├── POST /api/giveup     放弃，换看汤底
   ├── POST /api/track      客户端埋点（只有一个事件：开卷成功）
   ├── GET  /api/board      排行榜
   └── GET  /api/solves     每卷「几人结案」
```

`/api/ask` 的响应里会带 `bottom`（汤底）**当且仅当结案或放弃**。这条是硬约束，
`tools/judge-check.py` 里有一组断言专门钉它。

## 两条后端

`server.py` 给自建服务器和本机用，Python 标准库，零第三方依赖，存储是
`DATA_DIR` 下的几个 JSON 文件。`functions/api/[[path]].js` 给 Cloudflare Pages 用，
零依赖，存储是 KV 命名空间 `BOARD`。判题两边都是 TypeSafe REST；求灯本地走 Workers AI 的
REST 接口（复用 wrangler 凭据），线上走 `env.AI` 绑定。

**为什么要有两份**：自建那条路是为了整个打包带走（`pack.py` 出一个 zip，有 Python 就能跑），
Pages 那条路是为了零运维。两边共享的只有**口径**，不是代码。

### 所以有一条规矩：口径不许只改一边

判题的全部口径是这些同名同值的常量与说明正文：

- `HOST_LABELS` —— 十档印的名字
- `SOLVE_RULE` —— 五个数（四个阈值 + `keys_ratio`）
- `BASE_QUESTIONS` —— 喂给模型的那几组说明正文，含 `identity` 那段
- `build_questions()` —— 拼 `key_<id>` / `said_<id>` 两组问句
- `pick_host()` —— 拿概率定最终那枚印的那几步
- `state` 里字段的顺序（`cast` 必须最后，理由见 [judging.md](judging.md#cast-要排在-state-的最后一位)）

改一边就是错的，而症状是「线上偶尔判错」这种最难查的东西。`tools/judge-check.py` 结尾会
跑一遍双链路 parity，逐个比这些值；`tools/cast-check.py` 开头也有一道。改完必须跑。

## 一次判题怎么走的

```
POST /api/ask {puzzle_id, question, history, unlocked, stated}
      │
      ├─ 校验（题目长度上限、卷存在）
      ├─ bump_track("ask", puzzle_id)     ← 先记账：判题挂了也是玩家真问了
      ├─ judge(puzzle, question, history, unlocked, stated)
      │     ├─ 组 state（汤面 / 汤底 / 隐喻表 / 事实表 / 人物表 / 这句话 / 最近 8 轮）
      │     ├─ build_questions(puzzle)        → 一组问句
      │     ├─ typesafe(state, questions)     → ★ 唯一一次外部调用
      │     ├─ pick_host(choice, probabilities)  → 落哪枚印
      │     └─ 按 SOLVE_RULE 判两条结案路
      └─ 响应：label / say / verdict / solved / unlocked / stated / keys
                （只在结案或放弃时才带 bottom）
```

`unlocked` 和 `stated` 都是**跨轮累积**的：客户端把上一轮的结果存下来、下一轮带回来。
所以服务端不用存会话，也就没有会话要清理。

判题只有一个网络接缝，就是 `typesafe()` 这一个函数。离线替身
（`JUDGE_MODE=offline`）和回归用的桩都是从这个口子换进去的，`judge()` 一行都不用动。

## 数据存在哪

自建这条路是 `DATA_DIR` 下三个文件：`board.json`（排行榜，每卷只留前 30 行）、
`solves.json`（每卷结案人数）、`stats.json`（按日聚合的埋点）。三个都走「先写 `.tmp`
再 `os.replace`」的原子替换，读侧带按 mtime 失效的内存缓存，写侧加锁。半截 JSON 不会留在
盘上 —— 排行榜被写坏等于整份丢。

线上是 KV：

| 键 | 内容 |
|---|---|
| `board:<卷id>` | 该卷排行榜行。每卷一个键，只读要的那一卷 |
| `solves` | `{卷id: 人数}`。单键 —— 开页面要一次看全部 44 卷，拆成 44 个键反而更贵 |
| `st:d:YYYY-MM-DD` | 当日计数 + 分卷明细 |
| `st:u:YYYY-MM-DD` | 当日出现过的 uid，只用于 UV 去重 |
| `st:f:<uid>` | 该 uid 首次出现日，用来算「新增」 |

日期按 **Asia/Shanghai** 切：Worker 跑在 UTC，直接取 UTC 日期的话北京时间 00:00–08:00
的访问会记到前一天去。细节见 [telemetry.md](telemetry.md)。

## 前端

零依赖、零构建，两个文件加起来三千多行。`web/app.js` 管推拉换卷、侧墙预览、搜索、
排行榜、进度存档（`localStorage` 的 `fengcun.*`）、计时、浏览器语音、封面增量预热、
两套布局的切换；`web/styles.css` 装两套坐标系（横版 1536×1024 / 竖版 1024×1536），
关键位置全是 CSS 变量。

排行榜接口只在打开面板时才打；卷宗 `/api/puzzles` 给 60 秒缓存；静态图缓存一天；
CSS/JS 靠 `?v=` 换新。

界面上的硬约束（展示层级、紧凑态的出口、焦点、图片贴框）单独写在 [ui.md](ui.md)，
**改界面之前读那一篇** —— 那些约束基本是踩过坑才加上的。

## 隐私

不记问题原文、不记 IP、不记 UA、不记设备。判题密钥走环境变量或 Pages Secret，
仓库里没有任何凭据。说细一点见 [telemetry.md](telemetry.md)。
