# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BUAA course sign-in tool with two modes:

1. **Cloudflare Pages deployment** — static frontend + API proxy functions. Deploy by connecting GitHub repo in Cloudflare Dashboard.
2. **`BUAA-iClassSignIn-main/`** — standalone Python CLI/GUI tool.

## Architecture

```
public/             → Frontend static files (served by Cloudflare Pages)
functions/api/     → Cloudflare Pages Functions (API proxy, adds CORS headers)
BUAA-iClassSignIn-main/ → Standalone Python sign-in tool
```

## Key Files

- **`public/index.html`** — Frontend SPA. Calls `/api/*` (same-origin).
- **`functions/api/index.js`** — Proxy for BUAA iClass APIs.
  - `GET /api/status` — Health check
  - `GET /api/login?phone={id}` — Login, returns `{userId, sessionId}`
  - `GET /api/schedule?dateStr=&userId=&sessionId=` — Query schedule
  - `POST /api/sign` body `{courseSchedId, userId}` — Sign in
- **`BUAA-iClassSignIn-main/main.py`** — Python CLI sign-in (phone-based login).
- **`BUAA-iClassSignIn-main/password_ver.py`** — Python CLI (SSO-based login).
- **`BUAA-iClassSignIn-main/remotesign/`** — Tkinter GUI version.

## Deployment (Cloudflare Pages)

1. Go to https://dash.cloudflare.com/?to=/pages
2. Create project → Import Git repository → select `KaguraTart/BuaaSignIn`
3. Build settings: Build command = empty, Output directory = `public`
4. Save and Deploy

Every push to `main` auto-deploys.

## iClass API Endpoints

- Login: `GET https://iclass.buaa.edu.cn:8347/app/user/login.action?phone={id}&...`
- Schedule: `GET https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action?dateStr=&id=` (header: `sessionId`)
- Sign-in: `POST http://iclass.buaa.edu.cn:8081/app/course/stu_scan_sign.action?courseSchedId=&timestamp=` (body: `id={userId}`)

## Running Python Version

- CLI: edit `student_id` in `main.py`, run `python main.py`.
- SSO CLI: edit `stu_id`/`stu_pwd` in `password_ver.py`, run `python password_ver.py`.
- GUI: `pip install requests aiohttp` then `python BUAA-iClassSignIn-main/remotesign/main.py`.
- Build GUI to exe: `pyinstaller BUAA-iClassSignIn-main/remotesign/main.spec`.
