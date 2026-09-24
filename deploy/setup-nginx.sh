#!/usr/bin/env bash
# Publish the draft board at https://draft.gradyserver.com
#
# Run with sudo. It installs the site config, obtains a certificate, and reloads nginx.
# Everything is idempotent: re-running it is safe.
#
#   sudo ./deploy/setup-nginx.sh
set -euo pipefail

HOSTNAME_FQDN="draft.gradyserver.com"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_SRC="$REPO/deploy/draft.gradyserver.com.conf"
SITE_DST="/etc/nginx/sites-available/$HOSTNAME_FQDN.conf"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v certbot >/dev/null || { echo "certbot not installed" >&2; exit 1; }

echo "1/4  installing $SITE_DST"
install -m 0644 "$SITE_SRC" "$SITE_DST"
ln -sfn "$SITE_DST" "/etc/nginx/sites-enabled/$HOSTNAME_FQDN.conf"

if [ ! -d "/etc/letsencrypt/live/$HOSTNAME_FQDN" ]; then
  echo "2/4  obtaining a certificate (the TLS block is commented out until it exists)"
  # nginx cannot start referencing a certificate that does not exist yet, so serve plain HTTP
  # for the challenge first, then restore the real config.
  cp "$SITE_DST" "$SITE_DST.pending"
  cat > "$SITE_DST" <<PLAIN
server {
    listen 80;
    server_name $HOSTNAME_FQDN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
PLAIN
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/html -d "$HOSTNAME_FQDN" --non-interactive --agree-tos \
    --register-unsafely-without-email || {
      echo "certbot failed; restoring config" >&2; mv "$SITE_DST.pending" "$SITE_DST"; exit 1; }
  mv "$SITE_DST.pending" "$SITE_DST"
else
  echo "2/4  certificate already present"
fi

echo "3/4  testing the nginx configuration"
nginx -t

echo "4/4  reloading nginx"
systemctl reload nginx
echo
echo "Done. https://$HOSTNAME_FQDN"
echo "Start the app (as your user, not root):"
echo "  systemctl --user enable --now fha-web.service"
