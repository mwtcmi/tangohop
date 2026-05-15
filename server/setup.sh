#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== apt update =="
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release sqlite3 build-essential debian-keyring debian-archive-keyring apt-transport-https

echo "== node 20 =="
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node --version

echo "== caddy =="
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
caddy version

echo "== frogman user =="
id frogman >/dev/null 2>&1 || useradd --system --home /opt/frogman --shell /usr/sbin/nologin frogman

echo "== dirs =="
install -d -o frogman -g frogman -m 0755 /opt/frogman /opt/frogman/api
install -d -o frogman -g frogman -m 0750 /var/lib/frogman
install -d -o www-data -g www-data -m 0755 /var/www/frogman
install -d -o root    -g frogman -m 0750 /etc/frogman
install -d -o root    -g root    -m 0755 /var/backups/frogman
install -d -o caddy   -g caddy   -m 0750 /var/log/caddy 2>/dev/null || true

echo "== secret =="
if [ ! -f /etc/frogman/env ]; then
  SECRET=$(openssl rand -hex 32)
  cat >/etc/frogman/env <<EOF
TANGOHOP_SECRET=$SECRET
TANGOHOP_CORS_ORIGINS=https://mwtcmi.github.io,https://tangohop.freepbxapps.com,http://localhost:8765,http://localhost:8080,http://127.0.0.1:8765
PORT=3000
TANGOHOP_DB=/var/lib/frogman/scores.db
NODE_ENV=production
EOF
  chown root:frogman /etc/frogman/env
  chmod 0640 /etc/frogman/env
fi

echo "== app files =="
install -o frogman -g frogman -m 0644 /tmp/frogman-stage/server.js   /opt/frogman/api/server.js
install -o frogman -g frogman -m 0644 /tmp/frogman-stage/package.json /opt/frogman/api/package.json

echo "== npm install =="
cd /opt/frogman/api
sudo -u frogman npm install --omit=dev --no-audit --no-fund --silent

echo "== systemd =="
install -m 0644 /tmp/frogman-stage/frogman-api.service /etc/systemd/system/frogman-api.service
systemctl daemon-reload
systemctl enable --now frogman-api

echo "== caddyfile =="
install -m 0644 /tmp/frogman-stage/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "== cron =="
install -m 0755 /tmp/frogman-stage/backup.sh /etc/cron.daily/frogman-backup

echo "== status =="
sleep 2
systemctl is-active frogman-api
systemctl is-active caddy

echo "== SECRET (copy this) =="
grep ^FROGMAN_SECRET /etc/frogman/env
