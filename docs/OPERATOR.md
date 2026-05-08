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

Take regular backups of `data/` (the SQLite database and the DEV-ONLY
`data/keys/`). See [BACKUPS.md](./BACKUPS.md). Restore drills are
worth doing once, before you need them.

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
