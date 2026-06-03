#!/usr/bin/env python3
"""
BUAA iClass 自动签到守护进程 v5
基于 fontlos/buaa-api (2026.06.01) 改造：
  - 登录走完整 SSO：sso.buaa.edu.cn → ?type=jumpMyCenter → eschool/app/user/login_buaa.do
  - 签到路径 eschool 前缀 + Sessionid header
  - 时间戳用服务器时间 /app/common/get_timestamp.action
  - 移除 offset 二分搜索（服务器时间直接可用）
"""

import argparse
import asyncio
import http.cookiejar
import json
import logging
import random
import re
import signal
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ───────────────────────────────────────────────
# 常量
# ───────────────────────────────────────────────

ICLASS_PORT_HTTPS = 8346  # login_buaa
ICLASS_PORT_HTTPS_SCHED = 8347  # 课表
ICLASS_PORT_HTTP = 8081  # 签到 + 时间戳

ICLASS_HTTPS_BASE = f"https://iclass.buaa.edu.cn:{ICLASS_PORT_HTTPS}"
ICLASS_HTTPS_SCHED_BASE = f"https://iclass.buaa.edu.cn:{ICLASS_PORT_HTTPS_SCHED}"
ICLASS_HTTP_BASE = f"http://iclass.buaa.edu.cn:{ICLASS_PORT_HTTP}"
SSO_BASE = "https://sso.buaa.edu.cn"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"


# ───────────────────────────────────────────────
# Config
# ───────────────────────────────────────────────

class SignConfig:
    def __init__(self, phone: str = "", stu_id: str = "", stu_pwd: str = "",
                 notice_token: str = "", check_interval: int = 60,
                 log_file: str = "", signed_dates_file: str = "",
                 auto_window: int = 9):
        self.phone = phone
        self.stu_id = stu_id
        self.stu_pwd = stu_pwd
        self.notice_token = notice_token
        self.check_interval = check_interval
        self.log_file = log_file
        self.signed_dates_file = signed_dates_file
        self.auto_window = auto_window

    @classmethod
    def from_file(cls, path: str) -> "SignConfig":
        with open(path) as f:
            raw = json.load(f)
        return cls(
            phone=raw.get("phone", "") or raw.get("iclass_password", ""),
            stu_id=raw.get("stu_id", ""),
            stu_pwd=raw.get("stu_pwd", "") or raw.get("iclass_password", ""),
            notice_token=raw.get("notice_token", ""),
            check_interval=raw.get("check_interval", 60),
            log_file=raw.get("log_file", ""),
            signed_dates_file=raw.get("signed_dates_file", ""),
            auto_window=raw.get("auto_window", 9),
        )


# ───────────────────────────────────────────────
# Logging
# ───────────────────────────────────────────────

def setup_logging(log_file: str = "") -> logging.Logger:
    logger = logging.getLogger("buaasign")
    logger.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s | %(levelname)-8s | %(message)s", datefmt="%H:%M:%S")
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_file)
        fh.setFormatter(fmt)
        fh.setLevel(logging.DEBUG)
        logger.addHandler(fh)
    else:
        ch = logging.StreamHandler(sys.stdout)
        ch.setFormatter(fmt)
        logger.addHandler(ch)
    return logger


# ───────────────────────────────────────────────
# HTTP 工具
# ───────────────────────────────────────────────

def _ctx():
    return ssl._create_unverified_context()


def _build_opener(jar: http.cookiejar.CookieJar | None) -> urllib.request.OpenerDirector:
    """构造一个忽略证书校验 + 跟随重定向 + 可选 cookie 的 opener"""
    ctx = _ctx()
    https_handler = urllib.request.HTTPSHandler(context=ctx)
    handlers = [
        https_handler,
        urllib.request.HTTPRedirectHandler(),
    ]
    if jar is not None:
        handlers.insert(0, urllib.request.HTTPCookieProcessor(jar))
    return urllib.request.build_opener(*handlers)


