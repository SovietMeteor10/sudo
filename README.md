# sudo

`sudo` is a privacy-first, text-first identity and messaging prototype built on boring internet primitives.

It is a local-dev scaffold, not a production-secure system.

The current deployment intentionally keeps a single TypeScript Node/Express
process, SQLite database, and static browser portal. The code is separated so
the portal is replaceable and is not treated as the network itself.

## What it is

- privacy-first
- text-first
- identity + messaging prototype
- Tor-first in direction, not in current deployment
- quiet, lightweight, and chronological

The current UX is intentionally spare: a three-pane shell for identity, stream, and chats, with a landing/auth screen before session restore succeeds.

## Current features

- local signup and sign-in
- password-based dev auth
- account recovery code shown once
- recovery question/answer scaffolding
- signed identity documents
- trusted devices, pairing, and signed-membership-based revocation
- encrypted trusted-device sync for **contacts**, **follows/subscriptions**, and **message history** (server stores ciphertext + signed envelopes only — payloads sealed under a per-account key the server never sees)
- handle lookup and fuzzy search
- local connections list for conversation targets
- live personal-feed refresh: leader-elected polling with cross-tab broadcast and tab/focus wake-ups, no WebSockets
- encrypted inbox blob endpoints
- one-page three-pane client UI
- mobile tabs for identity, stream, and chats
- local dev reset command
- Pretext-backed stream rendering experiment isolated behind a small client abstraction

## Project structure

```text
src/app.ts           Express app construction and route mounting
src/server.ts        Production entrypoint; starts node dist/server.js listener
src/portal/          Static portal mounting adapter
src/web/client/      Browser TypeScript portal
src/web/static/      HTML and CSS shell served by Express
src/identity/        Identity registry, handle normalization, dev identity creation
src/relay/           Encrypted message relay/blob-store behavior
src/feeds/           Feed-facing data and future feed protocol work
src/discovery/       Discovery/search behavior separate from identity trust
src/node/            Node capability document and transport advertisement
src/storage/         SQLite setup, schema, and migrations
src/localState/      Local-dev account/session state
src/crypto/          Signing, key generation, fingerprints, canonical JSON
src/protocol/        Shared protocol constants, errors, and TypeScript types
src/routes/          HTTP compatibility adapters over the domain modules
docs/                Deployment, security, and roadmap notes
data/                Local runtime state, ignored by Git
dist/                TypeScript build output, ignored by Git
```

## Architecture direction

sudo is being kept as a protocol-oriented system rather than a single website.
The current static web UI is one replaceable portal. The identity registry,
relay/messaging layer, feed layer, discovery layer, crypto utilities, protocol
types, and SQLite storage are separated so future portals, onion relays,
identity registries, and discovery nodes can evolve independently.

Current public routes are preserved for compatibility, and module routes are
also mounted under:

- `/api/identity`
- `/api/relay`
- `/api/feeds`
- `/api/discovery`

The three user-visible concepts today are:

- Portal/client: `src/portal`, `src/web/client`, and `src/web/static`
- Identity registry: `src/identity`, exposed today through `/.well-known/handles`, `/finger`, and `/u`
- Relay/messaging layer: `src/relay`, exposed today through `/inbox`

Discovery, feeds, local client/dev state, crypto, and protocol types are kept
separate because future onion relays, identity registries, discovery nodes, and
portals should be able to evolve independently.

Transport metadata is advertised separately from the portal itself:

- `/.well-known/sudo/node.json` exposes the node capability document
- `delivery_relays` in identity documents are ordered relay preferences
- onion relays are preferred for private message transport when available
- HTTPS relay fallback is explicit and lower privacy

## Relationship and subscriptions

The shared relationship model ties together contacts, relay policy, and feed
visibility:

- `unknown` is the default when no relationship exists
- `known` is an accepted connection/contact
- `close` is an explicit close-contact whitelist and also counts as known for relay quotas
- `blocked` rejects relays and suppresses subscriptions where practical

Feed subscriptions live alongside relationships as local social-graph state.
They control which authors appear in the current portal stream, including
whether the viewer wants public, connections, or close-connection content.

The server-side visibility filters for restricted posts are still DEV-ONLY
scaffolding. They are useful for the current portal, but they are not a
replacement for future client-side encryption and group-key enforcement.

## Trusted devices

sudo accounts are replicated across trusted devices. The normal flow is:

1. create an account on one device
2. sign in on that device
3. optionally link another device later

The browser creates and keeps the device-held account material locally, then
registers signed public identity data with the server. A trusted device record
tracks the device name, trust state, last seen time, and capability flags.

The device panel lets you:

- see the current device
- see linked devices
- create a pairing code
- link another device
- revoke a device
- back up the account
- restore the account
- reset this device

Future encrypted event-diff sync will flow between trusted devices. It should
stay local-first and should not turn the relay into canonical storage.

## Identity documents

