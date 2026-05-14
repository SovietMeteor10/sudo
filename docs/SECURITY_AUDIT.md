# Security Audit — Phase 14

**Date:** 2026-05-13
**Branch:** `main` (HEAD `a8a71da`, post-Phase 13.1)
**Reviewers:** four parallel code-review passes covering (1) auth/devices/sync/tombstones, (2) relay/media/feed/push, (3) platform hardening + rate limits, (4) Tor/client/crypto/deps.
**Method:** static code review against `docs/SECURITY.md` threat model. No runtime probing. `npm audit` was run.

---

## Executive summary

The cryptographic core is in good shape. Key custody is client-only, chat wire is opaque ciphertext, identity registration is rigorously signature-checked, CSP/COOP/CORP/Permissions-Policy are tight, no clearnet leaks in shipped client modules (one comment-only exception), no npm-audit findings, no WebRTC, no plaintext keys in `localStorage`.

The **HTTP "social-graph" surface around the encrypted core is the problem.** Every route that writes a relationship (`/api/connections`, `/api/relay/relationships`), every push subscription write, the legacy and current relay inbox-read endpoints, the relay ack endpoint, feed-post deletion, discovery vote clearing, and the device register/revoke routes — all of them trust an `owner_canonical_id` field from the request body or URL with no signature, no bearer-token check, no proof the caller actually controls that identity. The identity-auth challenge flow (`/api/identity/challenge/start` → `/api/identity/session-from-challenge`) exists and works correctly, but it is not wired into the write paths that mutate trust state.

**The encryption holds, but the metadata and graph around it are freely manipulable from any HTTP client on the open internet.** A single attacker can today, against any user of sudo:

- Read the entire pending relay-inbox queue (sender handles, message ids, timestamps, ciphertext).
- Permanently delete (ack-redact) every queued message before the recipient's device retrieves it.
- Inject envelopes claiming to be from any handle they like (forged push notifications, quota exhaustion against the spoofed sender).
- Mark themselves "close" to the victim, then read connections-only and close-only feed posts.
- Hijack push subscriptions to receive real-time "who is messaging the victim" metadata, and use the push endpoint as an SSRF primitive.
- Delete any user's feed posts.
- Clear any user's discovery votes.
- Enumerate any user's notifications (incoming follows, replies, reposts, reactions, mutual peers).

These are not theoretical. Every one is a one-line `curl` away today.

**Recommendation:** do not launch on the open internet (clearnet or Tor) until at minimum the five Critical findings are patched. The single middleware described in "Recommended patch order" below closes most of the Critical and High set in one change.

---

## Triage table

| Severity | Count | Examples |
|---|---|---|
| **Critical** | 5 | Sender-spoof bypass, unauth inbox read, unauth ack-destroy, unauth connection rewrite, push poisoning + SSRF |
| **High** | 6 | Unauth feed-post delete, vote clearing, notifications enum, device register/revoke, sync-log read-by-device-id, legacy `/inbox` POST |
| **Medium** | 12 | PBKDF2 below 2026 baseline, X-Real-IP trust, media uploader header, no SQLite busy_timeout, pairing-code entropy, push DELETE no owner check, rate-limit map growth, others |
| **Low** | 12 | clearnet hostname in comment, SW message-origin check, deprecated `escape()`, `home_node` cross-origin reflection, others |

---

## Cross-cutting pattern (read this first)

Most Critical and High findings share **one** root cause: routes accept the actor's identity as **claim-of-id** rather than **proof-of-id.** Specifically:

```ts
// Pattern that recurs across connections, push, relay relationships,
// feed delete, discovery vote, device register, device revoke:
const body = request.body as { owner_canonical_id?: unknown, ... };
if (typeof body.owner_canonical_id !== "string") { 400; return; }
// ... then mutates state belonging to body.owner_canonical_id
```

The codebase already has the right primitives:
- `verifyDeviceMembership` / `acceptSignedMembership` (`src/devices/membership.ts`) for owner-key proofs.
- `consumeChallenge` + bearer-session minting (`identity-auth.handlers.ts`) for short-lived per-canonical sessions.
- `verifyCanonicalSignature` (`src/protocol/sign.ts`) for one-off signed payloads.

They are just not consistently applied. A single middleware that **(a)** reads `Authorization: Bearer <token>` or a per-request signed header, **(b)** resolves it to an authenticated `canonical_id`, and **(c)** rejects requests where any `*_canonical_id` field in body/URL disagrees with the authenticated one, would close C1, C2, C3, C4, C5, H1, H2, H3, H4, H5, M1 in one change. Some routes (push subscriptions, ack) need the second flavor (per-request signed payload) rather than a bearer; both are 1-day implementations.

A separate, smaller pattern: **the string `"unsafe_dev_only_..."` in a JSON response is used as if it were a runtime gate.** It is advisory only. Treat `// DEV ONLY:` comments without an `isLocalDevelopment` check as bugs.

