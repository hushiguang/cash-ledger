#!/usr/bin/env bash
# 在 NAS 上从 git 拉取最新代码并启动（或更新）服务。
# 配置文件和数据目录都放在 NAS 的固定路径下，不跟着代码走，重建容器也不丢。
#
# 首次部署：
#   ENV_FILE=/vol1/1000/docker/cash/.env \
#   DATA_PATH=/vol1/1000/docker/cash/data \
#   IMAGE_HOST_URL=https://image.example.com/api/index.php \
#   IMAGE_HOST_TOKEN=你的token \
#   ./scripts/deploy.sh
#
# 更省事的做法：cp deploy.conf.example deploy.conf 填一次，之后只跑：
#   ./scripts/deploy.sh
# 配置存在 deploy.conf 里（不进 git），命令行传同名变量可以临时覆盖。
#
# 可选：
#   SEED_DB=/path/to/ledger.db   首次把已有数据库放进数据目录
#   SKIP_PULL=1                  不拉代码，用当前目录的代码启动
#   NO_BUILD=1                   不重新构建镜像（只改配置时用）
#   ALLOW_REGISTER=false         开关注册
#   PORT=10091                   改端口
#   NETWORK_MODE=host            用宿主机网络（外部服务只有 IPv6 时必须开）

set -euo pipefail
cd "$(dirname "$0")/.."

# 0. 读 deploy.conf（本地配置，不进 git）。命令行传进来的同名变量优先。
CONF_FILE="${DEPLOY_CONF:-deploy.conf}"
conf_val() {
  [ -f "$CONF_FILE" ] || return 0
  awk -F= -v k="$1" '
    /^[[:space:]]*#/ { next }
    $1 == k { sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit }
  ' "$CONF_FILE"
}
pick() {                       # pick 配置名 命令行传入的值
  if [ -n "$2" ]; then printf '%s' "$2"; else conf_val "$1"; fi
}

ENV_FILE="$(pick ENV_FILE "${ENV_FILE:-}")"
DATA_PATH="$(pick DATA_PATH "${DATA_PATH:-}")"
IMAGE_HOST_URL="$(pick IMAGE_HOST_URL "${IMAGE_HOST_URL:-}")"
IMAGE_HOST_TOKEN="$(pick IMAGE_HOST_TOKEN "${IMAGE_HOST_TOKEN:-}")"
JWT_SECRET="$(pick JWT_SECRET "${JWT_SECRET:-}")"
ALLOW_REGISTER="$(pick ALLOW_REGISTER "${ALLOW_REGISTER:-}")"
PORT="$(pick PORT "${PORT:-}")"
NETWORK_MODE="$(pick NETWORK_MODE "${NETWORK_MODE:-}")"

# 1. 配置文件（不在代码目录里也行，用 ENV_FILE 指定）
ENV_FILE="${ENV_FILE:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cp .env.example "$ENV_FILE"
  echo "已用 .env.example 生成配置：$ENV_FILE"
fi

set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" '
    { if (substr($0, 1, length(k) + 1) == k "=") { print k "=" v; found = 1 } else print }
    END { if (!found) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

[ -n "${IMAGE_HOST_URL:-}" ]   && set_env IMAGE_HOST_URL "$IMAGE_HOST_URL"
[ -n "${IMAGE_HOST_TOKEN:-}" ] && set_env IMAGE_HOST_TOKEN "$IMAGE_HOST_TOKEN"
[ -n "${JWT_SECRET:-}" ]       && set_env JWT_SECRET "$JWT_SECRET"
[ -n "${ALLOW_REGISTER:-}" ]   && set_env ALLOW_REGISTER "$ALLOW_REGISTER"
[ -n "${PORT:-}" ]             && set_env PORT "$PORT"
[ -n "${DATA_PATH:-}" ]        && set_env DATA_PATH "$DATA_PATH"

# 2. 数据目录（数据库、jwt.secret 都在这里）
DATA_PATH="$(awk -F= '/^DATA_PATH=/ {print $2}' "$ENV_FILE" | tr -d '"')"
DATA_PATH="${DATA_PATH:-./data}"
mkdir -p "$DATA_PATH"
echo "数据目录：$DATA_PATH"

if [ ! -f "$DATA_PATH/ledger.db" ] && [ -n "${SEED_DB:-}" ] && [ -f "$SEED_DB" ]; then
  cp "$SEED_DB" "$DATA_PATH/ledger.db"
  echo "已放入已有数据库：$SEED_DB"
fi
if [ ! -f "$DATA_PATH/ledger.db" ]; then
  echo "提示：$DATA_PATH/ledger.db 不存在，启动后是空库，访问页面注册第一个账号（自动成为管理员）"
fi

# 3. 拉最新代码
if [ "${SKIP_PULL:-0}" != "1" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git remote -v)" ]; then
    git pull --ff-only || echo "git pull 没成功，继续用当前目录的代码"
  else
    echo "没有配置 git remote，跳过拉取"
  fi
fi

# 4. 选 compose 文件与命令
# NETWORK_MODE=host 时生成一份本地 compose（不进 git，拉取代码不会被覆盖），
# 容器直接用宿主机网络，外部服务只有 IPv6 地址时也能连上。
COMPOSE_FILE=docker-compose.yml
if [ "${NETWORK_MODE:-}" = "host" ]; then
  COMPOSE_FILE=docker-compose.host.yml
  sed -e 's|^    ports:|    network_mode: host|' \
      -e '/^      - "\${PORT:-8080}:\${PORT:-8080}"$/d' \
      docker-compose.yml > "$COMPOSE_FILE"
  echo "网络模式：host（已生成 $COMPOSE_FILE）"
fi

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
else
  echo "没找到 docker compose，先装：sudo apt install -y docker-compose-plugin"
  exit 1
fi

# 5. 启动
if [ "${NO_BUILD:-0}" = "1" ]; then
  "${DC[@]}" up -d
else
  "${DC[@]}" up -d --build
fi

"${DC[@]}" ps

PORT="$(awk -F= '/^PORT=/ {print $2}' "$ENV_FILE" | tr -d '"')"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "完成，访问：http://${IP:-本机IP}:${PORT:-8080}"