New identities use signed `sudo_identity` documents. A canonical ID is derived
deterministically from the public identity key in the form
`sudo:ed25519:<sha256-public-key>`, so the key is the stable identity and the
handle is only a human alias.

Identity documents include identity, messaging, and feed public keys, relay and
feed endpoint lists, timestamps, sequence number, and an Ed25519 signature.
Relay lists are now first-class `sudo_relay_capability` objects. The current
local-dev signup flow still writes private keys under `data/keys`; this is
explicitly DEV-ONLY and must move client-side later.

Because relay capabilities are part of the signed document, relay tampering
changes the identity signature and is visible during verification.

sudo also generates an 8x8 visual fingerprint from the public identity key. The
same key always produces the same coloured square grid, and a different key
should produce a visibly different grid. If a known contact's fingerprint
changes, treat that as an identity change until key continuity is verified.

## Relay envelopes

Private messages move through relays as `sudo_relay_envelope` records. The
relay stores routing metadata and opaque ciphertext only; it does not understand
plaintext message content. Current ciphertext uses a `dev-placeholder` scheme
until client-side encryption is implemented.

Relay policy is bounded store-and-forward:

- blocked sender/recipient pairs are rejected
- unknown pairs can have up to 3 pending messages
- known pairs have a higher bounded quota
- global, per-recipient, per-sender, and per-pair pending caps are enforced
- every envelope expires
- ACK and expiry tombstone rows and redact ciphertext

Current relay inbox and ACK routes are DEV-ONLY and do not yet authenticate the
recipient device. A real recipient should ACK only after durable local save.

## Signed text feeds

Feed posts use `sudo_feed_post` objects under `/api/feeds`. Posts are text-only,
bounded in size, signed by the author feed key when the current dev key
scaffolding is available, and stored in SQLite as protocol JSON plus indexed
columns.

Visibility modes are explicit:

- `public`: readable by anyone and suitable for future indexing
- `unlisted`: direct-link/author-feed visible, not public-indexed by default
- `connections_only`: restricted semantics, DEV-ONLY fetch without auth today
- `close_connections`: requires an explicit recipient list
- `public_metadata_encrypted_body`: public title/summary/tags with opaque encrypted body
- `private_message`: reserved for messaging, excluded from feed lists

Feed routes:

- `POST /api/feeds/posts` (rate-limited: 1 per author per 5s; rejects
  duplicate `kind: "repost"` with `error: "duplicate_repost"`)
- `GET /api/feeds/posts/:postId`
- `GET /api/feeds/posts/:postId/replies` (returns the descendant subtree;
  client builds the threaded reply view from the flat list)
- `GET /api/feeds/users/:canonicalId`
- `GET /api/feeds/users/:canonicalId/rss`
- `DELETE /api/feeds/posts/:postId`

Posts can carry `kind: "post" | "repost" | "reply"` plus `repost_of` /
`reply_to` references. Reposts of reposts are normalized to the canonical
original so duplicate-repost guards aren't bypassed by reposting someone
else's repost.

The RSS endpoint emits public/unlisted plaintext posts only. Restricted
visibility and encrypted-body modes are still development scaffolding until
client-side encryption, recipient authorization, and group key management exist.

### Personal-feed backfill: trust model today vs. long-term

When the personal feed is rebuilt — on sign-in, post, or any
connection/subscription change — the client calls
`GET /api/feeds/users/:authorCanonicalId?viewer=:viewerCanonicalId` for each
allowed author and merges the results.

