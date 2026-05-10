# Installing sudo

This is the minimum needed to run a sudo node from source.

## Prerequisites

- Node.js 20 or 22 LTS (`node --version`)
- npm (ships with Node)
- git
- Optional: `sqlite3` CLI for backups (`apt install sqlite3` on Debian/Ubuntu)

sudo runs as a single Node process backed by a local SQLite file. There is
no Redis, no message broker, no Docker.

## Get the code

```sh
git clone https://github.com/SovietMeteor10/sudo.git
cd sudo
cp .env.example .env
```

Edit `.env` and at minimum set `SUDO_PUBLIC_BASE_URL` to the URL operators
will visit. See [OPERATOR.md](./OPERATOR.md) for the full role list.

## Install dependencies and build

```sh
npm ci
npm run build
```

`npm ci` is preferred over `npm install` for reproducible installs from
`package-lock.json`.

## Run

```sh
npm start
# or
node dist/server.js
```

The process logs the bound address. By default it binds `127.0.0.1:3000`
so you can put nginx in front of it. See [DEPLOY_UBUNTU.md](./DEPLOY_UBUNTU.md)
for a real deployment.

## Health check

```sh
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/.well-known/sudo/node.json
```

`scripts/smoke.sh` (also exposed as `npm run smoke`) hits all of these in
one go. Pass `BASE_URL` to point at a remote node:

```sh
BASE_URL=https://example.com npm run smoke
```

## Where data lives

- `data/sudo.sqlite` — the SQLite database (path overridable via
  `SUDO_DB_PATH`, default derived from `SUDO_DATA_DIR`).
- `data/keys/` — dormant pre-migration artifact directory. As of
  7128bd3 no signup path writes here. Existing nodes should prune
  any leftover `*.dev-private-key.pem`, `*.dev-feed-private-key.pem`,
  `*.identity.json`, and `*.fingerprint.json` files (see
  [OPERATOR.md](./OPERATOR.md) §post-7128bd3 cleanup).
- `data/backups/` — destination for `npm run backup:sqlite`.

The whole `data/` directory is gitignored. Treat it as the
node's persistent state.

## Resolved config

```sh
npm run check:env
```

This prints the resolved config and warns on common operator mistakes
(unset public URL, default example.com left in place, bind host set to
0.0.0.0, NODE_ENV not production for an https deployment).

## Updating

```sh
git fetch origin main
git checkout main
git reset --hard origin/main
npm ci
npm run build
# then restart the service (see SYSTEMD.md)
```

Always check for migration notes in commit messages before pulling.
