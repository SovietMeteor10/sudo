# Security

`sudo` is a privacy-first identity and messaging prototype, but the current implementation is still dev-only scaffolding.

## Threat model

The intended long-term model is:

1. Handles are discovery names, not trust.
2. Identity is anchored by signatures and key continuity.
3. Messages are encrypted blobs only.
4. The server should not learn plaintext private keys or plaintext messages.

## Current weaknesses

- Dev sessions are opaque bearer tokens stored by hash in SQLite and cached in browser `localStorage`. (Migration target: client-signed challenge.)
- Recovery backup codes exist only as local-dev scaffolding.
- Recovery question and answer exist only as local-dev scaffolding.
- Inbox reads remain dev-only and unauthenticated.
- There is no key-rotation or key-continuity history UI yet.
- There is no Tor/onion deployment automation yet.
- There is no client-side encryption UI yet.

## Key custody (what changed in 7128bd3)

Browser signup creates Ed25519 identity, feed, messaging, device, and account-sync keypairs entirely in the browser via WebCrypto, encrypts the private bundle under the user's passphrase (PBKDF2 250000 iters → AES-GCM), and stores it in the `crypto_accounts` IndexedDB store. The server only ever sees the signed identity document (public keys + handle), which it validates via `/api/identity/register` and stores in the `identities` table.

Legacy server-mediated signup was retired in migration step 6: `POST /api/identity/signup`, `POST /api/identity/recover`, and the `/dev/signup` and `/dev/recover` aliases all return 404. The server holds no password hash, no recovery-answer hash, and no backup-code hash — the entire `dev_account_access` table was dropped. **No process writes to `data/keys/`.** New accounts MUST go through `/api/identity/register` with a client-signed `IdentityDocument`.

`data/keys/` on existing deployments may still hold dormant artifacts from before this commit (`*.dev-private-key.pem`, `*.dev-feed-private-key.pem`, `*.identity.json`, `*.fingerprint.json`). Operators should prune those once they confirm 7128bd3 (or later) is live — see [BACKUPS.md](./BACKUPS.md) and [OPERATOR.md](./OPERATOR.md).

Production feed posts must arrive client-signed. The server verifies the signature on the way in. Unsigned posts in production are rejected with `400 missing_signature`. In local development the legacy server-side fallback (or a `dev-placeholder:feed-signature-unavailable` string) still fires so existing fixture smokes keep working.

## Secrets handling

Treat these as secrets:

- Browser-held private identity / feed / messaging / device / account-sync keys (encrypted in IndexedDB; user must back up via `.sudo-backup.json` to survive losing the device)
- The user's backup-file passphrase (only used in the browser to decrypt `.sudo-backup.json`; never sent to the server)
- Session tokens

Policy:

- Never log them.
- Never commit them.
- Never place them in `localStorage` or `sessionStorage`.
- Never print them in docs or screenshots.
- Keep runtime material under `data/` and ignore it in Git.
- The server must never persist plaintext private keys. The legacy `data/keys/` directory should be empty on any node running 7128bd3 or later.
- The server must never accept a password, recovery answer, or backup code. Migration step 6 deleted the routes, the table, and the hashing helpers that ever did.

## Account recovery

Account recovery on a fresh device is the encrypted-backup-file flow: the user exports `.sudo-backup.json` from a running portal, carries the file and the backup passphrase to the new device, and restores. The server holds nothing that could authenticate the user — no password hash, no recovery-answer hash, no backup-code hash.

The legacy backup-code + recovery-answer + recovery-question flow (`POST /api/identity/recover`) was retired in migration step 6 along with the `dev_account_access` table that backed it.

## Key continuity

Trust should come from stable public keys and continuity warnings, not from handle lookup alone.

Future work should warn when a handle changes keys or when a canonical identity changes unexpectedly.

## Client-held keys

