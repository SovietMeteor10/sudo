# Security

`sudo` is a privacy-first identity and messaging prototype, but the current implementation is still dev-only scaffolding.

## Threat model

The intended long-term model is:

1. Handles are discovery names, not trust.
2. Identity is anchored by signatures and key continuity.
3. Messages are encrypted blobs only.
4. The server should not learn plaintext private keys or plaintext messages.

## Current weaknesses

- Dev signup and sign-in are local-development only.
- The server currently generates and stores plaintext private keys under `data/keys`.
- Recovery backup codes exist only as local-dev scaffolding.
- Recovery question and answer exist only as local-dev scaffolding.
- Dev sessions are opaque bearer tokens stored by hash in SQLite and cached in browser `localStorage`.
- Inbox reads remain dev-only and unauthenticated.
- There is no key-rotation or key-continuity history UI yet.
- There is no Tor/onion deployment automation yet.
- There is no client-side encryption UI yet.

## Secrets handling

Treat these as secrets:

- Dev private keys
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

The long-term design should move key generation and private key storage to the client device using passkeys, WebAuthn, Secure Enclave, or another hardware-backed mechanism.

The server should never need the private key in the final design.

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
