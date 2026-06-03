#!/bin/bash
set -e

CONFIG="/home/tartlab/project/others/BUAASign/config.json"
DATA_DIR="/home/tartlab/.local/share/buaasign"

echo "=== BUAA iClass 自动签到配置向导 v2 ==="
echo ""

read -p "手机号（iClass 登录账号）: " PHONE
read -sp "iClass 密码（可留空）: " PASSWORD
echo ""
read -p "Server酱 Token (直接回车跳过): " NOTICE_TOKEN
read -p "检查间隔秒数 [60]: " INTERVAL
INTERVAL=${INTERVAL:-60}

mkdir -p "$DATA_DIR"

cat > "$CONFIG" << EOF
{
  "phone": "$PHONE",
  "iclass_password": "$PASSWORD",
  "notice_token": "$NOTICE_TOKEN",
  "check_interval": $INTERVAL,
  "log_file": "$DATA_DIR/buaasign.log",
  "signed_dates_file": "$DATA_DIR/signed_dates.json"
}
EOF

# 防止密码提交
if [ -d .git ]; then
    if ! grep -q "config.json" .gitignore 2>/dev/null; then
        echo "config.json" >> .gitignore
    fi
fi

echo ""
echo "✅ 配置完成！"
echo ""
echo "测试运行（一次）："
echo "  python3 /home/tartlab/project/others/BUAASign/buaasign_daemon.py --config /home/tartlab/project/others/BUAASign/config.json --once"
echo ""
echo "启动守护进程（自动）："
echo "  sudo systemctl restart buaasign.service"
echo "  sudo systemctl status buaasign.service"
