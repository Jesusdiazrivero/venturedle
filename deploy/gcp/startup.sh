#!/usr/bin/env bash
# GCE startup script: runs as root on every boot, so everything here is idempotent. It knows
# nothing about the app — deploy.sh does that part.
set -euo pipefail

# 1. Docker with the Compose plugin. Debian's own repos do not ship the plugin.
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
fi

# 2. The state directory. uid 1000 is the container's `node` user and, usually, the first SSH
#    user too, so both `scp` and the app can write here.
mkdir -p /opt/venturedle/data
chown -R 1000:1000 /opt/venturedle

# 3. Swap. An e2-micro has 1 GB of RAM and `npm ci` + `vite build` will OOM without it.
if [ ! -f /swapfile ]; then
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile
	grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
swapon --show | grep -q '^/swapfile' || swapon /swapfile

# 4. Security updates without anybody logging in.
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
	DEBIAN_FRONTEND=noninteractive apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
fi
systemctl enable --now unattended-upgrades
