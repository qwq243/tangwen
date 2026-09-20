"""一条命令跑完项目的全部界面自查：起 server.py -> 依次跑 tools/*.mjs -> 关服务。

为什么必须串在一个进程里：这些探针都要求一个已经跑着的服务，而 detached 子进程
在部分沙箱/CI 环境里会随命令结束被回收 —— 分成两条命令跑，第二条必然是「连接被拒」。

用法:
    python tools/suite.py                  # 全部
    python tools/suite.py effect-shot      # 只跑文件名里含 effect-shot 的
    python tools/suite.py --port 8765 --out D:/tmp/shots

依赖：node 在 PATH 里（或设环境变量 NODE 指向 node.exe）。
"""
import argparse
import datetime
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)

# 探针自己用的假密钥 / 假数据目录。放在 tmp 下，不碰 data/ 里的真数据。
ADMIN_KEY = "suite-admin-key-not-a-real-secret"
# 假数据目录按**端口**分开（端口是每次现挑的）。
# 为什么不用固定一个 tmp/_admin-data：这台机器上可能同时有另一路会话在跑同一份套件，
# 两边的 seed_admin_data() 会互相重写 board.json —— 实测过一次
# 「/api/score 的响应里明明有那一行，打开榜时却没了」（solve-check 假红）。
# 用 <端口> 当后缀就把两路隔开了。
ADMIN_DATA = os.path.join(PROJ, "tmp", "_admin-data")          # 默认值（--url 指外部服务时用不到）


def admin_data_for(port: int) -> str:
    return os.path.join(PROJ, "tmp", "_admin-data-%d" % port)

# (文件名, 额外参数)，URL 会拼在最前面
SUITE = [
    ("tour-check.mjs", []),   # 首访分步引导：本探针不注入 seed，引导本身就是被测对象
    ("audio-check.mjs", []),  # 音效：离开页面静音 / 不变单调 / 高频节流
    ("mobile-check.mjs", ["390", "844"]),
    ("hint-check.mjs", ["390", "844"]),
    ("finder-hint-check.mjs", []),  # 点搜索框出分类 + 求灯那一下（提示在记录方框第一行、不压汤面）
    ("mobile-input-check.mjs", ["390", "844"]),  # 点输入框不能丢焦点（键盘弹起时布局不能把焦点顶掉）
    ("solve-check.mjs", ["390", "844"]),  # 结案之后：结算落库 / 榜上有我 / 表停
    ("track-check.mjs", []),  # 真问一句 -> 后台当场记到（含「不会记双」）；额外参数在 main() 里补
    ("fit-scan.mjs", []),
    ("effect-shot.mjs", []),
    ("probe.mjs", []),
    ("admin-shot.mjs", []),   # 额外参数在 main() 里补：密钥 + 截图目录
]


