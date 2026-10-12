#!/usr/bin/env bash
# BR Stats - one-time setup for an Ubuntu 22.04/24.04 server (made for Oracle Cloud's
# free Ampere A1, works on any Ubuntu box). Run as root; oracle-init.sh does this.
#
# Installs nginx, MongoDB, Python and Node, builds the site, and prepares the
# brstats-api / brstats-bot services. They start once you upload your settings,
# bot and data with brstats-finish (see deploy/README.md).
set -euo pipefail
DOMAIN="${DOMAIN:-br.iarhm.xyz}"
APP=/opt/brstats
SITE=$APP/site
export DEBIAN_FRONTEND=noninteractive
log() { echo "==> $*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }

log "Opening ports 80 and 443 in the server's firewall"
if ! iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

log "Installing packages"
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx python3-venv python3-dev \
  build-essential git curl gnupg unzip ca-certificates

if ! node -v 2>/dev/null | grep -qE '^v(2[0-9])\.'; then
  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v mongod >/dev/null; then
  log "Installing MongoDB 8.0"
  codename=$(. /etc/os-release; echo "$VERSION_CODENAME")
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod   # listens on 127.0.0.1 only (default mongod.conf)

log "Creating the brstats user"
id -u brstats >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin brstats
mkdir -p "$APP"
chown -R brstats:brstats "$APP"
chmod 755 "$APP"

install -m 755 "$SITE/deploy/brstats-update" /usr/local/bin/brstats-update
install -m 755 "$SITE/deploy/brstats-finish" /usr/local/bin/brstats-finish

log "Writing services"
cat > /etc/systemd/system/brstats-api.service <<EOF
[Unit]
Description=BR Stats API
After=network-online.target mongod.service
Wants=mongod.service

[Service]
User=brstats
WorkingDirectory=$SITE/backend
EnvironmentFile=$APP/backend.env
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP/venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 9101 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/brstats-bot.service <<EOF
[Unit]
Description=BR Stats Discord bot
After=network-online.target brstats-api.service

[Service]
User=brstats
WorkingDirectory=$APP/bot
Environment=PYTHONUNBUFFERED=1
Environment=WEBSITE_API_URL=http://127.0.0.1:9101/api
Environment=WEBSITE_URL=https://$DOMAIN
ExecStart=$APP/bot/.venv/bin/python bot.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

log "Configuring nginx for $DOMAIN"
cat > /etc/nginx/sites-available/brstats <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 16m;   # scoreboard screenshots

    root $SITE/frontend/build;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:9101;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /static/ {
        expires 1y;
    }

    location / {
        try_files \$uri /index.html;
        expires -1;
    }
}
EOF
ln -sf /etc/nginx/sites-available/brstats /etc/nginx/sites-enabled/brstats
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Building BR Stats"
brstats-update --no-pull

touch "$APP/.setup-done"
log "Setup done. Next: upload your settings, bot and data (upload-to-oracle.bat on your PC)."
