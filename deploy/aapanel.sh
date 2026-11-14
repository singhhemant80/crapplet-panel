#!/usr/bin/env bash
# aaPanel support for deploy/install.sh (sourced, not run directly).
#
# On a server with aaPanel the panel owns nginx, the firewall and SSL, so the installer:
#   - never installs Ubuntu's nginx / certbot and never touches ufw (that would lock you out of aaPanel)
#   - uses aaPanel's PostgreSQL / Redis when they're installed from the App Store, otherwise Ubuntu's
#   - puts the panel's rules into the aaPanel site you created for the domain:
#       /www/server/panel/vhost/nginx/0.crapplet_http.conf   rate limits, upstreams, WHMCS-link map (http level)
#       /www/server/panel/vhost/rewrite/<domain>.conf         the site's "URL rewrite" — all the proxy rules
#       and points the site's root at public-site/
#   SSL is issued from aaPanel (Website → the site → SSL → Let's Encrypt), not by certbot.

AA_ROOT=/www/server
AA_NGINX="$AA_ROOT/nginx/sbin/nginx"
AA_VHOST="$AA_ROOT/panel/vhost/nginx"
AA_REWRITE="$AA_ROOT/panel/vhost/rewrite"

aapanel_detected() { [ -x "$AA_NGINX" ] && [ -d "$AA_VHOST" ]; }
aapanel_present() { [ -d "$AA_ROOT/panel" ]; }

# aaPanel's PostgreSQL (App Store) — its psql lives under /www/server/pgsql and runs as "postgres"
aapanel_psql() {
  if [ -x "$AA_ROOT/pgsql/bin/psql" ]; then
    echo "$AA_ROOT/pgsql/bin"
  fi
}

# aaPanel's Redis (App Store) usually has a password — returns the redis:// URL to use
aapanel_redis_url() {
  local conf="$AA_ROOT/redis/redis.conf" pass port
  [ -f "$conf" ] || return 1
  port="$(awk '/^port /{print $2}' "$conf" | head -1)"
  pass="$(awk '/^requirepass /{print $2}' "$conf" | head -1)"
  if [ -n "$pass" ]; then
    # URL-encode the password (it may contain @ : / #)
    pass="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$pass")"
    echo "redis://:${pass}@127.0.0.1:${port:-6379}"
  else
    echo "redis://127.0.0.1:${port:-6379}"
  fi
}

# Ubuntu's nginx package (from an earlier plain install) would fight aaPanel's for ports 80/443.
# Both answer to the service name "nginx", so go by the package, never by the service name.
aapanel_retire_system_nginx() {
  if dpkg-query -W -f='${Status}' nginx-common 2>/dev/null | grep -q "install ok installed"; then
    echo "    removing Ubuntu's nginx package (aaPanel's nginx serves the site now; /etc/nginx is kept)"
    [ -x /usr/sbin/nginx ] && /usr/sbin/nginx -s quit 2>/dev/null || true
    rm -f /etc/nginx/sites-enabled/crapplet
    apt-get remove -y -q nginx nginx-core nginx-full nginx-light nginx-extras python3-certbot-nginx nginx-common >/dev/null 2>&1 || true
    systemctl daemon-reload 2>/dev/null || true
  fi
  # make sure aaPanel's nginx is running (its own init script)
  if ! pgrep -f "$AA_ROOT/nginx/sbin/nginx" >/dev/null 2>&1; then
    /etc/init.d/nginx start >/dev/null 2>&1 || "$AA_NGINX" || echo "!! couldn't start aaPanel's nginx — start it from aaPanel → App Store → Nginx"
  fi
}

aapanel_configure_site() {
  local domain="$1" root="$2" site_conf rw http
  site_conf="$AA_VHOST/${domain}.conf"
  rw="$AA_REWRITE/${domain}.conf"
  http="$AA_VHOST/0.crapplet_http.conf"

  if [ ! -f "$site_conf" ]; then
    cat <<MSG

!! There is no aaPanel website for ${domain} yet. Create it once, then run this again:

   aaPanel → Website → Add site
     Domain name:   ${domain}   (add www.${domain} too if you use it)
     Root directory: ${root}/public-site
     FTP / Database: don't create
     PHP version:    Static

   then:  sudo bash ${root}/deploy/update.sh

MSG
    exit 1
  fi

  # 1) http-level part: everything above "server {" in the template
  awk '/^server[[:space:]]*\{/{exit} {print}' "$root/deploy/nginx-crapplet.conf" > "$http.tmp"
  # 2) the site rules: from the marker to the server's closing brace
  {
    echo "# Crapplet Panel — written by deploy/install.sh on every update. Don't edit in aaPanel's URL rewrite tab;"
    echo "# change deploy/nginx-crapplet.conf in the repository instead."
    awk '/---- site rules/{on=1; next} on' "$root/deploy/nginx-crapplet.conf" | sed '$d'
  } > "$rw.tmp"

  # 3) the site's web root → public-site (aaPanel keeps whatever root line we set)
  if ! grep -qE "^[[:space:]]*root[[:space:]]+${root}/public-site;" "$site_conf"; then
    cp -a "$site_conf" "$site_conf.bak-crapplet"
    sed -i -E "0,/^([[:space:]]*)root[[:space:]]+[^;]+;/s##\1root ${root}/public-site;#" "$site_conf"
  fi
  # aaPanel's "anti-cross-site" file is for PHP only, and its immutable bit breaks updates
  if [ -e "$root/public-site/.user.ini" ]; then
    chattr -i "$root/public-site/.user.ini" 2>/dev/null || true
    rm -f "$root/public-site/.user.ini"
  fi

  cp -a "$http" "$http.bak" 2>/dev/null || true
  cp -a "$rw" "$rw.bak" 2>/dev/null || true
  mv "$http.tmp" "$http"
  mv "$rw.tmp" "$rw"
  if "$AA_NGINX" -t >/dev/null 2>&1; then
    "$AA_NGINX" -s reload 2>/dev/null || /etc/init.d/nginx reload || true
    rm -f "$http.bak" "$rw.bak"
  else
    echo "!! aaPanel's nginx rejected the new configuration — putting the previous one back:"
    "$AA_NGINX" -t || true
    if [ -f "$http.bak" ]; then mv "$http.bak" "$http"; else rm -f "$http"; fi
    if [ -f "$rw.bak" ]; then mv "$rw.bak" "$rw"; else : > "$rw"; fi
    [ -f "$site_conf.bak-crapplet" ] && mv "$site_conf.bak-crapplet" "$site_conf"
    "$AA_NGINX" -s reload 2>/dev/null || true
    exit 1
  fi
}
