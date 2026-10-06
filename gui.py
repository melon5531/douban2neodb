#!/usr/bin/env python3
"""douban2neodb 图形界面 —— 豆瓣电影标记同步到 NeoDB

直接运行：python gui.py   （或双击 启动同步界面.bat）
"""

import configparser
import queue
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

import sync_douban_to_neodb as core

CONFIG_PATH = core.CONFIG_PATH

# 配色
BG = "#f4f6f8"          # 窗口背景
CARD = "#ffffff"        # 卡片背景
DARK = "#1f2d3d"        # 头部深色
DARK_SUB = "#9fb3c8"
ACCENT = "#2f7d6d"      # 主色（NeoDB 绿）
ACCENT_DARK = "#276a5c"
ACCENT_LIGHT = "#eef5f3"
DANGER = "#c0574f"
DANGER_DARK = "#a94a43"
BORDER = "#d8dee4"

FONT = ("Microsoft YaHei UI", 10)
FONT_BOLD = ("Microsoft YaHei UI", 10, "bold")
FONT_TITLE = ("Microsoft YaHei UI", 15, "bold")
FONT_SMALL = ("Microsoft YaHei UI", 9)
FONT_LOG = ("Consolas", 9)


class App:
    def __init__(self, root):
        self.root = root
        root.title("离豆 · 豆瓣标记 → NeoDB 同步")
        root.geometry("880x680")
        root.minsize(760, 560)
        root.configure(bg=BG)
        try:
            logo = tk.PhotoImage(file=str(core.SCRIPT_DIR / "docs" / "logo.png"))
            root.iconphoto(True, logo)
            self._logo_ref = logo   # 防止被垃圾回收
        except Exception:
            pass

        self.q = queue.Queue()
        self.busy = False
        core.log = lambda msg: self.q.put(str(msg))   # 把脚本日志转发到界面

        self._build_styles()
        self._build_header()
        self._build_config_frame()
        self._build_buttons()
        self._build_progress()
        self._build_log()
        self.load_config_into_fields()
        self.root.after(100, self._poll_queue)

    # ------------------------------------------------------------ 样式

    def _build_styles(self):
        s = ttk.Style()
        s.theme_use("clam")
        s.configure(".", font=FONT, background=BG)

        s.configure("TFrame", background=BG)
        s.configure("TLabel", background=BG)
        s.configure("Header.TFrame", background=DARK)
        s.configure("HeaderTitle.TLabel", background=DARK, foreground="white", font=FONT_TITLE)
        s.configure("HeaderSub.TLabel", background=DARK, foreground=DARK_SUB, font=FONT_SMALL)

        s.configure("Card.TLabelframe", background=CARD, borderwidth=1, relief="solid")
        s.configure("Card.TLabelframe.Label", background=CARD, foreground=DARK,
                    font=FONT_BOLD, padding=(2, 0, 2, 4))
        s.configure("Card.TFrame", background=CARD)
        s.configure("Card.TLabel", background=CARD)

        s.configure("TEntry", padding=5, bordercolor=BORDER, lightcolor=BORDER,
                    fieldbackground="white")
        s.map("TEntry", bordercolor=[("focus", ACCENT)], lightcolor=[("focus", ACCENT)])
        s.configure("TCombobox", padding=4, fieldbackground="white")

        s.configure("TCheckbutton", background=CARD, focuscolor=CARD)
        s.map("TCheckbutton", background=[("active", CARD)])

        s.configure("TProgressbar", troughcolor="#e4e8eb", background=ACCENT,
                    borderwidth=0, thickness=12)

        s.configure("Primary.TButton", background=ACCENT, foreground="white",
                    padding=(18, 8), borderwidth=0, font=FONT_BOLD)
        s.map("Primary.TButton",
              background=[("active", ACCENT_DARK), ("disabled", "#a3c2bb")],
              foreground=[("disabled", "#f0f4f3")])

        s.configure("Ghost.TButton", background="white", foreground=ACCENT,
                    padding=(16, 8), borderwidth=1, bordercolor="#c2d4cf")
        s.map("Ghost.TButton",
              background=[("active", ACCENT_LIGHT), ("disabled", "#f2f4f4")],
              foreground=[("disabled", "#9db3ae")],
              bordercolor=[("active", ACCENT)])

        s.configure("Danger.TButton", background=DANGER, foreground="white",
                    padding=(18, 8), borderwidth=0)
        s.map("Danger.TButton",
              background=[("active", DANGER_DARK), ("disabled", "#ddb9b6")])

        s.configure("Status.TLabel", background=BG, foreground="#5a6b7b", font=FONT_SMALL)

    # ------------------------------------------------------------ 界面搭建

    def _build_header(self):
        h = ttk.Frame(self.root, style="Header.TFrame")
        h.pack(fill="x")
        inner = ttk.Frame(h, style="Header.TFrame", padding=(20, 14, 20, 12))
        inner.pack(fill="x")
        ttk.Label(inner, text="离豆 · 豆瓣标记 → NeoDB 同步", style="HeaderTitle.TLabel").pack(side="left")
        ttk.Label(inner, text="状态 · 评分 · 短评 · 日期 全部保留",
                  style="HeaderSub.TLabel").pack(side="left", padx=(14, 0), pady=(5, 0))

    def _build_config_frame(self):
        f = ttk.Labelframe(self.root, text=" 配置 ", style="Card.TLabelframe")
        f.pack(fill="x", padx=16, pady=(12, 6))

        body = ttk.Frame(f, style="Card.TFrame", padding=(10, 6, 10, 10))
        body.pack(fill="x")

        self.vars = {}
        row = 0

        def add_row(label, key, default="", width=64, show=""):
            nonlocal row
            ttk.Label(body, text=label, style="Card.TLabel").grid(
                row=row, column=0, sticky="e", padx=(4, 8), pady=4)
            var = tk.StringVar(value=default)
            ttk.Entry(body, textvariable=var, width=width, show=show).grid(
                row=row, column=1, sticky="we", padx=(0, 8), pady=4)
            self.vars[key] = var
            row += 1

        add_row("豆瓣 user_id", "user_id", width=28)
        add_row("豆瓣 Cookie", "cookie", width=80)
        add_row("NeoDB 服务器", "base_url", default="https://neodb.social")
        add_row("NeoDB 访问令牌", "token", width=56, show="●")

        ttk.Label(body, text="标记可见性", style="Card.TLabel").grid(
            row=row, column=0, sticky="e", padx=(4, 8), pady=4)
        self.vis_var = tk.StringVar(value="0")
        vis = ttk.Combobox(body, textvariable=self.vis_var, width=14, state="readonly",
                           values=["0  公开", "1  仅关注者", "2  仅自己"])
        vis.current(0)
        vis.grid(row=row, column=1, sticky="w", padx=(0, 8), pady=4)
        row += 1

        ttk.Label(body, text="同步的状态", style="Card.TLabel").grid(
            row=row, column=0, sticky="e", padx=(4, 8), pady=4)
        sf = ttk.Frame(body, style="Card.TFrame")
        sf.grid(row=row, column=1, sticky="w", padx=(0, 8), pady=4)
        self.status_vars = {}
        for name, label in [("collect", "看过"), ("wish", "想看"), ("do", "在看")]:
            v = tk.BooleanVar(value=True)
            self.status_vars[name] = v
            ttk.Checkbutton(sf, text=label, variable=v).pack(side="left", padx=(0, 16))
        row += 1

        ttk.Label(body, text="每次限制条数", style="Card.TLabel").grid(
            row=row, column=0, sticky="e", padx=(4, 8), pady=4)
        limit_f = ttk.Frame(body, style="Card.TFrame")
        limit_f.grid(row=row, column=1, sticky="w", padx=(0, 8), pady=4)
        self.limit_var = tk.StringVar(value="0")
        ttk.Entry(limit_f, textvariable=self.limit_var, width=7).pack(side="left")
        ttk.Label(limit_f, text="（0 = 不限制）", style="Card.TLabel").pack(side="left", padx=(8, 0))
        row += 1

        ttk.Label(body, text="豆瓣抓取间隔(秒)", style="Card.TLabel").grid(
            row=row, column=0, sticky="e", padx=(4, 8), pady=4)
        self.delay_var = tk.StringVar(value="3.0")
        ttk.Entry(body, textvariable=self.delay_var, width=7).grid(
            row=row, column=1, sticky="w", pady=4)
        row += 1

        body.columnconfigure(1, weight=1)

    def _build_buttons(self):
        f = ttk.Frame(self.root, padding=(16, 6, 16, 0))
        f.pack(fill="x")
        self.btns = {}
        for key, text, cmd in [
            ("save", "保存配置", self.save_config),
            ("check", "测试连接", self.run_check),
            ("dry", "预览（不写入）", self.run_dry),
            ("sync", "开始同步", self.run_sync),
            ("stop", "停止", self.request_stop),
        ]:
            style = {"sync": "Primary.TButton", "stop": "Danger.TButton"}.get(key, "Ghost.TButton")
            b = ttk.Button(f, text=text, command=cmd, style=style)
            b.pack(side="left", padx=(0, 10))
            self.btns[key] = b
        self.btns["stop"].configure(state="disabled")

    def _build_progress(self):
        f = ttk.Frame(self.root, padding=(16, 10, 16, 2))
        f.pack(fill="x")
        self.progress = ttk.Progressbar(f, mode="determinate", maximum=100)
        self.progress.pack(fill="x", side="top")
        self.status_lbl = ttk.Label(f, text="就绪 —— 同步可在任何中断后续传", style="Status.TLabel")
        self.status_lbl.pack(anchor="e", pady=(4, 0))

    def _build_log(self):
        f = ttk.Labelframe(self.root, text=" 运行日志 ", style="Card.TLabelframe")
        f.pack(fill="both", expand=True, padx=16, pady=(8, 14))
        self.log_box = scrolledtext.ScrolledText(
            f, height=14, state="disabled", font=FONT_LOG,
            bg="#fbfcfd", fg="#333a40", relief="flat",
            highlightthickness=0, padx=8, pady=6)
        self.log_box.pack(fill="both", expand=True, padx=6, pady=6)
        self.log_box.tag_configure("ok", foreground=ACCENT_DARK)
        self.log_box.tag_configure("err", foreground=DANGER)
        self.log_box.tag_configure("dim", foreground="#8a97a3")

    # ------------------------------------------------------------ 配置读写

    def _collect_cfg(self):
        return {
            "douban_user_id": self.vars["user_id"].get().strip(),
            "douban_cookie": self.vars["cookie"].get().strip(),
            "douban_delay": float(self.delay_var.get() or 3.0),
            "neodb_base": self.vars["base_url"].get().strip().rstrip("/") or "https://neodb.social",
            "neodb_token": self.vars["token"].get().strip(),
            "visibility": int(self.vis_var.get().split()[0]),
            "api_delay": 1.0,
        }

    def _statuses(self):
        return [s for s, v in self.status_vars.items() if v.get()]

    def load_config_into_fields(self):
        if not CONFIG_PATH.exists():
            return
        cp = configparser.ConfigParser()
        cp.read(CONFIG_PATH, encoding="utf-8")
        self.vars["user_id"].set(cp.get("douban", "user_id", fallback=""))
        self.vars["cookie"].set(cp.get("douban", "cookie", fallback=""))
        self.vars["base_url"].set(cp.get("neodb", "base_url", fallback="https://neodb.social"))
        self.vars["token"].set(cp.get("neodb", "token", fallback=""))
        self.delay_var.set(cp.getfloat("douban", "delay", fallback=3.0))
        vis = cp.getint("neodb", "visibility", fallback=0)
        self.vis_var.set(f"{vis}  " + {0: "公开", 1: "仅关注者", 2: "仅自己"}[vis])

    def save_config(self):
        cp = configparser.ConfigParser()
        cp.add_section("douban")
        cp.set("douban", "user_id", self.vars["user_id"].get().strip())
        cp.set("douban", "cookie", self.vars["cookie"].get().strip())
        cp.set("douban", "delay", self.delay_var.get().strip() or "3.0")
        cp.add_section("neodb")
        cp.set("neodb", "base_url", self.vars["base_url"].get().strip())
        cp.set("neodb", "token", self.vars["token"].get().strip())
        cp.set("neodb", "visibility", self.vis_var.get().split()[0])
        cp.set("neodb", "api_delay", "1.0")
        with open(CONFIG_PATH, "w", encoding="utf-8") as fp:
            cp.write(fp)
        self._gui_log("配置已保存到 config.ini\n", "ok")

    # ------------------------------------------------------------ 任务调度

    def _gui_log(self, msg, tag=None):
        self.log_box.configure(state="normal")
        self.log_box.insert("end", msg + "\n", tag or ())
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _poll_queue(self):
        while not self.q.empty():
            msg = self.q.get_nowait()
            if msg == "__DONE__":
                self._set_busy(False, "完成")
                self.progress.configure(value=100)
                self._gui_log("✅ 全部完成。", "ok")
                continue
            if msg == "__FAIL__":
                self._set_busy(False, "出错")
                continue
            if msg.startswith("__PROGRESS__"):
                self._done = int(msg[len("__PROGRESS__"):])
                total = max(self._total, 1)
                self.progress.configure(value=100 * self._done / total)
                self.status_lbl.configure(text=f"同步进度 {self._done} / {total}")
                continue
            tag = None
            if msg.startswith(("  + 已同步", "✅", "配置已保存")):
                tag = "ok"
            elif msg.startswith(("  ✗", "[错误]")):
                tag = "err"
            elif msg.startswith(("  = 已一致", "（使用")):
                tag = "dim"
            self._gui_log(msg, tag)
        self.root.after(150, self._poll_queue)

    def _set_busy(self, busy, status=""):
        self.busy = busy
        for k in ("save", "check", "dry", "sync"):
            self.btns[k].configure(state="disabled" if busy else "normal")
        self.btns["stop"].configure(state="normal" if busy else "disabled")
        if status:
            self.status_lbl.configure(text=status)

    def _validate(self, need_token=True):
        cfg = self._collect_cfg()
        if not cfg["douban_user_id"] or not cfg["douban_cookie"]:
            messagebox.showwarning("缺少配置", "请先填写豆瓣 user_id 和 Cookie。")
            return None
        if need_token and not cfg["neodb_token"]:
            messagebox.showwarning("缺少配置", "请先填写 NeoDB 访问令牌（设置 → 开发者里生成）。")
            return None
        return cfg

    def _start_task(self, target, status):
        if self.busy:
            return
        self._done = 0
        self._total = 0
        self.progress.configure(value=0)
        self._set_busy(True, status)
        threading.Thread(target=self._wrap, args=(target,), daemon=True).start()

    def _wrap(self, target):
        try:
            target()
            if not self.stop_flag:
                self.q.put("__DONE__")
        except SystemExit:
            pass
        except Exception as e:
            self.q.put(f"[错误] {e}")
            self.q.put("__FAIL__")

    # ------------------------------------------------------------ 各按钮

    def run_check(self):
        cfg = self._validate()
        if not cfg:
            return

        def job():
            core.check(cfg)

        self.stop_flag = False
        core.stop_requested = lambda: self.stop_flag
        self._start_task(job, "正在测试连接…")

    def run_dry(self):
        cfg = self._validate(need_token=False)
        if not cfg:
            return
        statuses = self._statuses()
        if not statuses:
            messagebox.showwarning("未选择", "请至少选择一个要同步的状态。")
            return
        self.stop_flag = False
        core.stop_requested = lambda: self.stop_flag
        self._start_task(lambda: core.sync(cfg, True, False, statuses, 0), "正在抓取预览…")

    def run_sync(self):
        cfg = self._validate()
        if not cfg:
            return
        statuses = self._statuses()
        if not statuses:
            messagebox.showwarning("未选择", "请至少选择一个要同步的状态。")
            return
        try:
            limit = int(self.limit_var.get() or 0)
        except ValueError:
            messagebox.showwarning("格式错误", "限制条数应为整数。")
            return
        if not messagebox.askyesno(
                "开始同步",
                f"将把豆瓣「{'、'.join({'collect': '看过', 'wish': '想看', 'do': '在看'}[s] for s in statuses)}」"
                f"的标记同步到 NeoDB。\n未变化的条目会自动跳过，可以随时停止并续传。\n\n确定开始？"):
            return
        self.stop_flag = False
        core.stop_requested = lambda: self.stop_flag
        self._start_task(lambda: core.sync(cfg, False, False, statuses, limit,
                                           progress=self._on_progress), "正在抓取豆瓣标记…")

    def _on_progress(self, done, total):
        self._total = total
        self.q.put(f"__PROGRESS__{done}")

    def request_stop(self):
        self.stop_flag = True
        self.status_lbl.configure(text="正在停止（等当前条目完成）…")


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
