#!/usr/bin/env bash
# Pull, rebuild, migrate BOTH envs, and (re)start the shared-host stack. Run from anywhere.
#   ./deploy.sh                  # build + migrate prod & staging + restart
#   ./deploy.sh --seed-prod      # also seed the production bootstrap admin (first prod deploy)
#   ./deploy.sh --seed-staging   # also seed the staging bootstrap admin (first staging deploy)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
COMPOSE="docker compose"

for f in .env.production .env.staging; do
  [ -f "$f" ] || { echo "Missing deploy/$f (copy the matching env.*.example)"; exit 1; }
done

# Refuse to start before TLS is bootstrapped (edge needs both certs or it crash-loops).
for d in pageden.app pageden.io; do
  if ! $COMPOSE run --rm --entrypoint sh certbot -c "test -s /etc/letsencrypt/live/$d/fullchain.pem" >/dev/null 2>&1; then
    echo "No TLS certificate for $d. Run ./scripts/init-letsencrypt.sh first."; exit 1
  fi
done

echo "==> Pulling latest source"; git -C "$ROOT" pull --ff-only
echo "==> Building images"; $COMPOSE build prod-server prod-web staging-server staging-web prod-migrate staging-migrate
echo "==> Migrating production DB"; $COMPOSE run --rm prod-migrate    pnpm --filter @pageden/server db:migrate:deploy
echo "==> Migrating staging DB";    $COMPOSE run --rm staging-migrate pnpm --filter @pageden/server db:migrate:deploy
for arg in "$@"; do
  case "$arg" in
    --seed-prod)    echo "==> Seeding prod admin";    $COMPOSE run --rm prod-migrate    pnpm --filter @pageden/server db:seed:deploy ;;
    --seed-staging) echo "==> Seeding staging admin"; $COMPOSE run --rm staging-migrate pnpm --filter @pageden/server db:seed:deploy ;;
  esac
done
echo "==> Starting services"; $COMPOSE up -d
echo "==> Pruning dangling images"; docker image prune -f
$COMPOSE ps
