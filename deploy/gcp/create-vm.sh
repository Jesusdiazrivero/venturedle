#!/usr/bin/env bash
# One-time GCP setup: a static IP, a firewall rule, an e2-micro VM with Docker, and a daily
# snapshot schedule (which is the entire backup story — see docs/06-deployment.md).
#
#   PROJECT=my-gcp-project ./deploy/gcp/create-vm.sh
#   PROJECT=my-gcp-project ZONE=europe-west1-b NAME=venturedle ./deploy/gcp/create-vm.sh
#
# Safe to re-run: every step is skipped if it already exists. Deploy the app with deploy.sh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PROJECT=${PROJECT:?set PROJECT to your GCP project id}
ZONE=${ZONE:-us-central1-a}
NAME=${NAME:-venturedle}
REGION=${ZONE%-*}

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com

# A static IP so a DNS A record survives a VM restart.
gcloud compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 ||
	gcloud compute addresses create "$NAME-ip" --region "$REGION"
IP=$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')

# The network tag keeps the rule scoped to this VM.
gcloud compute firewall-rules describe "$NAME-web" >/dev/null 2>&1 ||
	gcloud compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME"

if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
	echo "instance $NAME already exists in $ZONE"
else
	# e2-micro in us-west1/us-central1/us-east1 is in the Always Free tier. startup.sh installs
	# Docker and adds swap; it runs on every boot and is idempotent.
	gcloud compute instances create "$NAME" \
		--zone "$ZONE" --machine-type e2-micro --tags "$NAME" \
		--address "$IP" --image-family debian-12 --image-project debian-cloud \
		--boot-disk-size 20GB --boot-disk-type pd-standard \
		--metadata-from-file startup-script="$HERE/startup.sh"
fi

# Daily disk snapshots, kept a fortnight: this captures companies.json and venturedle.db together.
gcloud compute resource-policies describe "$NAME-daily" --region "$REGION" >/dev/null 2>&1 ||
	gcloud compute resource-policies create snapshot-schedule "$NAME-daily" --region "$REGION" \
		--max-retention-days 14 --daily-schedule --start-time 03:00
gcloud compute disks add-resource-policies "$NAME" --zone "$ZONE" \
	--resource-policies "$NAME-daily" 2>/dev/null ||
	echo "snapshot policy already attached"

cat <<MSG

VM ready at $IP
  1. point a DNS A record at $IP (skip for an IP-only smoke test)
  2. put DOMAIN=your.host and AUTH_MODE in deploy/.env
  3. ZONE=$ZONE NAME=$NAME ./deploy/gcp/deploy.sh
MSG
