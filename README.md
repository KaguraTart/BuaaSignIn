# BUAA iClass Sign-In

BUAA 课程签到工具，基于智慧教室扫码签到 API 实现。

## 架构

```
public/          → 前端静态文件（Cloudflare Pages 托管）
functions/api/   → Cloudflare Pages Functions（API 代理，解决跨域）
BUAA-iClassSignIn-main/ → 独立 Python 版（无需网络）
```

## 部署到 Cloudflare Pages（免费）

### 方式：Dashboard 连接 GitHub（推荐）

1. 打开 👉 https://dash.cloudflare.com/?to=/pages
2. 点击 **"Create a project"**
3. 选择 **"Import Git repository"**
4. 选择仓库 `KaguraTart/BuaaSignIn`，分支选 `main`
5. 构建设置：
   - **Build command**：留空
   - **Build output directory**：`public`
6. 点击 **"Save and Deploy"**

部署完成后，访问 `https://buaa-iclass.<你的子域名>.pages.dev`

> 每次 push 到 `main` 分支都会自动重新部署。

### 重要：API 代理说明

BUAA iClass API (`iclass.buaa.edu.cn`) **没有 CORS 头**，浏览器直接调用会被拦截。

本项目通过 `functions/api/index.js`（Cloudflare Pages Functions）代理请求：
- `GET /api/status` — 健康检查
- `GET /api/login?phone=学号` — 登录获取 session
- `GET /api/schedule?dateStr=&userId=&sessionId=` — 查询课表
- `POST /api/sign` body `{courseSchedId, userId}` — 签到

前端直接调用 `/api/*` 即可，由 Cloudflare 自动添加 CORS 头。

## 独立 Python 版（无需部署）

不想用网页版？`BUAA-iClassSignIn-main/` 目录下有独立的 Python 工具：

```bash
# 快速签到（只需学号）
cd BUAA-iClassSignIn-main
# 编辑 main.py，填入 student_id
python main.py

# SSO 版（需要账号密码）
# 编辑 password_ver.py，填入 stu_id 和 stu_pwd
python password_ver.py

# GUI 版
pip install requests aiohttp
python BUAA-iClassSignIn-main/remotesign/main.py
```

## 免责声明

本工具仅用于个人学习与研究交流，请勿用于违反学校规定的用途。使用本工具造成的一切后果由使用者自行承担。