def _cookie_header(jar: http.cookiejar.CookieJar, url: str) -> str:
    """从 cookieJar 中提取适用于 url 的 Cookie 头"""
    req = urllib.request.Request(url)
    return jar.make_cookies_request(req) and "; ".join(
        f"{c.name}={c.value}" for c in jar
    ) or ""


def _send(method: str, url: str, jar: http.cookiejar.CookieJar | None = None,
          data: dict | None = None, headers: dict | None = None,
          timeout: int = 15) -> tuple[int, str, str]:
    """
    返回 (status_code, final_url, body)
    自动跟随重定向，jar 同步 Set-Cookie
    """
    body_bytes = urllib.parse.urlencode(data).encode() if data else b""
    hdrs = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body_bytes if method == "POST" else None,
                                 method=method, headers=hdrs)
    opener = _build_opener(jar)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.url, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, getattr(e, "url", url), e.read().decode("utf-8", errors="ignore")


# ───────────────────────────────────────────────
# SSO + Class 登录（2026.06 新流程）
# ───────────────────────────────────────────────

def login_sso_and_class(stu_id: str, stu_pwd: str, logger) -> tuple[str, str] | None:
    """
    返回 (sessionId, userId) 或 None
    1. SSO 登录拿 TGC cookie
    2. 访问 iClass?type=jumpMyCenter 拿 loginName（=sessionId）
    3. 调 login_buaa.do 拿 userId
    """
    jar = http.cookiejar.CookieJar()

    # 1) SSO 登录页 → 拿 execution
    logger.info(f"SSO 登录中... (学号 {stu_id})")
    sso_login_url = f"{SSO_BASE}/login?service=" + urllib.parse.quote(
        "https://iclass.buaa.edu.cn:8346/", safe=""
    )
    status, final_url, body = _send("GET", sso_login_url, jar=jar)
    logger.debug(f"SSO login page: status={status}, final_url={final_url[:120]}")

    # 已登录
    if final_url and urllib.parse.urlparse(final_url).path == "/":
        logger.info("SSO 已登录（Cookie 仍有效）")
    else:
        m = re.search(r'<input name="execution" value="([^"]+)"', body)
        if not m:
            logger.error(f"SSO: 找不到 execution 字段, body={body[:200]}")
            return None
        execution = m.group(1)
        logger.debug(f"SSO execution={execution[:32]}...")

        # 2) 提交学号密码
        form = {
            "username": stu_id,
            "password": stu_pwd,
            "submit": "登录",
            "type": "username_password",
            "execution": execution,
            "_eventId": "submit",
        }
        status, final_url, body = _send("POST", f"{SSO_BASE}/login", jar=jar, data=form,
                                        headers={"Referer": f"{SSO_BASE}/login"})
        logger.debug(f"SSO submit: status={status}, final_url={final_url[:120]}")

        if status >= 400:
            logger.error(f"SSO 登录失败: HTTP {status}")
            return None

        # 风险页 continueForm
        if "continueForm" in body:
            logger.warning("SSO 检测到账号风险，尝试忽略继续登录...")
            m2 = re.search(r'<input name="execution" value="([^"]+)"', body)
            if not m2:
                logger.error("SSO 风险页: 找不到 execution")
                return None
            form2 = {"execution": m2.group(1), "_eventId": "ignoreAndContinue"}
            status, final_url, body = _send("POST", f"{SSO_BASE}/login", jar=jar, data=form2,
                                            headers={"Referer": f"{SSO_BASE}/login"})
            if status >= 400:
                logger.error(f"SSO 风险页失败: HTTP {status}")
                return None
            logger.info("SSO 风险已忽略")

    # 3) ?type=jumpMyCenter 拿 loginName（sessionId）
    jump_url = f"{ICLASS_HTTPS_BASE}/?type=jumpMyCenter"
    status, final_url, body = _send("GET", jump_url, jar=jar,
                                    headers={"Referer": "https://iclass.buaa.edu.cn/"})
    logger.debug(f"jumpMyCenter: status={status}, final_url={final_url[:200]}")
    m = re.search(r"loginName=([A-Za-z0-9+/=]+)", final_url or "")
    if not m:
        # 兜底：从 body 中找
        m = re.search(r"loginName=([A-Za-z0-9+/=]+)", body or "")
    if not m:
        logger.error(f"未能从 iClass 拿到 loginName, final_url={final_url}, body={body[:200]}")
        return None
    session_id = m.group(1)
    logger.info(f"loginName 拿到 ✅ (len={len(session_id)})")

    # 4) login_buaa.do 拿 userId
    qs = urllib.parse.urlencode({
        "phone": session_id,
        "password": "",
        "verificationType": "2",
        "verificationUrl": "",
        "userLevel": "1",
    })
    status, final_url, body = _send("GET", f"{ICLASS_HTTPS_BASE}/eschool/app/user/login_buaa.do?{qs}",
                                    headers={"Referer": "https://iclass.buaa.edu.cn/"})
    logger.debug(f"login_buaa.do: status={status}, body[:200]={body[:200]}")
    if status != 200:
        logger.error(f"login_buaa.do HTTP {status}")
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        logger.error(f"login_buaa.do 响应非 JSON: {e}, body={body[:200]}")
        return None
    if not (data.get("STATUS") == "0" or data.get("status") == "0"):
        logger.error(f"login_buaa.do 失败: {data.get('ERRMSG', data.get('message', body[:200]))}")
        return None
    user_id = str(data.get("result", {}).get("id", ""))
    if not user_id:
        logger.error(f"login_buaa.do 响应缺 id: {body[:200]}")
        return None
    logger.info(f"Class 登录成功 ✅ UID={user_id}")
    return session_id, user_id


