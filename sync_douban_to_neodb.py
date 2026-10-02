#!/usr/bin/env python3
"""douban2neodb —— 豆瓣电影标记同步到 NeoDB

不走导出文件：直接抓取豆瓣标记列表页（同豆坟的思路），
然后通过 NeoDB API 逐条写入（状态 / 星级 / 短评 / 标记日期都会保留）。

用法：
    python sync_douban_to_neodb.py check            # 检查豆瓣 cookie 和 NeoDB token
    python sync_douban_to_neodb.py sync --dry-run   # 只抓取并预览，不写入 NeoDB
    python sync_douban_to_neodb.py sync             # 全量增量同步（未变化的自动跳过）
    python sync_douban_to_neodb.py sync --full      # 忽略本地缓存，全部重新比对
    python sync_douban_to_neodb.py sync --statuses collect,wish
"""

import argparse
import configparser
import hashlib
import html
import json
import random
import re
import sys
import time
from pathlib import Path

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.ini"
STATE_PATH = SCRIPT_DIR / "state.json"

# 豆瓣状态 -> (url路径, NeoDB shelf_type)
DOUBAN_STATUSES = {
    "collect": ("collect", "complete"),   # 看过
    "wish":    ("wish",    "wishlist"),   # 想看
    "do":      ("do",      "progress"),    # 在看
}

# 豆瓣列表页每页条数
PAGE_SIZE = 15

RE_ITEM_BLOCK = re.compile(r'<div class="item[^"]*"[^>]*>(.*?)(?=<div class="item|\Z)', re.S)
RE_SUBJECT = re.compile(r'href="https://movie\.douban\.com/subject/(\d+)/"')
RE_TITLE = re.compile(r'<em>(.*?)</em>', re.S)
RE_RATING = re.compile(r'class="rating(\d)-t"')
RE_RATING_ALT = re.compile(r'class="allstar(\d)0 rating"')
RE_DATE = re.compile(r'<span class="date">([\d-]+)</span>')
RE_COMMENT = re.compile(r'<span class="comment">(.*?)</span>', re.S)


def log(msg):
    print(msg, flush=True)


# 供 GUI 设置的协作式停止开关与进度回调
stop_requested = lambda: False


def fail(msg):
    print(f"[错误] {msg}", file=sys.stderr)
    sys.exit(1)


def load_config():
    if not CONFIG_PATH.exists():
        fail(f"找不到 {CONFIG_PATH}，请先复制 config.example.ini 为 config.ini 并填写。")
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_PATH, encoding="utf-8")
    d = {
        "douban_user_id": cfg.get("douban", "user_id", fallback="").strip(),
        "douban_cookie": cfg.get("douban", "cookie", fallback="").strip(),
        "douban_delay": cfg.getfloat("douban", "delay", fallback=3.0),
        "neodb_base": cfg.get("neodb", "base_url", fallback="https://neodb.social").strip().rstrip("/"),
        "neodb_token": cfg.get("neodb", "token", fallback="").strip(),
        "visibility": cfg.getint("neodb", "visibility", fallback=0),
        "api_delay": cfg.getfloat("neodb", "api_delay", fallback=1.0),
    }
    if not d["douban_user_id"]:
        fail("config.ini 里缺少 douban.user_id（你的豆瓣个人主页地址里的那串字母数字）。")
    if not d["douban_cookie"]:
        fail("config.ini 里缺少 douban.cookie（登录豆瓣后从浏览器复制的 Cookie）。")
    if not d["neodb_token"]:
        fail("config.ini 里缺少 neodb.token（NeoDB 设置 → 开发者 里生成的访问令牌）。")
    return d


# ---------------------------------------------------------------- 豆瓣抓取

def douban_get(session, url, cfg):
    for attempt in range(3):
        resp = session.get(url, timeout=30, allow_redirects=True)
        if resp.status_code == 200 and "movie.douban.com" in resp.url:
            body = resp.text
            if "有异常请求来自您的IP" in body or "有异常请求来自您的设备" in body:
                fail("豆瓣返回了反爬提示（异常请求），请加大 config.ini 里的 delay 再试。")
            if "accounts.douban.com" in resp.url or "sec.douban.com" in resp.url:
                fail("豆瓣把请求重定向到了登录/验证页，cookie 可能已失效。")
            return body
        if resp.status_code in (403, 418):
            fail(f"豆瓣返回 {resp.status_code}，cookie 无效或被风控，请重新复制 cookie。")
        time.sleep(cfg["douban_delay"] * (attempt + 1))
    fail(f"多次请求豆瓣失败：{url}")


def parse_marks(page_html):
    """解析一个标记列表页，返回条目列表"""
    items = []
    for block in RE_ITEM_BLOCK.findall(page_html):
        m = RE_SUBJECT.search(block)
        if not m:
            continue
        subject_id = m.group(1)
        title = ""
        mt = RE_TITLE.search(block)
        if mt:
            title = re.sub(r"\s+", " ", html.unescape(mt.group(1))).strip()
        mr = RE_RATING.search(block) or RE_RATING_ALT.search(block)
        stars = int(mr.group(1)) if mr else 0
        md = RE_DATE.search(block)
        date = md.group(1) if md else ""
        mc = RE_COMMENT.search(block)
        comment = html.unescape(mc.group(1)).strip() if mc else ""
        items.append({
            "douban_id": subject_id,
            "url": f"https://movie.douban.com/subject/{subject_id}/",
            "title": title,
            "stars": stars,          # 1-5，0 表示未评分
            "date": date,            # 标记日期 YYYY-MM-DD
            "comment": comment,      # 短评
        })
    return items


