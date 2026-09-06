#!/usr/bin/env bash
# First-time setup on a fresh Ubuntu droplet (tested against 22.04/24.04). Run as root:
#   ssh root@168.144.127.72 'bash -s' < deploy/setup-droplet.sh
# Then put the repo at /opt/citynovus, fill /opt/citynovus/.env, and run: docker compose up -d --build
set -euo pipefail
apt-get update -y
apt-get install -y ca-certificates curl git ufw
# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
# Firewall: ssh + web only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Swap helps a small droplet build the site
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
mkdir -p /opt/citynovus
echo "Docker ready. Next:"
echo "  git clone <your repo> /opt/citynovus   (or rsync the folder)"
echo "  cp /opt/citynovus/deploy/env.production.example /opt/citynovus/.env && nano /opt/citynovus/.env"
echo "  cd /opt/citynovus && docker compose up -d --build"
echo "  ADMIN_TOKEN=... API=https://citynovus.com SEED=300 node scripts/seed.mjs   (from your laptop)"
