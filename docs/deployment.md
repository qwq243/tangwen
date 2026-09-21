# 部署

两条路，选一条。两边跑的是同一套接口、同一份判题口径，区别只是谁来扛进程。

**不管走哪条，先改 `wrangler.jsonc` 里的 `name`**（它决定线上域名和部署目标），
如果你要走 Pages，还要把 KV 命名空间的 id 换成自己的。

## 路 A：Cloudflare Pages

适合「不想运维」。前端是纯静态，`functions/` 下的 Worker 就是后端，存储用 KV。

**1. 建 KV 命名空间，把 id 填进 `wrangler.jsonc`**

```bash
npx wrangler kv namespace create BOARD
```

拿到 id 替换掉 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。绑定名必须留着 `BOARD`，
代码里是按这个名字取的。

**2. 同步卷宗**

```bash
cp puzzles.json functions/puzzles.json
```

`functions/puzzles.json` 必须和根目录那份**字节一致**，否则线上判题还是旧汤底。
汤底改一半是最坏的情况：本地对、线上错，而且两边都「看起来能跑」。
难度与汤色也在同一个文件里，所以这一条同时管着「线上判得对不对」和「线上印得对不对」。

**3. 配 Secret 和变量**

```bash
npx wrangler pages secret put TYPESAFE_API_KEY --project-name <你的项目名>
npx wrangler pages secret put ADMIN_KEY       --project-name <你的项目名>
```

求灯要靠 Workers AI 绑定，绑定名必须是 `AI`（写在 `wrangler.jsonc` 里的 `ai` 那项）。
可选变量 `HINT_MODEL` 会插到模型链最前面，用来临时试新模型。

**4. 部署**

```bash
npx wrangler pages deploy --branch main
```

如果项目改用 Git 集成，注意 Pages 的构建输出目录是 `web`（`wrangler.jsonc` 里的
`pages_build_output_dir`）。没有构建步骤，它就是直接把 `web/` 发上去。

**5. 验证**

打开 `/api/health`，对着这张表看哪个是 `false`：

```json
{"ok":true,"typesafe":true,"puzzles":44,"stt":"browser",
 "hint":true,"hint_model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","hint_fallbacks":3,
 "judge_model":"jev-latest","stats":true,"admin":true}
```

| 字段 | 不对意味着什么 |
|---|---|
| `typesafe` | 没配 `TYPESAFE_API_KEY`，判题整个不可用 |
| `judge_model` | 必须就是 `jev-latest`。十档阈值是照它量的，换模型等于换口径 |
| `hint` | 没绑 Workers AI（绑定名必须是 `AI`），求灯永远同一句兜底 |
| `hint_model` | 当前主力求灯模型，部署后核对一眼 —— 模型下线是静默故障 |
| `puzzles` | 卷宗条数。线上下发的是 `functions/puzzles.json`，两副本不一致时它会不对 |
| `stats` / `admin` | KV 绑定 / 后台密钥有没有到位 |

`stt` 恒为 `browser`，因为它不依赖服务端。

**这一路上不会有 `judge_mode` 字段** —— 那是 `server.py` 才有的（本机的离线替身要从那儿
认路）。线上只有真判题，没有替身可以走。

部署完还有两问要自己答一遍：

1. `puzzles.json` 与 `functions/puzzles.json` 是不是字节一致？
2. `/api/hint` 回来的 `model` 是不是链里第一个？**退到备胎了也不是错**，但要知道，
   因为那说明主力出了状况（下线 / 403 / 一直泄底）。

## 路 B：自己的服务器

**不需要 `pip install`。** 服务端只用 Python 标准库（`http.server` + `urllib`），
原来的 ASR 依赖已经去掉，`models/` 那 148 MB 也不用传。有 Python 3.10+ 就能跑。

服务器上没有本机那些配置，所以判题和求灯的凭据必须给全：

| 变量 | 用途 | 缺省行为 |
|---|---|---|
| `TYPESAFE_API_KEY` | 判题，必填 | 没有就一律回「无回音」 |
| `CF_ACCOUNT_ID` `CF_API_TOKEN` | 求灯（Workers AI 免费额度） | 没有就只能回兜底句 |
| `ADMIN_KEY` | 后台登录 | 没有则后台进不去 |
| `HOST` `PORT` | 监听地址 | 默认 `0.0.0.0:8765` |

```bash
HOST=0.0.0.0 PORT=8765 \
TYPESAFE_API_KEY=xxx \
CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx \
ADMIN_KEY=xxx \
python server.py
```

排行榜和埋点落在 `DATA_DIR`（默认 `./data`，目录不存在会自动建）。
这个目录**要留得住** —— 换机器、重置容器之前记得备份，排行榜只在这里。

前面挂 Nginx 反代即可。注意两件事：一是静态资源的缓存头 `web/_headers` 只在 Pages 上
生效，自建要让 Nginx 照着配（`/styles.css`、`/app.js*`、`/audio.js` 可以长缓存，
但那样就必须靠 `?v=` 换新）；二是 `/api/ask` 会调外部模型，超时给够。

## 打包带走

```bash
python pack.py          # 产出 dist/tangwen-<日期>.zip
```

打包前会先做一次**引用校验**：把 `index.html` / `styles.css` / `app.js` /
`puzzles.json` 里出现的本地路径全抽出来，逐个确认落在包内，少一个就直接报错退出，
不会吐一个「看起来能跑」的半成品。

包内不含 `models/`、`tmp/`、`asr.py`、`web/prototypes/` 和调试图；
封面 PNG 兜底图会一起打进去（约 42MB）。如果你的用户都是近三年的浏览器，
把 `web/images/*.png` 删掉能把包压到 6MB 左右。

## 上线前自查

本机先跑这几条：

```bash
python tools/admin-check.py     # 后台 49 条断言，自带服务与临时数据目录
python tools/suite.py           # 界面全套 12 个脚本
python tools/judge-check.py     # 结案口径回归，不联网
python tools/cast-check.py      # 身份题全库回归，打真接口
```

**只在改过判题口径时**加跑这一条：

```bash
python tools/judge-check.py && python tools/cast-check.py --quick
```

前者不联网、把结案口径与双链路 parity 一起验掉，后者抽查身份题。
**只改一边是这条链路最容易犯的错**，而且症状是「线上偶尔判错」这种最难查的。

改结案口径要动的地方列在 [judging.md](judging.md#改这一组档位要动哪些地方) 末尾；
除记账那一条外，parity 都会逐条查，漏一边当场红。

线上跑起来之后，`docs/testing.md` 里的探针可以直接指向线上地址（它们都接 URL 参数），
不过注意 `solve-check.mjs` 会真写一行成绩到服务端。
