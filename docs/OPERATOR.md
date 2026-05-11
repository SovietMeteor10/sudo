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

### Enforce quotas

The protocol caps relay use per sender, per recipient, per pair, and
globally (see `src/protocol/constants.ts`). These are the spam and
sybil pressure release valves for unknown senders. Don't lift them
casually.

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
