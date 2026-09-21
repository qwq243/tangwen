# 探针与回归

这个项目的界面约束大多是踩坑之后补上的，所以验收不靠肉眼，靠一堆探针。它们都住在
`tools/` 里，一半是 Node（真开一个 headless Chrome，量 DOM、量矩形、截图），
一半是 Python（跑接口、比常量、验口径）。

## 一条命令跑完

```bash
python tools/suite.py                 # 自己起服务、依次跑、自己关
python tools/suite.py effect-shot     # 只跑文件名里含 effect-shot 的
python tools/suite.py --port 8765 --out D:/tmp/shots
```

默认串了 12 个脚本：tour / audio / mobile / hint / finder-hint / mobile-input / solve /
track / fit-scan / effect-shot / probe / admin-shot。

两件事是必须的，不是讲究：

**`suite.py` 把服务的数据目录指到 `tmp/_admin-data/`**（`DATA_DIR` 环境变量），
开跑前还用固定随机种子造 34 天假数据和几行假排行榜。探针会提问、会写排行榜，
不隔离的话每跑一次回归就污染一次 `data/`；而只有一天数据时折线图就是一个孤点，
日期轴、极值取整、悬停定位这些分支全都走不到，探针会**假绿**。

**`suite.py` 会避让已占用的端口**：开跑前先连一下 8765，连得上（多半是常驻实例，
双击 `start.cmd` 起的那个）就自己换一个空闲端口，并在开头把这件事说清楚。
判占用不能靠「自己 bind 一下试试」：Windows 允许 `0.0.0.0:8765` 与 `127.0.0.1:8765`
同时绑上，bind 成功不代表没人。

**这个坑踩过一次**：两套服务同占 8765，请求一半发给新代码一半发给旧代码 —— 探针随机红绿，
而且是「单独跑就过、跟着全套跑就挂」那种最难查的假绿。**改完 `server.py` 要量真代码时，
先把常驻的那个实例重启掉**，它不会自己吃改动。

上面这些探针都会先注入 `tools/seed.mjs` 把自己的 `localStorage` 塞好，
把首访那张「夜馆规矩」入馆引导跳掉 —— 它是个全屏浮层，不跳的话截出来的图量到的全是那张卡片。

还有一条共同的：它们都会拦掉 `/api/ask` 造假回答（判题要出网，在断网或受限环境里服务端
开 socket 会被拒，报 `WinError 10013`）。想连真接口加 `--real-ask`，但要在正常联网时跑。
`effect-shot.mjs` 还会自己造一条 226 字的汤底，因为汤底是服务端私有字段、只随 `/api/ask`
下发，不自己造一条就验不出「画卷要不要滚、朱印会不会压字」。

## 出文档用的实机截图

```bash
DATA_DIR=tmp/_shotsrv JUDGE_MODE=offline PORT=8795 python server.py &
node tools/shots.mjs http://127.0.0.1:8795/
```

它真起 Chrome、真加载页面、真的把界面驱动到「问了几轮」「结案」「搜剧本」那几个状态，
然后把 webp 写进 `docs/screenshots/`（README 上那几张就是它出的）。

为什么不能拿 `probe.mjs` 的截图凑合：probe 的图是量布局时顺手拍的，多半停在首页，
看不出这个游戏在干什么 —— 记录里有几条问答、关键点点亮了几格、结案画卷长什么样，
这些才是别人点进来想看的。

出图要的是稳定画面，所以它把 `/api/ask` 拦成一个照剧本回话的桩；其余接口全走真的，
**关键点的 label 就是从真 `/api/puzzles` 里取的**（脚本里再抄一份卷宗，chips 迟早显示
`undefined`）。结案那一步会真写一行成绩进排行榜，所以**别把 URL 指到线上**，
给它一个临时 `DATA_DIR` 最稳。想更小或更清晰就调 `SHOT_DSF` / `SHOT_Q`。

## 界面探针

按顺序大致是「量布局 → 量交互 → 量状态」。每个都接一个 URL 参数，默认指本机。

```bash
node tools/probe.mjs http://127.0.0.1:8765/
```
多视口量元素坐标、间距、JS 报错，顺带截图。它的 `gaps` 就是判断「有没有贴太近 /
有没有被面板压住」的依据：`prevToWin` / `winToNext` 是两个箭头到中央金框内窗的距离
（还要减去 `--frame-pad`），`nextToDossier` 是右箭头到记录面板的距离，负数就是压上了。

```bash
node tools/pixel-scan.mjs tmp/_shot/probe_desktop_1440x900.png 235 544 0 full
```
在 PNG 的一行带里扫「金色」列，量画框真实外沿。自带 PNG 解码，不依赖第三方库。

```bash
node tools/mobile-check.mjs http://127.0.0.1:8765/ 390 844
```
手机端体检：键盘弹起后有没有遮挡、换卷 / 声音 / 排行榜还能不能用、回答看不看得到。

```bash
node tools/fit-scan.mjs http://127.0.0.1:8765/
```
竖屏尺寸扫描：哪些尺寸该用画廊、哪些该落紧凑态，逐个断言（含记录面板装满的场景）。
**它里面抄了一份 `GALLERY_MIN_RATIO` / `GALLERY_MIN_PAD`**，改门槛要连它一起改，
见 [ui.md](ui.md)。

```bash
node tools/compact-scan.mjs http://127.0.0.1:8765/
```
竖屏可用高度扫描：紧凑态六段各占多高、画卷够不够大、汤面字号、上下留白对不对称。
它扫 8 档高度、比其余几个慢一档，所以**不在 `suite.py` 的默认串里** —— 改紧凑态 CSS 时
单独跑一遍。

