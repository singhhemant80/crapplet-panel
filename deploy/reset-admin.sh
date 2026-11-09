#!/usr/bin/env bash
# Reset (or create) a staff Administrator login and print the new password.
#
#   sudo bash /opt/crapplet-panel/deploy/reset-admin.sh admin@crapplet.co.in            # random password
#   sudo bash /opt/crapplet-panel/deploy/reset-admin.sh admin@crapplet.co.in 'MyPass#1'  # chosen password
#   sudo bash /opt/crapplet-panel/deploy/reset-admin.sh --list                           # show staff logins
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${APP_USER:-crapplet}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)"; exit 1; }

if [ "${1:-}" = "--list" ]; then
  sudo -u "$APP_USER" bash -lc "cd '$ROOT/apps/api' && npx tsx -e '
    import { prisma } from \"./src/db\";
    prisma.user.findMany({ where: { type: \"STAFF\" }, select: { email: true, status: true } })
      .then((u) => { console.table(u); process.exit(0); });
  '"
  exit 0
fi

EMAIL="$(printf '%s' "${1:?Usage: reset-admin.sh <email> [password]}" | tr '[:upper:]' '[:lower:]')"
PASS="${2:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)}"

sudo -u "$APP_USER" env RESET_EMAIL="$EMAIL" RESET_PASS="$PASS" bash -lc "cd '$ROOT/apps/api' && npx tsx -e '
  import bcrypt from \"bcryptjs\";
  import { prisma } from \"./src/db\";
  (async () => {
    const email = process.env.RESET_EMAIL!, hash = await bcrypt.hash(process.env.RESET_PASS!, 12);
    const role = await prisma.role.findUnique({ where: { name: \"Administrator\" } });
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) await prisma.user.update({ where: { id: u.id }, data: { type: \"STAFF\", status: \"ACTIVE\", passwordHash: hash, roleId: role?.id ?? u.roleId, totpSecretEnc: null, totpEnabled: false } });
    else await prisma.user.create({ data: { type: \"STAFF\", email, firstName: \"Crapplet\", lastName: \"Admin\", passwordHash: hash, roleId: role?.id, emailVerifiedAt: new Date() } });
    process.exit(0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
'"
printf '%s\n' "Admin: $EMAIL" "Password: $PASS" > /root/crapplet-admin-credentials.txt
chmod 600 /root/crapplet-admin-credentials.txt
echo
echo "  Admin login reset"
echo "  Email:    $EMAIL"
echo "  Password: $PASS"
echo "  (also saved to /root/crapplet-admin-credentials.txt)"
