#!/usr/bin/env bash
# Ship the build context and the schedule to the VM, then build and start there.
#
#   ZONE=us-central1-a NAME=venturedle ./deploy/gcp/deploy.sh
#
# Updating the schedule alone is step 2 on its own — the backend notices the new mtime within 30 s
# and no restart is needed. The root `.env` (Harmonic and LLM keys) is never copied; deploy/.env
# travels inside deploy/ and is what the container reads.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ZONE=${ZONE:-us-central1-a}
NAME=${NAME:-venturedle}
REMOTE=/opt/venturedle

cd "$ROOT"
[ -f data/companies.json ] || {
	echo "data/companies.json is missing — run \`npm run extract\` (or \`npm run example-schedule\`)" >&2
	exit 1
}
[ -f deploy/.env ] || {
	echo "deploy/.env is missing — copy deploy/.env.example and fill it in" >&2
	exit 1
}

# 1. the build context. `scp --recurse` flattens a file argument, so extractor/package.json needs
#    its directory to exist first — hence the mkdir and the second copy.
gcloud compute ssh --zone "$ZONE" "$NAME" -- "mkdir -p $REMOTE/data $REMOTE/extractor"
gcloud compute scp --recurse --zone "$ZONE" \
	Dockerfile .dockerignore package.json package-lock.json tsconfig.base.json \
	shared backend frontend deploy \
	"$NAME:$REMOTE/"
gcloud compute scp --zone "$ZONE" extractor/package.json "$NAME:$REMOTE/extractor/package.json"

# 2. the schedule (the answer key). This line alone is a schedule update.
gcloud compute scp --zone "$ZONE" data/companies.json "$NAME:$REMOTE/data/companies.json"

# 3. build and start on the VM. The first build takes a few minutes on an e2-micro; the swapfile
#    from startup.sh is what keeps it from being killed.
#    Alternative if that is too slow: build locally and ship the image instead —
#      docker build -t venturedle . && docker save venturedle | gzip |
#        gcloud compute ssh --zone "$ZONE" "$NAME" -- 'gunzip | sudo docker load'
#    then drop `build:` from deploy/docker-compose.yml and keep `image: venturedle:latest`.
gcloud compute ssh --zone "$ZONE" "$NAME" -- "cd $REMOTE/deploy && sudo docker compose up -d --build"

DOMAIN=$(grep -E '^DOMAIN=' deploy/.env | cut -d= -f2- | tr -d '"' || true)
if [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != ":80" ]; then
	curl -fsS "https://$DOMAIN/api/health" && echo " — $DOMAIN is up"
else
	echo "deployed; DOMAIN is ':80', so smoke-test it on the VM's IP over plain HTTP"
fi
