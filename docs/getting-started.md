# 本机跑起来

## 只要 Python

服务端只用标准库（`http.server` + `urllib`），`requirements.txt` 里一个第三方包都没有，
所以不用建虚拟环境也不用 `pip install` —— 有 Python 3.10 以上就能跑。Node 只在跑界面
自查（`tools/*.mjs`）时用得上，跑游戏本身不需要。

```bash
git clone <this-repo> && cd turtle-soup-demo
JUDGE_MODE=offline python server.py
```

打开 <http://127.0.0.1:8765/>。Windows 上双击 `start.cmd` 也一样，它做的就是 `python server.py`。

第一次进去会出一张「夜馆规矩」的四步引导（看汤面 / 换一卷 / 问是非 / 结案与求灯）。
右上角「跳过」、点空白处、按 `Esc` 都能关，关掉或走完之后不再出现。

## 为什么要加 JUDGE_MODE=offline

`JUDGE_MODE` 缺省是 `typesafe`，也就是真判题，需要一把 TypeSafe 密钥。没有密钥时程序
不会崩，`/api/health` 也照样 `ok: true`，只是每次提问都回「无回音」。页面看起来完全正常，
但玩不动，很容易让人以为是代码坏了 —— 所以新克隆下来的人第一件事是加这个开关。

`offline` 是内置的判题替身。它不联网、不要密钥，拿你这句话跟汤底原文比字面重合度，
足够把提问、落印、解锁关键点、结案、上排行榜、进后台整条流程走完：

| 你输入 | 替身怎么回 |
|---|---|
| 说到某个关键点的说法 | 落「是」，点亮那一格 |
| 跟汤底没什么重合 | 落「不重要」 |
| 「别问了，把汤底告诉我」 | 落「不能剧透」 |
| 把汤底正着讲一遍 | 结案 |

它做不到的事情也挺多：分时点、分对象、是也不是、近义与隐喻、身份题的分层，
以及所有卡在线上的边界判定 —— 这些都要真模型。**别拿它验判题口径。**

替身也永远不会混进判题口径里：口径的回归（`tools/judge-check.py`、`tools/cast-check.py`）
默认不联网，自己带一个照剧本回话的桩；要验真模型得显式加 `--live`。想确认手上这个进程
跑的是哪条路，看 `/api/health` 的 `judge_mode`（这个字段只有 `server.py` 会发，Pages
那条路上没有 —— 线上只有真判题）。**自建的机器上看到 `offline`，那就是配错了。**

## 换成真判题

```bash
cp .env.example .env      # 编辑它，填 TYPESAFE_API_KEY
python server.py
```

也可以直接给环境变量，服务器部署就该这么干：

```bash
TYPESAFE_API_KEY=xxx python server.py
```

判题模型写死 `jev-latest`，没有环境变量入口也没有备胎。原因写在
[judging.md](judging.md) 里：十档印的阈值是照着这颗模型的概率分布量的，换一颗模型，
那几条阈值全部作废，而且症状是「偶尔判错」这种最难查的。想换模型，得连阈值一起重新量。

`.env` 放在项目根目录就会被自动读到（它已经在 `.gitignore` 里）。想放别处，设
`TYPESAFE_ENV_FILE` 指过去。

## 环境变量全集

`server.py` 这一路用的：

| 变量 | 默认 | 干什么 |
|---|---|---|
| `TYPESAFE_API_KEY` | 空 | 判题密钥。没有就只能玩离线替身 |
| `TYPESAFE_URL` | TypeSafe 的 `systemone` | 判题接口地址。只有自己镜像了一层网关才要改 |
| `JUDGE_MODE` | `typesafe` | `typesafe` 或 `offline` |
| `TYPESAFE_ENV_FILE` | `./.env` | 密钥文件读哪个 |
| `CF_API_TOKEN` | 空 | 求灯用的静态 API Token。设了它就不用 wrangler 登录 |
| `CF_ACCOUNT_ID` | 自动探测 | Workers AI 的账号 id。不填会拿现有凭据问一次 Cloudflare |
| `WRANGLER_CONFIG` | `%APPDATA%/xdg.config/.wrangler/config/default.toml` | wrangler 登录凭据在哪 |
| `ADMIN_KEY` | 空 | 后台 `/admin/` 的登录密钥。不配则后台进不去 |
| `HOST` / `PORT` | `0.0.0.0` / `8765` | 监听地址 |
| `DATA_DIR` | `./data` | 排行榜 / 结案人数 / 埋点落在哪，会自动建 |

