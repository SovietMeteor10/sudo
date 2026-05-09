# sudo Architecture

`sudo` is a protocol-oriented system, not a single website or app.

The current deployment is intentionally simple: one TypeScript Node/Express
server, SQLite storage, and a static browser portal. That deployment shape can
stay boring while the source tree separates the concepts that should be
replaceable later.

## System Parts

- Replaceable portals: web clients, local clients, and future native clients that present the protocol to users.
- Cryptographic identity registry: handle records, canonical IDs, signed identity documents, key fingerprints, and key continuity.
- Onion-first encrypted relays: message transport and ciphertext storage. Tor/onion routing is not implemented yet.
- Signed text feeds: chronological text posts with future signing and replication boundaries.
- Optional discovery indexes: search and ranking helpers that are separate from identity trust.

`sudochat.xyz` should be understood as one portal into sudo, not the whole
network. A portal may host a client, but identities, relays, feeds, and
discovery indexes should be able to run independently.

## Current Boundaries

- `src/app.ts` builds the Express app and mounts protocol modules.
- `src/server.ts` is the production entrypoint and only starts listening.
- `src/protocol` contains shared protocol constants, errors, and types.
- `src/crypto` contains shared key, hash, signature, and fingerprint utilities.
- `src/identity` owns identity registry behavior.
- `src/relay` owns encrypted message relay behavior and relay policy placeholders.
- `src/feeds` owns feed-facing behavior.
- `src/discovery` owns search/index behavior.
- `src/storage` owns SQLite setup, schema, and migrations.
- `src/web` owns the current static portal.

The legacy public routes remain mounted for compatibility while newer module
routes are exposed under `/api/identity`, `/api/relay`, `/api/feeds`, and
`/api/discovery`.

## Identity Continuity

The public identity key is the true sudo identity. A handle is a human alias
that helps people find and remember an identity, but it is not the root of
trust.

Canonical IDs are deterministic and derived from the public identity key:
`sudo:ed25519:<sha256-public-key>`. Identity documents are signed by the
identity key and include separate identity, messaging, feed keys, and ordered
delivery relay capabilities.

Each identity also has a visual fingerprint generated directly from a
cryptographic hash of the public identity key. The fingerprint is an 8x8 grid
of deterministic coloured squares, with 32 bits of pattern information mirrored
across the square. There is no avatar service and no randomness.

If the visual fingerprint changes for a known handle or contact, users should
treat that as an identity change until they can verify key continuity out of
band.

## Trusted Devices

sudo accounts are replicated across trusted devices. A user account is not
just a login on one browser; it is a cryptographic identity plus a set of
device registrations that can be linked and revoked over time.

The current model keeps the browser as the local owner of account material and
uses the server as a relay and rendezvous point. The server stores signed
public identity data and trusted-device metadata, but it is not the canonical
owner of private user state.

The canonical trust object for a trusted device is the **SignedDeviceMembership**
doc — signed by the owner's identity key (the same key that signs the
IdentityDocument) and stored in the `device_memberships` table. Anyone holding
the owner's identity public key can verify a membership without trusting the
server's index. The `trusted_devices` SQLite row is an index/cache derived
from these signed docs so reads stay cheap; if the cache is wiped or skewed,
`rebuildTrustedDevicesFromMemberships` can replay the canonical log to
reconstruct it. Pairing and revocation accept an optional `signed_membership`
on the API today; legacy clients that don't yet send one still work, and the
cache row remains the read path for the current UI.

Trusted devices are modeled separately so future encrypted event-diff sync can
move between devices without turning the relay into the source of truth. That
future sync layer should stream encrypted changes for messages, contacts,
subscriptions, feed state, and device events rather than copying whole stores.

## Relay Model

sudo relays are temporary bounded mailboxes for encrypted envelopes. They are
not archives, social graphs, or message databases with plaintext semantics.

A relay envelope contains routing metadata, an opaque ciphertext field, a
ciphertext scheme label, timestamps, status, and a sender signature placeholder.
The current development ciphertext scheme is `dev-placeholder`; real
client-side encryption and onion transport are future work.

Relay storage is bounded:

- blocked sender/recipient pairs cannot submit envelopes
- unknown senders have a small pending quota
- known senders have a larger bounded quota
- global, recipient, sender, and sender/recipient pair caps are checked
- all envelopes have TTLs

Recipient devices should ACK only after saving the envelope durably on the
device. The current server cannot verify that local save yet. On ACK or expiry,
the relay tombstones the row and redacts ciphertext from the relay copy.

The intended future transport is onion-first relay access. HTTPS access to a
portal is useful for deployment, but it is not the same as private network
transport.

## Transport Metadata

The portal transport and the private-message relay transport are separate
concerns. A user may visit sudo over HTTPS while their private relay delivery
prefers an onion endpoint.

The node capability document at `/.well-known/sudo/node.json` advertises:

- the node's public base URL
- an optional onion base URL
- the node roles
- ordered relay capabilities

If `SUDO_ONION_BASE_URL` is unset, the node advertises `onion_base_url: null`.
HTTPS relay fallback is explicit and should be treated as lower privacy than
onion transport. Tor is transport only; it is not identity or storage.

## Relationship Model

sudo uses a shared relationship model to connect contacts, relay policy, and
feed visibility.

Relationship tiers are:

- `unknown`: implicit default when no row exists
- `known`: accepted contact or connection
- `close`: explicit close-connection whitelist and also known for relay policy
- `blocked`: zero acceptance and hidden where practical

Feed subscriptions are separate local/social graph state. A subscription says
which authors a user wants to follow and whether the viewer wants public,
connections, or close-connection content in their local stream view.

Relay policy reads the same relationship model:

- blocked sender/recipient pairs are rejected
- unknown pairs stay heavily limited
- known and close pairs share the higher relay quota today

Server-side restricted feed filtering is only scaffolding for now. It helps the
current portal behave sensibly, but it is not cryptographic access control.
Future device-held keys and encrypted group delivery still need to land before
restricted feeds should be treated as private transport.

## Signed Text Feeds

sudo feed posts are signed text protocol objects. They are separate from private
message relay envelopes and from future discovery indexes.

Current feed posts are text-only and support explicit visibility modes:

- `public`: readable by anyone and intended to be indexable later.
- `unlisted`: fetchable by direct ID or author feed, but not shown in public indexes by default.
- `connections_only`: intended for approved connections and not discoverable by default.
- `close_connections`: restricted to an explicit recipient list and not natively repostable with attribution.
- `public_metadata_encrypted_body`: public title, summary, and tags with opaque encrypted body content.
- `private_message`: reserved for message semantics and excluded from normal feed display.

The current server can sign feed posts with plaintext development feed keys from
`data/keys` when they exist. That is DEV-ONLY scaffolding. Production feed
signing should happen with device-held feed keys, and restricted bodies should
be encrypted before reaching the server.

RSS-style publishing is available for public and unlisted text posts. The RSS
endpoint deliberately excludes close-connection content, restricted encrypted
bodies, deleted posts, and private-message semantics. Future discovery should
only index public or explicitly discoverable feed metadata; it should not be
treated as identity trust.

### Backfill Trust Model

When the personal feed needs an author's posts (because the viewer just
followed/befriended them), the client today calls
`GET /api/feeds/users/:authorCanonicalId?viewer=:viewerCanonicalId` on the node
the client is connected to. For the single-node MVP, that node is also the host
of those signed feed objects. This is acceptable for now but is **not** the
final trust model.

The long-term model:

- **Source of truth** is the signed feed post itself. Each post carries the
  author's signature; clients should verify signatures locally rather than
  trust the host that served them.
- **Author home node**: the author's identity document advertises a feed
  endpoint (their home node, an onion endpoint, or both). Clients should
  resolve "give me A's posts" by hitting A's advertised feed host, not by
  querying whichever node the viewer happens to be on.
- **Federation**: nodes are not authoritative caches. A node that doesn't host
  A's posts should be free to refuse, redirect, or proxy without affecting
  the viewer's ability to verify what comes back.
- **Replies and reposts** carry their own signatures and `reply_to` /
  `repost_of` references; once federated, a reply hosted on node X to a post
  hosted on node Y still verifies because the signature is over the full
  canonical post object.

