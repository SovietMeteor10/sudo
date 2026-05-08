# Deploying sudo on Ubuntu

This walks through a boring single-host setup on Ubuntu LTS:
Node + sudo + systemd + nginx + Let's Encrypt + ufw.

No Docker, no PM2, no orchestrator. Just a long-running Node process
behind nginx.

## 1. Server user

Run sudo as a dedicated unprivileged user. Replace `sudo-node` below
with whatever name you prefer; do not literally use `sudo` because that
is the system tool.

```sh
sudo adduser --disabled-password --gecos "" sudo-node
sudo usermod -aG sudo sudo-node    # only if this user needs to admin
sudo mkdir -p /home/sudo-node/apps
sudo chown sudo-node:sudo-node /home/sudo-node/apps
```

## 2. Install Node LTS

The NodeSource installer is the simplest path on Ubuntu:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential sqlite3
node --version
```

`build-essential` is needed because `better-sqlite3` builds a native
addon. `sqlite3` is the CLI used by `scripts/backup-sqlite.sh`.

## 3. Clone and install

```sh
sudo -u sudo-node -i
cd ~/apps
git clone https://github.com/SovietMeteor10/sudo.git
cd sudo
cp .env.example .env
$EDITOR .env
```

Set at minimum:

- `SUDO_NODE_NAME="your node name"`
- `SUDO_PUBLIC_BASE_URL="https://example.com"`
- `SUDO_HOST="127.0.0.1"` (bind only to loopback; nginx terminates TLS)
- `SUDO_PORT=3000`

Then build:

```sh
npm ci
npm run build
npm run check:env
```

## 4. systemd service

Install the unit. See [SYSTEMD.md](./SYSTEMD.md) for the file.

```sh
sudo cp packaging/sudo.service /etc/systemd/system/sudo.service
sudo systemctl daemon-reload
sudo systemctl enable --now sudo.service
sudo systemctl status sudo.service
```

(If you skip the packaging file, paste the unit from `SYSTEMD.md`
directly into `/etc/systemd/system/sudo.service`.)

Confirm the local app is up:

```sh
curl -fsS http://127.0.0.1:3000/health
```

## 5. nginx reverse proxy

```sh
sudo apt install -y nginx
sudo cp packaging/nginx.example.conf /etc/nginx/sites-available/sudo
# or paste the snippet from NGINX.md
sudo ln -s /etc/nginx/sites-available/sudo /etc/nginx/sites-enabled/sudo
sudo nginx -t
sudo systemctl reload nginx
```

See [NGINX.md](./NGINX.md) for the config.

## 6. TLS via Certbot

```sh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com -d www.example.com
```

Certbot edits the nginx config to add `listen 443 ssl` and the
certificate paths. After it finishes, reload nginx and re-run
`npm run smoke` against the https URL.

## 7. Firewall

```sh
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"
sudo ufw enable
sudo ufw status
```

The sudo Node process is on `127.0.0.1` and is not exposed directly.

## 8. Logs and restarts

```sh
sudo journalctl -u sudo.service -f          # follow logs
sudo systemctl restart sudo.service          # restart
sudo systemctl status sudo.service           # status
```

## 9. Updating

As `sudo-node`:

```sh
cd ~/apps/sudo
git fetch origin main
git checkout main
git reset --hard origin/main
npm ci
npm run build
sudo systemctl restart sudo.service
```

After restart, run `npm run smoke` to confirm the deploy.

## 10. Backups

See [BACKUPS.md](./BACKUPS.md). At minimum:

```sh
npm run backup:sqlite
```

writes a timestamped copy under `data/backups/`. Schedule it with a
systemd timer or cron.