Every account is client-key only. The browser generates and stores all private keys in IndexedDB, encrypted under the user's passphrase (PBKDF2-SHA256 at 600 000 iterations as of Phase 14 — see MED-1). The server never receives them. Sign-in unlocks the encrypted IndexedDB bundle locally, then mints a server session by signing a single-use challenge nonce with the local identity key — no password ever crosses the wire.

Bundles created before Phase 14 (at 250 000 iterations) auto-upgrade to 600 000 on the next unlock via the existing `v1→v2` re-encrypt-on-unlock path in `src/web/client/crypto/key-storage.ts`. Bundles whose `kdf.iterations` falls below the floor of 100 000 are refused outright as evidence of tampering.

Future hardening: move local-unlock from passphrase-derived AES-GCM to a passkey/WebAuthn-backed credential. The bearer `sessionToken` still exists for backwards compatibility, but it no longer guards any Critical or High audit finding — see "Per-request signed-payload auth" below.

The server must never need the private key. There is no longer a code path that writes one to disk.

## Per-request signed-payload auth (Phase 14)

The Phase 14 audit found that the HTTP routes around the encrypted
core trusted `owner_canonical_id` from the request body or URL with
no proof of ownership. Every "social graph" write was reachable
unauthenticated from any HTTP client on the open internet.

The fix: an `X-Sudo-Auth` header that carries a per-request signed
payload. The header is base64url-encoded JSON of
`{canonical_id, [device_id,] ts, nonce, signature}`, where the
signature is over the canonical JSON of `{type:"sudo_request_auth",
method, path, body_digest, canonical_id, [device_id,] ts, nonce}`.

Replay defenses:

- `ts` must be within ±60 s of server time.
- `nonce` must not have been seen in the current process within
  120 s; stored in-memory (lost on process restart, which bounds
  the worst-case replay window to the ts skew).
- `body_digest` is `sha256(canonicalJson(body))` (or `sha256("null")`
  for empty bodies — `request.body === {}` is normalized to `null`
  so client and server agree). A captured signature can't be reused
  with a different body.
- `method` and `path` are part of the signed payload, so a signature
  for `POST /api/connections` can't be replayed against any other
  route.

Server-side enforcement lives in `src/identity/request-auth.ts`
(middleware) and `src/node/trusted-ip.ts` (loopback-only X-Real-IP).

Client-side signing lives in `src/web/client/crypto/request-auth.ts`
(`signedFetchAsIdentity`, `signedFetchAsDevice`). The signer is
derived from the currently-unlocked account; calling a signed-fetch
helper while the account is locked throws `MissingSignerError`.

### Routes requiring identity-key signature

Signer: the unlocked account's identity private key. Cross-checked
against the named `owner_canonical_id` field in the body, URL, or
query string (a mismatch returns `403 canonical_id_mismatch`).

| Method | Path | Cross-check |
|---|---|---|
| `POST` | `/api/connections` | body `owner_canonical_id` |
| `DELETE` | `/api/connections/:ownerCanonicalId/:subjectCanonicalId` | URL `ownerCanonicalId` |
| `POST` | `/api/subscriptions` | body `owner_canonical_id` |
| `DELETE` | `/api/subscriptions/:ownerCanonicalId/:authorCanonicalId` | URL `ownerCanonicalId` |
| `POST` | `/api/relay/relationships` | body `sender_canonical_id` |
| `POST` | `/api/push/subscriptions` | body `owner_canonical_id` (+ private-IP block on endpoint URL) |
| `DELETE` | `/api/push/subscriptions` | body `owner_canonical_id` |
| `DELETE` | `/api/feeds/posts/:postId` | route handler verifies authenticated canonical_id matches post author |
| `DELETE` | `/api/discovery/reactions/:postId/:actorCanonicalId/vote` | URL `actorCanonicalId` |
| `GET` | `/api/notifications/incoming/:recipientCanonicalId` | URL `recipientCanonicalId` |

