#!/usr/bin/env bash
# One-time Let's Encrypt issuance for wildcard production and staging domains. Run from deploy.
# Prereqs:
# - DNS A records: go.pageden.app, *.pageden.app, go.pageden.io, *.pageden.io -> this Droplet.
# - Porkbun API access enabled for both domains.
# - deploy/secrets/porkbun.ini exists and is chmod 600.
# - .env.production + .env.staging present.
set -euo pipefail
cd "$(dirname "$0")/.."
EMAIL="${LETSENCRYPT_EMAIL:-}"
[ -z "$EMAIL" ] && { read -rp "Email for Let's Encrypt notices: " EMAIL; }
COMPOSE="docker compose"
STAGING="${CERTBOT_STAGING:-0}"
PORKBUN_CREDENTIALS="./secrets/porkbun.ini"

[ -f "$PORKBUN_CREDENTIALS" ] || {
  echo "Missing $PORKBUN_CREDENTIALS. Create it with dns_porkbun_key and dns_porkbun_secret.";
  exit 1;
}

if [ "$(stat -c "%a" "$PORKBUN_CREDENTIALS" 2>/dev/null || stat -f "%Lp" "$PORKBUN_CREDENTIALS")" != "600" ]; then
  echo "$PORKBUN_CREDENTIALS must be chmod 600.";
  exit 1;
fi

echo "==> Building images"; $COMPOSE build prod-server prod-web staging-server staging-web

# Seed temporary self-signed certs so nginx can start before real cert issuance.
for d in pageden.app pageden.io; do
  echo "==> Temporary self-signed cert for $d"
  docker run --rm --entrypoint sh -v pageden_certbot_etc:/etc/letsencrypt alpine/openssl -c "\
    mkdir -p /etc/letsencrypt/live/$d && \
    openssl req \
      -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /etc/letsencrypt/live/$d/privkey.pem \
      -out /etc/letsencrypt/live/$d/fullchain.pem \
      -subj '/CN=$d'"
done

echo "==> Starting all services"; $COMPOSE up -d
EXTRA=""; [ "$STAGING" = "1" ] && EXTRA="--staging"

echo "==> Requesting real wildcard certificate for pageden.app"
$COMPOSE run --rm --entrypoint sh certbot -c "\
  rm -rf /etc/letsencrypt/live/pageden.app /etc/letsencrypt/archive/pageden.app /etc/letsencrypt/renewal/pageden.app.conf; \
  certbot certonly $EXTRA \
    --non-interactive --agree-tos --no-eff-email --email $EMAIL \
    --preferred-challenges dns --manual \
    --manual-auth-hook /hooks/porkbun-auth.py \
    --manual-cleanup-hook /hooks/porkbun-cleanup.py \
    --cert-name pageden.app \
    -d '*.pageden.app'"

echo "==> Requesting real wildcard certificate for pageden.io"
$COMPOSE run --rm --entrypoint sh certbot -c "\
  rm -rf /etc/letsencrypt/live/pageden.io /etc/letsencrypt/archive/pageden.io /etc/letsencrypt/renewal/pageden.io.conf; \
  certbot certonly $EXTRA \
    --non-interactive --agree-tos --no-eff-email --email $EMAIL \
    --preferred-challenges dns --manual \
    --manual-auth-hook /hooks/porkbun-auth.py \
    --manual-cleanup-hook /hooks/porkbun-cleanup.py \
    --cert-name pageden.io \
    -d '*.pageden.io'"

echo "==> Restarting certbot renewer and edge"; $COMPOSE up -d --force-recreate certbot edge
echo "==> Reloading edge"; $COMPOSE exec edge nginx -t && $COMPOSE exec edge nginx -s reload
echo "Done. Wildcard TLS is ready for go.pageden.app, *.pageden.app, go.pageden.io, and *.pageden.io."
