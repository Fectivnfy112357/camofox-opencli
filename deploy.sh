#!/usr/bin/env bash
#
# deploy.sh — 在服务器上拉取最新代码、重建镜像并启动 camofox-opencli。
#
# 用法(在服务器仓库目录 /www/dk_project/dk_app/camofox-opencli/ 下):
#   ./deploy.sh              # 拉取 + 同步 submodule + 重建 + 启动 + 验证
#   ./deploy.sh --no-build   # 只拉取 + 重启(源码没变时用,秒级)
#   ./deploy.sh --logs       # 部署完 tail 网关日志
#
# 幂等:重复执行安全。docker compose 仅在源码 hash 变化时全量 build。
set -euo pipefail

cd "$(dirname "$0")"

BUILD=1
FOLLOW_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --logs)     FOLLOW_LOGS=1 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# docker compose v2 优先,回退到 v1 的 docker-compose
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "找不到 docker compose / docker-compose" >&2; exit 1
fi

echo "==> [1/5] 拉取主仓库最新代码"
git pull --rebase

echo "==> [2/5] 同步 submodule 到主仓库记录的指针"
# 用 --remote 会跟到子仓库分支 HEAD,可能超前于主仓库指针;这里只同步到
# 主仓库提交里锁定的指针,保证与刚 git pull 的内容一致。
# --force:子仓库历史里曾跟踪 node_modules(现已剔除),工作区残留文件会
# 让普通 checkout 因"本地修改将被覆盖"而失败;强制覆盖即可(构建产物,
# Docker 内会重新 npm ci)。
git submodule update --init --recursive --force || {
  echo "    submodule checkout 冲突,清理残留后重试..."
  git submodule foreach --recursive 'git reset --hard && git clean -fdx' || true
  git submodule update --init --recursive --force
}

if [ "$BUILD" -eq 1 ]; then
  echo "==> [3/5] 重建镜像(源码 hash 变化时全量 build,约 5-10 分钟)"
  $DC build
else
  echo "==> [3/5] 跳过 build (--no-build)"
fi

echo "==> [4/5] 启动容器"
$DC up -d

echo "==> [5/5] 验证"
# 等网关起来(最多 ~30s)
# 宿主端口:优先 .env 里的 GATEWAY_EXPOSE_PORT(服务器常改成 9378),
# 否则回退到 compose 的默认 8080。API key 同理,.env 覆盖 compose。
[ -f .env ] && set -a && . ./.env && set +a || true
API_KEY="${GATEWAY_API_KEY:-$(grep -oP 'GATEWAY_API_KEY:\s*"\K[^"]+' docker-compose.yml || true)}"
PORT="${GATEWAY_EXPOSE_PORT:-8080}"
HDR=()
[ -n "$API_KEY" ] && HDR=(-H "Authorization: Bearer $API_KEY")

ok=0
for i in $(seq 1 15); do
  if curl -fsS "${HDR[@]}" "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done
if [ "$ok" -eq 1 ]; then
  echo "    ✓ 网关健康检查通过 (:${PORT}/health)"
else
  echo "    ✗ 网关未在 30s 内就绪 — 查看 logs/gateway/ 或 '$DC logs gateway'" >&2
fi

# MCP 并发探活:8 并发不应触发熔断(本次修复的核心)
echo "    → 8 并发 /health 探活(验证 MCP 并发修复)"
codes=$(for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " "${HDR[@]}" "http://localhost:${PORT}/health" &
done; wait)
echo "      HTTP: ${codes}"

echo "    → 宿主机日志目录:"
ls -la logs/gateway/ 2>/dev/null || echo "      (logs/gateway 尚未生成,首个请求后出现)"

echo "==> 部署完成"

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  echo "==> tail 网关日志 (Ctrl-C 退出)"
  tail -f logs/gateway/gateway.log
fi