### Routes requiring device-key signature

Signer: the device's published `device_public_key` looked up from
`device_memberships`. The membership must be `trust_state="active"`
under the named owner. Cross-checked against the named `device_id`.

| Method | Path | Cross-check |
|---|---|---|
| `GET` | `/api/relay/inbox/:canonicalId` | URL `canonicalId` (owner) |
| `POST` | `/api/relay/envelopes/:messageId/ack` | route handler asserts the envelope's `recipient_canonical_id` matches the signer |
| `GET` | `/api/devices/:ownerCanonicalId/sync` | URL owner + query `device_id` |
| `POST` | `/api/devices/:ownerCanonicalId/sync/ack` | URL owner + body `recipient_device_id` |
| `GET` | `/api/devices/:ownerCanonicalId/sync/peer-progress` | URL owner + query `caller_device_id` |
| `GET` | `/api/devices/:ownerCanonicalId/sync/cursor` | URL owner + query `device_id` |

### Other Phase 14 gates

- `POST /api/relay/envelopes` — the `sender_signature: "dev-placeholder"`
  bypass is dev-only. In production an envelope without a real Ed25519
  signature over its canonical fields returns `400 missing_signature`
  (CRIT-1).
- `POST /api/devices/register` and `POST /api/devices/:deviceId/revoke`
  — `signed_membership` is now mandatory; the route rejects with
  `400 missing_signed_membership` if absent (HIGH-5). Revoke's
  push-subscription deletion side-effect runs only after signature
  verification succeeds.
- `POST /api/relay/expire` — dev-only (404 in prod).
- `POST /api/discovery/reindex` — dev-only (404 in prod).
- `POST /api/push/subscriptions` — endpoint URL is resolved at
  subscription time and rejected if any resolved IP falls in a
  reserved range (loopback, RFC1918, link-local, CGNAT, IPv4/v6
  multicast, IPv6 ULA/link-local, AWS metadata `169.254.169.254`).
  This closes the CRIT-5 SSRF leg. A strict push-provider allowlist
  (FCM/Apple/Mozilla/Microsoft) is intentionally deferred — see
  `docs/SECURITY_AUDIT.md` "Product decisions".

### Legacy bearer-token auth

`dev_sessions` bearer tokens (`Authorization: Bearer <token>`) still
exist and still authenticate `GET /api/identity/session`. They do
**not** authenticate any of the Critical/High routes above — those
require a per-request signature. Removing bearers entirely is a
Phase 14.1+ cleanup; the bearer table is no longer a single trust
point for any audit-flagged operation.

### Routes that remain public reads (intentional)

- `GET /api/identity/handles/:handle`, `/search`, `/profiles/:id`
- `GET /api/devices/:owner` — device + membership listing (public
  threat model: handles and devices are discovery names, not trust)
- `GET /api/feeds/posts`, `/users/:id`, `/users/:id/rss`,
  `/posts/:id`, `/posts/:id/replies`, `/posts/:id/thread`,
  `/personal/:viewer`
- `GET /api/discovery/hot|rising|recent`, `/handles`, `/posts/:id`
- `GET /api/typing/:recipient` — ephemeral typing state
- `GET /.well-known/sudo/node.json`

These do not surface ciphertext or content the threat model treats
as private. Authorization-gated *content* (e.g. `connections_only`
feed posts) still requires identity-signed reads where the viewer's
visibility depends on a relationship; see `feed.service.ts`
`canSeeAuthorPosts`.

## Passkeys and WebAuthn

Passkeys are a direction for device-held account access, not a password replacement on the server.

The browser should authenticate with a device-held credential. Biometrics remain only a local unlock mechanism.

## Tor and onion routing

Tor is future work. When it arrives:

- do not run it blindly on random VPS providers
- keep the app bound to localhost behind a proxy or onion service
- avoid leaking onion URLs through logs or public metadata where possible

