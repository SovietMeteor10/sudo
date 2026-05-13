# Operating a sudo node

A sudo node is a single Node process plus a SQLite file. It plays
several roles at once on that small footprint. This page describes what
those roles are and what an operator is responsible for.

## Roles a node can play

A node advertises its roles in `/.well-known/sudo/node.json` (built from
`buildNodeCapabilityDocument` in `src/node/node.config.ts`). The current
build serves all of them in one process. They are kept conceptually
separate so they can be split later.

### portal

The browser client served at `/`. Talks to the local node's APIs and
hosts the landing/auth UX. Replaceable: native clients or third-party
portals can speak the same protocol.

### identity_registry

Owns handles, signed identity documents, key fingerprints, and key
continuity. The handle is a human alias; the public key is the actual
identity. Routes:

- `GET /.well-known/handles/:handle`
- `/api/identity/...`
- `/finger/:handle`, `/u/:canonical`

### relay

Accepts encrypted store-and-forward envelopes between users. Stores
ciphertext only, with quotas and TTLs. ACK/expiry redacts the
ciphertext. Never an archive. See `src/relay/`.

### feed_host

Hosts signed text feed posts with explicit visibility modes (public,
unlisted, connections, close, public-meta-encrypted-body). Source of
truth for posts. See `src/feeds/`.

### discovery_index

Builds explainable hot/rising indexes over public feed posts using
signed reactions. Indexes only what is meant to be public. See
`src/discovery/`.

## Operator responsibilities

### Keep the service online

- Run sudo under systemd with `Restart=always`. See [SYSTEMD.md](./SYSTEMD.md).
- Watch `journalctl -u sudo.service` and `npm run smoke`.
- Never expose Node directly. Always front it with nginx (see
  [NGINX.md](./NGINX.md)).

### Respect that relays store ciphertext only

The relay must not be turned into a plaintext message log. Operators
should not keep ciphertext beyond the protocol's TTL/ACK semantics.
Don't add hooks that decrypt envelopes — the relay does not have the
keys, and that is the point.

### Sync is explicit, not automatic

The trusted-device sync log (`device_sync_log`) replicates **only**
the slices we have explicitly modeled: `contact`, `subscription`,
`message`, `draft`, `profile`. There is no generic "replicate the
whole settings store" slice.

Local-only state stays local:

- per-device cursors (`sync.origin_sequence:*`,
  `sync.recipient_cursor:*`) and `backfill_state` entries
- `device.metadata.*` (per-install identifiers, fingerprints)
- reminder dismissals, collapsed-panel flags, transient dialog state
- any browser-local UI preference that hasn't been deliberately
  modeled as a slice

Why this matters operationally:

- It bounds the surface area of what the relay sees. If a setting
  isn't on the allowlist, no event for it can be accepted at the
  edge (`isKnownSliceKind` in `src/devices/devices.routes.ts`).
- It prevents a "sync everything" projector from echoing writes back
  to the origin device and producing infinite sync loops.
- It prevents accidental cross-device propagation of secrets (e.g.
  a local bearer token cached for dev purposes).
- It keeps cross-device UX predictable: a reminder dismissed on
  desktop is *not* dismissed on mobile, by design.

