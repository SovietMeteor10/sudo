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
identity key and include separate identity, messaging, and feed keys.

Each identity also has a visual fingerprint generated directly from a
cryptographic hash of the public identity key. The fingerprint is an 8x8 grid
of deterministic coloured squares, with 32 bits of pattern information mirrored
across the square. There is no avatar service and no randomness.

If the visual fingerprint changes for a known handle or contact, users should
treat that as an identity change until they can verify key continuity out of
band.

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
