# Release Notes

## Unreleased

### Architectural Shift

- Reorganized sudo as a protocol-oriented system rather than a single website.
- Added explicit module boundaries for portal/client, identity, relay, feeds, discovery, storage, crypto, and shared protocol types.
- Split Express app construction from server startup so `node dist/server.js` remains the production entrypoint.

### Identity System

- Added signed `sudo_identity` documents.
- Added deterministic canonical IDs derived from Ed25519 public identity keys.
- Added deterministic 8x8 visual fingerprints for human key-continuity checks.
- Added identity and fingerprint API routes.

### Relay System

- Added `sudo_relay_envelope` records for opaque private-message relay transport.
- Added bounded store-and-forward semantics with unknown, known, and blocked relationship tiers.
- Added relay quotas, TTLs, ACK tombstones, and expiry redaction.

### Local-First Storage

- Added browser IndexedDB database `sudo_local_state` for private local state.
- Added append-only local events, local messages, contacts, identities seen, drafts, settings, subscriptions, and pending outbound queue stores.
- Added encrypted backup export/import using browser Web Crypto PBKDF2 and AES-GCM.
- Moved browser private state away from `localStorage`.

### Feed System

- Added signed text-only `sudo_feed_post` protocol objects.
- Added explicit feed visibility modes for public, unlisted, restricted, close-connection, and public-metadata/encrypted-body posts.
- Added SQLite feed post persistence, soft-delete tombstones, author feed routes, and RSS-style public/unlisted publishing.
- Added a minimal portal composer and chronological author feed display.

### Relationship System

- Added unified connection tiers for unknown, known, close, and blocked state.
- Added connection and subscription APIs that sync relay policy and feed visibility.
- Added server-side viewer-aware filtering for restricted feed posts as DEV-ONLY scaffolding.
