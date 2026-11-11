#!/usr/bin/env bash
# Manual command-line PostgreSQL + uploads backup. Scheduled backups now run from the panel
# (Admin → Setup → Database Backups); this script no longer deletes anything.
set -euo pipefail
ENV_FILE="${ENV_FILE:-$(dirname "$(readlink -f "$0")")/../apps/api/.env}"
[ -f "$ENV_FILE" ] || ENV_FILE=$(ls /home/*/crapplet-panel/apps/api/.env /opt/crapplet-panel/apps/api/.env 2>/dev/null | head -1)
DB_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
DEST=/var/backups/crapplet
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST"
pg_dump --format=custom --no-owner "$DB_URL" > "$DEST/db-$STAMP.dump"
tar -czf "$DEST/uploads-$STAMP.tgz" -C /var/lib/crapplet uploads 2>/dev/null || true
echo "$(date -Is) backup ok: $DEST/db-$STAMP.dump ($(du -h "$DEST/db-$STAMP.dump" | cut -f1))"
# Restore: pg_restore --clean --no-owner -d "$DB_URL" /var/backups/crapplet/db-YYYYMMDD-HHMM.dump
