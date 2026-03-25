# BUAA iClass Sign-In

BUAA 课程签到工具，前端通过调用 iClass API 实现查询和签到。

## 部署方案：Cloudflare Pages（免费）

本项目使用 **Cloudflare Pages** 托管，同时提供静态前端和 API 代理函数，无需自建服务器。

### 目录结构

```
/
├── public/              # 静态文件（部署到 Pages）
│   └── index.html      # 前端界面
├── functions/api/       # Cloudflare Pages Functions（API 代理）
│   └── index.js        # 登录 / 查课表 / 签到
├── cloudflare-worker/   # 独立 Worker 版本（可选）
├── .github/workflows/
│   └── deploy.yml      # 自动部署到 Cloudflare Pages
└── wrangler.toml       # Wrangler 配置
```

### 一键部署步骤

#### 1. Fork 本仓库

#### 2. 获取 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **My Profile** → **API Tokens**
3. 点击 **Create Token** → **Create Custom Token**
4. 配置权限：
   - **Account** → **Cloudflare Pages**: `Edit`
5. 复制生成的 Token

#### 3. 获取 Cloudflare Account ID

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com) 右上角点击头像
2. 复制 **Account ID**

#### 4. 配置 GitHub Secrets

在 GitHub 仓库的 **Settings** → **Secrets and variables** → **Actions** 中添加：

| Secret Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 你的 Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |

#### 5. 推送代码

将代码推送到 `main` 分支，GitHub Actions 会自动：
1. 构建前端
2. 部署到 Cloudflare Pages
3. API 函数自动响应 `/api/*` 路由

部署完成后访问：`https://buaa-iclass.<your-account>.pages.dev`

### 本地调试

```bash
# 安装 Wrangler
npm install -g wrangler

# 启动本地预览
wrangler pages dev public

# 预览带函数
wrangler pages dev public --compatibility-flag=nodejs_compat
```

### 本地开发（不依赖 Cloudflare）

如果只想本地使用，可直接编辑 `BUAA-iClassSignIn-main/main.py`，填入学号后运行 `python main.py`。

## 架构说明

- **前端**（`public/`）：纯静态 HTML/JS/CSS，无构建步骤
- **API 代理**（`functions/api/`）：Cloudflare Workers，将 iClass API 响应包装并添加 CORS 头，解决跨域问题
- **自动部署**：GitHub Actions + Cloudflare Pages，push 即部署

## 免责声明

本工具仅用于个人学习与研究交流，请勿用于违反学校规定的用途。使用本工具造成的一切后果由使用者自行承担。