```bash
node tools/frame-fit.mjs http://127.0.0.1:8765/
```
图片必须贴着画框：11 个视口加「改宽 / 换卷 / 竖横互转」几条路径，再全库逐卷量，
偏差 > 1px 就报错（顺带断言顶部控件不压左右墙画框）。**改 `.slide` / `.strip` /
`--slot-*` / `syncLayout` 之后先跑它。**

```bash
node tools/hint-check.mjs        http://127.0.0.1:8765/
node tools/finder-hint-check.mjs http://127.0.0.1:8765/
```
求灯的两条。前者管「两套布局里提示看不看得见、是不是排在记录方框第一行（不压汤面、
不压输入条）、能不能反复读、刷新后还在不在、加了那一行会不会挤坏画卷」；
后者管「点搜索框要出两行分类、点求灯那一下整行要亮、这句话屏幕上是不是只出现在一个地方」。

```bash
node tools/finder-timer-check.mjs http://127.0.0.1:8765/
```
搜剧本、汤色筛选、计时三条一起：宽屏与紧凑态各有出口、点结果能跳卷、按汤色筛对了、
停表期间的空转不计入用时。

```bash
node tools/mobile-input-check.mjs http://127.0.0.1:8765/
```
输入框焦点：真触屏点三个输入框，键盘弹起（视口压矮）时焦点站不站得住。
手机上「卡一下然后输入不了」就是这条钉的。

```bash
node tools/tour-check.mjs http://127.0.0.1:8765/
```
首访引导：四卡翻页（按钮 / 方向键 / 圆点 / 滑动）、跳过与存档、紧凑态整卡不滚动。

```bash
node tools/effect-shot.mjs http://127.0.0.1:8765/
```
结案与关键点解锁的观感：定格截图，断言展示层级（`.reveal-title` 必须小于
`.finale-title`）、朱印不压正文、十档印章齐全、轻触能不能收起。
开头那张 `VERDICTS` 表会挨个喂一遍十档，**加了新档漏在这里会直接报出来**。

```bash
node tools/audio-check.mjs http://127.0.0.1:8765/
```
音效：离开页面必须静音（三条事件路径）、同一件事十次不许一个样、高频音必须节流。
详见 [audio.md](audio.md)。

```bash
node tools/solve-check.mjs http://127.0.0.1:8765/
```
结案：成绩真的落库、榜上有我、表停了、难度与人数都在。**它会真写一行成绩到服务端**，
其余走真接口。

```bash
node tools/track-check.mjs http://127.0.0.1:8765/
```
埋点：真问一句，后台当场记到 `ask`（不等攒批），而且不会记双。

## 接口与口径回归

```bash
python tools/admin-check.py
```
后台回归，自带服务、自带临时数据目录，**不碰 `data/`**。49 条断言：埋点聚合
（含判题失败、求灯按模型记、兜底那一档、「讲对了没结案」那一档、关键点自己讲出来那一路）、
UV 去重、登录限流、token 过期与篡改、排行榜删档、卷宗带汤色。

```bash
node tools/admin-shot.mjs http://127.0.0.1:8765/ <ADMIN_KEY> tmp/_shot
```
后台界面：真登录取 token，验图表真渲染、图没被缩放、悬停提示出得来、模型调用卡五格与
模型表、卷宗核对真敲搜索真点分类、没横向溢出。

```bash
python tools/judge-check.py           # 不联网
python tools/judge-check.py -v        # 顺便打印每一问落下来的印与结案标记
python tools/judge-check.py --live    # 再加一段实模型自查，要密钥
```
结案口径回归。离线那段把 `typesafe` 换成一个照剧本回话的桩，喂的是**判题输出**而不是问题
—— 被测的正是 `judge()` 拿到那组答案之后怎么落印、结不结案。所以它跑得飞快、结果稳定，
可以常驻。它同时跑一遍双链路 parity。断言清单在
[judging.md](judging.md#验收)。

```bash
python tools/cast-check.py                 # 全库 303 问，打真接口
python tools/cast-check.py --quick         # 抽查
python tools/cast-check.py --no-cast --quick   # 看「只有说明、没有人物表」会怎样
```
身份题回归：写定的必须一是一否、未写明的必须落「不重要」。开头还有一道不联网的断言，
比对两条链路的说明正文与 state 字段顺序。

## 语料与封面

```bash
python tools/difficulty.py            # 只打印分数表
python tools/difficulty.py --write    # 只补还没有值的卷
python tools/soup.py --write          # 提议汤色 + 打命中证据，只补缺的
python tools/cast.py --write          # 补人物表
python tools/bili-import.py           # 抓合集、拆条、去重（补卷第一步）
```

前三个都守着同一条规矩：**值以 `puzzles.json` 为准**，已有的值不覆盖（除非 `--force`）。
详见 [game-data.md](game-data.md)。

## 两个不出现在命令行里的帮手

`tools/chrome-port.mjs` 给探针要一个「此刻真的没人监听」的 CDP 端口。为什么不能用固定的
9833 这种数：探针拿到 `--remote-debugging-port` 之后是去连那个端口的，如果上一轮探针的
Chrome 没被杀干净、端口还占着，这次新起的 Chrome 会因为冲突静默退出，而探针照旧连上了
**旧实例** —— 旧实例带着上一轮的 `localStorage`（进度、已解锁的关键点、存下来的提示），
于是布局断言随机红绿，而且「单独跑就过、跟着全套跑就挂」。每次 `listen(0)` 拿一个系统
分配的空闲端口，旧残留就不可能被连上。

`tools/seed.mjs` 是所有探针共用的注入脚本，进页面前把 `fengcun.tour` 和 `fengcun.sound`
塞好，用的是 `Page.addScriptToEvaluateOnNewDocument`，跑在 `app.js` 之前。
