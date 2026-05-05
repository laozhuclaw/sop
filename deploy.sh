#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-root@47.102.216.22}"
TARGET="${2:-/var/www/html/sop/}"

rsync -avz --delete \
  --exclude ".git" \
  --exclude "deploy.sh" \
  ./ "$HOST:$TARGET"

echo "Deployed to http://47.102.216.22/sop/"

