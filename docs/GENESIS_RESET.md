# Genesis network reset runbook

This is the operator playbook for performing a full network reset on
a sudo node — wiping every user-generated row, blob, and push
subscription while preserving deployable infrastructure, then
bringing the network back online as a "day-zero" launch.

Run this WITH INTENT. There is no rollback once the snapshot has
been overwritten.

---

## When this is the right tool

- You ran a pre-launch beta and want to reset before public
  rollout.
- A data-integrity bug requires starting clean and you have
  out-of-band notification capability for users.
- You are about to migrate to a new server identity (onion or
  clearnet) and want every old browser to force-reconnect.

This is NOT the right tool for:

- Routine maintenance (use `scripts/smoke.sh` against your
  staging node).
- Deleting a single user (no helper for that yet; do it manually
  via SQLite + media GC).
- Reclaiming disk (use `/api/admin/media/gc` for that).

---

## What survives the reset

| Surface | Preserved |
| --- | --- |
| SQLite schema (tables + indexes) | yes |
| `${SUDO_DATA_DIR}/keys/` (VAPID, onion) | yes |
| Operator config (env / nginx / systemd / torrc) | yes (lives outside dataDir) |
| Reset snapshot JSON | yes (operator audit trail) |
| Schema migrations record | yes |

## What gets wiped

| Surface | After reset |
| --- | --- |
| identities | 0 rows |
| encrypted_messages, relay_envelopes, relay_relationships | 0 rows |
| connections, feed_subscriptions, feed_posts | 0 rows |
| trusted_devices, device_sync_*, device_pairing_tokens, device_memberships | 0 rows |
| tombstone_watermarks, identity_challenges, dev_sessions | 0 rows |
| push_subscriptions | 0 rows |
| discovery_post_index, discovery_reactions | 0 rows |
| media_blobs (SQLite) | 0 rows |
| `${SUDO_DATA_DIR}/media/*` (files) | empty |
| In-memory rate-limit buckets | reset on service restart |
| `.epoch` | re-minted to a new UUID |

---

## Step-by-step

### 0. Pre-flight

```sh
# Confirm the live smoke gate against your node passes RIGHT NOW.
BASE_URL=https://yourdomain.example bash scripts/smoke.sh
BASE_URL=https://yourdomain.example npm run smoke:csp

# Take an out-of-band backup. Same ordering as routine backups —
# SQLite first, then media dir. See OPERATOR.md.
sqlite3 ${SUDO_DATA_DIR}/sudo.sqlite ".backup '/backups/pre-reset.sqlite'"
tar -czf /backups/pre-reset-media.tgz -C ${SUDO_DATA_DIR} media
```

The backup is your only rollback path. If the reset goes wrong,
you'll restore from this.

### 1. Maintenance mode

The reset script handles this — it creates
`${SUDO_DATA_DIR}/.maintenance` before doing any destructive work.
The server's `maintenanceMiddleware` returns HTTP 503 for every
route except `/health` and `/api/health` while the flag is present.

You can also flip the flag manually at any time:

```sh
echo "scheduled maintenance until 14:00 UTC" > ${SUDO_DATA_DIR}/.maintenance
# (later)
rm ${SUDO_DATA_DIR}/.maintenance
```

The file's contents are the message returned to clients.

### 2. Run the reset

Interactive (production):

```sh
node scripts/reset-network.cjs
```

You'll be asked to type `continue` then `RESET SUDO NETWORK`.

Dev/CI shortcut (only valid when `SUDO_NODE_ENV` is NOT
production):

```sh
node scripts/reset-network.cjs --yes
```

Preview without changes:

```sh
node scripts/reset-network.cjs --dry-run
```

The script:

1. Engages maintenance mode (touches `.maintenance`).
2. Writes a snapshot to
   `${SUDO_DATA_DIR}/reset-snapshot-YYYY-MM-DDTHH-MM-SS.json`
   (metadata only — counts, totals; no plaintext, no ciphertext).
3. DELETE FROM every user-generated table; VACUUM to reclaim disk.
4. Unlinks every file in `${SUDO_DATA_DIR}/media/`.
5. Mints a new `.epoch` value (causes every previously-connected
   browser to wipe its IndexedDB on next visit).
6. Removes `.maintenance`.

### 3. Restart the service