For now, treat "this node's SQLite is hosting these signed posts" as a
single-node convenience. Federation will replace that assumption with remote
feed-host resolution; signature verification on the client is the long-term
trust anchor.

### Server-side guardrails

Two non-cryptographic guardrails on `POST /api/feeds/posts`:

- **Rate limit**: at most one feed post per author per 5 seconds (covers
  ordinary posts, replies, and reposts). Server returns
  `{ ok: false, error: "rate_limited", retry_after_seconds: N }` with HTTP 429.
- **One repost per (author, original)**: the server rejects a second
  `kind: "repost"` whose `repost_of` already has a non-deleted repost from
  the same author with `{ error: "duplicate_repost" }` and HTTP 409. Reposts
  of reposts are normalized server-side to point at the canonical original.

Both guardrails are convenience for the current single-node deployment and
will need to be re-expressed at the federation boundary (rate-limit at the
relay/host edge; duplicate-repost as a property of the signed object set).

## Discovery Indexes

Discovery nodes are optional indexes, not the source of truth. The source of
truth remains the signed feed post.

Discovery only indexes public and public-metadata/encrypted-body posts. It does
not index `connections_only`, `close_connections`, `private_message`, deleted,
or otherwise restricted posts by default.

Reactions are signed public objects tied to an indexed post. They are stored as
transparent reaction records, then rolled up into public counts and ranking
metadata.

Hot and rising scores are explainable, derived fields. The current ranking uses
reaction counts and age with no opaque recommendation model. Users should be
able to inspect the counts and explanation string and understand why a post is
shown.

## Local-First Private State

Private user state belongs to the client device. The current browser portal uses
IndexedDB database `sudo_local_state` as its working copy for identities seen,
contacts, known/blocked users, private message history, sent history, outbound
queue state, relay tombstone events, feed subscriptions, cached feed items,
drafts, device metadata, app settings, and an append-only local event log.

The relay remains a temporary bounded mailbox. It should never become the
private message archive. Received relay envelopes must be written durably to
local IndexedDB before the client calls the relay ACK route. ACK then allows the
relay to tombstone the row and redact ciphertext.

Browser storage caveats matter: IndexedDB is local to the browser profile and
can be cleared by the user, browser policy, or device loss. Users should export
encrypted backups before clearing browser data. Backup export uses local Web
Crypto PBKDF2 and AES-GCM; the backup passphrase is never sent to the server.

Future multi-device sync should replicate encrypted local state between
authorized devices. It should not make the relay a history store.

## Self-hosted nodes

A node is meant to be operable by a non-Anthropic operator with a
boring stack. The reference deployment is Ubuntu LTS + Node + systemd +
nginx + Let's Encrypt. There is no Docker, no PM2, no orchestrator on
purpose: the operator can reason about every moving part.

Configuration is read once at startup by `readNodeRuntimeConfig` in
`src/node/node.config.ts`. Keys an operator usually sets:

- `SUDO_NODE_NAME`, `SUDO_PUBLIC_BASE_URL`, `SUDO_ONION_BASE_URL`
- `SUDO_HOST`, `SUDO_PORT` (legacy `HOST`/`PORT` still honored)
- `SUDO_DATA_DIR`, `SUDO_DB_PATH`
- `SUDO_ENABLE_HTTPS_RELAY_FALLBACK`, `SUDO_PREFER_ONION_RELAYS`
- `SUDO_ALLOW_SIGNUPS`, `SUDO_REQUIRE_INVITE`
- `SUDO_LOG_LEVEL`

`/.well-known/sudo/node.json` advertises the node name, public and
onion base URLs, roles, and ordered relay capabilities derived from the
same config. `npm run check:env` prints the resolved config and warns
on common mistakes; `npm run smoke` probes `/health`, `/api/health`,
`/.well-known/sudo/node.json`, and `/client/main.js`.

The full operator path is documented under `docs/`: `INSTALL.md`,
`DEPLOY_UBUNTU.md`, `SYSTEMD.md`, `NGINX.md`, `BACKUPS.md`, and
`OPERATOR.md`.
