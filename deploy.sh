#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-root@47.102.216.22}"
TARGET="${2:-/var/www/html/sop/}"
PORT="${PORT:-50022}"

SSH_OPTS="-p ${PORT} -o StrictHostKeyChecking=no"
RSYNC=(rsync -avz --delete -e "ssh ${SSH_OPTS}")

if [[ -n "${SSHPASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  RSYNC=(sshpass -e "${RSYNC[@]}")
fi

"${RSYNC[@]}" \
  --exclude ".git" \
  --exclude "deploy.sh" \
  ./ "$HOST:$TARGET"

echo "Deployed to http://47.102.216.22/sop/"