For the single-node MVP, those signed feed objects live in this node's SQLite
database, so "fetch from the node" and "fetch from the author's feed host" are
the same thing. **This is a deployment convenience, not the trust model.** The
source of truth is the signed post — clients should verify signatures locally
rather than trust the host. The long-term direction is portable signed feed
objects fetched from the author's advertised feed endpoint (home node or onion
endpoint), not central server trust. See
[ARCHITECTURE.md](./ARCHITECTURE.md#backfill-trust-model) for the federation
direction.

## Discovery

The discovery layer is an optional public index over discoverable feed posts.
It is not the source of truth. The feed remains the source of truth.

Discovery routes:

- `POST /api/discovery/reactions`
- `GET /api/discovery/posts/:postId`
- `GET /api/discovery/hot`
- `GET /api/discovery/rising`
- `GET /api/discovery/recent`
- `POST /api/discovery/reindex`

Only public and public-metadata/encrypted-body posts are indexed. Restricted
feed modes are excluded from discovery.

Ranking is transparent:

- `hot_score = (recommend*3 + repost*4 + reply*2 - downrank*2 - report*8) / pow(age_hours + 2, 1.2)`
- `rising_score = recent_recommend*3 + recent_repost*4 + recent_reply*2 - recent_downrank*2 - recent_report*8`

Reactions are public protocol objects. The current build uses DEV-ONLY
placeholder signatures until client-held signing is implemented.

## Local storage and backups

The browser portal keeps private working state on this device, not in server
SQLite. This includes contacts, local events, private message history, pending
outbound messages, identities seen, drafts, subscriptions, device metadata,
trusted devices, and app settings.

The maintenance panel can export and import encrypted `.sudo-backup.json` files.
Backups are encrypted locally. The backup passphrase stays in the browser and
is not sent to the server.

Development caveats:

- local message bodies may be plaintext on this device until full client-side encryption lands
- clearing browser data can delete private state
- relay ACK must happen only after the client has saved the envelope locally
- multi-device sync is future work

## Run locally

```sh
npm install
npm run build
npm run dev
```

The app listens on `http://localhost:3000` by default.

## Transport configuration

Relevant environment variables:

- `SUDO_PUBLIC_BASE_URL`
- `SUDO_ONION_BASE_URL`
- `SUDO_ENABLE_HTTPS_RELAY_FALLBACK`
- `SUDO_PREFER_ONION_RELAYS`
- `SUDO_NODE_NAME`

The existing HTTPS portal still works as the user-facing entry point. Onion
transport is a delivery preference for private relay traffic, not a replacement
for the portal.

## Reset local dev state

```sh
npm run dev:reset
```

This deletes and recreates the local SQLite registry, dev sessions, dev private keys, and other runtime state under `data/`.

## Self-hosting

A sudo node is one Node process plus a SQLite file behind nginx. No
Docker, no orchestrator. The operator docs walk through it:

- [docs/INSTALL.md](docs/INSTALL.md) — clone, install, build, run
- [docs/DEPLOY_UBUNTU.md](docs/DEPLOY_UBUNTU.md) — full Ubuntu setup with Node, systemd, nginx, Certbot, ufw
- [docs/SYSTEMD.md](docs/SYSTEMD.md) — service unit template
- [docs/NGINX.md](docs/NGINX.md) — minimal reverse-proxy site config
- [docs/BACKUPS.md](docs/BACKUPS.md) — SQLite + data dir backups, restore, schedule
- [docs/OPERATOR.md](docs/OPERATOR.md) — node roles and operator responsibilities

Bootstrap and verify with:

```sh
cp .env.example .env
npm ci && npm run build
npm run check:env
npm start &
BASE_URL=http://127.0.0.1:3000 npm run smoke
npm run backup:sqlite
```

Each portal that runs sudo is an interchangeable entry point into the
network — not the network itself.

## Local Wi-Fi testing

```sh
HOST=0.0.0.0 npm run dev
```

Find your laptop IP, then open `http://LOCAL_IP:3000` from another trusted device on the same network.

This is only for trusted LAN testing. It is not private and not production-ready.

## VPS testing

For private SSH-tunnel testing:

```sh
HOST=127.0.0.1 PORT=3000 npm run dev
ssh -p 2222 -L 3000:127.0.0.1:3000 ubuntu@YOUR_VPS_IP
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for public nginx deployment guidance and firewall notes.

## Security model and caveats

- Private keys are generated in the browser and never leave the device.
- The registry is discovery, not trust.
- Signatures and key continuity are what matter.
- Messages should remain encrypted blobs only.
- Tor and onion routing are future work.

See [docs/SECURITY.md](docs/SECURITY.md) for the detailed threat model and [docs/ROADMAP.md](docs/ROADMAP.md) for the next implementation steps.

## Auth

Every account is client-key only. The browser portal generates an Ed25519 identity keypair, posts the signed `IdentityDocument` to `/api/identity/register`, and authenticates via the client-signed challenge flow. The server stores no password, no recovery answer, and no backup-code hash.

```http
POST /api/identity/register
content-type: application/json

{ "identity_document": { "type": "sudo_identity", "canonical_id": "...", "handle": "@SovietMeteor", "keys": { ... }, "signature": "..." } }
```

```http
GET /api/identity/challenge/sudo:ed25519:abcd...
→ { "nonce": "...", "expires_at": "...", "canonical_id": "..." }
```

```http
POST /api/identity/session-from-challenge
content-type: application/json

{ "canonical_id": "...", "nonce": "...", "signature": "..." }
→ { "identity": { ... }, "sessionToken": "...", "expiresAt": "..." }
```

Sessions are restored with `GET /api/identity/session` using the bearer token stored in the browser. Account recovery on a new device is the encrypted backup-file flow: export `.sudo-backup.json` + passphrase, restore on the new device.

## Handle lookup and connections

The chats pane searches as you type with a fuzzy local-dev lookup endpoint.

Connections are local browser-only conversation targets keyed by canonical ID. They are not a social graph.

## Deployment notes

- Bind the app to `127.0.0.1` behind nginx for production-like setups.
- Do not expose the Node process directly on `0.0.0.0` on a public VPS unless that is intentional.
- Use HTTPS.
- Prefer a fresh public VPS or droplet for public prototype work.
- Keep Docker port exposure and firewall rules deliberate.

More detail is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
