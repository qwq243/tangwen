# 怎么改

先读这两篇，能省下不少来回：[docs/judging.md](docs/judging.md)（判题口径为什么是现在这样）
和 [docs/ui.md](docs/ui.md)（界面上的硬约束）。这个项目里不少看着啰嗦的写法都是踩过坑
之后补的，删之前先看看那两篇里有没有提到它。

## 跑起来

```bash
JUDGE_MODE=offline python server.py     # 不要密钥，先把游戏跑起来
python tools/suite.py                   # 界面全套自查，自己起服务自己关
python tools/judge-check.py             # 判题口径回归，不联网
```

要 `TYPESAFE_API_KEY` 才能验真判题，见 [docs/getting-started.md](docs/getting-started.md)。

## 提交之前

改了什么就跑对应的那一条，别只跑全套：

| 改了什么 | 跑什么 |
|---|---|
| `web/styles.css` / `web/app.js` / `web/audio.js` | **先把 `web/index.html` 里的 `?v=` 加一**，再 `python tools/suite.py` |
| 画面位置、`.slide` / `.strip` / `--slot-*` / `syncLayout` | `node tools/frame-fit.mjs <url>` |
| 紧凑态 | `node tools/compact-scan.mjs <url>`（它比别个慢，所以不在 suite 默认串里） |
| 输入框 | `node tools/mobile-input-check.mjs <url>` |
| 判题口径 | `python tools/judge-check.py` 和 `python tools/cast-check.py --quick` |
| 后台 | `python tools/admin-check.py` 和 `node tools/admin-shot.mjs <url> <ADMIN_KEY>` |
| `puzzles.json` | `python tools/difficulty.py --write`、`python tools/soup.py --write`、`python tools/cast.py --write`，然后 `python tools/suite.py` 加打一遍真接口 |

`?v=` 那一条不是形式：`web/_headers` 把 CSS 和 JS 设成一年不过期，不加这个标记，
线上拿到的还是老代码。

## 那些故意重复的地方

这个项目有几处**同一件事写在两个地方**，都不是疏忽。只改一处是这里最容易犯的错，
而且症状通常是最难查的那种（「线上偶尔判错」「手机上位置偏了」）。改之前先扫一眼这张表。

**判题口径**一共有两份：`server.py` 和 `functions/api/[[path]].js`。要同步的东西是
`HOST_LABELS`、`SOLVE_RULE` 的五个数、`BASE_QUESTIONS` 的说明正文（含 `identity`）、
`build_questions()` 里 `said_` 那组问句的措辞、`pick_host()` 的几步判断、以及 `state` 里
字段的顺序。`tools/judge-check.py` 结尾的 parity 会逐条比，漏一边当场红 ——
但它是**跑的时候**才发现，所以改的时候心里要有数。

**布局门槛**是一道方程的两头：`web/styles.css` 里 `.stage.tall` 那些常量
（`--slot-y` / `.read` / `.dossier` 的 `bottom`）和 `app.js` 的 `GALLERY_MIN_RATIO` /
`GALLERY_MIN_PAD`。而且 **`tools/fit-scan.mjs` 里抄了一份门槛的拷贝**，
`tools/hint-check.mjs` 的紧凑态测试高度也是从同一个方程算出来的 —— 不改它们，
suite 会白红一轮，报的却是界面症状。

**引导文案**：入馆引导第四卡（`web/index.html` 的 `tour-card` 肆）和首页简介是同一句话的
两个出口，一起改。

**印章配色**：加档或改档要同时动 `HOST_LABELS`、`BASE_QUESTIONS`、`pick_host`、
以及 `web/styles.css` 里的 `.stamp.*` 和 `.ledger .a.*`。
`tools/effect-shot.mjs` 开头的 `VERDICTS` 表会挨个喂一遍，漏了哪一档直接报出来。

**卷宗**：`puzzles.json` 和 `functions/puzzles.json` 必须字节一致，部署前确认。
汤底改一半是最坏的情况 —— 本地对、线上错，两边都「看起来能跑」。

**阈值与量法**：`SOLVE_RULE` 里除 `keys_ratio` 之外的四个数都是量出来的，不是拍的。
改 `said_` 的问句措辞就必须重新量 `said_floor` 的两条边界（真话最低 0.47、杂音最高 0.39），
只改一个数会让杂音顶穿真话，而症状是「偶尔把闲问当成他说对了」。量法写在
[docs/judging.md](docs/judging.md) 里。

## 加一卷题

流程在 [docs/game-data.md](docs/game-data.md) 里。有三件事别省：

一是 `facts` / `keys` / `metaphor_map` 必须逐卷读一遍手工写，判题的准头全在这上面，
写不出公式。二是补完要**打一遍真接口**，schema 全对和「判得动」是两回事。
三是补完要跑 `frame-fit.mjs`，新封面的裁切可能比全库最贴边的那张还紧。

## 提交

提交信息写清「改了什么、为什么」。这个项目的提交历史长短不一，长的那些通常是因为
改的是一个曾经判错的阈值 —— 那种把来龙去脉写进信息里，比写「fix bug」有用得多。

界面改动请在描述里带上跑了哪几个探针、结果如何。判题口径改动请说明跑了
`judge-check.py` 和 `cast-check.py`，以及有没有重新量阈值。

## 已知的授权边界

`puzzles.json` 的汤面汤底是抖音「许二木」的作品，著作权不在本项目。往里加题之前先想清楚
来源；如果你打算把项目用于商业用途，建议把语料换成自己写的（格式见
[docs/game-data.md](docs/game-data.md)）。完整说明见 [NOTICE](NOTICE)。