def scrape_douban(cfg, statuses):
    """抓取指定状态的全部标记，返回 {douban_id: mark}；带 6 小时内的本地缓存"""
    cache_file = SCRIPT_DIR / "marks_cache.json"
    if cache_file.exists():
        try:
            cache = json.loads(cache_file.read_text(encoding="utf-8"))
            if cache.get("statuses") == statuses \
                    and time.time() - cache.get("time", 0) < 6 * 3600 \
                    and cache.get("user_id") == cfg["douban_user_id"]:
                log(f"（使用本机缓存的豆瓣抓取结果，共 {len(cache['marks'])} 条；"
                    f"要强制重抓请删除 marks_cache.json）")
                return cache["marks"]
        except Exception:
            pass

    session = requests.Session()
    session.headers.update({
        "User-Agent": UA,
        "Cookie": cfg["douban_cookie"],
        "Referer": "https://movie.douban.com/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    marks = {}
    for status in statuses:
        url_path, _ = DOUBAN_STATUSES[status]
        start = 0
        stride = PAGE_SIZE
        count = 0
        log(f"—— 抓取豆瓣标记「{status}」…")
        while True:
            if stop_requested():
                log(f"「{status}」抓取被手动停止")
                return marks
            page_url = (f"https://movie.douban.com/people/{cfg['douban_user_id']}/"
                        f"{url_path}?start={start}&sort=time&mode=detail")
            body = douban_get(session, page_url, cfg)
            page_items = parse_marks(body)
            if not page_items:
                break
            stride = max(stride, len(page_items))
            for item in page_items:
                item["douban_status"] = status
                # 同一影片标记过多个状态时，后抓的（按 collect,wish,do 顺序）不覆盖先抓的
                marks.setdefault(item["douban_id"], item)
            count += len(page_items)
            log(f"   已抓取 {count} 条（start={start}）")
            # 「后页」span 里带 start= 链接说明还有下一页
            next_span = re.search(r'<span class="next">(.*?)</span>', body, re.S)
            if not (next_span and "start=" in next_span.group(1)):
                break
            start += stride
            time.sleep(cfg["douban_delay"] + random.uniform(0, 1.5))
        log(f"「{status}」共 {count} 条")
    try:
        cache_file.write_text(json.dumps(
            {"time": time.time(), "user_id": cfg["douban_user_id"],
             "statuses": statuses, "marks": marks}, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return marks


# ---------------------------------------------------------------- NeoDB API

def neodb_api(cfg, method, path, ok_codes=(200,), **kwargs):
    headers = {"Authorization": f"Bearer {cfg['neodb_token']}"}
    resp = requests.request(method, cfg["neodb_base"] + path, headers=headers, timeout=60, **kwargs)
    if resp.status_code not in ok_codes:
        detail = resp.text[:300]
        raise RuntimeError(f"NeoDB {method} {path} -> {resp.status_code}: {detail}")
    return resp


def check_neodb(cfg):
    resp = neodb_api(cfg, "GET", "/api/me")
    me = resp.json()
    log(f"NeoDB 认证成功：{me.get('username')}（{cfg['neodb_base']}）")


def neodb_fetch_item(cfg, douban_url):
    """让 NeoDB 收录该豆瓣条目并返回 uuid；确认无法收录时返回 None"""
    last_err = ""
    for attempt in range(6):
        resp = neodb_api(cfg, "GET", "/api/catalog/fetch",
                         params={"url": douban_url}, ok_codes=(200, 202, 404))
        if resp.status_code == 200:
            data = resp.json()
            item_url = data.get("url") or ""
            if item_url:  # 形如 /api/movie/<uuid>
                return item_url.rstrip("/").split("/")[-1]
            if data.get("uuid"):
                return data["uuid"]
        elif resp.status_code == 404:
            return None
        else:
            last_err = f"{resp.status_code} {resp.text[:120]}"
        time.sleep(5)  # 202 = 收录中，NeoDB 正在后台去豆瓣抓取
    if last_err:
        log(f"    （fetch 轮询失败：{last_err}）")
    return None


def neodb_get_mark(cfg, uuid):
    resp = neodb_api(cfg, "GET", f"/api/me/shelf/item/{uuid}", ok_codes=(200, 404))
    if resp.status_code == 404:
        return None
    return resp.json()


def neodb_mark(cfg, uuid, shelf_type, comment, stars, date):
    body = {
        "shelf_type": shelf_type,
        "visibility": cfg["visibility"],
        "comment_text": comment,
        "rating_grade": stars * 2 if stars else 0,   # 豆瓣 5 星制 -> NeoDB 10 分制
        "tags": [],
    }
    if date:
        body["created_time"] = f"{date}T12:00:00+08:00"
    neodb_api(cfg, "POST", f"/api/me/shelf/item/{uuid}", json=body)


# ---------------------------------------------------------------- 同步主流程

def mark_signature(mark):
    raw = "|".join([mark["douban_status"], str(mark["stars"]), mark["comment"], mark["date"]])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def load_state():
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {}


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def sync(cfg, dry_run, full, statuses, limit, progress=None):
    marks = scrape_douban(cfg, statuses)
    log(f"豆瓣共抓到 {len(marks)} 条标记")
    if not marks:
        log("没有需要同步的标记。")
        return

    if dry_run:
        for mark in marks.values():
            stars = f"{'★' * mark['stars']}{'☆' * (5 - mark['stars'])}" if mark["stars"] else "未评分"
            log(f"  [{mark['douban_status']}] {mark['title']}  {stars}  {mark['date']}"
                + (f"  短评：{mark['comment']}" if mark["comment"] else ""))
        log(f"dry-run 结束，共 {len(marks)} 条，未写入 NeoDB。")
        return

    state = load_state()
    done = skipped = 0
    missing = []
    total = len(marks)
    for mark in marks.values():
        if stop_requested():
            log(f"同步被手动停止（已处理 {done} 条，可随时重跑续传）")
            break
        if limit and done >= limit:
            break
        if progress:
            progress(done, total)
        douban_id = mark["douban_id"]
        sig = mark_signature(mark)
        if not full and state.get(douban_id, {}).get("sig") == sig:
            skipped += 1
            continue

        shelf_type = DOUBAN_STATUSES[mark["douban_status"]][1]
        title = mark["title"] or douban_id
        try:
            uuid = neodb_fetch_item(cfg, mark["url"])
            if uuid is None:
                log(f"  ？ NeoDB 无法收录：{title}（{mark['url']}）")
                missing.append(title)
                continue
            existing = neodb_get_mark(cfg, uuid)
            if existing and existing.get("shelf_type") == shelf_type \
                    and (existing.get("rating_grade") or 0) == (mark["stars"] * 2) \
                    and (existing.get("comment_text") or "") == mark["comment"]:
                log(f"  = 已一致，跳过：{title}")
            else:
                neodb_mark(cfg, uuid, shelf_type, mark["comment"], mark["stars"], mark["date"])
                stars = f"{'★' * mark['stars']}" if mark["stars"] else "未评分"
                log(f"  + 已同步：{title}（{shelf_type} {stars} {mark['date']}）")
            state[douban_id] = {"sig": sig, "uuid": uuid, "shelf_type": shelf_type}
            save_state(state)
            done += 1
        except Exception as e:
            log(f"  ✗ 失败（{title}）：{e}")
        time.sleep(cfg["api_delay"] + random.uniform(0, 0.5))

    log(f"同步完成：本次处理 {done} 条，缓存命中跳过 {skipped} 条。")
    if missing:
        log(f"有 {len(missing)} 条在 NeoDB 收录失败（多为豆瓣已下架条目），可稍后重试 sync --full 补齐。")


def check(cfg):
    log(f"检查豆瓣：user_id = {cfg['douban_user_id']}")
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Cookie": cfg["douban_cookie"],
                            "Referer": "https://movie.douban.com/",
                            "Accept-Language": "zh-CN,zh;q=0.9"})
    url = f"https://movie.douban.com/people/{cfg['douban_user_id']}/collect?sort=time&mode=detail"
    body = douban_get(session, url, {"douban_delay": 3})
    if "你的电影" in body or parse_marks(body) or "用户" in body:
        log("豆瓣 cookie 有效，标记列表页可访问。")
    else:
        log("警告：豆瓣页面已取到，但内容可能异常，建议先跑一次 sync --dry-run 确认。")
    check_neodb(cfg)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="把豆瓣电影标记同步到 NeoDB")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="检查豆瓣 cookie 和 NeoDB token 是否可用")

    p_sync = sub.add_parser("sync", help="抓取豆瓣标记并同步到 NeoDB")
    p_sync.add_argument("--dry-run", action="store_true", help="只抓取预览，不写入 NeoDB")
    p_sync.add_argument("--full", action="store_true", help="忽略本地缓存，全部与 NeoDB 比对")
    p_sync.add_argument("--statuses", default="collect,wish,do",
                        help="要同步的豆瓣状态，逗号分隔：collect(看过),wish(想看),do(在看)")
    p_sync.add_argument("--limit", type=int, default=0, help="本次最多写入多少条（0 不限制）")

    args = parser.parse_args()
    cfg = load_config()

    if args.command == "check":
        check(cfg)
    elif args.command == "sync":
        statuses = [s.strip() for s in args.statuses.split(",") if s.strip()]
        bad = [s for s in statuses if s not in DOUBAN_STATUSES]
        if bad:
            fail(f"未知状态：{bad}，可选值为 collect / wish / do")
        sync(cfg, args.dry_run, args.full, statuses, args.limit)


if __name__ == "__main__":
    main()
