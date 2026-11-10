#!/usr/bin/env bash
# Crapplet Cloud installer for a fresh Ubuntu 24.04 LTS VM or bare-metal server (no Docker).
#
#   sudo DOMAIN=crapplet.co.in ADMIN_EMAIL=admin@crapplet.co.in bash deploy/install.sh
#
# Optional: LETSENCRYPT_EMAIL=you@… (issues SSL), SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM, SEED_DEMO=true
# Safe to re-run: existing .env secrets and database are kept; code is rebuilt and migrations applied.
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=crapplet.co.in}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${DOMAIN}}"
APP_USER="${APP_USER:-crapplet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env"

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)"; exit 1; }
. /etc/os-release
[ "${VERSION_ID}" = "24.04" ] || echo "WARNING: tested on Ubuntu 24.04, found ${PRETTY_NAME}"

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=2 -o Dpkg::Lock::Timeout=300)
apt-get "${APT_OPTS[@]}" update -y -q || echo "WARNING: apt update had errors — continuing with the package lists we have"
apt-get "${APT_OPTS[@]}" install -y -q curl ca-certificates gnupg nginx postgresql postgresql-contrib redis-server certbot python3-certbot-nginx ufw fonts-inter
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get "${APT_OPTS[@]}" install -y -q nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2@5

log "Configuring Redis (local only, AOF persistence)"
sed -i 's/^#\?\s*supervised .*/supervised systemd/; s/^#\?\s*appendonly .*/appendonly yes/' /etc/redis/redis.conf
grep -q '^bind 127.0.0.1' /etc/redis/redis.conf || sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
systemctl enable --now redis-server && systemctl restart redis-server

id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

log "Preparing PostgreSQL"
systemctl enable --now postgresql
if [ ! -f "$ENV_FILE" ]; then
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crapplet') THEN CREATE ROLE crapplet LOGIN PASSWORD '${DB_PASS}';
  ELSE ALTER ROLE crapplet PASSWORD '${DB_PASS}'; END IF;
END \$\$;
SQL
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='crapplet'" | grep -q 1 || sudo -u postgres createdb -O crapplet crapplet

  log "Writing $ENV_FILE (secrets generated — back this file up!)"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
API_PORT=4000
APP_URL=https://${DOMAIN}
DATABASE_URL=postgresql://crapplet:${DB_PASS}@127.0.0.1:5432/crapplet
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=$(openssl rand -hex 48)
# AES-256-GCM key for Proxmox/Virtualizor/gateway secrets, VPS passwords and 2FA seeds. NEVER change or lose it.
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
# auto = secure cookies on https://, plain cookies when opened over http:// (e.g. by IP before SSL)
COOKIE_SECURE=auto
UPLOAD_DIR=/var/lib/crapplet/uploads
SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_SECURE=false
SMTP_USER=${SMTP_USER:-}
SMTP_PASS=${SMTP_PASS:-}
SMTP_FROM="${SMTP_FROM:-Crapplet Cloud <billing@${DOMAIN}>}"
INBOUND_EMAIL_SECRET=$(openssl rand -hex 24)
IP_RESERVATION_MINUTES=15
PROVISION_DRY_RUN=false
ENV
  chmod 600 "$ENV_FILE"
  FIRST_INSTALL=1
else
  echo "Keeping existing $ENV_FILE"
  # older installs forced Secure cookies, which breaks logging in over http:// — switch to auto
  sed -i 's/^COOKIE_SECURE=true$/COOKIE_SECURE=auto/' "$ENV_FILE"
  FIRST_INSTALL=0
fi
mkdir -p /var/lib/crapplet/uploads /var/backups/crapplet
chown -R "$APP_USER":"$APP_USER" "$ROOT" /var/lib/crapplet /var/backups/crapplet

log "Installing dependencies and building"
echo "    npm packages (2–5 minutes the first time)…"
sudo -u "$APP_USER" bash -lc "cd '$ROOT' && npm ci --no-audit --no-fund --loglevel=error"
echo "    compiling the API…"
sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && npx prisma generate && npx tsc -p tsconfig.json"
echo "    building the website (2–4 minutes)…"
sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/web' && NEXT_TELEMETRY_DISABLED=1 npx next build"

log "Applying database migrations"
sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && npx prisma migrate deploy"
# sanity check: the committed migrations must match schema.prisma exactly
if ! sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code --shadow-database-url \"\$(grep ^DATABASE_URL .env | cut -d= -f2-)_shadow\"" >/dev/null 2>&1; then
  echo "NOTE: could not confirm migrations == schema (needs CREATEDB for a shadow DB). Run 'npx prisma migrate status' in apps/api to double-check."
fi

if [ "$FIRST_INSTALL" = "1" ]; then
  log "Seeding catalogue, roles and the admin account"
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)"
  sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && SEED_ADMIN_EMAIL='$ADMIN_EMAIL' SEED_ADMIN_PASSWORD='$ADMIN_PW' SEED_DEMO='${SEED_DEMO:-false}' npx tsx prisma/seed.ts"
  printf '%s\n' "Admin: $ADMIN_EMAIL" "Password: $ADMIN_PW" > /root/crapplet-admin-credentials.txt
  chmod 600 /root/crapplet-admin-credentials.txt
fi

log "Starting processes with PM2"
sudo -u "$APP_USER" bash -lc "cd '$ROOT' && pm2 startOrReload deploy/ecosystem.config.js && pm2 save"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null

log "Configuring Nginx for ${DOMAIN}"
sed "s|__DOMAIN__|${DOMAIN}|g; s|__ROOT__|${ROOT}|g" "$ROOT/deploy/nginx-crapplet.conf" > /etc/nginx/sites-available/crapplet
ln -sf /etc/nginx/sites-available/crapplet /etc/nginx/sites-enabled/crapplet
rm -f /etc/nginx/sites-enabled/default
chmod o+x "$(dirname "$ROOT")" "$ROOT" || true
nginx -t && systemctl reload nginx

if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  log "Re-applying the existing SSL certificate"
  certbot install --nginx -n --cert-name "$DOMAIN" --redirect >/dev/null 2>&1 || echo "certbot couldn't re-apply SSL — run: certbot --nginx -d $DOMAIN"
elif [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
  log "Requesting Let's Encrypt certificate"
  certbot --nginx -n --agree-tos -m "$LETSENCRYPT_EMAIL" -d "$DOMAIN" -d "www.$DOMAIN" --redirect || echo "certbot failed — check DNS, then re-run: certbot --nginx -d $DOMAIN"
fi

log "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

log "Nightly database backups (02:30 IST, 14 days kept)"
install -m 750 "$ROOT/deploy/backup.sh" /usr/local/bin/crapplet-backup
echo "30 21 * * * root /usr/local/bin/crapplet-backup >> /var/log/crapplet-backup.log 2>&1" > /etc/cron.d/crapplet-backup

log "Done"
echo "Website:      https://${DOMAIN}/"
echo "Client area:  https://${DOMAIN}/client"
echo "Admin:        https://${DOMAIN}/admin   (credentials in /root/crapplet-admin-credentials.txt)"
echo "Logs:         sudo -u ${APP_USER} pm2 logs"