## Metadata leakage

Even with encrypted messages, metadata still exists:

- handle lookups
- connection targets
- timing
- message delivery patterns

Expect to revisit metadata minimization later.

## Trusted-device sync log

The server stores a `device_sync_log` table that relays encrypted
SignedSyncEvent envelopes between paired devices. The encryption key
is derived on the client from the per-account `account_sync` key,
which lives only inside the encrypted local bundle and never leaves
the browser. The server therefore stores the events but cannot read
the per-slice payload.

What the server CAN see (plaintext fields on the envelope, used for
routing, dedupe, and replay protection):

- `event_id` — UUID
- `owner_canonical_id` — which account this belongs to
- `origin_device_id` — which paired device produced it
- `slice` — `"contact"`, `"subscription"`, `"message"`, `"draft"`,
  `"profile"`, or `"read_state"`
- `kind` — e.g. `"contact.upsert"`, `"subscription.delete"`,
  `"message.upsert"`, `"message.delete"`, `"draft.upsert"`,
  `"draft.delete"`, `"profile.upsert"`, `"read_state.upsert"`
- `sequence` — per-(owner, origin_device) monotonic counter
- `created_at`, `server_received_at`
- `signature` — the origin device's device-key signature, used to
  verify the envelope before it's accepted

What the server **cannot** see (sealed inside `encrypted_payload`):

- contact handles, canonical_ids, fingerprints, and tier
- subscription author canonical_ids and visibility flags
- message bodies, conversation_ids, and peer canonical_ids
- relay-message linkage details

`smoke:contact-sync`, `smoke:subscription-sync`, and
`smoke:message-sync` each include an audit assertion that pulls the
entire stored log via the public listing route and verifies that no
slice plaintext (handle, canonical_id, message body, peer id,
conversation id) appears anywhere readable on the server.

A revoked device's `POST /:owner/sync`, `GET /:owner/sync`, and
`POST /:owner/sync/ack` all return 403; revocation is enforced at the
relay edge and is independent of any local state the revoked device
still holds.

### Sync is explicit, not automatic

The trusted-device sync log carries **only** the slices listed above.
There is intentionally no generic `setting.upsert` / `setting.delete`
slice that replicates the local `settings` IndexedDB store wholesale.

What this means in practice:

- Cross-device state must be explicitly modeled as a slice (with its
  own `slice` name, allowlisted `kind` values, a projector that
  applies inbound events, and a broadcast wrapper that publishes
  outbound writes).
- Anything not modeled — `device.metadata.*`, dismissals, per-device
  cursors (`sync.origin_sequence:*`, `sync.recipient_cursor:*`),
  session markers, transient dialog flags, browser-local UI
  preferences — stays on the device that wrote it and never crosses
  the relay.
- Adding a new synced setting is a deliberate, reviewable change:
  define the payload, pick a slice + kind, add an `isKnownSliceKind`
  entry in `src/devices/devices.routes.ts`, write the projector, and
  add a smoke that proves both arrival on the peer AND that the new
  key actually carries the value the user expects.

The motivation is to avoid three classes of bug at once:

- **Sync loops** — a "sync everything" projector that fires a write
  on apply will echo back to the origin and bounce indefinitely.
- **Accidental secret propagation** — keys like
  `sudo.account.session_token` or any local bearer would be
  inadvertently mirrored to every paired device.
- **Cross-device UX confusion** — a "dismissed this reminder" or
  "collapsed this panel" flag belongs to one viewport; replicating
  it surprises the user on their other device.

`smoke:link-with-backfill` includes a regression assertion that a
local-only key written on A does not appear on B after a successful
backfill, locking this design choice in.

## Safe logging

Acceptable logs:

- startup and shutdown
- health checks
- non-sensitive error codes
- request IDs

Unacceptable logs:

- passwords
- backup codes
- recovery answers
- bearer tokens
- private keys
- raw message bodies