---

## CRITICAL

### CRIT-1 — Relay accepts forged sender on any `sender_signature: "dev-placeholder"`

- **Where:** `src/relay/relay.service.ts:62-78` (mounted from `src/relay/relay.routes.ts:43-69`)
- **What:**
  ```ts
  if (parsed.sender_signature !== "dev-placeholder"
      && parsed.sender_signature !== "dev-placeholder:relay-signature-unavailable") {
    const sender = getIdentityByCanonicalId(parsed.sender_canonical_id);
    if (sender === null) return { ok: false, error: "invalid_envelope" };
    const isValid = verifyCanonicalSignature(/* ... */);
    if (!isValid) return { ok: false, error: "invalid_envelope" };
  }
  ```
  Signature verification is skipped entirely when `sender_signature === "dev-placeholder"`. **There is no `isLocalDevelopment` gate**, unlike `src/feeds/feed.service.ts:667-675` which DOES gate the equivalent feed fallback. The POST endpoint itself requires no bearer token.
- **Impact:** Any unauthenticated remote can submit a relay envelope claiming an arbitrary `sender_canonical_id`. The envelope lands in the recipient's `/api/relay/inbox/:canonicalId` listing. Body ciphertext is opaque (the recipient has no shared key with the attacker), but plaintext metadata is preserved: `sender_canonical_id`, `sender_handle`, `created_at`, `is_forwarded`, `reply_to_relay_message_id`. Concrete harms:
  1. **Spoofed push notifications** — `push.service.ts` reads `sender_handle` and the recipient's lock screen says "@alice just sent a message" with no way to detect forgery.
  2. **Quota burn against the spoofed sender** — the attacker exhausts `ownerRelayEnvelopeQuota` against any victim, locking the legitimate user out of sending.
  3. **Tier accounting abuse** — spoofed "known"-tier traffic stalls a victim's known-tier inbox by pretending to be a victim's contact.
- **Fix:** Drop the `dev-placeholder` bypass in production. Mirror `feed.service.ts`: if no real signature is supplied, only accept when `readNodeRuntimeConfig().isLocalDevelopment`, otherwise return `400 missing_signature`. Tighten `parseRelayEnvelopeInput` so the default `sender_signature` is `null`, not `"dev-placeholder"`.

### CRIT-2 — `GET /api/relay/inbox/:canonicalId` is fully unauthenticated

- **Where:** `src/relay/relay.routes.ts:88-96`
- **What:**
  ```ts
  relayRouter.get("/inbox/:canonicalId", (request, response) => {
    // DEV ONLY: recipient authentication is not implemented yet. ...
    response.json({
      warning: "unsafe_dev_only_ciphertext_listing",
      envelopes: listRecipientRelayInbox(request.params.canonicalId)
    });
  });
  ```
  No auth check. The `warning` string is the only protection.
- **Impact:** Anyone can list every pending envelope for any canonical_id and read plaintext fields: `message_id`, `sender_canonical_id`, `sender_handle`, `created_at`, `expires_at`, `is_forwarded`, `reply_to_relay_message_id`, plus the raw ciphertext. This is a full social-graph dump per victim — every minute, on a cron, for the entire userbase.
- **Fix:** Require recipient-device auth. Easiest near-term: require a bearer session whose `canonical_id` matches `:canonicalId`. Production path: per-request signed payload using the device key.

### CRIT-3 — `POST /api/relay/envelopes/:messageId/ack` destroys envelopes for anyone

- **Where:** `src/relay/relay.routes.ts:98-108`, `src/relay/relay.store.ts:140-159`
- **What:**
  ```ts
  relayRouter.post("/envelopes/:messageId/ack", (request, response) => {
    // DEV ONLY: the server cannot verify durable local recipient save yet.
    const result = ackStoredRelayEnvelope(request.params.messageId);
    ...
  });
  ```
  `ackRelayEnvelope` sets `status='acked'` AND `ciphertext=''`. The row is permanently retired. The route has no auth.
- **Impact:** Combined with CRIT-2 (unauth inbox listing), an attacker can enumerate a target's pending message_ids and ack every one, **permanently denying delivery of all queued messages before the legitimate recipient device picks them up.** Persistent attacker = total inbound channel kill, untraceable.
- **Fix:** Require recipient-device proof on ack. Same shape as CRIT-2.

### CRIT-4 — `POST /api/connections` and `POST /api/relay/relationships` let strangers rewrite anyone's connection graph