Adding a new synced setting is a deliberate change: define the
payload, pick a slice + kind, extend `isKnownSliceKind`, register a
projector, and add a smoke covering both arrival on the peer and the
intended user-visible behavior. See SECURITY.md ("Sync is explicit,
not automatic") for the security framing.

### Enforce quotas

The protocol caps relay use per sender, per recipient, per pair, and
globally (see `src/protocol/constants.ts`). These are the spam and
sybil pressure release valves for unknown senders. Don't lift them
casually.

### Linked-device sync status

Settings → Linked devices shows a status line under each device. The
labels are the only user-facing surface for sync health; the
underlying state lives in the per-(owner, target_device_id) row of
the IndexedDB `backfill_state` store.

| Label                          | Meaning |
| ------------------------------ | ------- |
| `this device`                  | The current browser. Always synced with itself. |
| `synced`                       | Backfill completed successfully. Live writes flow normally. |
| `syncing…`                     | First-ever backfill is in flight for this peer. |
| `retrying sync…`               | A retry attempt is in flight (attempts > 1). |
| `sync will retry soon`         | Last attempt failed (likely a transient outage); the client is waiting out a backoff (30s → 2m → 10m) before the next auto-retry. |
| `sync paused — retry available`| Attempts hit `MAX_BACKFILL_ATTEMPTS` (5). The device has stopped auto-retrying; the user can click `retry sync` to bypass the cap. |
| `revoked`                      | The peer was revoked. No sync traffic flows in either direction. |

The dialog auto-refreshes every 5 seconds while open, so a transient
`syncing…` should flip to `synced` without the user re-opening it.
Closing the dialog tears the timer down.

Each row carries an "advanced" disclosure with the technical fields
operators may need when triaging:

- `id` — short device_id (first 8 chars)
- `backfill attempts` — count from `backfill_state.attempts`
- `events sent` — `backfill_state.total_events` for the last run
- `incoming cursor` — `sync.recipient_cursor:<owner>:<device>` setting
- `outgoing sequence` — `sync.origin_sequence:<owner>:<device>` setting
- `last attempt` — ISO timestamp of the last backfill attempt
- `last error` — raw error string (e.g. `contacts: 1 of 1 failed to post`, `rate_limited`)
- `recent attempts` — ring buffer of the last 5 backfill attempts
  (newest first), each rendered as `HH:MM ok, N events` or
  `HH:MM failed, <error>`. Useful for spotting flapping vs.
  one-off failures.

### When to click `retry sync`

The button appears on rows whose status is `sync will retry soon` or
`sync paused — retry available`. Clicking it:

- bypasses the auto-retry backoff (does not wait out the 30s/2m/10m
  window),
- still respects the per-device 5-attempt cap,
- runs immediately and re-renders the row in place,
- appends one entry to `recent attempts` regardless of outcome.

Click it when:

- the user is actively waiting for the peer to converge and
  doesn't want to wait out the backoff,
- the underlying network/relay issue has visibly cleared (e.g. a
  page that was rate-limited is loading again),
- the row has been stuck at `sync paused — retry available` for a
  while and the operator has identified the root cause.

Don't click it in a tight loop when `last error` is `rate_limited`
— the cap will keep firing until the 60s sliding window clears.

If a backfill is stuck:

1. Open Settings → Linked devices. Confirm the status is
   `sync will retry soon` or `sync paused — retry available`, not
   `synced` (which means there's nothing to fix).
2. Expand the advanced disclosure on the stuck row. The `last error`
   line is the most useful signal:
   - `rate_limited` → the per-IP or per-owner sync cap fired (see
     `src/devices/sync-rate-limit.ts`). The next auto-retry will
     succeed once the 60s window slides. Don't click retry in a tight
     loop; it'll just keep firing the cap.
   - `simulated_outage` / `network` → transient. Click `retry sync`.
   - `sequence_regression` / `invalid_sync_signature` /
     `origin_not_authorized` → something is wrong with the local
     device's keys or its membership. A relink (revoke + re-pair) is
     usually the safest fix.
3. If the device is genuinely unreachable (e.g. the user's other
   browser was wiped), revoke it. A `revoked` device produces 403 on
   `POST /:owner/sync`, `GET /:owner/sync`, and `POST /:owner/sync/ack`
   — see SECURITY.md.

Server-side journals worth checking when a single device is failing
across many users (i.e. an operator-level problem, not user-level):

- `journalctl -u sudo.service --since '15 min ago' | grep '/sync'` —
  look for spikes in 429s (rate-limit firing) or 503s (relay
  upstream issue).
- `sqlite3 data/sudo.sqlite "SELECT origin_device_id, COUNT(*) FROM
  device_sync_log WHERE created_at > datetime('now', '-1 hour') GROUP BY
  origin_device_id ORDER BY 2 DESC LIMIT 5"` — top emitters; a sudden
  burst from one device often signals a client in a retry loop.

### Revoke vs. link again vs. reset

These three are easy to confuse and have very different blast radii.
Settings → Linked devices is the surface; this section is the cheat
sheet for support / triage.

**Revoke a peer.** The destructive trust action. Clicking the
`revoke` button on an active row opens an inline confirm pane
("revoke <name>?") that names the target device. A second click on
`revoke device` commits. The client signs a new
`SignedDeviceMembership` for the target with `trust_state = revoked`
and `sequence = latest + 1`, POSTs it, and the server's
`resolveActiveMembership` then returns null for that device. The
revoked device's `POST /:owner/sync`, `GET /:owner/sync`, and
`POST /:owner/sync/ack` all return 403 — the gate is cryptographic,
not a soft UI flag. The revoked row stays visible in the panel as
historical context.

Use revoke when the user wants a specific paired browser to lose
access (lost laptop, sold device, suspected compromise of one
device only).

**Link again from a revoked row.** The reversibility path. A
revoked row offers a `link again` button that opens the same
temporary-passcode flow used by the top-level `link another
device`. The previously-revoked device row is NOT silently
restored — the operator/user runs the normal collect-account flow
on a fresh browser, which mints a fresh `device_id` and posts an
active membership at a higher sequence than the revoked one. The
old revoked membership stays revoked forever (it remains the
authoritative cryptographic record that that specific device was
cut off); the new device shows up as a separate active row.

Use link-again when the user revoked the wrong device by accident
or when they want to bring a previously-revoked browser back
online — they have to re-pair it through normal channels, no
secret restore path.

**Reset this device.** Settings → Reset this device is **local
data deletion only**. It drops the local IndexedDB and reloads.
It does NOT revoke the device on the server. The signed
membership on the relay is unchanged, and the user can re-import
their encrypted backup (or collect-account from another device)
to come back online with the same identity. This is destructive
for this browser's local cache (drafts, message history that
hasn't been synced from peers yet) but not for the account on
the relay.

Revocation is **not** account deletion. We don't currently
support account deletion; the identity continues to exist on
the registry until the user explicitly takes it down.

### Sync log growth

`device_sync_log` is the relay's encrypted-envelope store. It is
append-only today: there is **no automatic pruning** of old rows.
Each row carries `{ event_id, owner_canonical_id, origin_device_id,
origin_device_seq, slice, kind, created_at, server_received_at,
signed_event_json }`. The `signed_event_json` column holds the
opaque ciphertext envelope; the server never decrypts it.

Why no pruning yet: deletion needs a `purged_before` watermark
protocol so a slow-to-poll device that holds a tombstone older than
the cutoff can't be tricked into resurrecting the body via a stale
upsert replay. Until that protocol is designed, GC stays off.

To check current growth on a node:

```sh
sqlite3 data/sudo.sqlite \
  "SELECT COUNT(*), MIN(server_received_at), MAX(server_received_at)
   FROM device_sync_log"
```

Or, more friendly, hit the dev-only diagnostic endpoint (gated on
`isLocalDevelopment`):

```sh
curl -s http://127.0.0.1:3000/api/admin/sync/stats | jq
```

Returns:

- `device_sync_log.total_rows` — total envelopes stored
- `device_sync_log.distinct_owners` — unique owner canonical ids
- `device_sync_log.oldest_row_age_ms` / `newest_row_age_ms` — wall-clock age of the oldest/newest envelope
- `rows_by_owner_top` — top-10 owners by row volume (useful when triaging "which account is producing the load")
- `memberships.active` / `memberships.revoked` — totals across the registry
- `sync_lag.max_behind` / `avg_behind` / `devices_observed` — how far recipient-cursor positions trail the latest server_seq, computed from `device_sync_cursors` × `device_sync_log`

The endpoint returns 404 in production. A production-gated variant
(operator-bearer or admin-IP) is the next step; the path is
deliberately scoped under `/api/admin/` so the URL contract doesn't
change when that lands.

### Sync ordering: in-tab serial, cross-tab cooperative

Outbound sync events are serialized per `(owner, origin_device_id)`
through an in-process promise-chain lock in
`src/web/client/sync/coordinator.ts`. The lock spans **build →
sign → POST**, not just the sequence-number reservation, so the
events land on the wire in the same order they were reserved. A
fast post for `seq N+1` cannot overtake a slow post for `seq N`.

Cross-tab serialization is not protected by this lock. Two tabs of
the same origin share IndexedDB but not the JavaScript module state.
In practice this risk is bounded by the unlock model: a freshly
opened second tab restores the session but leaves the crypto bundle
locked until the user enters their password, so the second tab
silently no-ops on outbound posts. If the user explicitly unlocks
both tabs, cross-tab races become possible — the server's UNIQUE
constraint on `(owner, origin_device_id, origin_device_seq)` will
reject duplicates with `sequence_regression`, and the broadcast
wrapper returns false. Local writes remain durable; the broadcast
just has to be retried on the next user action.

A future hardening pass should add `navigator.locks` (Web Locks API)
or a `BroadcastChannel`-coordinated leader election to extend the
lock across tabs.

### Backups

Take regular backups of `data/sudo.sqlite` (the registry, relay
envelopes, feed posts, sessions). See [BACKUPS.md](./BACKUPS.md).
**Do not back up plaintext private key material.** As of 7128bd3 the
server no longer writes to `data/keys/`; user account secrets live in
the browser and the user is responsible for exporting their
encrypted `.sudo-backup.json` to survive device loss.

Restore drills are worth doing once, before you need them.

### TLS and reverse proxy

Use nginx + Let's Encrypt as in [DEPLOY_UBUNTU.md](./DEPLOY_UBUNTU.md).
Bind sudo to `127.0.0.1` only. nginx is the only public listener.

### Onion transport (later)

Onion-first relay transport is an architectural goal. Today the node
advertises an HTTPS relay capability and falls back gracefully. When
you bring up a Tor hidden service, set `SUDO_ONION_BASE_URL` and the
node will start advertising it as a higher-priority relay capability.
See [TOR.md](./TOR.md) for that path.

### Stay boring

No Docker, no PM2, no orchestrator. The point of this stack is that an
operator with `journalctl`, `nginx -t`, and `sqlite3` can fully reason
about what is happening. Keep the surface area boring on purpose.

## Health and resolved config

```sh
npm run smoke         # /health, /api/health, /.well-known/sudo/node.json, /client/main.js
npm run check:env     # prints resolved config + warnings
```

Run both after every deploy.

## Post-7128bd3 cleanup

Commit 7128bd3 stopped server keygen for the legacy signup path. New
accounts no longer produce private-key files under `data/keys/`. On
nodes that ran prior versions, prune the dormant artifacts once you
confirm a current build is live.

```sh
# Confirm the build (response includes signature_required posture)
curl -fsS https://example.com/health

# Preview what would be removed
sudo find /home/sudo-node/apps/sudo/data/keys -type f \
  \( -name "*.dev-private-key.pem" \
     -o -name "*.dev-feed-private-key.pem" \
     -o -name "*.identity.json" \
     -o -name "*.fingerprint.json" \) -print

# Review the list. If everything is dormant dev-signup material
# (which is the only thing the old path ever wrote), delete:
sudo find /home/sudo-node/apps/sudo/data/keys -type f \
  \( -name "*.dev-private-key.pem" \
     -o -name "*.dev-feed-private-key.pem" \
     -o -name "*.identity.json" \
     -o -name "*.fingerprint.json" \) -delete

# Verify the directory is now empty (or only contains a .gitkeep)
sudo ls -la /home/sudo-node/apps/sudo/data/keys
```

After pruning, an HTTP-direct unsigned feed post on the production
node returns `400 missing_signature` (the production browser portal
always signs client-side, so this only affects HTTP-direct callers
without a valid signature):

```sh
# Should return: {"ok":false,"error":"missing_signature",...}
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"author_canonical_id":"sudo:ed25519:...","author_handle":"@x","visibility":"public","body":"ping","public_metadata":{"tags":[]},"created_at":"...","updated_at":"...","deleted_at":null,"sequence":1}' \
  https://example.com/api/feeds/posts
```

Also apply the nginx version-leak fix from [NGINX.md](./NGINX.md) if
the `Server:` response header still advertises `nginx/1.x.y`.

## Legacy /api/identity/signin removed

Migration step 5 deleted the legacy `POST /api/identity/signin`
route, the `/dev/signin` alias, the `[legacy-signin]` instrumentation
log, and the browser-side fallback. The production browser portal
now authenticates exclusively via the client-signed challenge flow
(`GET /api/identity/challenge/:id` + `POST /api/identity/session-from-challenge`).

Anything HTTP-direct that still POSTs `/api/identity/signin` will
now get a 404 from the catch-all route — that's the death-watch
signal. The smoke `client-signed-session` Phase 3 explicitly
asserts this 404. The `dev_account_access` table that survived
this step was finally dropped in step 6 below.

## Legacy /api/identity/signup and /api/identity/recover removed

Migration step 6 deleted the last two password/recovery routes:

- `POST /api/identity/signup` and the `/dev/signup` alias
- `POST /api/identity/recover` and the `/dev/recover` alias
- `handleIdentitySignup`, `handleIdentityRecover`, and the
  `[legacy-signup]` / `[legacy-recover]` instrumentation
- `accountAccessProvider.createCredential` and
  `recoverCredential` (the entire `DevRecoverySecretProvider`
  class), along with the password/recovery hashing helpers
- the `dev_account_access` table itself —
  `runMigrations()` now `DROP TABLE IF EXISTS dev_account_access`,
  so existing droplets shed the table on first restart after this
  build lands and new installs never create it
- the `recoverDevHandle` browser API export and the
  `runRecover()` portal call site
- the entire recovery-mode UI in the restore dialog (the
  `restore-mode-recovery` / `restore-mode-file` toggle, the
  recovery-fields panel, and the recovery-answer copy). Restore
  is now exclusively backup-file-and-passphrase.
- the `npm run create-user` CLI (`src/cli/createUser.ts` and
  `src/identity/devSignup.ts`), which depended on
  `accountAccessProvider.createCredential`. Admins now create
  accounts the same way users do, via the browser portal.

Telemetry over the 5dde8a3 release window showed only
`sudo-probe-*` user agents on both routes — zero `Mozilla/*` and
zero successful (`outcome:"ok"`) recoveries — so the password
and backup-code-recovery surfaces were retired.

Anything HTTP-direct that still POSTs to any of those four paths
will now get a 404 from the catch-all route — that's the
death-watch signal. The smoke `client-signed-session` Phase 4
explicitly asserts the 404 for each.

What's left of the auth surface:

- `POST /api/identity/register` — signed `IdentityDocument` only.
  No password or recovery material is ever sent or stored.
- `GET  /api/identity/challenge/:canonicalId` —
  single-use nonce.
- `POST /api/identity/session-from-challenge` — nonce + client
  signature → session token.
- `GET  /api/identity/session` — bearer-token session restore.

Account recovery on a new device is the encrypted backup-file
flow: export `.sudo-backup.json` from the running portal, carry
it to the new device, restore with the backup passphrase. The
server holds nothing that could authenticate the user.

## Phase 11.1 — storage lifecycle, quotas, and cleanup

A sudo node has three storage surfaces that need active operator
attention: the SQLite database, the encrypted media blob store, and
the various short-lived auxiliary tables (pairing codes, identity
challenges, dev sessions). Phase 11.1 added per-owner quotas and
periodic sweepers; this section describes what an operator needs to
know.

### Configurable quotas

Three env vars tune the storage caps. Defaults are generous and
suitable for a small node (~100 users).

| Variable | Default | What it caps |
| --- | --- | --- |
| `SUDO_OWNER_MEDIA_QUOTA_BYTES` | `524288000` (500 MB) | Total ciphertext bytes one account can store across all media. Server tally is bytes-on-disk for `(uploader_canonical_id = $you)`. |
| `SUDO_OWNER_RELAY_ENVELOPE_QUOTA` | `5000` | Number of pending relay envelopes one sender can have in flight (across all recipients). Catches runaway clients. |
| `SUDO_MEDIA_RETENTION_DAYS` | `30` | A blob whose `last_accessed_at` is older than this is a GC candidate. Downloads bump the timestamp, so active media is never collected. |

Per-class size caps remain hard-coded in `media.routes.ts`: image
10 MB, video 50 MB, file 25 MB. These are the per-upload caps, not
the per-owner cap.

### Lifecycle sweepers

Three periodic timers run inside the node process:

- **every 5 minutes** — `expireRelayEnvelopes()` marks past-TTL
  envelopes as `expired` and blanks their ciphertext.
- **every 60 minutes** — `runRelayRetentionSweep()` hard-deletes
  pairing tokens, identity challenges, dev sessions, and envelopes
  that have been in the `expired` state for more than 72h.
- **every 60 minutes** — `runOrphanBlobGc()` deletes media blobs
  whose `last_accessed_at` is past the retention window, and
  reaps `.tmp` files older than 1h (crash leftovers from
  interrupted uploads).

The sweeps log to stdout only when they actually delete something,
so a quiet log is the desired state.

### Operator-only diagnostic endpoints

Gated to development mode (`SUDO_NODE_ENV` ≠ `production`). All
return 404 in prod.

- `GET  /api/admin/storage/snapshot` — aggregated quota state +
  top uploaders + orphan candidate counts. Numeric/structural only,
  no plaintext bodies or ciphertext.
- `GET  /api/admin/media/summary` — per-class blob counts +
  bytes, and the list of files on disk that have no SQLite row
  (untracked / legacy).
- `POST /api/admin/media/gc` — fire the orphan-blob GC. Pass
  `?dry_run=1` to preview which blobs would be collected without
  actually deleting them.
- `POST /api/admin/relay/retention-sweep` — fire the relay
  retention sweep on demand.
- `GET  /dev/diagnostics` — operator HTML page that auto-refreshes
  the snapshot above. Also surfaces client-side IDB state when
  loaded inside a signed-in browser.

### Manual storage cleanup

If a node hits disk-pressure unexpectedly:

```bash
# Preview which blobs the next GC would delete (no changes).
curl -s -X POST http://127.0.0.1:3000/api/admin/media/gc?dry_run=1 | jq

# Run the live sweep.
curl -s -X POST http://127.0.0.1:3000/api/admin/media/gc | jq

# Force the relay retention pass too.
curl -s -X POST http://127.0.0.1:3000/api/admin/relay/retention-sweep | jq

# Aggregated view of where the bytes are.
curl -s http://127.0.0.1:3000/api/admin/storage/snapshot | jq
```

For a deeper purge — when an account leaves and you want their
blobs gone before the retention window — directly UPDATE
`last_accessed_at` to a far-past date in `media_blobs` and run
the GC.

### Backup guidance

The SQLite file `${SUDO_DATA_DIR}/sudo.sqlite` (default
`./data/sudo.sqlite`) and the media directory
`${SUDO_DATA_DIR}/media/` are the two on-disk surfaces. A
consistent snapshot is a `.backup` of the SQLite file plus a
rsync/tar of the media dir taken AFTER the SQLite backup
completes — that ordering means any media blob referenced in the
DB exists on disk; the reverse (a blob without a DB row) is
benign and the next GC will reap it.

For per-user backup the operator does nothing; users export
`.sudo-backup.json` from the portal, which is an encrypted blob
of their account keys and conversation state. The server holds
nothing that could decrypt these backups.

### VAPID rotation

Web Push uses a VAPID keypair stored in
`${SUDO_DATA_DIR}/keys/vapid.json`. Rotating it invalidates every
push subscription bound to the prior public key, so:

- announce maintenance, then stop the node;
- delete `keys/vapid.json` and restart — the node mints a fresh
  pair on first boot;
- expect a brief period where existing signed-in browsers can't
  receive push until each device re-subscribes (handled
  automatically by `push.client.ts` on next visit).

### Onion deployment prerequisites

Before exposing a sudo node over Tor:

1. Set `SUDO_ONION_BASE_URL=http://<your.onion>` in the runtime
   env. The portal advertises this in the relay capability list.
2. Set `SUDO_PREFER_ONION_RELAYS=true` so clients on .onion talk
   to .onion relays.
3. Configure `torrc` to forward `HiddenServicePort 80 127.0.0.1:3000`
   onto the loopback bind of the node.
4. Verify CSP and headers still pass — `bash scripts/smoke.sh`
   against your .onion address should return all `ok`s.

### Disaster recovery notes

The dev-friendly drop-everything reset is just `rm -rf
${SUDO_DATA_DIR}`. In production:

- DO NOT delete `keys/` unless you're rebuilding the node from
  scratch; you'd lose the node identity AND every signed-in
  user's session-bearer trust.
- DB corruption: try `sqlite3 sudo.sqlite '.recover' >
  recovered.sql` first. The schema has no destructive cascades,
  so partial restores are safe.
- Lost media: there is no recovery if the on-disk blob is gone
  and no peer has cached it. Document this clearly with users —
  sudo is not a backup service.
