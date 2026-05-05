#!/usr/bin/env bash
#
# Deploy the AICP SOP console (frontend static + Node backend) to the Aliyun
# server. Designed to be safe to re-run during a live drill.
#
# Usage:
#   ./deploy.sh                              # default host/path
#   ./deploy.sh root@1.2.3.4 /opt/aicp-sop/  # override
#
# Environment overrides:
#   PORT       SSH port (default 50022)
#   APP_PORT   Node listen port on remote (default 3000)
#   SERVICE    systemd service name (default aicp-sop)
#   SSHPASS    if set + sshpass installed, used for password auth (NOT recommended)
#   DRY_RUN=1  print rsync commands without executing
#
# Recommended: use SSH key auth (ssh-copy-id) and leave SSHPASS unset.
#
set -euo pipefail

HOST="${1:-root@47.102.216.22}"
TARGET="${2:-/var/www/html/sop/}"
PORT="${PORT:-50022}"
APP_PORT="${APP_PORT:-3000}"
SERVICE="${SERVICE:-aicp-sop}"

# Keep host-key checking ON. The first connect will prompt; pin the host key
# in ~/.ssh/known_hosts and subsequent runs will be silent and MITM-safe.
SSH_OPTS="-p ${PORT} -o StrictHostKeyChecking=accept-new"

SSH=(ssh ${SSH_OPTS} "$HOST")
RSYNC=(rsync -avz --delete -e "ssh ${SSH_OPTS}")

if [[ -n "${SSHPASS:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "SSHPASS set but sshpass not installed. brew install hudochenkov/sshpass/sshpass" >&2
    exit 1
  fi
  echo "WARNING: SSHPASS in use. Switch to ssh keys when possible." >&2
  SSH=(sshpass -e ssh ${SSH_OPTS} "$HOST")
  RSYNC=(sshpass -e rsync -avz --delete -e "ssh ${SSH_OPTS}")
fi

if [[ "${DRY_RUN:-}" == "1" ]]; then
  RSYNC=("${RSYNC[@]}" --dry-run)
  echo "[dry-run] commands will be printed but not executed"
fi

echo ">> syncing static frontend to $HOST:$TARGET"
"${RSYNC[@]}" \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude "deploy.sh" \
  --exclude "server/data/" \
  --exclude "server/node_modules/" \
  --exclude "server/package-lock.json" \
  --exclude "server/smoke-test.mjs" \
  ./ "$HOST:$TARGET"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "[dry-run] would now: npm install on remote and restart $SERVICE"
  exit 0
fi

echo ">> installing backend deps + restarting service on remote"
"${SSH[@]}" bash -s <<EOF
set -euo pipefail
cd "$TARGET/server"
if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed on the remote. Install Node 18+ first." >&2
  exit 1
fi
npm install --omit=dev --no-audit --no-fund
mkdir -p data/uploads
if systemctl list-unit-files | grep -q '^${SERVICE}.service'; then
  systemctl restart ${SERVICE}.service
  systemctl --no-pager status ${SERVICE}.service | head -15 || true
else
  echo "WARN: ${SERVICE}.service not found. See server/README.md for systemd setup." >&2
fi
EOF

echo ">> done. Public URL: http://47.102.216.22/sop/"