- **Where:** `src/connections/connections.routes.ts:17-49`, `src/relay/relay.routes.ts:110-134`, `src/connections/connections.service.ts:17-56`
- **What:** Both endpoints accept `owner_canonical_id` (or `sender_canonical_id`/`recipient_canonical_id` pair) in the body with no signature, no bearer, no claim verification.
- **Impact:** Two distinct chains:
  1. **Reading restricted feed posts.** `feed.service.ts:569-589` decides visibility on `connections_only` / `close_connections` posts by reading `getConnectionRelationship(viewer, author).tier`. An attacker runs `POST /api/connections {owner_canonical_id: "sudo:eve", subject_canonical_id: "sudo:victim", tier: "close"}` (writing Eve→Victim from Eve's side, which the visibility filter then reads to grant Eve view rights), then `GET /api/feeds/posts/<id>?viewer=sudo:eve` reads any victim's connections-only post. **This is a plaintext content leak**, not just metadata.
  2. **Targeted DoS between any two users.** Attacker posts `{owner: <victim>, subject: <peer>, tier: "blocked"}` — `evaluateRelayPolicy` then silently drops every subsequent message between them.
  3. **Forced follower / feed subscription.** `upsertConnection` writes `feed_subscriptions` for non-unknown/non-blocked tiers — the attacker shows up in the victim's follower list.
- **Fix:** Require a signature over `{owner_canonical_id, subject_canonical_id, tier, ts}` verified against the owner's identity key, or a bearer-session whose canonical_id matches `owner_canonical_id`. Same fix applies to `DELETE /api/connections/:owner/:subject` and `POST /api/relay/relationships`. The legacy `relay_relationships` table write in `upsertConnectionRelationship` must also be gated (otherwise the relay tier accounting is still poisonable through the back door — see MED-6).

### CRIT-5 — Push subscription poisoning + SSRF

- **Where:** `src/push/push.routes.ts:58-96`
- **What:**
  ```ts
  if (!isCanonicalId(body?.owner_canonical_id)) { 400; return; }
  ...
  if (!isNonEmptyString(body?.endpoint, 2048) || !/^https?:\/\//i.test(body!.endpoint!)) { ... }
  ...
  upsertPushSubscription({ owner_canonical_id: body.owner_canonical_id!, endpoint: body.endpoint!, p256dh: body.p256dh!, auth: body.auth! });
  ```
  No proof of `owner_canonical_id`. Endpoint URL is only checked for `http(s)://` prefix — no provider allowlist, no private-IP block.
- **Impact:** Two attacks in one endpoint:
  1. **Real-time traffic analysis.** Attacker posts a subscription for `{owner: <victim>, endpoint: attacker.tld, p256dh: <attacker_pub>, auth: <attacker_auth>}`. Every relay envelope to the victim triggers `push.service.ts` → web-push → attacker, decryptable by the attacker. Payload includes `{conversation_hint, sender_handle, unread_count}` — a live presence/communication oracle.
  2. **SSRF.** `endpoint` is any `http(s)://` URL. Internal addresses, link-local IPs, cloud metadata services all pass. The server signs+POSTs encrypted blobs there on every chat envelope — usable amplification primitive.
- **Fix:**
  1. Require a signature from `owner_canonical_id`'s identity key over the subscription material.
  2. Reject endpoints that don't resolve to a public push provider (allowlist: FCM `fcm.googleapis.com`, Apple `*.push.apple.com`, Mozilla `updates.push.services.mozilla.com`, Windows `*.notify.windows.com`, etc.) — OR at minimum block private/reserved/link-local IP ranges and require DNS resolution to a public IP at subscription time.
  3. The DELETE endpoint (`push.routes.ts:98-116`) needs the same owner-proof — see MED-5.

---

## HIGH

### HIGH-1 — Legacy `POST /inbox/:canonicalId` accepts arbitrary messages, no rate limit, no TTL

- **Where:** `src/routes/inbox.ts:14-39`, `src/relay/messageStore.ts:18`
- **What:** Legacy fallback inbox endpoint stores any `{from, ciphertext, nonce, signature}` body with no verification (`signature` is recorded but never checked). No per-IP/per-recipient rate limit. The `encrypted_messages` table has no `expires_at` column and is never swept by retention (only the newer `relay_envelopes` is reaped). Genesis reset wipes the table; routine ops never do.
- **Impact:** (a) Same shape as CRIT-1 — sender spoofing via a different code path. (b) Anonymous SQLite growth attack: `for i in 1..N; POST /inbox/<canonical>` with 64KB bodies, forever.
- **Fix:** Either remove the legacy `/inbox/*` routes entirely (sibling legacy routes were 404'd in migration step 6; this one slipped), OR gate them behind `isLocalDevelopment`, OR add the retention sweep and rate limits. Either way it must not co-exist with CRIT-1.

### HIGH-2 — `DELETE /api/feeds/posts/:postId` accepts claim-of-author with no signature

- **Where:** `src/feeds/feed.routes.ts:65-80` → `src/feeds/feed.service.ts:448-473`
- **What:** Authorization is "does the request body's `requester_canonical_id` equal the post's `author_canonical_id`?" Author canonical_ids are public (RSS, `/api/feeds/users/:id`, `.well-known`). Anyone who knows a post_id constructs `?requester_canonical_id=<author>` and the post is soft-deleted.
- **Impact:** Anyone can delete any user's feed posts.
- **Fix:** Require a signature by the author's feed key over `{post_id, ts, "delete"}`.

### HIGH-3 — `DELETE /api/discovery/reactions/:postId/:actorCanonicalId/vote` is unauthenticated

- **Where:** `src/discovery/discovery.routes.ts:67-73`
- **What:** No auth. Anyone can clear anyone else's recommend/downrank votes on any post.
- **Impact:** Skews ranking. Lets coordinated abusers strip downvotes from their own posts by clearing other users' votes.
- **Fix:** Require a signature by `actor_canonical_id`'s identity key (same shape as `createDiscoveryReaction` already accepts).

### HIGH-4 — `GET /api/notifications/incoming/:victim` enumerates social activity unauthenticated

- **Where:** `src/notifications/notifications.routes.ts:28-143`
- **What:** No auth, no rate limit. Returns the victim's incoming follows, replies, reposts, reactions, and mutual-connection peers. Fans out 5 SQL aggregate reads per request.
- **Impact:** Full social-graph dump per victim. Also a per-call read-load amplifier (no rate limit).
- **Fix:** Require recipient auth (bearer-session canonical_id matches `:recipientCanonicalId`). Also wire `checkOwnerReadRate` for parity with other listing endpoints.

### HIGH-5 — `POST /api/devices/register` and `POST /api/devices/:deviceId/revoke` accept unsigned membership

- **Where:** `src/devices/devices.routes.ts:94-150`, `src/devices/devices.routes.ts:367-399`
- **What:** Both handlers treat `signed_membership` as **optional**. Without it, the server inserts/mutates a `trusted_devices` row carrying attacker-controlled fields. Revoke additionally calls `deletePushSubscriptionsForDevice(deviceId)` as a side effect.
- **Impact:**
  - **Register:** Plant a bogus device in any owner's listing. The `device_memberships` log is not touched, so sync-edge access is preserved (revocation enforcement still holds), but `GET /api/devices/:owner` returns the bogus row — UI shows "you have a 'pwned-laptop' device you don't recognize."
  - **Revoke:** Flip any victim device's `trust_state` to `revoked` (visible in linked-devices UI) **and silently delete its push subscriptions.** Legitimate owner's pushes stop until re-subscribe.
- **Fix:** Make `signed_membership` mandatory on both routes. Reject when absent. Reject when `verifyDeviceMembership` doesn't pass. Move `deletePushSubscriptionsForDevice` to fire only after signature verification succeeds.

### HIGH-6 — `GET /api/devices/:owner/sync` accepts device_id as proof-of-identity (no key check)

- **Where:** `src/devices/devices.routes.ts:536-568, 575-588, 632-688, 693-708`
- **What:** Auth is `resolveActiveMembership(owner, deviceId)` — "does a row exist with `trust_state='active'`?" The caller passes `device_id` as a query param. The server does not verify the caller actually holds the corresponding `device_public_key`.
- **Impact:** An attacker who learns any active device_id for a target owner (trivially available via the unauthenticated `GET /api/devices/:owner` listing) can:
  - Pull the entire encrypted sync log. Body bytes are AES-GCM sealed under the per-account `account_sync` key (attacker can't decrypt slices), but plaintext envelope fields (`event_id`, `origin_device_id`, `slice`, `kind`, `sequence`, `created_at`, `server_received_at`, `signature`, watermark snapshot) are returned — including purge cadence per device.
  - Forge `POST /sync/ack` to advance the recipient cursor on behalf of someone else's device. Cursors only move forward → silent data loss on re-pull.
  - Read `GET /sync/peer-progress` sync-lag telemetry between any two devices.
  
  `docs/SECURITY.md` claims "revoked device's /sync paths all return 403" (true), but does not claim "only the device itself can call these." The current implementation is "anyone claiming to be that device" — a meaningful gap.
- **Fix:** Replace "claim-by-id" with "prove with signature." Either (a) per-route signed payload header (e.g. `x-device-signature` over `{path, body, ts, nonce}` verified against the device's published `device_public_key`), or (b) mint a per-device bearer at pair/complete time and require it.

---

## MEDIUM

### MED-1 — PBKDF2 iterations 250 000 (OWASP 2023 baseline: 600 000)

- **Where:** `src/web/client/crypto/key-storage.ts:15` (`ACCOUNT_ITERATIONS = 250000`)
- **Impact:** The IDB-resident encrypted account bundle holds every private key. An attacker with the bundle (forensic disk seizure, malicious browser extension, device sold without wipe) is reduced to an offline dictionary attack at ~2.4× the cost of the 2026 baseline. A 4-word diceware passphrase (~10⁵ candidates) is within GPU-cracking reach.
- **Fix:** Raise to `600_000`, re-encrypt on next unlock (the codebase already has a v1→v2 auto-upgrade dance — line 213-216 of the same file). Reject any envelope with `kdf.iterations` below a floor (e.g. 100 000) at decrypt time to defend against a tampered backup.
- **Product decision:** doubles unlock latency on low-end mobile (~120 ms → ~240 ms on a 2019 phone). Surface to UX before bumping.

### MED-2 — `X-Real-IP` trusted unconditionally; bypasses every per-IP rate limit if nginx is misconfigured

- **Where:** `src/relay/relay.routes.ts:37-41`, `src/media/media.routes.ts:92-96`, `src/typing/typing.routes.ts:67-71`, `src/push/push.routes.ts:48-52`. Express trust-proxy is `"loopback"` (`src/app.ts:33`).
- **What:** `resolveRelayIp` prefers `request.get("x-real-ip")` over `request.ip` unconditionally. Behind a misconfigured nginx (or a cloudflared tunnel without `proxy_set_header X-Real-IP $remote_addr`), a remote client can rotate the header per request and bypass every per-IP rate limit in the relay/media/typing/push surfaces.
- **Fix:** Only consult `X-Real-IP` when `request.ip === "127.0.0.1"`. Or drop the header entirely and trust `request.ip` (Express already correctly resolves it given `trust proxy = "loopback"`).

### MED-3 — Media upload `uploader_canonical_id` header is unauthenticated → quota exhaustion against any victim

- **Where:** `src/media/media.routes.ts:131-154`
- **What:** Header is taken on faith. The code comment acknowledges this is the design. With 30 uploads/min/IP × 25 MB each = 750 MB/min sustained per IP, a single IP can drain a victim's `ownerMediaQuotaBytes` in seconds.
- **Fix:** Signed attestation (per-upload signature against the uploader's identity key over `{blob_sha256, size, class, ts}`). Phase 11.2 docstring already promises this.

### MED-4 — No `SQLITE_BUSY` retry; no `busy_timeout` set

- **Where:** `src/storage/db.ts:11-15`
- **What:** Better-sqlite3 is single-threaded per process so in-process writes don't collide, but any co-located writer (smoke harness, periodic sweeps in `server.ts`, a manual `sqlite3` CLI) briefly holding the writer lock causes route handlers to throw `SQLITE_BUSY` → 500. Most routes don't catch.
- **Fix:** `db.pragma("busy_timeout = 5000")` at boot — better-sqlite3 honours this, no API change.

### MED-5 — `POST /api/discovery/reindex` is unauth and rebuilds the index in one SQLite transaction

- **Where:** `src/discovery/discovery.routes.ts:93`, `src/discovery/discovery.store.ts:329`
- **What:** No auth. Anonymous caller can fire it in a tight loop. Each call locks the writer for the duration of the full sweep — blocks every other write (envelope insert, sync events).
- **Fix:** Gate behind `isLocalDevelopment`, or add a per-IP rate limit (1/min) plus a "another reindex in progress" guard.

### MED-6 — Legacy `relay_relationships` table is doubly written, doubling the CRIT-4 poisoning surface

- **Where:** `src/connections/connections.store.ts:80-94` (`upsertConnectionRelationship` writes both `connections` AND `relay_relationships`)
- **What:** Belongs with CRIT-4. Calling out separately because a fix to CRIT-4 must also lock down `upsertLegacyRelayRelationship`, or attacker-controlled tier accounting persists via the back door.

### MED-7 — Pairing code entropy 48 bits

- **Where:** `src/devices/devices.store.ts:346-348` (`randomBytes(3).toString("hex")` × 2)
- **What:** Per-IP cap is 30/min and TTL is 60s, but the cap is per-IP only — a botnet defeats it. PBKDF2 wraps protect the bundle contents, so impact is layered.
- **Fix:** Bump to `randomBytes(5)` for 80-bit entropy (still fits the `XXXXXX-XXXXXX` shape with base32). Add a per-owner-canonical bucket so cross-IP brute force is also bounded.

### MED-8 — `POST /api/devices/pair/start` accepts any `owner_canonical_id`, creates real DB rows

- **Where:** `src/devices/devices.routes.ts:152-162`
- **What:** No verification the caller is the owner. Attacker can spam pairing tokens for any handle. Retention sweep runs hourly, so spam persists.
- **Fix:** Require bearer-session match for `owner_canonical_id`.

### MED-9 — `pair/cancel` is unauthenticated beyond knowing the pairing_token

- **Where:** `src/devices/devices.routes.ts:272-280`
- **What:** UUIDv4 token (122-bit entropy) is the only guard. Practical risk is low; flag for completeness and add a per-owner rate limit on cancels.

### MED-10 — `POST /api/push/subscriptions` DELETE has no owner check

- **Where:** `src/push/push.routes.ts:98-116`
- **What:** Comment says "an attacker who can flood DELETE without owning the device_id cannot affect any row." That holds for random device_ids, but `device_id` is observable (32-hex, transported in /api/devices, sometimes logged). Anyone knowing a victim's `(device_id, endpoint)` pair can permanently de-register them.
- **Fix:** Signed-by-owner attestation, same as the POST.

### MED-11 — In-route rate-limit `Map`s grow unbounded across keys

- **Where:** `relay.routes.ts`, `media.routes.ts`, `typing.routes.ts`, `push.routes.ts` (inline limiters with no key-eviction)
- **What:** The peer limiters (`challenge-rate-limit.ts`, `sync-rate-limit.ts`, `owner-read-rate-limit.ts`) have a `pruneIfStale` sweep. The inline ones don't. An attacker who rotates source IPs every minute grows these Maps indefinitely. Slow memory leak; not crash-exploitable but worth fixing for parity.
- **Fix:** Add `pruneIfStale` equivalents, or migrate the inline limiters to a shared helper.

### MED-12 — Maintenance-mode `existsSync` per request + TOCTOU window

- **Where:** `src/node/maintenance.ts:24`
- **What:** Every request stats a file pre-route. Reset script's "engage → wipe → disengage" window can leak a small handful of writes during the engage transition.
- **Fix:** Cache result for 1s in-memory, or use `fs.watch` to flip an in-memory flag.

---

## LOW

| ID | Title | Where | Fix |
|---|---|---|---|
| LOW-1 | Clearnet hostname `sudochat.xyz` in comment in `dist/web/client/local/qr-encoder.js` (Phase 12 doc says "no hardcoded clearnet hosts in client") | `src/web/client/local/qr-encoder.ts:3` | Replace with `<origin>` placeholder; extend `onion-origin-isolation-smoke` to walk all `dist/web/client/**/*.js`. |
| LOW-2 | Service-worker `message` listener has no `event.source.url` origin check | `src/web/static/sw.js:135` | Ignore messages where source URL doesn't start with `self.location.origin`. |
| LOW-3 | `home_node` rendered on onion profile page reflects the originally-registered origin (possibly clearnet) | `src/routes/profile.ts:38-60` | **Product call:** strip/rewrite on onion-served responses, OR accept as designed (cross-discovery is a feature). |
| LOW-4 | `escape(atob(...))` (deprecated ES2025-removed API) | `src/web/client/local/relay-local.ts:61` | Use `decodeURIComponent`/`TextDecoder` path. |
| LOW-5 | `NETWORK_EPOCH` cache not invalidated until process restart — reset script's runbook says "restart", but if forgotten, genesis reset no-ops for stale clients | `src/node/network.epoch.ts:19-44` | `fs.watch` the file, or document "restart REQUIRED, not recommended" in `GENESIS_RESET.md`. |
| LOW-6 | `inbox`/`profile`/`finger`/`home_node` fields on `IdentityDocument` are unconstrained free-form strings; rendered HTML-escaped or text-plain so no XSS | `src/protocol/types.ts:65-80` | Add URL regex + CR/LF/NULL reject at registration. |
| LOW-7 | `/dev/diagnostics` HTML page inline `<script type="module">` would violate the hash-pinned CSP, so the page never works as designed | `src/routes/dev.ts:190` | Either inline the script content into `index.html` for hash coverage, or move it to a `/client/diagnostics.js` static file. |
| LOW-8 | `consumeChallenge` deletes the row even on bad canonical_id mismatch | `src/identity/identity-challenge.service.ts:73-94` | Acceptable as-is (rate-limit bounds it). Document. |
| LOW-9 | Pairing TTL was recently tightened to 60s; older client images may surprise | `src/devices/devices.store.ts:33` | Operator-runbook note. |
| LOW-10 | Per-origin sync `SELECT MAX(seq)` + `INSERT` outside transaction; concurrent posts at same sequence throw UNIQUE → 500 instead of clean 409 | `src/devices/syncStore.ts:32-92` | Wrap in `db.transaction()`, catch UNIQUE → 409. |
| LOW-11 | `upsertDeviceMembership` allows same-sequence overwrite (clock-skew risk only — strict less-than is too lenient) | `src/devices/devices.store.ts:209-249` | Block `sequence <= latest.sequence`. |
| LOW-12 | media.gc.ts deletes DB row before file; concurrent download bump can no-op silently | `src/media/media.gc.ts:116-137` | Take the bump-then-stream sequence under a row lock, or move bump to post-stream close. |

---

## Investigated and clean (selected highlights)

- **Identity registration.** `verifyIdentityDocument` checks signature against the declared public key, then recomputes `canonical_id = sha256(public_key)` and rejects mismatch. Monotonic sequence replay-protected. Cannot register under someone else's canonical_id.
- **Challenge nonce flow.** 256-bit random, single-use, DELETE-on-consume (even for invalid attempts), 60s default TTL, rate-limited per-IP + per-canonical BEFORE the consume so bucket-burning doesn't drain budget for the legit user.
- **`session-from-challenge`.** Verifies owner signature over canonical `{type, canonical_id, nonce}` before minting a session.
- **Device sync POST.** Requires `resolveActiveMembership` + `verifySyncEvent` against the device's published key. Cannot inject sync events under another device.
- **Revoked device sync gating.** `trust_state === "active"` enforced. `stale-session-replay-smoke` covers it.
- **CSP.** `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, importmap pinned by sha256 hash recomputed at startup. No `unsafe-eval`. `style-src 'unsafe-inline'` is conscious and documented.
- **Permissions-Policy.** 11 features explicitly denied (`geolocation`, `microphone`, `payment`, `usb`, `bluetooth`, `magnetometer`, `gyroscope`, `accelerometer`, `display-capture`, `interest-cohort`, `browsing-topics`) plus 2 scoped to origin (`camera=(self)` for QR scanner, `fullscreen=(self)`). The slice originally said "13 features denied" — that was counting all 13 directives instead of just the denials; the "11 denied" figure in `docs/SECURITY.md` is correct.
- **COOP/CORP/X-Frame-Options/Referrer-Policy/HSTS.** All present with strict values.
- **Client innerHTML usage.** Two sites, both safe (hardcoded HTML + server-generated QR SVG with no untrusted interpolation). No `eval`, `new Function`, `outerHTML` writes, `dangerouslySetInnerHTML`.
- **No WebRTC, no WebSockets, no external fetches.** Every client `fetch` resolves against `window.location.origin`.
- **No plaintext private keys in localStorage.** Only the network-epoch string, leader-claim records, onboarding-flag, public-only restore metadata.
- **AES-GCM.** Fresh 12-byte IV from `randomBytes` everywhere (`messaging.ts`, `media.ts`, `sync.ts`, `key-storage.ts`). No IV reuse risk.
- **Math.random not used in security contexts.** All security RNG is `crypto.randomBytes` or `crypto.subtle`.
- **Body limits.** `express.json({ limit: "64kb" })`. Media stream caps per class (10/50/25 MB) enforced with chunk-by-chunk size accounting; oversize triggers 413 and unlinks the `.tmp` file. Atomic `rename(2)` prevents partial uploads from appearing under a public URL.
- **JSON / prototype pollution.** Each route reads fields via `typeof` checks. No `Object.assign({}, body)`, no spread into a trusted shape, no `lodash.merge`.
- **ReDoS.** Every user-input regex is bounded (anchored, fixed-length, no nested quantifiers).
- **Real `/dev/*` and `/api/admin/*` routes** in `src/routes/dev.ts` are correctly gated; `diagnostics-hardening-smoke` enforces it.
- **`/api/push/test`** is correctly `isLocalDev`-gated.
- **Maintenance middleware** is mounted before media/JSON/every router; only `/health` + `/api/health` bypass.
- **`/.well-known/sudo/node.json`** is origin-aware: onion requests get onion-only transports.
- **npm audit.** 0 vulnerabilities across all severities. 120 prod deps, 16 dev. Direct deps: `@chenglou/pretext@0.0.6` (single-maintainer, recommend pinning exact version), `better-sqlite3@11.10`, `express@4.22.1`, `web-push@3.6.7`.

---

## Product decisions surfaced by this audit

These need an explicit call before patch:

1. **PBKDF2 600k iterations (MED-1).** Doubles unlock latency on low-end mobile. Recommended yes, but the user-visible latency is real.
2. **`home_node` cross-origin reflection on onion profile pages (LOW-3).** Either a feature (cross-discovery) or a leak (clearnet identity visible on onion). Pick one and document.
3. **Push subscription endpoint allowlist vs private-IP block (CRIT-5).** **Decided 2026-05-13: private-IP block only.** Strict allowlist (FCM/Apple/Mozilla/Windows) would forecloses self-hosted / federated push setups that don't exist today but are on the long-term roadmap. The private-IP block in `src/push/endpoint-validation.ts` (rejects loopback, RFC1918, link-local, CGNAT, AWS metadata, IPv6 ULA/link-local, multicast) covers the SSRF leg; the per-request signature on `POST /api/push/subscriptions` (CRIT-5 sig fix) covers the traffic-analysis-oracle leg. **Allowlist deferred** as defense-in-depth — revisit if a future audit finds the private-IP block insufficient.
4. **Bearer sessions vs per-request signed payloads** for the social-graph writes. `docs/SECURITY.md` already commits to "eliminate bearers in favor of per-request client-signed token." Phase 14 patches can choose: short-term bearer (matches existing identity-auth flow, ships fast) or long-term per-request signature (matches the doc's roadmap, takes longer).
5. **Legacy `/inbox/*` routes (HIGH-1).** Three options: delete (matches treatment of other migration-step-6 legacy routes), gate behind `isLocalDevelopment`, or harden in place. Recommend delete.

---

## Recommended patch order

If you're patching in one session, do them in this order — earlier fixes make later ones simpler.

**Group A — single shared middleware (closes most CRITs and HIGHs)**

1. **Authn middleware.** Add `requireAuthenticatedOwner(canonicalIdFieldName)` that resolves `Authorization: Bearer <token>` to a session-bound canonical_id and rejects if the named body/URL field disagrees. Wire into:
   - `POST /api/connections` (CRIT-4)
   - `DELETE /api/connections/:owner/:subject` (CRIT-4)
   - `POST /api/relay/relationships` (CRIT-4)
   - `DELETE /api/feeds/posts/:postId` (HIGH-2) — needs feed-key-signature variant since deletion is by author key, not session
   - `DELETE /api/discovery/reactions/:postId/:actor/vote` (HIGH-3) — actor-signature variant
   - `GET /api/notifications/incoming/:victim` (HIGH-4)
   - `POST /api/devices/register` (HIGH-5) — make `signed_membership` required
   - `POST /api/devices/:deviceId/revoke` (HIGH-5) — same
2. **Drop `dev-placeholder` bypass in prod** for `submitRelayEnvelope` (CRIT-1).
3. **Gate or remove** `GET /api/relay/inbox/:canonicalId` + `POST /api/relay/expire` behind `isLocalDevelopment` for immediate stop-gap (CRIT-2) — then ship the per-request signed read in the same group.
4. **Gate `POST /api/relay/envelopes/:messageId/ack`** behind recipient-device proof (CRIT-3).

**Group B — push endpoint surface (CRIT-5)**

5. Require signature on `POST /api/push/subscriptions` over the subscription material.
6. Add private-IP/link-local block on endpoint URL. Decide on provider allowlist vs block-only.
7. Apply same signature requirement to `DELETE /api/push/subscriptions` (MED-10).

**Group C — quick wins**

8. `db.pragma("busy_timeout = 5000")` (MED-4).
9. `resolveRelayIp` only honor `X-Real-IP` when `req.ip === "127.0.0.1"` (MED-2).
10. Gate `POST /api/discovery/reindex` behind `isLocalDevelopment` (MED-5).
11. Pairing code entropy 48 → 80 bits (MED-7).
12. `POST /api/devices/pair/start` requires owner session (MED-8).
13. Add per-key eviction to inline rate-limit Maps (MED-11).
14. Add MED-3 signed-uploader attestation to media upload, OR at minimum require the canonical_id to match an authenticated session.

**Group D — defense in depth**

15. PBKDF2 250k → 600k with auto-upgrade-on-unlock (MED-1). **Product decision first.**
16. SW `message` source-origin check (LOW-2).
17. Clearnet hostname comment scrub + smoke extension (LOW-1).
18. LOW-7, LOW-10, LOW-11, LOW-12 hygiene.

**Smokes to add for every fixed Critical/High**

- `relay-sender-spoof-smoke` — assert `dev-placeholder` POST is rejected with 400 in prod-mode.
- `relay-inbox-unauth-smoke` — assert unauth GET `/api/relay/inbox/:canonical` returns 401/403 in prod.
- `relay-ack-unauth-smoke` — assert unauth POST `/ack` returns 401/403 in prod.
- `connections-unauth-smoke` — assert unauth POST `/api/connections` returns 401/403; verify visibility of a connections-only post is not granted via forged tier.
- `push-subscription-unauth-smoke` — assert unauth POST/DELETE `/api/push/subscriptions` returns 401/403; assert SSRF private-IP block.
- `feed-delete-unauth-smoke` — assert unauth DELETE returns 401/403.
- `discovery-vote-clear-unauth-smoke` — assert unauth DELETE returns 401/403.
- `notifications-incoming-unauth-smoke` — assert unauth GET returns 401/403.
- `device-register-revoke-unsigned-smoke` — assert both routes reject missing `signed_membership`.
- `sync-log-device-id-claim-smoke` — assert `GET /api/devices/:owner/sync?device_id=...` requires device-key proof.
- `legacy-inbox-deleted-smoke` — assert legacy `/inbox/:canonical` POST returns 404 (recommended) or has been hardened equivalently.

---

## Appendix — raw slice reports

Detailed code excerpts and reviewer notes available in:
- `.audit-slice-platform.md` — dev/admin gating, CSP/XSS, storage, rate limits, races, locking, epoch
- `.audit-slice-tor-client.md` — Tor leakage, deps, client storage, crypto
- `.audit-slice-auth.md` — auth, devices, sync log, tombstones
- `.audit-slice-relay.md` — relay, media, feed, push

These are kept out of git (`.audit-slice-*`) and may be deleted once findings are converted to issues.
