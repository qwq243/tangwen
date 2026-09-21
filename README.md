# 汤问 · 海龟汤

<p align="center">
  <b><a href="https://tangwen.pages.dev">▶ 在线玩 · tangwen.pages.dev</a></b><br>
  <sub>44 卷中文海龟汤 · 手机电脑都行 · 不用注册、不用登录</sub>
</p>

![夜馆画廊：中央金框是当前这一卷，左右侧墙是邻卷，底栏是卷目](docs/screenshots/gallery.webp)

你只看到故事的一半。另一半，问出来。

## 玩法

一局大概是这样：

**一、读汤面。** 中央金框里是故事的一半，通常是个说不通的结局 —— 一个人死了，
或者某件事发生后，有个地方怎么都对不上。

**二、问是非题。** 底栏打字，或者按住麦克风说话。汤主只肯答七句：

> 是 · 不是 · 是也不是 · 部分对 · 接近了 · 无关 · 不重要

**三、盯着关键点。** 每一卷藏着几个关键点。问到一条，右边亮一格 —— 那是进度，不是通关条件。

**四、把关键点用自己的话讲出来，就结案。** 不必复述整个故事，讲到够就封卷；
当然你把整个来龙去脉讲一遍也算。

**五、卡住了可以求灯。** 点亮左下角那盏灯，底栏会多出一枚「求灯」，点一次要一句提示。
代价是这一卷结案时，榜上不记你那盏「孤灯」。

换卷左右滑，或者点两侧画框。顶上那个搜索框认卷名、认卷里的字，也认 **汤色** ——
清汤不吓人、红汤有命案、黑汤重口，按今天想喝哪一口挑；旁边还有 浅 / 中 / 深 三档难度。

排行榜上的「用时」是**手上时间**：一分钟没动静就停表。出门吃个饭、手机息屏、
切去聊天再回来，用时不会凭空涨掉几千秒。

<p align="center">
  <img src="docs/screenshots/puzzle.webp" width="49%" alt="问到一半：落印、记录里一条条问答、右侧关键点 chips 亮了两格">
  <img src="docs/screenshots/solve.webp" width="49%" alt="结案：汤底封卷，画卷里报出问数、用时、汤色和第几位结案">
</p>
<p align="center">
  <img src="docs/screenshots/finder.webp" width="49%" alt="搜剧本：按汤色或深浅筛，每行标着难度与汤色">
  <img src="docs/screenshots/mobile.webp" width="49%" alt="手机上同一份 DOM 走竖版画廊">
</p>

## 汤主是怎么判的

这一步值得单独说，因为它不是「让聊天模型随便回一句」。

汤底、事实表（哪些命题为真、哪些为假）、隐喻对照表、人物表，**全部只存在服务端**，
玩家猜中之前一个字节都不会下发。玩家问的每一句，都会连着这几张表一起，作为一道
结构化的判题请求交给 **TypeSafe 的 `jev` 模型** —— 拿回来的不是一段话，是一组概率：
这一问是「是」的可能性、「不是」的可能性、「是也不是」的可能性……

「是也不是」是单独一档，因为题目复杂时答案本来就可能是「一半是、一半不是」
（汤底里这个人死过一次又活着回来，问「他死了吗」，答是答不是都错）。

落哪一枚印由 `pick_host()` 按几条阈值定，而那几条阈值不是拍的，是照着 `jev` 在
这个任务上的**实测概率分布量出来的**（`both >= 0.3`、`min(是,不是) >= 0.18`、
`是+不是 >= 0.45` …）。所以判题模型写死不换、也不设备胎：换一颗模型，那几条阈值全部
作废，而且症状是「偶尔判错」这种最难查的。真要换，得连阈值一起重新量。

**结案有两条路，走通哪条都算**：关键点被你自己讲出来讲到够，或者整段猜中。
「关键点**问到**齐」故意不算 —— 那是进度条。玩家靠探测性是非题完全可以把关键点一排问亮，
可他连核心机制都没往那儿想，那不叫破案；这条口径是改过三次才定下来的。

细节在 [docs/judging.md](docs/judging.md)。

## 自己跑一份

要 **Python 3.10+**。只有跑界面自查时才需要 Node。

```bash
git clone https://github.com/qwq243/tangwen
cd tangwen
JUDGE_MODE=offline python server.py
```

打开 <http://127.0.0.1:8765/>。Windows 上双击 `start.cmd` 等同。

`JUDGE_MODE=offline` 是内置的判题替身：不联网、不要密钥，把提问、落印、解锁关键点、
结案、上排行榜、进后台整条流程都能走完（**判得不准**，它只拿字面重合度当尺子，
只够让你先玩起来）。想换成真判题，搞一把 TypeSafe 密钥填进 `.env` 就行：

