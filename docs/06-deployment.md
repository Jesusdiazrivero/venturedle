# 06 — Deployment

Principle: **the deployable unit is one Docker image plus one `docker compose` file**, and the
persistent state is one directory (`data/`) containing `companies.json` and `venturedle.db`. That
runs identically on a laptop, a GCP VM, a Hetzner box, an AWS Lightsail instance or Fly.io. GCP is
the documented first target; nothing in the image or compose file is GCP-specific. There is no
cron, no bucket and no sidecar in production: backups are disk snapshots.

## Image

Single multi-stage `Dockerfile` at the repo root (build context = repo root so `shared/` is
available):

```dockerfile
# ---- build the SPA ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY extractor/package.json extractor/          # all four manifests so the lockfile resolves; nothing else from extractor/
RUN npm ci --workspaces --include-workspace-root
COPY shared shared
COPY frontend frontend
RUN npm run build -w frontend                   # vite build → frontend/dist (no tsc here)

# ---- runtime: backend (tsx, no compile) + built SPA ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data STATIC_DIR=/app/frontend/dist COMPANIES_FILE=/data/companies.json
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY extractor/package.json extractor/
RUN npm ci --omit=dev --workspace shared --workspace backend --include-workspace-root \
 && npm cache clean --force
COPY shared shared
COPY backend backend
COPY --from=build /app/frontend/dist frontend/dist
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "node_modules/tsx/dist/cli.mjs", "backend/src/server.ts"]   # no npx: never touch the network at start
```

`.dockerignore` keeps the context small and keeps secrets and the extractor's source out:
`node_modules`, `**/.env`, `.cache`, `data/*.db*`, `docs`, `.git`, `extractor/*` with
`!extractor/package.json`. The extractor's dependencies are not installed because its workspace is
not requested in the runtime `npm ci`. Image size target: < 250 MB uncompressed (`node:24-alpine`
is ~170 MB of that).

## Compose

