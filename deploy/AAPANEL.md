# Running Crapplet Panel on aaPanel

The installer detects aaPanel (`/www/server/nginx`) and works alongside it:

| Part | Plain Ubuntu install | With aaPanel |
|---|---|---|
| Web server | Ubuntu nginx | aaPanel's Nginx — the panel's rules go into your aaPanel site |
| SSL | certbot | aaPanel → Website → site → SSL → Let's Encrypt |
| Firewall | ufw (22, 80, 443) | left to aaPanel → Security |
| PostgreSQL | Ubuntu package | aaPanel's PgSQL if installed from the App Store, otherwise Ubuntu's |
| Redis | Ubuntu package | aaPanel's Redis if installed (its password is picked up), otherwise Ubuntu's |
| Node.js + PM2 | system Node 22, PM2 as user `crapplet` | the same — no need for aaPanel's Node project manager |

## Fresh server

1. Install aaPanel, then in **App Store** install **Nginx** (any recent version). PostgreSQL/Redis from the App Store are optional — skip them and the installer uses Ubuntu's.
2. **Website → Add site**: domain `your.domain` (+ `www.your.domain`), root `/opt/crapplet-panel/public-site`, PHP **Static**, no FTP, no database.
3. On the server:
   ```bash
   git clone https://github.com/singhhemant80/crapplet-panel.git /opt/crapplet-panel
   sudo DOMAIN=your.domain ADMIN_EMAIL=you@your.domain bash /opt/crapplet-panel/deploy/install.sh
   ```
   If you installed aaPanel's PostgreSQL and the installer says it can't sign in, add `PG_SUPERUSER_PASSWORD='…'` (aaPanel → Databases → PgSQL → root password).
4. **Website → your site → SSL → Let's Encrypt**, then switch on **Force HTTPS**.
5. **Security**: ports 80 and 443 open.

## Moving an existing install onto aaPanel (same server)

1. Take a backup first: Admin → Setup → Database Backups → Back up now (and keep `apps/api/.env` safe — its `APP_ENCRYPTION_KEY` can't be recreated).
2. Install aaPanel. When it offers LNMP/LAMP, choose **Nginx only** (App Store → Nginx). It can't start yet while Ubuntu's nginx holds port 80 — that's fine.
3. Add the website as in step 2 above.
4. `sudo bash /opt/crapplet-panel/deploy/update.sh` — the installer removes Ubuntu's nginx package (keeps `/etc/nginx`), starts aaPanel's, and writes the site rules. Database, Redis, `.env` and uploads are untouched.
5. Issue SSL in aaPanel as above.

## What the installer writes

- `/www/server/panel/vhost/nginx/0.crapplet_http.conf` — rate-limit zones, upstreams, old WHMCS link map
- `/www/server/panel/vhost/rewrite/<domain>.conf` — the site's **URL rewrite**: all proxy rules. Rewritten on every update; don't edit it in aaPanel (edit `deploy/nginx-crapplet.conf` instead).
- the site's `root` line → `/opt/crapplet-panel/public-site`

If aaPanel's nginx rejects the new rules, the previous files are put back and the update stops.

Updates are the same as before: `sudo bash /opt/crapplet-panel/deploy/update.sh`.