```bash
cp .env.example .env      # 填上 TYPESAFE_API_KEY
python server.py
```

想部署给别人玩，两条路：Cloudflare Pages（零运维，前端纯静态 + Workers）或自己的服务器
（一个 zip 加一个 Python 就能跑，服务端只用标准库，没有 `pip install`）。
见 [docs/deployment.md](docs/deployment.md)。

## 仓库里有什么

44 卷中文海龟汤。前端是原生 HTML / CSS / JS，没有框架也没有构建步骤；服务端只用
Python 标准库。音效是 Web Audio 现场合成的，零音频素材；埋点只记「什么事件发生了几次」，
不记问题原文、不记 IP、不记 UA。

```
server.py                  HTTP 服务 + 判题编排（标准库 http.server，无框架）
puzzles.json               44 卷汤面 / 汤底 / 关键点 / 人物表 / 难度 / 汤色
web/
  index.html
  styles.css               两套坐标系：横版 1536×1024 / 竖版 1024×1536
  app.js                   推拉换卷、侧墙预览、搜索、排行榜、进度存档、浏览器语音
  audio.js                 纯 Web Audio 合成：环境音 + 音效
  images/*.webp            封面，*.png 是同图兜底
  admin/                   后台「账房」，零依赖单页
functions/api/[[path]].js  Cloudflare Pages 版的同一套接口
tools/                     探针与回归脚本
docs/                      文档与封面设计稿
asr.py                     旧的服务端听写，已停用，留作回流参考
pack.py                    打部署包，含引用完整性校验
```

有两处地方最容易让新人改错。一是**同一个后端有两份实现**（`server.py` 给自建服务器
和本机用，`functions/api/[[path]].js` 给 Cloudflare Pages 用），两边共享的不是代码而是
**口径** —— 十档印的名字、五个阈值、喂给模型的说明正文、`state` 里字段的顺序，各有一份
同名同值的拷贝，只改一边就会「线上偶尔判错」，所以 `tools/judge-check.py` 结尾会逐值比
一遍两边。二是**几处常量是故意重复的**：CSS 里的布局常量和 `app.js` 里的阈值是同一道
方程的两头，引导文案和首页简介是同一句话的两个出口 —— 这一类列在
[CONTRIBUTING.md](CONTRIBUTING.md) 的「改 X 要连带动 Y」清单里。

## 文档

| 文档 | 讲什么 |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | 本机跑、环境变量全集、离线替身是怎么回事 |
| [docs/architecture.md](docs/architecture.md) | 两条链路、请求怎么走、数据存在哪 |
| [docs/judging.md](docs/judging.md) | 十档印、结案的两条路、阈值怎么量出来的 |
| [docs/hints.md](docs/hints.md) | 求灯：模型链为什么必须是链、三条硬约束、泄底闸 |
| [docs/game-data.md](docs/game-data.md) | `puzzles.json` 的格式、难度与汤色怎么定、怎么补新卷 |
| [docs/ui.md](docs/ui.md) | 两套布局、写界面时的硬约束、焦点与图片贴框 |
| [docs/audio.md](docs/audio.md) | 音效：后台静音、不许单调、高频节流 |
| [docs/telemetry.md](docs/telemetry.md) | 埋点记了什么（以及刻意没记什么）、后台怎么看 |
| [docs/deployment.md](docs/deployment.md) | 部署到 Pages 或自己的服务器、上线前自查 |
| [docs/testing.md](docs/testing.md) | 探针与回归脚本总览 |
| [docs/performance.md](docs/performance.md) | 性能与内存，附三个踩过的坑 |

改界面之前请先读 [docs/ui.md](docs/ui.md)，那里的约束基本都是踩坑之后补上的。

## 许可与致谢

代码是 MIT，随便用。

**44 卷汤面汤底不是我写的 —— 作者是抖音的「许二木」。**
语料取自他的「许二木海龟汤文字版」合集（在 B 站，id `rl999117`），著作权在他手里，
不在 MIT 的授权范围内。放在仓库里是为了让项目开箱即用；你要商用或者大范围再分发，
请自己确认授权，或者把 `puzzles.json` 换成你自己写的题 —— 格式很直白，见
[docs/game-data.md](docs/game-data.md)。汤色的分类口径另有一处出处，同一篇里写了。

判题与求灯分别跑在 [TypeSafe](https://api.typesafe.ai) 的 `jev` 模型和
Cloudflare Workers AI 上。封面是生图模型出的，提示词在
[`docs/design/prompts.jsonl`](docs/design/prompts.jsonl)。

第三方内容的完整说明在 [NOTICE](NOTICE)。
