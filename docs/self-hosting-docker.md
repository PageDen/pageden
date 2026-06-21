# Self-host Pageden with Docker

This guide runs the public-core Pageden app with Docker Compose. It is for self-hosted deployments only and keeps cloud-only hosted-service features disabled by default.

The default stack builds the Pageden server and web images from this checkout, then runs PostgreSQL, the API server, the web UI, local filesystem storage, and one-shot migration/seed jobs. You do not need Node, pnpm, Prisma, or nginx installed on the host.

## Requirements

- Docker Engine with the Docker Compose plugin
- 2 GB RAM minimum; 4 GB recommended
- A DNS name and external reverse proxy for production HTTPS, or `localhost` for local testing

## Services

| Service | Purpose | Public by default |
|---|---|---:|
| `postgres` | PostgreSQL database | no |
| `migrate` | one-shot Prisma migration job | no |
| `seed` | one-shot first-admin bootstrap job | no |
| `server` | Fastify API, auth, MCP, storage | no |
| `web` | nginx-served SPA with same-origin `/api` proxy | yes, port `3000` |

Persistent data lives in these named Docker volumes:

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `pageden_storage` | filesystem-backed document/blob storage |

Volume names are prefixed by the Compose project name. Run `docker volume ls` if you need the exact names.

## Quick start: localhost

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/PageDen/pageden.git
   cd pageden
   ```

2. Create your self-host env file.

   ```bash
   cp .env.selfhost.example .env
   ```

3. Generate two application secrets and paste them into `.env` as `SESSION_SECRET` and `TOKEN_HASH_SECRET`.

   ```bash
   openssl rand -base64 48
   openssl rand -base64 48
   ```

4. Edit `.env` and set at least:

   - `POSTGRES_PASSWORD`
   - `SESSION_SECRET`
   - `TOKEN_HASH_SECRET`
   - `BOOTSTRAP_ADMIN_EMAIL`
   - `BOOTSTRAP_ADMIN_PASSWORD`

   Use URL-safe characters for `POSTGRES_PASSWORD` because `docker-compose.selfhost.yml` builds `DATABASE_URL` from the database env vars.

5. Build and start the stack.

   ```bash
   docker compose -f docker-compose.selfhost.yml up -d --build
   ```

6. Verify the app.

   ```bash
   curl -fsS http://localhost:3000/
   curl -fsS http://localhost:3000/api/health
   ```

   The health endpoint returns:

   ```json
   { "status": "ok" }
   ```

7. Open <http://localhost:3000> and log in with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`.

## Configuration

| Env var | Required | Example | Notes |
|---|---:|---|---|
| `PAGEDEN_SERVER_IMAGE` | no | `pageden-server:selfhost` | Local server image tag built by Compose. Advanced users may override with a published image tag. |
| `PAGEDEN_WEB_IMAGE` | no | `pageden-web:selfhost` | Local web image tag built by Compose. Advanced users may override with a published image tag. |
| `PAGEDEN_WEB_PORT` | no | `3000` | Host port mapped to the web container. |
| `POSTGRES_DB` | yes | `pageden` | Database created by the Postgres image. |
| `POSTGRES_USER` | yes | `pageden` | Database user. |
| `POSTGRES_PASSWORD` | yes | generated value | Use URL-safe characters. |
| `APP_URL` | yes | `http://localhost:3000` | Public origin users visit. |
| `WEB_ORIGIN` | yes | `http://localhost:3000` | Browser origin allowed by the server. Usually same as `APP_URL`. |
| `SESSION_SECRET` | yes | generated value | At least 32 characters. |
| `TOKEN_HASH_SECRET` | yes | generated value | At least 32 characters. |
| `CLOUD_HOSTED` | yes | `false` | Must stay `false` for this self-host stack. |
| `STORAGE_DRIVER` | yes | `fs` | Default self-host storage driver. |
| `STORAGE_ROOT` | yes | `/data/storage` | Container path backed by `pageden_storage`. |
| `BOOTSTRAP_ADMIN_EMAIL` | yes | `admin@example.com` | First admin account. |
| `BOOTSTRAP_ADMIN_PASSWORD` | yes | generated value | First admin password. |
| `GOOGLE_CLIENT_ID` | no | blank | Optional self-host Google OAuth. |
| `GOOGLE_CLIENT_SECRET` | no | blank | Optional self-host Google OAuth. |
| `GOOGLE_REDIRECT_URI` | no | blank | Usually `${APP_URL}/api/auth/google/callback`. |

