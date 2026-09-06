#!/usr/bin/env bash
# Nightly Postgres dump. On the droplet: crontab -e →  15 2 * * * /app/scripts/backup.sh
# Managed Postgres on DigitalOcean also keeps its own daily backups; this is the copy you control.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="${BACKUP_DIR:-/data/backups}"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M)
pg_dump "$DATABASE_URL" | gzip > "$DIR/citynovus-$STAMP.sql.gz"
# keep 30 days
find "$DIR" -name 'citynovus-*.sql.gz' -mtime +30 -delete
echo "backup written: $DIR/citynovus-$STAMP.sql.gz"
