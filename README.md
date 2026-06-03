# BUAA iClass Sign-In

BUAA 课程签到工具，基于智慧教室扫码签到 API 实现。

## 当前架构

```
用户浏览器
    ↓ (https://iclass.kaguratart.com)
cloudflared tunnel (systemd 服务，持久运行)
    ↓
proxy.js (localhost:8787) → BUAA iClass (内网)
    ↓
buaasign_daemon.py (systemd) → 自动轮询 + 签到
```

- **`proxy.js`** — Node.js 代理服务器，前端页面 + 转发 API 请求到 BUAA 内网
- **`buaasign_daemon.py`** — Python 守护进程，每分钟查课表、课前 9 分钟自动签到
- **`cloudflared.service`** — systemd 服务，通过 Cloudflare Tunnel 将本地服务暴露到公网
- **域名**：`iclass.kaguratart.com`

## 服务启动

### 方式一：systemd（推荐）

```bash
# 启动所有相关服务
sudo systemctl start buaasign-proxy.service
sudo systemctl start buaasign.service
sudo systemctl start buaasign.timer
sudo systemctl start cloudflared

# 状态
systemctl status buaasign-proxy buaasign buaasign.timer cloudflared
```

### 方式二：手动 nohup（systemd 不可用时）

```bash
cd /home/tartlab/project/others/BUAASign
nohup node proxy.js > /tmp/proxy.log 2>&1 &
nohup python3 buaasign_daemon.py --config config.json \
    >> /home/tartlab/.local/share/buaasign/buaasign.log 2>&1 &
```

## API 端点 (v5)

| 用途 | 端口/协议 | 路径 |
|---|---|---|
| SSO 登录 | 443/HTTPS | `sso.buaa.edu.cn/login` |
| 拿 loginName | 8346/HTTPS | `?type=jumpMyCenter`（重定向链里含 `loginName=...`） |
| Class 登录 | 8346/HTTPS | `eschool/app/user/login_buaa.do` |
| 课表 | 8347/HTTPS | `app/course/get_stu_course_sched.action` |
| 服务器时间 | 8081/HTTP | `app/common/get_timestamp.action` |
| 签到 | 8081/HTTP | `eschool/app/course/stu_scan_sign.action` |

所有 Class API 请求必须带 `Sessionid: {loginName}` header。

## 配置

`config.json`（已加入 `.gitignore`）：

```json
{
  "stu_id": "你的学号",
  "stu_pwd": "统一认证密码",
  "notice_token": "Server酱Token（可选）",
  "auto_window": 9,
  "check_interval": 60,
  "log_file": "/home/tartlab/.local/share/buaasign/buaasign.log",
  "signed_dates_file": "/home/tartlab/.local/share/buaasign/signed_dates.json"
}
```

## 公开访问

- **正式域名**：https://iclass.kaguratart.com
- **Workers 域名**：https://iclass.kaguratart.workers.dev

## 重要说明

- `iclass.buaa.edu.cn` 解析到内网 IP，proxy.js 直连不经过代理
- iClass 使用自签名证书，`rejectUnauthorized: false` 已配置
- 签到窗口：课前 10 分钟至下课
- **不再需要 offset 二分搜索**：服务器时间戳从 `/app/common/get_timestamp.action` 直接拿
- **loginName 有效期短**：daemon 每 25 分钟会重新走 SSO 拿

## 独立 Python 版（无需网络，可离线使用）

```bash
cd BUAA-iClassSignIn-main

# 快速版（只需学号，遍历课表找当前课程）
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
