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

## iClass API Endpoints

- Login: `https://iclass.buaa.edu.cn:8347/app/user/login.action`
- Schedule: `https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action`
- Sign-in: `https://iclass.buaa.edu.cn:8347/app/course/stu_scan_sign.action`

## Important Notes

- `iclass.buaa.edu.cn` resolves to `10.20.11.166` (internal BUAA IP). The proxy must connect directly, not through external proxies.
- The iClass API returns HTTP redirects that must be followed with HTTPS forced (port 8347 only accepts HTTPS).
- The iClass certificate is self-signed, so `rejectUnauthorized: false` is needed in Node.js HTTPS requests.
- Sign-in is only allowed between 10 minutes before class start and class end time.

## Python Version

- CLI: edit `student_id` in `main.py`, run `python main.py`.
- SSO CLI: edit `stu_id`/`stu_pwd` in `password_ver.py`, run `python password_ver.py`.
- GUI: `pip install requests aiohttp` then `python BUAA-iClassSignIn-main/remotesign/main.py`.