def seed_admin_data(data_dir: str) -> None:
    """给后台探针造 34 天的历史数据。

    为什么必须造：只有一天数据时折线图就是一个孤点，日期轴、极值取整、
    悬停定位这些分支全都走不到，探针会假绿。
    固定随机种子 —— 每次跑出来的数一样，断言才好写。

    顺便把整条 suite 的数据目录都指到这里：探针会提问、会写排行榜，
    以前是直接写进 data/ 的，等于每跑一次回归就污染一次真数据。
    """
    os.makedirs(data_dir, exist_ok=True)
    rnd = random.Random(20260920)
    base = datetime.date.today()
    pids = ["jumper", "song", "exam", "room"]
    # 求灯模型表：主力 + 偶发的备胎。后台那张「模型调用」表要按这个分解算占比，
    # 只塞一个模型的话「占比」永远是 100%，那一列等于没测。
    hint_models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct"]
    days = {}
    for i in range(34):
        d = (base - datetime.timedelta(days=i)).isoformat()
        pv = rnd.randint(6, 80)
        hint = rnd.randint(0, 14)
        back = rnd.randint(0, 2)                  # 退到备胎的那几句
        fall = 1 if rnd.random() < 0.08 else 0     # 全挂回兜底（少数几天）
        days[d] = {
            "c": {
                "pv": pv,
                "uv": max(1, int(pv * rnd.uniform(0.5, 0.85))),
                "new": rnd.randint(0, 6),
                "ask": rnd.randint(4, 120),
                "hint": hint + back + fall,
                "solve": rnd.randint(0, 11),
                "give": rnd.randint(0, 3),
                "judgefail": 1 if rnd.random() < 0.06 else 0,
                "hintfallback": fall,
            },
            "p": {pid: {"ask": rnd.randint(0, 24), "hint": rnd.randint(0, 3),
                        "solve": rnd.randint(0, 4)} for pid in pids},
            "m": {hint_models[0]: hint, hint_models[1]: back},
        }
    with open(os.path.join(data_dir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump({"days": days, "seen": {}, "first": {}, "rl": {}}, f, ensure_ascii=False)
    # 排行榜也塞几行：后台那张表空着的话，删除按钮、孤灯标记这些分支都测不到
    board = {
        pid: [{"id": f"probe-{i}", "name": f"探针{i}", "asks": 3 + i,
               "ms": 60000 + i * 17000, "used_hint": i % 2 == 0} for i in range(5)]
        for pid in pids
    }
    with open(os.path.join(data_dir, "board.json"), "w", encoding="utf-8") as f:
        json.dump(board, f, ensure_ascii=False)


def port_busy(port: int) -> bool:
    """这个端口上是不是已经有人在服务。

    不能靠「自己 bind 一下试试」判断 —— Windows 允许 0.0.0.0:8765 和 127.0.0.1:8765
    同时绑上（一个绑全部地址、一个绑回环），bind 成功不代表没人。能不能连上才是判据。

    2026-09-20 踩过：常驻实例占着 8765（双击 start.cmd 起的那个），suite 又在同一个
    端口起了自己的一份，于是请求一半发给新代码、一半发给旧代码 —— 探针随机红随机绿，
    而且「单独跑就过、跟着全套跑就挂」。跟着这次一起查了半天。"""
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("only", nargs="?", default="", help="只跑文件名里含这个串的脚本")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--url", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    port = args.port
    if port_busy(port):
        port = free_port()
        print("[注意] %d 上已经有服务在跑（多半是常驻实例：双击 start.cmd 起的那个）。" % args.port)
        print("       本次改用 %d —— 探针量的必须是本次这版代码；两个进程同端口会让" % port)
        print("       请求一半发给新代码、一半发给旧代码，结果随机红绿。")
    url = args.url or "http://127.0.0.1:%d/" % port
    node = os.environ.get("NODE") or shutil.which("node")
    if not node:
        print("[FAIL] 找不到 node —— 装一个，或设环境变量 NODE 指向 node.exe")
        return 2

    todo = [(n, a) for n, a in SUITE if (not args.only or args.only in n)]
    if not todo:
        print("[FAIL] 没有匹配的脚本:", args.only)
        return 2

    data_dir = ADMIN_DATA if args.url else admin_data_for(port)
    if any(n in ("admin-shot.mjs", "track-check.mjs") for n, _ in todo):
        seed_admin_data(data_dir)

    env = dict(os.environ)
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["DATA_DIR"] = data_dir
    env["ADMIN_KEY"] = ADMIN_KEY

    srv = subprocess.Popen([sys.executable, "server.py"], cwd=PROJ, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    fails = []
    try:
        ready = False
        for _ in range(80):
            if srv.poll() is not None:
                break
            try:
                with urllib.request.urlopen(url + "api/health", timeout=1) as r:
                    print("health:", r.read().decode("utf-8", "replace").strip())
                    ready = True
                    break
            except Exception:
                time.sleep(0.5)
        if not ready:
            print("[FAIL] 服务 20s 没起来（server.py 直接退了？端口被占？）")
            return 2

        for name, extra in todo:
            argv = [node, os.path.join("tools", name), url] + extra
            if name == "admin-shot.mjs":
                argv += [ADMIN_KEY, args.out or os.path.join(PROJ, "tmp", "_shot")]
            elif name == "track-check.mjs":
                argv += [ADMIN_KEY, "390", "844"]
            elif args.out and name in ("probe.mjs", "effect-shot.mjs", "mobile-check.mjs"):
                argv.append(args.out)
            print("\n" + "=" * 58)
            print("### " + name)
            print("=" * 58)
            try:
                p = subprocess.run(argv, cwd=PROJ, timeout=args.timeout)
                if p.returncode:
                    fails.append(name)
            except subprocess.TimeoutExpired:
                print("[FAIL] 超时")
                fails.append(name)
    finally:
        try:
            srv.terminate()
            try:
                srv.wait(timeout=5)
            except subprocess.TimeoutExpired:
                srv.kill()
        except Exception:
            pass

    print("")
    if fails:
        print("[FAIL] %d 个脚本没过：%s" % (len(fails), " / ".join(fails)))
        return 1
    print("[OK] 全部通过（%d 个脚本）" % len(todo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