## Production URL and HTTPS

For production, put Pageden behind your own HTTPS reverse proxy such as Caddy, nginx, Traefik, or a platform load balancer.

Set `.env` to the public HTTPS origin:

```dotenv
APP_URL=https://docs.example.com
WEB_ORIGIN=https://docs.example.com
PAGEDEN_WEB_PORT=3000
```

Then configure your reverse proxy to send traffic to the Docker host on `http://127.0.0.1:3000` or the appropriate host/port.

The first self-host implementation intentionally does not include a Caddy, certbot, DNS, or wildcard-domain overlay. Keep HTTPS as external reverse-proxy configuration for v1.

## Updating

When deploying from a Git checkout, pull the latest source and rebuild the local images:

```bash
git pull --ff-only
docker compose -f docker-compose.selfhost.yml up -d --build
```

The stack runs migrations before the server starts:

```bash
docker compose -f docker-compose.selfhost.yml up migrate
```

The seed job is repeat-safe. It keeps the bootstrap admin role current and does not duplicate the bootstrap audit event on repeated runs.

## Backups

Back up both PostgreSQL and the filesystem storage volume.

Create a backup directory:

```bash
mkdir -p backups
```

Database backup using PostgreSQL custom format:

```bash
docker compose -f docker-compose.selfhost.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/pageden.dump
```

Storage backup:

```bash
docker run --rm \
  -v "$(basename "$PWD")_pageden_storage:/data/storage:ro" \
  -v "$PWD/backups:/backups" \
  alpine tar czf /backups/pageden-storage.tgz -C /data storage
```

If your Compose project name is not the repository directory name, replace the volume name with the exact value from `docker volume ls`.

## Restore

Stop the stack before restoring:

```bash
docker compose -f docker-compose.selfhost.yml down
```

Restore the database into a fresh or existing Postgres volume:

```bash
docker compose -f docker-compose.selfhost.yml up -d postgres
cat backups/pageden.dump | docker compose -f docker-compose.selfhost.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'
```

Restore storage:

```bash
docker run --rm \
  -v "$(basename "$PWD")_pageden_storage:/data/storage" \
  -v "$PWD/backups:/backups:ro" \
  alpine sh -c 'rm -rf /data/storage/* && tar xzf /backups/pageden-storage.tgz -C /data'
```

Start the full stack:

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

## Optional published-image override

The default stack builds local `pageden-server:selfhost` and `pageden-web:selfhost` images from this checkout. If published container images are available in your environment, advanced users may override the image tags in `.env`:

```dotenv
PAGEDEN_SERVER_IMAGE=ghcr.io/pageden/pageden-server:v1.2.3
PAGEDEN_WEB_IMAGE=ghcr.io/pageden/pageden-web:v1.2.3
```

Then run:

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Do not set `VITE_API_BASE_URL` to `http://localhost:4000/api` for self-hosted production. The web image should use same-origin `/api`, and `apps/web/nginx.conf` proxies `/api` to the `server` container.

## Troubleshooting

### `POSTGRES_PASSWORD` or another variable is not set

Copy `.env.selfhost.example` to `.env` and replace all `CHANGE_ME` values.

### Server fails with `SESSION_SECRET must be at least 32 characters`

Generate a longer secret:

```bash
openssl rand -base64 48
```

### Browser API calls go to `localhost:4000`

Use the self-host web image or source-build fallback above. The self-host web bundle should call same-origin `/api`, not the development backend URL.

### `migrate` or `seed` exited and does not keep running

That is expected. They are one-shot jobs. Inspect logs with:

```bash
docker compose -f docker-compose.selfhost.yml logs migrate seed
```

### Login cookie or CORS issues in production

Make sure `APP_URL` and `WEB_ORIGIN` exactly match the public HTTPS origin users visit, including scheme and hostname.

### Attachments or stored content disappear after restart

Check that the `pageden_storage` volume still exists and is mounted by the `server` service:

```bash
docker compose -f docker-compose.selfhost.yml config
```

#
