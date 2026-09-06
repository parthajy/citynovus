#!/usr/bin/env bash
# Ship the current folder to the droplet and restart. Run from your laptop in the repo root:
#   deploy/deploy.sh
set -euo pipefail
HOST="${HOST:-root@168.144.127.72}"
rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude .env --exclude .git ./ "$HOST:/opt/citynovus/"
ssh "$HOST" 'cd /opt/citynovus && docker compose up -d --build && docker compose ps'
echo "deployed. health:"; curl -s https://citynovus.com/api/health || true; echo
