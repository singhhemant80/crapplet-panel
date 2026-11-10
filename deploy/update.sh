#!/usr/bin/env bash
# Update an existing Crapplet Panel install in place — no curl | bash needed:
#
#   sudo bash /opt/crapplet-panel/deploy/update.sh
#
# Pulls the latest code (git), then runs deploy/install.sh, which rebuilds, applies database
# migrations and reloads PM2. The domain is read from apps/api/.env; .env, database and uploads are kept.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${BRANCH:-main}"
[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

if [ -z "${DOMAIN:-}" ] && [ -f "$ROOT/apps/api/.env" ]; then
  DOMAIN="$(grep -E '^APP_URL=' "$ROOT/apps/api/.env" | cut -d= -f2- | sed -E 's#^https?://##; s#/.*$##; s#:.*$##')"
fi
[ -n "${DOMAIN:-}" ] || { echo "Couldn't read the domain from apps/api/.env — run: sudo DOMAIN=your.domain bash $0"; exit 1; }

echo "==> Checking connection to GitHub"
if ! timeout 20 git ls-remote --heads "$(git -C "$ROOT" remote get-url origin)" "$BRANCH" >/dev/null 2>&1; then
  echo "!! Can't reach GitHub from this server within 20 seconds."
  echo "   Check:  getent hosts github.com      (DNS)"
  echo "           curl -4 -sSI https://github.com | head -1"
  echo "   If DNS fails, add a resolver:  echo 'nameserver 1.1.1.1' >> /etc/resolv.conf"
  exit 1
fi

echo "==> Pulling the latest code (${BRANCH})"
git config --global --add safe.directory "$ROOT" 2>/dev/null || true
OLD="$(git -C "$ROOT" rev-parse --short HEAD)"
timeout 300 git -C "$ROOT" fetch --depth 1 origin "$BRANCH"
git -C "$ROOT" reset --hard "origin/$BRANCH"
echo "    ${OLD} → $(git -C "$ROOT" rev-parse --short HEAD): $(git -C "$ROOT" log -1 --format=%s)"

export DOMAIN
exec bash "$ROOT/deploy/install.sh"
