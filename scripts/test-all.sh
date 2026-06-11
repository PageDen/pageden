#!/usr/bin/env bash
# One-command test runner: brings up Postgres, applies migrations, and runs the suites.
#
#   pnpm test:all            # unit (all packages) + server integration + coverage gate + report
#   pnpm test:all --e2e      # also run the Playwright end-to-end suite
#   pnpm test:all --no-docker # skip starting Postgres (use an already-running DB / DATABASE_URL)
#
# Requires Docker (for Postgres) unless --no-docker is passed, plus a populated .env.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_E2E=false
USE_DOCKER=true
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=true ;;
    --no-docker) USE_DOCKER=false ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f .env ]; then
  echo "==> No .env found — creating one from .env.example (fill in real secrets for a full run)."
  cp .env.example .env
fi
# Load DATABASE_URL, POSTGRES_*, BOOTSTRAP_ADMIN_* into the environment for the test runners.
set -a; . ./.env; set +a

if [ "$USE_DOCKER" = true ]; then
  echo "==> Starting Postgres (docker compose)"
  docker compose up -d postgres
  echo "==> Waiting for Postgres to accept connections…"
  for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-pageden}" >/dev/null 2>&1; then
      echo "    ready"; break
    fi
    if [ "$i" -eq 30 ]; then echo "Postgres did not become ready in time." >&2; exit 1; fi
    sleep 1
  done
fi

echo "==> Generating Prisma client + applying migrations"
pnpm db:generate
pnpm db:migrate

echo "==> Unit tests (server + web + plugin)"
pnpm test

echo "==> Server integration / contract / security + coverage gate"
pnpm --filter @pageden/server test:coverage

if [ "$RUN_E2E" = true ]; then
  echo "==> Installing Playwright browser (first run only) + running e2e"
  pnpm --filter @pageden/web exec playwright install chromium
  pnpm --filter @pageden/web e2e
fi

echo "==> Coverage-by-category report"
pnpm test:report || true

echo ""
echo "✅ All requested test suites passed."