# ───────────────────────────────────────────────
# 课表 / 时间戳 / 签到
# ───────────────────────────────────────────────

def fetch_schedule(session_id: str, user_id: str, date_str: str,
                   logger) -> list:
    """date_str 格式 YYYYMMDD"""
    qs = urllib.parse.urlencode({"dateStr": date_str, "id": user_id})
    url = f"{ICLASS_HTTPS_SCHED_BASE}/app/course/get_stu_course_sched.action?{qs}"
    status, _, body = _send("POST", url, headers={
        "Sessionid": session_id,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    if status != 200:
        logger.error(f"课表查询 HTTP {status}")
        return []
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        logger.error(f"课表响应非 JSON: {body[:200]}")
        return []
    if data.get("STATUS") == "0" or data.get("status") == "0":
        result = data.get("result", [])
        return result if isinstance(result, list) else []
    logger.error(f"课表查询失败: {data.get('ERRMSG', data.get('message', body[:200]))}")
    return []


def fetch_server_timestamp(session_id: str, logger) -> int | None:
    """从 iClass 服务器拿时间戳（毫秒）"""
    url = f"{ICLASS_HTTP_BASE}/app/common/get_timestamp.action"
    status, _, body = _send("POST", url, headers={"Sessionid": session_id})
    if status != 200:
        logger.error(f"get_timestamp HTTP {status}: {body[:200]}")
        return None
    try:
        data = json.loads(body)
        ts = int(data.get("timestamp", 0))
        if ts <= 0:
            logger.error(f"get_timestamp 响应缺 timestamp: {body[:200]}")
            return None
        return ts
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"get_timestamp 解析失败: {e}, body={body[:200]}")
        return None


def do_sign_in(session_id: str, user_id: str, course_sched_id: str,
               logger) -> tuple[bool, str]:
    """
    返回 (success, message)
    """
    ts = fetch_server_timestamp(session_id, logger)
    if ts is None:
        return False, "无法获取服务器时间戳"
    qs = urllib.parse.urlencode({
        "courseSchedId": course_sched_id,
        "timestamp": str(ts),
        "id": user_id,
    })
    url = f"{ICLASS_HTTP_BASE}/eschool/app/course/stu_scan_sign.action?{qs}"
    status, _, body = _send("POST", url, headers={
        "Sessionid": session_id,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    if status != 200:
        return False, f"签到 HTTP {status}: {body[:200]}"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False, f"签到响应非 JSON: {body[:200]}"
    if data.get("STATUS") == "0" or data.get("status") == "0":
        stu_sign_status = (data.get("result") or {}).get("stuSignStatus", "?")
        return True, f"签到成功 (stuSignStatus={stu_sign_status})"
    err = data.get("ERRMSG") or data.get("message") or body[:200]
    return False, f"签到失败: {err}"


# ───────────────────────────────────────────────
# 通知 / 已签到日期 / 工具
# ───────────────────────────────────────────────

def send_notice(token: str, title: str, desp: str):
    if not token:
        return
    try:
        data = urllib.parse.urlencode({"title": title, "desp": desp}).encode()
        req = urllib.request.Request(
            f"https://sctapi.ftqq.com/{token}.send", data=data, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:
        print(f"[Notice] 推送失败: {e}", file=sys.stderr)


def load_signed_dates(path: str) -> set:
    if not path or not Path(path).exists():
        return set()
    try:
        with open(path) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_signed_dates(path: str, dates: set):
    if not path:
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(list(dates), f)


def parse_class_time(s: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def in_polling_window() -> bool:
    now = datetime.now()
    total_min = now.hour * 60 + now.minute
    return 450 <= total_min <= 1350


def is_time_to_sign(class_begin: str, auto_window: int) -> bool:
    begin_dt = parse_class_time(class_begin)
    if begin_dt is None:
        return False
    now = datetime.now()
    diff = (begin_dt - now).total_seconds()
    return 0 <= diff <= auto_window * 60


# ───────────────────────────────────────────────
# 主循环
# ───────────────────────────────────────────────

async def run_loop(config: SignConfig, logger: logging.Logger):
    running = True

    def on_signal(sig, frame):
        nonlocal running
        logger.info("收到退出信号，正在关闭...")
        running = False

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    # 会话缓存：避免每分钟重新走 SSO
    cached_creds: tuple[str, str] | None = None
    cache_expire = 0.0  # unix 时间戳
    CACHE_TTL = 25 * 60  # 25 分钟（上课时长通常 90-120 分钟，安全一些）

    def ensure_login() -> tuple[str, str] | None:
        nonlocal cached_creds, cache_expire
        now_ts = time.time()
        if cached_creds and now_ts < cache_expire:
            return cached_creds
        if not config.stu_id or not config.stu_pwd:
            logger.error("未配置 stu_id/stu_pwd，无法走 SSO 登录")
            return None
        creds = login_sso_and_class(config.stu_id, config.stu_pwd, logger)
        if creds:
            cached_creds = creds
            cache_expire = now_ts + CACHE_TTL
        return creds

    while running:
        try:
            if not in_polling_window():
                logger.debug("不在轮询窗口 (07:30-22:30) 内，跳过")
                await asyncio.sleep(60)
                continue

            today = datetime.now().strftime("%Y-%m-%d")
            dates = load_signed_dates(config.signed_dates_file)

            if today in dates:
                logger.debug(f"[{datetime.now().strftime('%H:%M')}] 今日已全部签到")
            else:
                creds = ensure_login()
                if not creds:
                    logger.error("登录失败")
                    await asyncio.sleep(config.check_interval)
                    continue
                session_id, user_id = creds

                # 查询课表
                date_yyyymmdd = datetime.now().strftime("%Y%m%d")
                courses = fetch_schedule(session_id, user_id, date_yyyymmdd, logger)
                if not courses:
                    logger.info("今日无课程")
                else:
                    signed = 0
                    for course in courses:
                        cid = course.get("id", "")
                        name = course.get("courseName", "未知")
                        begin = course.get("classBeginTime", "")
                        end = course.get("classEndTime", "")
                        sign_status = course.get("signStatus", "0")

                        if not cid:
                            continue
                        if sign_status == "1":
                            logger.debug(f"已签到，跳过: {name}")
                            continue
                        if not is_time_to_sign(begin, config.auto_window):
                            logger.debug(f"未到签到时间，跳过: {name} (开始 {begin})")
                            continue

                        logger.info(f"开始签到: {name} (课程 {begin})")
                        # 失败重试 2 次（带抖动）
                        success = False
                        last_msg = ""
                        for attempt in range(2):
                            ok, msg = do_sign_in(session_id, user_id, cid, logger)
                            last_msg = msg
                            if ok:
                                success = True
                                break
                            if attempt == 0:
                                jitter = random.randint(1, 5)
                                logger.warning(f"签到失败，{jitter} 秒后重试... ({msg})")
                                await asyncio.sleep(jitter)
                                # 重试前刷新一次登录态（避免会话过期）
                                if "会话" in msg or "登录" in msg or "401" in msg or "4001" in msg:
                                    cached_creds = None
                                    creds = ensure_login()
                                    if creds:
                                        session_id, user_id = creds

                        if success:
                            signed += 1
                            course["signStatus"] = "1"
                            logger.info(f"✅ {name} - {last_msg}")
                        else:
                            logger.warning(f"❌ {name} - {last_msg}")

                        await asyncio.sleep(1.5)

                    now = datetime.now()
                    if signed > 0:
                        title = f"BUAA 签到成功 — {now.strftime('%m-%d %H:%M')}"
                        desp = f"✅ 签到 {signed} 门 | {now.strftime('%H:%M:%S')}"
                        send_notice(config.notice_token, title, desp)
                        dates.add(today)
                        save_signed_dates(config.signed_dates_file, dates)
                        logger.info(f"本次完成: {signed} 门课程")
                    else:
                        logger.info("本次无新签到（可能未到时间或已签）")

        except Exception as e:
            logger.error(f"流程异常: {e}")

        for _ in range(min(config.check_interval, 60)):
            if not running:
                break
            await asyncio.sleep(1)


# ───────────────────────────────────────────────
# 入口
# ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="BUAA iClass 自动签到守护进程 v5")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--once", action="store_true", help="只查课表，不签到")
    args = parser.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        print(f"配置文件不存在: {args.config}", file=sys.stderr)
        print(json.dumps({
            "stu_id": "你的学号",
            "stu_pwd": "统一认证密码",
            "notice_token": "Server酱Token（可选）",
            "auto_window": 9,
            "check_interval": 60,
            "log_file": "/home/tartlab/.local/share/buaasign/buaasign.log",
            "signed_dates_file": "/home/tartlab/.local/share/buaasign/signed_dates.json"
        }, indent=2, ensure_ascii=False))
        sys.exit(1)

    config = SignConfig.from_file(args.config)
    # --once 模式：日志写 stdout；守护进程模式：写文件
    logger = setup_logging("" if args.once else config.log_file)

    if not config.stu_id or not config.stu_pwd:
        logger.error("配置错误: 需要提供 stu_id（学号）和 stu_pwd（统一认证密码）")
        sys.exit(1)

    logger.info("=== BUAA Sign-In 守护进程 v5 启动 ===")
    logger.info(f"学号: {config.stu_id}")
    logger.info(f"签到窗口: 课前 {config.auto_window} 分钟")
    logger.info(f"轮询间隔: {config.check_interval}s")
    logger.info(f"通知: {'已配置' if config.notice_token else '未配置'}")

    if args.once:
        creds = login_sso_and_class(config.stu_id, config.stu_pwd, logger)
        if not creds:
            logger.error("登录失败")
            return
        sid, uid = creds
        date_yyyymmdd = datetime.now().strftime("%Y%m%d")
        courses = fetch_schedule(sid, uid, date_yyyymmdd, logger)
        logger.info(f"今日课程: {len(courses)} 门")
        for c in courses:
            status = "✅ 已签到" if c.get("signStatus") == "1" else "⬜ 未签到"
            logger.info(f"  {status} | {c.get('courseName','?')} | {c.get('classBeginTime','')[:16]} | {c.get('classroomName','')}")
        return

    asyncio.run(run_loop(config, logger))


if __name__ == "__main__":
    main()
