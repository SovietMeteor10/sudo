# Backups

sudo's persistent state is one directory: `data/` (configurable via
`SUDO_DATA_DIR`). The most important file is the SQLite database at
`SUDO_DB_PATH` (default `data/sudo.sqlite`). Back up the directory and
you have a working copy of the node.

## What lives in `data/`

- `sudo.sqlite` (+ `-wal`, `-shm`) — identities, relay envelopes, feed
  posts, discovery indexes, sessions
- `keys/` — DEV-ONLY plaintext key material from the dev signup flow.
  Treat this as sensitive. Never share. Future client-side keys live
  in the browser, not on the server.
- `backups/` — output of `npm run backup:sqlite`

## Server backups vs user backups

Two different things share the word "backup":

- **Server/node backups** — what an operator takes to recover a node
  after disk loss. SQLite database + key material.
- **User account backups** — encrypted `.sudo-backup.json` files
  produced by the browser portal's account export. These are encrypted
  with the user's passphrase via Web Crypto and have nothing to do with
  what the operator stores.

Operator backups never decrypt user content. They preserve only what
the node already holds (identity registry, ciphertext envelopes,
public feeds, public reactions).

## Quick backup

```sh
npm run backup:sqlite
```

This calls `scripts/backup-sqlite.sh`, which:

1. Reads `SUDO_DB_PATH` (or derives it from `SUDO_DATA_DIR`)
2. Creates `data/backups/` if needed
3. Uses `sqlite3 ... .backup` if the CLI is installed (safe while the
   node is running)
4. Falls back to a plain file copy with a warning if `sqlite3` is
   missing — stop the service before doing that
5. Refuses to overwrite an existing timestamped file

Output looks like `data/backups/sudo-20260508T145501Z.sqlite`.

## Full directory backup

For a complete operator backup, also copy `data/keys/` and any other
files you have placed in `data/`:

```sh
tar --exclude='data/backups' -czf sudo-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz data
```

Move the tarball off the host. `keys/` is sensitive; encrypt the
archive at rest if you store it externally.

## Restore

1. Stop the service: `sudo systemctl stop sudo.service`
2. Move the broken database aside: `mv data/sudo.sqlite data/sudo.sqlite.broken`
3. Copy a backup into place: `cp data/backups/sudo-<stamp>.sqlite data/sudo.sqlite`
4. If you also lost `keys/`, restore from the tarball.
5. Start the service: `sudo systemctl start sudo.service`
6. Smoke test: `npm run smoke`

## Schedule

Either of these is fine to start with.

### systemd timer

`/etc/systemd/system/sudo-backup.service`:

```ini
[Unit]
Description=sudo sqlite backup
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/home/sudo-node/apps/sudo
EnvironmentFile=/home/sudo-node/apps/sudo/.env
ExecStart=/usr/bin/bash scripts/backup-sqlite.sh
User=sudo-node
Group=sudo-node
```

`/etc/systemd/system/sudo-backup.timer`:

```ini
[Unit]
Description=daily sudo sqlite backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sudo-backup.timer
```

### cron

```cron
17 4 * * * cd /home/sudo-node/apps/sudo && /usr/bin/bash scripts/backup-sqlite.sh >> /var/log/sudo-backup.log 2>&1
```

Either way, also rotate old backups (e.g. keep last 30 daily files) so
`data/backups/` doesn't grow unbounded.
