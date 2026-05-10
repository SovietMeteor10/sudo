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

Legacy server-mediated signup (`/api/identity/signup` and the `/dev/signup` alias) generates a keypair in memory, signs the identity document the registry stores, and immediately discards the private key. **No process now writes to `data/keys/`.** The legacy path is kept for HTTP-direct fixture smokes and any pre-7128bd3 callers; new code should call `/api/identity/register` instead.

`data/keys/` on existing deployments may still hold dormant artifacts from before this commit (`*.dev-private-key.pem`, `*.dev-feed-private-key.pem`, `*.identity.json`, `*.fingerprint.json`). Operators should prune those once they confirm 7128bd3 (or later) is live — see [BACKUPS.md](./BACKUPS.md) and [OPERATOR.md](./OPERATOR.md).

Production feed posts must arrive client-signed. The server verifies the signature on the way in. Unsigned posts in production are rejected with `400 missing_signature`. In local development the legacy server-side fallback (or a `dev-placeholder:feed-signature-unavailable` string) still fires so existing fixture smokes keep working.

## Secrets handling

Treat these as secrets:

- Browser-held private identity / feed / messaging / device / account-sync keys (encrypted in IndexedDB; user must back up via `.sudo-backup.json` to survive losing the device)
- Passwords
- Backup codes
- Recovery answers
- Session tokens

Policy:

- Never log them.
- Never commit them.
- Never place them in `localStorage` or `sessionStorage`.
- Never print them in docs or screenshots.
- Keep runtime material under `data/` and ignore it in Git.
- The server must never persist plaintext private keys. The legacy `data/keys/` directory should be empty on any node running 7128bd3 or later.

## Password hashing

Dev passwords are hashed with Node `crypto.scrypt` and a per-account salt.

This is acceptable for local development, but the real product should move account access to device-held credentials and eventually passkeys/WebAuthn.

## Backup codes and recovery

Backup codes are generated once at signup and shown once.

Recovery question and answer are stored only as salted hashes. They are scaffolding for future recovery flows, not a production recovery design.

The recovery flow must always require more than a single factor alone.

## Key continuity

Trust should come from stable public keys and continuity warnings, not from handle lookup alone.

Future work should warn when a handle changes keys or when a canonical identity changes unexpectedly.

## Client-held keys

Production browser signup generates and stores all private keys in the browser as of 7128bd3. The server never receives them. Sign-in unlocks the encrypted IndexedDB bundle locally with the user's passphrase; the server-side credential path is a fallback for legacy accounts only.

Future hardening: move local-unlock from passphrase-derived AES-GCM to a passkey/WebAuthn-backed credential, and eliminate the bearer `sessionToken` entirely in favor of a client-signed challenge so the server's session table stops being a single trust point.

The server must never need the private key. There is no longer a code path that writes one to disk.

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
- `slice` — `"contact"`, `"subscription"`, or `"message"`
- `kind` — e.g. `"contact.upsert"`, `"subscription.delete"`,
  `"message.upsert"`
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