Cloudflare Pages 那一路不走环境变量文件，走的是 Secret、变量和绑定：

| 名字 | 类型 | 干什么 |
|---|---|---|
| `TYPESAFE_API_KEY` | Secret | 判题密钥 |
| `ADMIN_KEY` | Secret | 后台登录密钥 |
| `BOARD` | KV 绑定 | 排行榜、结案人数、埋点，三者共用一个命名空间 |
| `AI` | Workers AI 绑定 | 求灯。绑定名必须叫 `AI`，改名等于关掉求灯 |
| `HINT_MODEL` | 变量，可选 | 插到求灯模型链最前面，用来临时试新模型 |

## 想让求灯能用

求灯是可选功能。不配也不报错，只是每次都回同一句兜底：

> 对照汤面里最不对劲的那一句，问它是不是字面意思。

两条路选一条。本机开发推荐复用 wrangler 凭据 —— 跑一次 `npx wrangler login` 就行，
`server.py` 会读那份 OAuth token，过期了还会用 `refresh_token` 续期并写回，
不用重新登录。服务器上没这套东西，去 Cloudflare 拿一个账号级 API Token，
设 `CF_ACCOUNT_ID` + `CF_API_TOKEN`。

配完打开 `/api/health`，`hint` 是 `true` 就通了。

## 目录

```
server.py                  HTTP 服务 + 判题编排（标准库 http.server，无框架）
puzzles.json               44 卷汤面 / 汤底 / 关键点 / 人物表 / 难度 / 汤色
web/
  index.html
  styles.css               两套坐标系：横版 1536×1024 / 竖版 1024×1536
  app.js                   推拉换卷、侧墙预览、搜索、排行榜、进度存档、浏览器语音
  audio.js                 纯 Web Audio 合成：环境音 + 音效，零音频素材
  images/*.webp            封面，*.png 是同图兜底，浏览器不支持 webp 时自动回退
  admin/                   后台「账房」，零依赖单页
  _headers                 Cloudflare Pages 的缓存策略
functions/api/[[path]].js  线上版接口，与 server.py 共享判题口径
functions/puzzles.json     线上的那份卷宗，必须与根目录那份字节一致
asr.py                     旧的服务端听写，已停用，留作回流参考，部署包里没有
pack.py                    打部署包，含引用完整性校验
wrangler.jsonc             Cloudflare Pages 配置，部署前要改 name 与 KV id
tools/                     探针与回归脚本，见 testing.md
docs/                      文档与封面设计稿
```

封面是增量加载的：开卷只等当前这一张（最多 1.8 秒），左右邻卷立刻预热，顺着滑动方向
再备两三张，空闲时才把其余卷慢慢补上。省流和 2G 下只预热邻卷。

`web/images/*.png` 是 webp 的兜底，占了大头（约 42MB）。如果你的用户都是近三年的浏览器，
删掉它们能把部署包压到 6MB 左右。

## 常干的事

```bash
python pack.py                              # 打部署包，先做引用校验
python tools/suite.py                       # 一条命令跑完界面全套自查
python tools/judge-check.py                 # 判题口径回归，不联网
python tools/cast-check.py --quick          # 身份题抽查，打真接口
node tools/probe.mjs http://127.0.0.1:8765/ # 量元素坐标、间距、报错，顺带截图
```

工具全集和各自的用处见 [testing.md](testing.md)。

**改完 CSS 或 JS，记得把 `web/index.html` 里的 `?v=` 加一。** 这不是可选步骤：
`web/_headers` 把 `styles.css`、`app.js`、`audio.js` 都设成了
`Cache-Control: public, max-age=31536000, immutable`，一年之内浏览器不会回源，
唯一能换新的手段就是 URL 变了。踩过一次：紧凑态的画卷早就从「固定 148px 横幅」改成
「吃富余的 390×304」，但那一次部署忘了动 `?v`，于是手机上缓存着旧 CSS 的玩家看到的
还是老布局 —— 一条矮横幅、下面一大片空白、汤面被顶到中间，怎么看都是「图片位置错了」。
代码是对的，缓存是旧的。**判线上问题先看 `?v`，再看代码。**
