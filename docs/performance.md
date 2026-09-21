# 性能与内存

做过一轮「不换观感、只换速度」的打磨。数字都是本机量的。

## 服务端

| 改动 | 量到的东西 |
|---|---|
| `HTTP/1.1` + keep-alive（原来是 stdlib 默认的 HTTP/1.0，**一个请求一条 TCP 连接**） | 一页 40 多个请求：6 个文本请求从 6 条连接变 1 条 |
| 文本类 gzip（css / js / html / json，图和字体不压，它们本来就压过了） | styles.css 87734→27457、app.js 96048→33880、audio.js 29780→9734、index.html 14652→5086、`/api/puzzles` 26370→10484 字节（合计 254KB → 87KB） |
| `board.json` / `stats.json` 内存缓存（**按文件 mtime 失效**） | 这两个文件原来每次请求都 `read_text + json.loads` 整份读一遍 |
| 两份数据文件改成「先写 `.tmp` 再 `os.replace`」 | 半截 JSON 不会留在盘上（排行榜被写坏等于下一次读整份丢） |
| `upsert_score` 整段读-改-写加了锁 | 旧写法没锁：同一卷两人几乎同时结案会**丢一条成绩** |
| `/api/puzzles` 的 18KB 响应体在启动时算好 + 60 秒缓存 | 省掉每次开页的序列化和重发 |
| `request_queue_size` 5 → 128 | 一页并发打四十来个请求，默认 backlog 排满后会丢连接（表现为「有几张封面是空的」） |
| `Handler.timeout = 65` | keep-alive 的连接不会一直挂着占线程 |

**线上那一路也做了同样的收口**：卷宗和题目都是随包发布的死数据，判题要发的那组 question、
`/api/puzzles` 的响应体和它的字符串形式现在都在**模块级算一次**（Worker 实例会复用），
不再每个请求拼一遍；`/api/puzzles` 给了 `max-age=60, stale-while-revalidate=600`。
判题本身仍然是一问一次 TypeSafe 请求，这个省不掉。

## 前端

**每秒那一次 tick 不再空写 DOM。** `#askCount` / `#elapsed` / `#lastMs` 走 `setText()`
（记着上次写进去的字符串，没变就不碰）。**这三个元素的所有写入都在这一处**，
别在别处直接 `textContent =`，否则那份记忆会失效。

**页面切到后台就不 tick 了**（表在切走那一刻已经停过），手机上省掉整晚的空转。

**拖动改成 rAF 节流**：`pointermove` 一帧可能来好几下，而一个 `setOffset` 要写 8 个元素的
transform。位置先只记在 `dragX` 上，一帧最多落一次 DOM。**松手、起推拉动画前必须
`cancelDragMove()`**，否则排队那一帧会在动画起来之后按拖动中的位置再写一遍
（连 `transition` 都被改成 `none`）。

**手机上封面预解码有界**：空闲补图从「全库全补」收成前后各 8 卷（`IDLE_SPAN`，
桌面仍是全补）。手机上那是这个页面最大的一块内存。

**等待期有反馈**：求灯和提问的状态行前 3 秒只是「……」，之后带上秒数
（`startWait` / `stopWait`，慢网络下能看出它在动，而不是以为点空了）。

**排行榜分了「取不到」和「尚无结案」** —— 以前断网时显示「尚无结案」，看着像榜是空的。

## 三个踩出来的坑

**走自定义 gzip 通道时必须用 `self.guess_type()` 定 Content-Type。**
那份 `extensions_map` 只补了 webp / js / css / json / woff2，**`.html` 不在里面** ——
直接查 map 会掉到 `application/octet-stream`，于是首页被浏览器当文件下载，页面停在
`about:blank`，**`tools/suite.py` 里 5 个探针一起「量不到 DOM」**。
代码是对的，MIME 是错的，报错信息还都在探针自己的 JS 里。

**keep-alive 下 POST 必须把请求体读干净。** `/api/stt` 这类不读 body 的分支留着没读的
字节，会被当成同一条连接上下一个请求的请求行。现在 `do_POST` 一进来就整份读掉存着
（`_body`），分块请求体直接断连接。

**非 UTF-8 的请求体不能再以 `UnicodeDecodeError` 冒出去。** 那会打死处理线程，
客户端只看到一个没头没尾的 empty reply；现在转成 `JSONDecodeError`，按 400 回。

## 还有一处：读屏出口

`#srVerdict`（`.sr-verdict`，1×1 + `clip-path` 裁干净）是给读屏留的出口。
这游戏全是「看」的（印章一闪、记录条一列、汤底在画卷里），没有它读屏用户问完一句
什么都收不到。

**别改成 `display:none`** —— 藏起来的 live region 不会播报。`tools/hint-check.mjs` 的
`findText()` 会显式跳过它，免得它把「提示行被藏起来了」这种真故障盖成假绿。
