// 给探针要一个「此刻真的没人监听」的 CDP 端口。
//
// 为什么不能用固定的 9833 这种数：
// 探针是拿到 `--remote-debugging-port` 之后**去连**那个端口的（`/json/version`、
// `/json/new`）。如果上一轮探针的 Chrome 没被杀干净，端口还占着，这次新起的
// Chrome 会因为端口冲突静默退出，而探针照旧连上了**旧实例** —— 旧实例带着上一轮的
// localStorage（进度、已解锁的关键点、存下来的提示），于是布局断言随机红、随机绿，
// 而且「单独跑就过、跟着全套跑就挂」，查起来极费劲。2026-09-20 实测踩过一次。
//
// 每次 listen(0) 拿一个系统分配的空闲端口，旧的残留实例就不可能被连上。
import { createServer } from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
