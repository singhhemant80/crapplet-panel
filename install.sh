#!/usr/bin/env bash
# One-command installer for Crapplet Panel (Ubuntu 24.04, run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/singhhemant80/crapplet-panel/main/install.sh | sudo bash -s -- --domain crapplet.co.in --email admin@crapplet.co.in
#
# Options:  --domain <domain>    (required)  site domain, e.g. crapplet.co.in
#           --email <email>      admin login + Let's Encrypt contact (default admin@<domain>)
#           --no-ssl             skip the Let's Encrypt certificate
#           --demo               also seed demo data (test server, IP range, demo customer)
#           --dir <path>         install directory (default /opt/crapplet-panel)
#           --branch <name>      git branch (default main)
# Re-running the same command updates an existing install (git pull + rebuild + migrations); data is kept.
# Faster update that doesn't need this download:  sudo bash /opt/crapplet-panel/deploy/update.sh
set -euo pipefail

REPO="https://github.com/singhhemant80/crapplet-panel.git"
DIR="/opt/crapplet-panel"
BRANCH="main"
DOMAIN="${DOMAIN:-}"
EMAIL="${ADMIN_EMAIL:-}"
SSL=1
DEMO="${SEED_DEMO:-false}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-ssl) SSL=0; shift ;;
    --demo) DEMO=true; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (use sudo)."; exit 1; }
if [ -z "$DOMAIN" ] && [ -r /dev/tty ]; then read -rp "Domain for the panel (e.g. crapplet.co.in): " DOMAIN < /dev/tty; fi
[ -n "$DOMAIN" ] || { echo "--domain is required"; exit 1; }
EMAIL="${EMAIL:-admin@${DOMAIN}}"

echo "==> Crapplet Panel → ${DOMAIN}  (dir ${DIR}, branch ${BRANCH})"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=2 -o Dpkg::Lock::Timeout=120)
if ! command -v git >/dev/null; then
  echo "==> Installing git"
  apt-get "${APT_OPTS[@]}" update -y -q
  apt-get "${APT_OPTS[@]}" install -y -q git curl ca-certificates
fi

if [ -d "$DIR/.git" ]; then
  echo "==> Updating existing checkout"
  git -C "$DIR" config --global --add safe.directory "$DIR" || true
  timeout 300 git -C "$DIR" fetch --depth 1 origin "$BRANCH" || { echo "!! Couldn't reach GitHub (see: getent hosts github.com)"; exit 1; }
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  echo "==> Cloning ${REPO}"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

export DOMAIN ADMIN_EMAIL="$EMAIL" SEED_DEMO="$DEMO"
[ "$SSL" = "1" ] && export LETSENCRYPT_EMAIL="$EMAIL"
exec bash "$DIR/deploy/install.sh"
