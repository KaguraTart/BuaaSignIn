# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BUAA course sign-in tool. Has two modes:

1. **Cloudflare Pages deployment** (recommended) — static frontend + API proxy functions, auto-deploys via GitHub Actions.
2. **`BUAA-iClassSignIn-main/`** — standalone Python CLI/GUI tool calling iClass APIs directly.

## Architecture (Cloudflare Pages)

```
public/             → Cloudflare Pages static files
functions/api/      → Cloudflare Pages Functions (API proxy, handles CORS)
cloudflare-worker/  → Standalone Worker (alternative deployment)
.github/workflows/  → GitHub Actions auto-deploy
```

## Key Files

- **`public/index.html`** — Modern single-page frontend. API_BASE = '' (same-origin).
- **`functions/api/index.js`** — Proxy for iClass APIs, adds CORS headers.
  - `GET /api/status` — Health check
  - `GET /api/login?phone={id}` — Login, returns `{userId, sessionId}`
  - `GET /api/schedule?dateStr={YYYYMMDD}&userId=&sessionId=` — Query schedule
  - `POST /api/sign` body `{courseSchedId, userId}` — Sign in
- **`.github/workflows/deploy.yml`** — Pushes to main → auto-deploys to Cloudflare Pages.
- **`BUAA-iClassSignIn-main/main.py`** — Python CLI sign-in (phone-based login).
- **`BUAA-iClassSignIn-main/password_ver.py`** — Python CLI sign-in (SSO-based login).
- **`BUAA-iClassSignIn-main/remotesign/`** — Tkinter GUI version.

## iClass API Endpoints

- Login: `GET https://iclass.buaa.edu.cn:8347/app/user/login.action?phone={id}&...`
- Schedule: `GET https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action?dateStr=&id=` (header: `sessionId`)
- Sign-in: `POST http://iclass.buaa.edu.cn:8081/app/course/stu_scan_sign.action?courseSchedId=&timestamp=` (body: `id={userId}`)

## Deployment (Cloudflare Pages)

1. Fork repo.
2. Create Cloudflare API token (Account → Cloudflare Pages: Edit).
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to GitHub Secrets.
4. Push to `main` → GitHub Actions auto-deploys.

Local preview: `wrangler pages dev public`

## Running Python Version

- CLI: edit `student_id` in `main.py`, run `python main.py`.
- SSO CLI: edit `stu_id`/`stu_pwd` in `password_ver.py`, run `python password_ver.py`.
- GUI: `pip install requests aiohttp` then `python BUAA-iClassSignIn-main/remotesign/main.py`.
- Build GUI to exe: `pyinstaller BUAA-iClassSignIn-main/remotesign/main.spec`.
