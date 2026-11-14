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
. "$ROOT/deploy/aapanel.sh"
AAPANEL=0
if aapanel_detected; then AAPANEL=1; echo "aaPanel detected — its nginx, firewall and SSL will be used"
elif aapanel_present; then echo "!! aaPanel is installed but its Nginx isn't. Install Nginx from aaPanel → App Store first, then run this again."; exit 1; fi
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)"; exit 1; }
. /etc/os-release
[ "${VERSION_ID}" = "24.04" ] || echo "WARNING: tested on Ubuntu 24.04, found ${PRETTY_NAME}"

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT_OPTS=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=2 -o Dpkg::Lock::Timeout=300)
apt-get "${APT_OPTS[@]}" update -y -q || echo "WARNING: apt update had errors — continuing with the package lists we have"
PKGS=(curl ca-certificates gnupg python3 fonts-inter)
if [ "$AAPANEL" = "1" ]; then
  # aaPanel owns the web server, firewall and SSL; database and Redis come from its App Store if installed there
  [ -n "$(aapanel_psql)" ] || PKGS+=(postgresql postgresql-contrib)
  aapanel_redis_url >/dev/null || PKGS+=(redis-server)
else
  PKGS+=(nginx postgresql postgresql-contrib redis-server certbot python3-certbot-nginx ufw)
fi
apt-get "${APT_OPTS[@]}" install -y -q "${PKGS[@]}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get "${APT_OPTS[@]}" install -y -q nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2@5

if [ "$AAPANEL" = "1" ] && aapanel_redis_url >/dev/null; then
  log "Using aaPanel's Redis"
  REDIS_URL_VALUE="$(aapanel_redis_url)"
else
log "Configuring Redis (local only, AOF persistence)"
sed -i 's/^#\?\s*supervised .*/supervised systemd/; s/^#\?\s*appendonly .*/appendonly yes/' /etc/redis/redis.conf
grep -q '^bind 127.0.0.1' /etc/redis/redis.conf || sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
systemctl enable --now redis-server && systemctl restart redis-server
REDIS_URL_VALUE="redis://127.0.0.1:6379"
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

log "Preparing PostgreSQL"
PG_BIN="$(aapanel_psql)"
if [ -n "$PG_BIN" ]; then
  echo "    using aaPanel's PostgreSQL ($PG_BIN)"
  # its client tools match its server version (backups and restores use pg_dump / pg_restore)
  for t in psql pg_dump pg_restore createdb; do ln -sf "$PG_BIN/$t" "/usr/local/bin/$t"; done
else
  systemctl enable --now postgresql
fi
# run SQL as the database superuser: peer login as "postgres", or — when aaPanel's PostgreSQL asks for
# a password — PG_SUPERUSER_PASSWORD (aaPanel → Databases → PgSQL → root password)
pg_admin() {
  if [ -n "${PG_SUPERUSER_PASSWORD:-}" ]; then PGPASSWORD="$PG_SUPERUSER_PASSWORD" psql -w -h 127.0.0.1 -U postgres "$@"
  else sudo -u postgres psql -w "$@"; fi
}
if [ ! -f "$ENV_FILE" ] && ! pg_admin -tc "SELECT 1" >/dev/null 2>&1; then
  echo "!! Can't sign in to PostgreSQL as its superuser."
  echo "   With aaPanel's PostgreSQL, copy the root password from aaPanel → Databases → PgSQL and run:"
  echo "   sudo PG_SUPERUSER_PASSWORD='that-password' DOMAIN=${DOMAIN} bash $ROOT/deploy/install.sh"
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  DB_PASS="$(openssl rand -hex 24)"
  pg_admin -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crapplet') THEN CREATE ROLE crapplet LOGIN PASSWORD '${DB_PASS}';
  ELSE ALTER ROLE crapplet PASSWORD '${DB_PASS}'; END IF;
END \$\$;
SQL
  pg_admin -tc "SELECT 1 FROM pg_database WHERE datname='crapplet'" | grep -q 1 || pg_admin -c "CREATE DATABASE crapplet OWNER crapplet"

  log "Writing $ENV_FILE (secrets generated — back this file up!)"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
API_PORT=4000
APP_URL=https://${DOMAIN}
DATABASE_URL=postgresql://crapplet:${DB_PASS}@127.0.0.1:5432/crapplet
REDIS_URL=${REDIS_URL_VALUE}
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
chown -R "$APP_USER":"$APP_USER" "$ROOT" /var/lib/crapplet /var/backups/crapplet 2>/dev/null || {
  # a file aaPanel marked immutable (e.g. public-site/.user.ini) — everything else is owned correctly
  echo "    note: some files couldn't be re-owned (immutable); continuing"; }

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

if [ "$AAPANEL" = "1" ]; then
log "Configuring the aaPanel website for ${DOMAIN}"
aapanel_retire_system_nginx
chmod o+x "$(dirname "$ROOT")" "$ROOT" || true
aapanel_configure_site "$DOMAIN" "$ROOT"
echo "    SSL: aaPanel → Website → ${DOMAIN} → SSL → Let's Encrypt, then turn on Force HTTPS"
else
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
  # www only when it has a DNS record — otherwise Let's Encrypt refuses the whole certificate
  WWW=(); getent hosts "www.$DOMAIN" >/dev/null 2>&1 && WWW=(-d "www.$DOMAIN")
  certbot --nginx -n --agree-tos -m "$LETSENCRYPT_EMAIL" -d "$DOMAIN" "${WWW[@]}" --redirect || echo "certbot failed — check that ${DOMAIN} points to this server (and isn't proxied by Cloudflare yet), then re-run: certbot --nginx -d $DOMAIN"
fi

log "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null
fi

log "Database backups are scheduled in the panel (Admin → Setup → Database Backups)"
# the old nightly cron is replaced by the panel's own backups (same folder, with schedule, retention and offsite copy)
rm -f /etc/cron.d/crapplet-backup
install -m 750 "$ROOT/deploy/backup.sh" /usr/local/bin/crapplet-backup   # still there for a manual command-line backup

if [ "$FIRST_INSTALL" = "0" ] && [ "${SKIP_VIRTUALIZOR_SYNC:-0}" != "1" ]; then
  log "Syncing Virtualizor (services, IP pools, OS templates)"
  sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && NODE_ENV=production timeout 660 node dist/scripts/post-update.js" || echo "    Virtualizor sync didn't finish — run it from Admin → VPS & Services → Sync all"
fi

log "Done"
echo "Website:      https://${DOMAIN}/"
echo "Client area:  https://${DOMAIN}/client"
echo "Admin:        https://${DOMAIN}/admin   (credentials in /root/crapplet-admin-credentials.txt)"
echo "Logs:         sudo -u ${APP_USER} pm2 logs"