`deploy/docker-compose.yml` — two services. Caddy terminates TLS with automatic Let's Encrypt
certificates when `DOMAIN` is set; without a domain it serves plain HTTP on :80 (useful for a first
smoke test on the VM's IP).

```yaml
services:
  app:
    build: { context: .., dockerfile: Dockerfile }
    image: venturedle:latest
    restart: unless-stopped
    env_file: .env # deploy/.env: AUTH_MODE, GOOGLE_*, PUBLIC_URL (see deploy/.env.example)
    volumes:
      - ../data:/data # companies.json + venturedle.db live here, on the host
    expose: ["8080"]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      DOMAIN: ${DOMAIN:-:80} # e.g. venturedle.example.com ; ":80" = plain http
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes: { caddy_data: {}, caddy_config: {} }
```

`deploy/Caddyfile`:

```
{$DOMAIN} {
    encode zstd gzip
    reverse_proxy app:8080
}
```

Two env files, on purpose: the **root `.env`** is for local dev and the extractor (Harmonic and
LLM keys live there and never leave the laptop); **`deploy/.env`** is what the production
container sees (`DOMAIN`, `AUTH_MODE`, `GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_DOMAIN`, `PUBLIC_URL`).
Both have a committed `.example`. Compose also reads `deploy/.env` for the
`${DOMAIN}` substitution, so one file drives both services.

Local production-like run (no keys): first make a schedule that starts today, then bring it up:

```bash
npm run example-schedule          # re-dates data/companies.example.json to start today
cd deploy && cp .env.example .env && DOMAIN=:80 docker compose up -d --build   # → http://localhost
```

(The image runs with `NODE_ENV=production`, so `DEV_TODAY` and the example file are not available
there — production always plays the real schedule in `data/companies.json`.)

Only `data/` on the host matters. Back it up, and you can recreate everything else from git.

## GCP (Compute Engine)

Why a VM and not Cloud Run: SQLite wants a real disk and a single writer. Cloud Run's filesystem
is ephemeral and it scales to N instances; making SQLite work there means Litestream sidecars or a
managed database, which is exactly the complexity v2 is removing. A single small VM with Docker is
the dumbest thing that works, and it is portable.

Cost: an `e2-micro` in `us-west1`, `us-central1` or `us-east1` is in the Always Free tier (one per
billing account, 30 GB standard disk, 1 GB egress/month). In Europe (`europe-west1`) the same VM is
roughly €6–7/month. Choose by latency vs. cost; the game is not latency-sensitive.

### One-time setup — `deploy/gcp/create-vm.sh`

A shell script (bash, `set -euo pipefail`) that takes `PROJECT`, `ZONE` (default `us-central1-a`),
`NAME` (default `venturedle`) and does:

```bash
HERE=$(cd "$(dirname "$0")" && pwd)             # anchor file paths to the script, not the caller's cwd
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com

# static IP so DNS does not break on restart
gcloud compute addresses create "$NAME-ip" --region "${ZONE%-*}"
IP=$(gcloud compute addresses describe "$NAME-ip" --region "${ZONE%-*}" --format='value(address)')

# firewall for the default network (tags keep it scoped to this VM)
gcloud compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME" || true

# Debian + Docker via startup script; 20 GB pd-standard is plenty
gcloud compute instances create "$NAME" \
  --zone "$ZONE" --machine-type e2-micro --tags "$NAME" \
  --address "$IP" --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 20GB --boot-disk-type pd-standard \
  --metadata-from-file startup-script="$HERE/startup.sh"

# daily disk snapshots, kept 14 days — this is the backup strategy (see below)
gcloud compute resource-policies create snapshot-schedule "$NAME-daily" --region "${ZONE%-*}" \
  --max-retention-days 14 --daily-schedule --start-time 03:00 || true
gcloud compute disks add-resource-policies "$NAME" --zone "$ZONE" --resource-policies "$NAME-daily" || true

echo "VM ready at $IP — point your DNS A record at it, then run deploy/gcp/deploy.sh"
```

`deploy/gcp/startup.sh` runs as root on every boot and must be idempotent. It does four things
and nothing app-specific: install Docker with Compose from Docker's own apt repo (Debian's repos
do not ship the compose plugin — use `https://get.docker.com` or the documented apt steps);
`mkdir -p /opt/venturedle/data && chown -R 1000:1000 /opt/venturedle` (uid 1000 is both the
container's `node` user and, typically, the first SSH user, so `scp` and the app can both write);
add a 2 GB swapfile (an e2-micro has 1 GB RAM and `npm ci` + `vite build` will otherwise OOM); enable
`unattended-upgrades`. Do **not** `usermod` a "default user" — at startup-script time there is none
yet on GCE. Run Docker with `sudo` in `deploy.sh`.

### Deploying — `deploy/gcp/deploy.sh`

```bash
# 1. copy the build context + the schedule (deploy/.env travels inside deploy/; the root .env with API keys is NOT copied)
gcloud compute scp --recurse --zone "$ZONE" \
  Dockerfile .dockerignore package.json package-lock.json tsconfig.base.json shared backend frontend extractor/package.json deploy \
  "$NAME:/opt/venturedle/"
gcloud compute scp --zone "$ZONE" data/companies.json "$NAME:/opt/venturedle/data/companies.json"
# 2. build on the VM + start   (slow on e2-micro — a few minutes the first time; swap makes it possible)
gcloud compute ssh --zone "$ZONE" "$NAME" -- "cd /opt/venturedle/deploy && sudo docker compose up -d --build"
# 3. smoke (skip when DOMAIN is ':80')
[ "$DOMAIN" != ":80" ] && curl -fsS "https://$DOMAIN/api/health"
```

Note the `extractor/package.json` goes up as a file into `extractor/` (scp `--recurse` on a file
path flattens; create the directory first or copy the manifests in a second `scp`). If building on
the VM proves too slow, the documented alternative is to build locally and ship the image —
`docker build -t venturedle . && docker save venturedle | gzip | gcloud compute ssh … -- 'gunzip |
sudo docker load'` — and set `image: venturedle` without `build:` in compose. Both paths are one
script; pick one and keep the other as a comment.

Updating the schedule is the second `scp` line alone — the backend picks up the new mtime within
30 s, no restart. Updating the app is steps 1–2. `deploy/.env` on the VM holds `DOMAIN`,
`AUTH_MODE`, `GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_DOMAIN`, `PUBLIC_URL`; extractor keys never go
to the VM.

### Backups

The daily **disk snapshot schedule** created above is the whole backup story: it captures
`data/venturedle.db` and `data/companies.json` together, costs cents, needs no bucket, IAM or cron,
and restoring is "create a disk from the snapshot". A snapshot of a live SQLite database in WAL
mode is crash-consistent, which is fine for a game. If you ever want a clean logical copy (e.g.
before a risky change), `docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/venturedle.db').exec(\"VACUUM INTO '/data/backup.db'\")"` and copy the file off with `scp`. No `backup.sh`, no GCS.

### Google sign-in on GCP

Only if `AUTH_MODE=google`: create an OAuth 2.0 Client ID (Web application) in the same project.
Authorised JavaScript origins: `https://$DOMAIN`, plus `http://localhost` **and**
`http://localhost:5173` for dev (Google requires both forms for localhost; bare IP addresses are
not accepted, so google mode cannot be smoke-tested on the VM's IP with `DOMAIN=:80` — use
anonymous mode for that). No redirect URI is needed: the GIS button/One Tap callback returns the ID
token to the page. Put the client id in `deploy/.env` and, for a Workspace lock,
`GOOGLE_ALLOWED_DOMAIN=acurio.vc`. Nothing else on GCP is required.

## Other targets (not documented in detail, but the design keeps them one step away)

- **Any Linux VM (Hetzner, DigitalOcean, Lightsail, OVH)**: install Docker, copy the same files,
  `docker compose up -d`. `startup.sh` is Debian/Ubuntu-generic.
- **Fly.io**: `fly launch` with a 1 GB volume mounted at `/data`, `min_machines_running = 1`,
  `max = 1`. Fly terminates TLS, so drop the caddy service.
- **Cloud Run / ECS / anything that scales horizontally**: only after replacing SQLite with a
  networked database (Postgres/Turso) — see `07-decisions.md`. Not a v2 goal.

## Local development (no Docker)

```bash
npm install
cp .env.example .env            # defaults are fine: AUTH_MODE=anonymous
npm run dev                     # concurrently: backend (tsx watch, :8080) + frontend (vite, :5173)
```

`.env.example` sets `COMPANIES_FILE=data/companies.example.json` (shipped: ~30 well-known
companies scheduled from `2026-01-01`) and `DEV_TODAY=2026-01-01`, so "today" always lands on a
scheduled puzzle with no keys and no extractor run. `DEV_TODAY` is refused when
`NODE_ENV=production`. Change it to `2026-01-02` to see the next puzzle. SQLite file at
`data/venturedle.db` (gitignored).

## Files

```
Dockerfile
.dockerignore                    # node_modules, **/.env, .cache, data/*.db*, docs, .git, extractor/* (!extractor/package.json)
.env.example                     # local dev + extractor
deploy/
  .env.example                   # production container + DOMAIN
  docker-compose.yml
  Caddyfile
  gcp/
    create-vm.sh
    startup.sh
    deploy.sh
```