The `getNetworkEpoch()` value is cached in process memory after the
first read; the reset script only updates the file. A service
restart picks up the new epoch:

```sh
sudo systemctl restart sudo
```

### 4. Validate empty state

```sh
# Health check.
curl https://yourdomain.example/health

# Confirm an arbitrary anonymous endpoint returns "empty".
curl https://yourdomain.example/api/identity/search?q=anyone
# → { "results": [] }

# Confirm node.json still works + the new epoch is being served.
curl https://yourdomain.example/.well-known/sudo/node.json | jq
curl https://yourdomain.example/api/network/epoch | jq
```

### 5. Validate first signup

Open `https://yourdomain.example/` (or your `.onion`). Click
**sign up**. Pick a handle + passphrase. You should reach the
signed-in state with no awkward placeholders, no leftover
notifications, and no stale chat rows.

### 6. Validate first message

Open the same site in a second browser profile / device. Sign up
a second handle. From the first browser, search for the second
handle and send a test message. Confirm:

- Send succeeds (no `unknown_quota_exceeded`).
- Recipient receives it (encrypted-chat-envelope round-trip
  works).
- Reload the recipient browser; the message survives (Phase 11.6
  pending_decrypt path is exercised).

### 7. Validate push registration

In Settings → Notifications, enable push. Trigger a message to
that account from a peer. Confirm a notification arrives. The
message body must be generic ("new message"), not plaintext.

### 8. Validate onion + clearnet parity

If you run a dual-origin deployment:

```sh
BASE_URL=https://yourdomain.example npm run smoke:onion-origin-generation
BASE_URL=https://yourdomain.example npm run smoke:onion-csp
BASE_URL=https://yourdomain.example npm run smoke:onion-no-clearnet-leak
```

All three should pass.

### 9. Smokes against the live URL

```sh
BASE_URL=https://yourdomain.example npm run smoke:network-reset
BASE_URL=https://yourdomain.example npm run smoke:empty-launch-state
BASE_URL=https://yourdomain.example npm run smoke:epoch-invalidation
```

If any fail, treat as a deploy regression — investigate before
declaring the launch live.

---

## Rollback

If the reset went wrong (script crashed, smoke failures you can't
diagnose), restore from the pre-reset backup taken in step 0:

```sh
# 1. Engage maintenance mode again.
echo "rolling back genesis reset" > ${SUDO_DATA_DIR}/.maintenance

# 2. Stop the service so it releases the SQLite WAL.
sudo systemctl stop sudo

# 3. Restore SQLite.
cp /backups/pre-reset.sqlite ${SUDO_DATA_DIR}/sudo.sqlite
rm -f ${SUDO_DATA_DIR}/sudo.sqlite-shm ${SUDO_DATA_DIR}/sudo.sqlite-wal

# 4. Restore media.
rm -rf ${SUDO_DATA_DIR}/media
tar -xzf /backups/pre-reset-media.tgz -C ${SUDO_DATA_DIR}

# 5. Restore epoch — bumping it would force every legitimate
#    user to wipe their browser. Keep the pre-reset value.
#    If you no longer have it, generate a new one and accept the
#    user-side wipe.

# 6. Restart + verify.
sudo systemctl start sudo
rm ${SUDO_DATA_DIR}/.maintenance
BASE_URL=https://yourdomain.example bash scripts/smoke.sh
```

---

## Failure modes + recovery

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| Script aborts before writing snapshot | DB lock contention | Stop the service, retry. |
| Script aborts after wipe, before clearing `.maintenance` | Operator typo, file perms | `rm ${SUDO_DATA_DIR}/.maintenance` manually; restart service. |
| Browsers still show old chats after reset | Service not restarted; old `.epoch` still cached in memory | `systemctl restart sudo`. |
| Push notifications stop working | Stale subscriptions plus new VAPID key | Have each user toggle Settings → Notifications off+on. |
| `node.json` still lists old onion URL | `SUDO_ONION_BASE_URL` env still set on service unit | Verify env, restart. |

---

## Audit trail

The snapshot JSON written at `${SUDO_DATA_DIR}/reset-snapshot-*.json`
is the only record of the prior network state. Keep it on a
separate disk if you need post-reset auditing. It contains:

- per-table row counts before the wipe
- media blob count + total bytes
- the timestamp of the reset

It does NOT contain any plaintext bodies, ciphertext, handles, or
user-attributable metadata.
