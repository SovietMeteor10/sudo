# Roadmap

This project is intentionally small at the surface and conservative underneath. The next work should strengthen the trust model before adding more UI.

## Highest priority

- Client-side key generation and local key storage
- Passkeys / WebAuthn account access
- Real encrypted messaging flows
- Key continuity warnings and history
- Better session handling that does not rely on browser storage

## Messaging and identity

- Encrypted inbox retrieval for authenticated recipients only
- Compose, decrypt, and send flows in the client
- Finger/profile rendering that stays text-first and inspectable
- RSS-like stream signing and verification
- Public profile and identity document editing

## Transport

- Tor/onion routing
- Onion-aware URLs in identity documents
- Better local and remote deployment profiles

## Platform hardening

- Rate limiting
- Abuse handling
- Replay protection
- Safer logging
- Safer deployment defaults
- Better secret lifecycle management

## Later

- Federation
- Cross-device recovery flows
- Social recovery
- Hardware-backed credentials where available
- More explicit trust warnings when keys change
