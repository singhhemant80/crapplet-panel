#!/usr/bin/env bash
# Nightly PostgreSQL + uploads backup. Keeps 14 days locally; copy /var/backups/crapplet off-site (rclone/rsync).
set -euo pipefail
ENV_FILE="${ENV_FILE:-$(dirname "$(readlink -f "$0")")/../apps/api/.env}"
[ -f "$ENV_FILE" ] || ENV_FILE=$(ls /home/*/crapplet-panel/apps/api/.env /opt/crapplet-panel/apps/api/.env 2>/dev/null | head -1)
DB_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
DEST=/var/backups/crapplet
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST"
pg_dump --format=custom --no-owner "$DB_URL" > "$DEST/db-$STAMP.dump"
tar -czf "$DEST/uploads-$STAMP.tgz" -C /var/lib/crapplet uploads 2>/dev/null || true
find "$DEST" -type f -mtime +14 -delete
echo "$(date -Is) backup ok: $DEST/db-$STAMP.dump ($(du -h "$DEST/db-$STAMP.dump" | cut -f1))"
# Restore: pg_restore --clean --no-owner -d "$DB_URL" /var/backups/crapplet/db-YYYYMMDD-HHMM.dump
