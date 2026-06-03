# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BUAA course sign-in tool with two modes:

1. **Cloudflare Tunnel + Node.js** — Local proxy + cloudflared tunnel for public access
2. **`BUAA-iClassSignIn-main/`** — Standalone Python CLI/GUI tool

## Architecture

```
Browser
  ↓ (public URL)
cloudflared quick tunnel (trycloudflare.com, changes on restart)
  ↓
proxy.js (localhost:8787) → BUAA iClass (内网)
```

## Key Files

- **`proxy.js`** — Standalone Node.js server. Runs on port 8787. Serves frontend + proxies all API requests to BUAA iClass.
  - Connects directly to `iclass.buaa.edu.cn` (no proxy)
  - Auto-follows HTTP redirects, forces HTTPS
  - Requires `node >= 18`

- **`worker.js`** — Cloudflare Workers entry point (legacy, not currently used)

- **`public/index.html`** — Frontend static files (for Cloudflare Pages deployment)

- **`functions/api/index.js`** — Cloudflare Pages Functions version (alternative)

- **`BUAA-iClassSignIn-main/`** — Standalone Python sign-in tool

## Running the Tool

```bash
# Terminal 1: Start proxy server
node proxy.js

# Terminal 2: Create public tunnel
cloudflared tunnel --url http://localhost:8787

# Access via the generated trycloudflare.com URL
```

For a permanent URL, create a named Cloudflare Tunnel via the Cloudflare Dashboard.

## iClass API Endpoints (v5, 2026-06-01 改造)

按端口/路径分组（端口不能混用）：

| 用途 | 端口 | 协议 | 路径 |
|---|---|---|---|
| SSO 登录页 | 443 | HTTPS | `sso.buaa.edu.cn/login` |
| 拿 loginName | 8346 | HTTPS | `iclass.buaa.edu.cn:8346/?type=jumpMyCenter`（重定向链里含 `loginName=...`） |
| Class 登录 | 8346 | HTTPS | `eschool/app/user/login_buaa.do?phone={loginName}&...` |
| 课表 | 8347 | HTTPS | `app/course/get_stu_course_sched.action?dateStr=...&id=...` |
| 服务器时间 | 8081 | HTTP | `app/common/get_timestamp.action` |
| 签到 | 8081 | HTTP | `eschool/app/course/stu_scan_sign.action?courseSchedId=...&timestamp=...&id=...` |

所有 Class API 请求必须带 `Sessionid: {loginName}` header（即从 SSO 跳回的 URL 里的 `loginName=...`）。

## 登录流程 (v5)

1. POST `https://sso.buaa.edu.cn/login` 学号密码 → 拿 `CASTGC` cookie
2. GET `https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter` 带 CASTGC → 跟随重定向链 → 拿到 `loginName=xxx`
3. GET `https://iclass.buaa.edu.cn:8346/eschool/app/user/login_buaa.do?phone={loginName}&...` → 拿 `id`
4. token = `{loginName}@{id}`，用 `Sessionid: {loginName}` header 调后续 API

## 重要说明

- `iclass.buaa.edu.cn` 解析到内网 IP `10.20.11.166`，proxy.js / daemon 直连不经过代理
- iClass 使用自签名证书，`rejectUnauthorized: false` 已配置
- 签到窗口：课前 10 分钟至下课
- **不再需要 offset 二分搜索**：服务器时间戳从 `/app/common/get_timestamp.action` 直接拿
- **loginName 有效期短**：每次开 daemon 重新走 SSO 拿
- **端口/协议固定**：登录 8346/https，课表 8347/https，签到+时间戳 8081/http

## Python Version

- CLI: edit `student_id` in `main.py`, run `python main.py`.
- SSO CLI: edit `stu_id`/`stu_pwd` in `password_ver.py`, run `python password_ver.py`.
- GUI: `pip install requests aiohttp` then `python BUAA-iClassSignIn-main/remotesign/main.py`.
