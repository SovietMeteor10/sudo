# Backups

sudo's persistent server state is essentially one file: the SQLite
database at `SUDO_DB_PATH` (default `data/sudo.sqlite`). Back up that
file and you have a working copy of the node.

User account backups are a separate thing — they live in the browser
and are exported by the user, not the operator. See below.

## What lives in `data/`

- `sudo.sqlite` (+ `-wal`, `-shm`) — identities, relay envelopes, feed
  posts, discovery indexes, sessions. **This is what to back up.**
- `keys/` — dormant pre-migration directory. As of commit 7128bd3 the
  server no longer writes private key material anywhere. Any
  `*.dev-private-key.pem`, `*.dev-feed-private-key.pem`,
  `*.identity.json`, or `*.fingerprint.json` files left here on
  upgraded nodes are leftovers from the old codepath and should be
  pruned (see [OPERATOR.md](./OPERATOR.md) §post-7128bd3 cleanup).
  Do **not** back this directory up — copying plaintext private-key
  material was always a bad backup practice.
- `backups/` — output of `npm run backup:sqlite`

## Server backups vs user backups

Two different things share the word "backup":

- **Server/node backups** — what an operator takes to recover a node
  after disk loss. The SQLite database is sufficient. The server does
  not hold any user's private key material; user secrets live in the
  browser.
- **User account backups** — encrypted `.sudo-backup.json` files
  produced by the browser portal's account export. These are encrypted
  with the user's passphrase via Web Crypto and contain the user's
  private identity / feed / messaging / device / account-sync keys.
  The user is responsible for exporting and storing these. The server
  never sees the contents.

If a user clears their browser data without an exported
`.sudo-backup.json` and without a paired trusted device, the account
is unrecoverable from the server side. That is the intended posture:
the server does not hold a recovery shortcut.

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

## Full directory backup (optional, advanced)

For most nodes, just backing up the SQLite database is enough. If you
want a tarball of `data/` for a dedicated archive (operator notes,
out-of-band config, etc.), explicitly exclude both `data/keys/` and
`data/backups/`:

```sh
tar --exclude='data/backups' --exclude='data/keys' \
    -czf sudo-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz data
```

Excluding `data/keys/` is deliberate. On nodes running 7128bd3 or
later it is empty; on older nodes it holds dormant plaintext
private-key material that should be pruned, not archived.

## Restore

1. Stop the service: `sudo systemctl stop sudo.service`
2. Move the broken database aside: `mv data/sudo.sqlite data/sudo.sqlite.broken`
3. Copy a backup into place: `cp data/backups/sudo-<stamp>.sqlite data/sudo.sqlite`
4. Start the service: `sudo systemctl start sudo.service`
5. Smoke test: `npm run smoke`

Note: there is intentionally no step that restores private key
material from a server backup. User secrets live in the browser. A
user who has lost their device must restore from their own
`.sudo-backup.json` or via a paired trusted device.

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
