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
- generated backup code shown once
- recovery question/answer scaffolding
- signed identity documents
- handle lookup and fuzzy search
- local connections list for conversation targets
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

## Identity documents

New identities use signed `sudo_identity` documents. A canonical ID is derived
deterministically from the public identity key in the form
`sudo:ed25519:<sha256-public-key>`, so the key is the stable identity and the
handle is only a human alias.

Identity documents include identity, messaging, and feed public keys, relay and
feed endpoint lists, timestamps, sequence number, and an Ed25519 signature. The
current local-dev signup flow still writes private keys under `data/keys`; this
is explicitly DEV-ONLY and must move client-side later.

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

## Local storage and backups

The browser portal keeps private working state in IndexedDB database
`sudo_local_state`, not in server SQLite. This includes contacts, local events,
private message history, pending outbound messages, identities seen, drafts,
subscriptions, device metadata, and app settings.

The maintenance panel can export and import encrypted `.sudo-backup.json` files.
Backups are encrypted locally with Web Crypto PBKDF2 and AES-GCM. The backup
passphrase stays in the browser and is not sent to the server.

Development caveats:

- local message bodies may be plaintext in IndexedDB until full client-side encryption lands
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

## Reset local dev state

```sh
npm run dev:reset
```

This deletes and recreates the local SQLite registry, dev sessions, dev private keys, and other runtime state under `data/`.

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

- The server currently generates and stores dev private keys.
- Private keys must move to the client device later.
- Password auth is local-dev only.
- Backup code and recovery Q&A are scaffolding.
- The registry is discovery, not trust.
- Signatures and key continuity are what matter.
- Messages should remain encrypted blobs only.
- Tor and onion routing are future work.

See [docs/SECURITY.md](docs/SECURITY.md) for the detailed threat model and [docs/ROADMAP.md](docs/ROADMAP.md) for the next implementation steps.

## Local-dev auth

Sign-in uses handle + password.

Recovery uses the backup code plus recovery answer only for local-dev recovery.

Example request shapes:

```http
POST /dev/signup
content-type: application/json

{
  "handle": "SovietMeteor",
  "password": "example-password",
  "recoveryQuestion": "first fictional world you obsessed over",
  "recoveryAnswer": "example recovery answer"
}
```

```http
POST /dev/signin
content-type: application/json

{
  "handle": "SovietMeteor",
  "password": "example-password"
}
```

```http
POST /dev/recover
content-type: application/json

{
  "handle": "SovietMeteor",
  "backupCode": "example-backup-code",
  "recoveryQuestion": "first fictional world you obsessed over",
  "recoveryAnswer": "example recovery answer"
}
```

Sessions are restored with `/dev/session` using a bearer token stored in browser `localStorage` for now. That is temporary dev scaffolding only.

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
