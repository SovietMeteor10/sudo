# Manual Smoke Checks

The repo currently has no frontend test harness, so the portal smoke is
documented manually. Run these after any change that touches
`src/web/`, `src/portal/`, or files imported by `dist/web/client/**`.

## Setup

```sh
npm run build
SUDO_PORT=3017 node dist/server.js
```

Open `http://127.0.0.1:3017/` in a fresh browser profile (clear local
storage / IndexedDB so the page lands on the unauthenticated state).

## Network sanity

Open devtools → Network. Reload. Confirm none of these 404:

- `/client/main.js`
- `/protocol/relays.js`
- `/protocol/constants.js`
- `/protocol/identity.js`

If `/protocol/*.js` 404s, `main.js` will not execute and no landing
buttons will respond. The static portal must mount `dist/protocol`.

## Landing + auth flow smoke

1. Body should reach `data-auth-state="menu"` on load.
2. Initial landing shows only `sign in` and `sign up`. There is no
   `restore` button on the landing itself.
3. Click `sign in` → sign-in card opens.
   - Card width caps around 520px; nothing overflows the viewport.
   - Card contains: handle, passphrase, `restore account`, `back`,
     and a primary `sign in` button.
4. Click `back` → returns to landing.
5. Click `sign up` → sign-up card opens.
   - Card width caps around 760px.
   - Card does **not** contain a `restore account` button.
   - Fields: username, passphrase, confirm passphrase.
6. Click `back` → returns to landing.
7. Open sign-in, click `restore account` → restore card opens.
   - Card width caps around 720px.
   - Only one panel is visible at a time. Toggle between
     `recovery` and `backup file` modes; the inactive panel hides.
   - Click `back` → returns to the **sign-in** card (not landing).
8. Tab to `sign in`, press `Enter` → opens sign-in card.
9. Tab to `sign up`, press `Space` → opens sign-up card.
10. Hover the `sudo` brand to start the flicker animation, then click
    `sign in` → card opens (flicker must not capture clicks).

## Signup canonical-id check

In the sign-up card, create an account with a unique handle and a
strong passphrase. After "create account" the page should advance to
the signed-in state. If you see "canonical id does not match identity
public key", the browser canonical-id derivation is out of sync with
the server (see `src/protocol/identity.ts` and
`src/web/client/crypto/identity.ts`).

After signup, verify the registered identity:

```sh
curl -fsS http://127.0.0.1:3017/api/identity/handles/<handle>
```

The `canonical_id` should look like
`sudo:ed25519:<64-hex>` or `sudo:ecdsa-p256:<64-hex>`.

## Identity-register regression

`scripts/test-register.cjs` (also exposed as `npm run smoke:auth`)
builds an Ed25519 identity document fixture in pure Node, posts it
to `/api/identity/register`, asserts:

- `[object Promise]` literal canonical_id is rejected
- a wrong-hash but well-formed canonical_id is rejected
- a key-type/canonical_id mismatch is rejected
- a well-formed Ed25519 doc is accepted
- handle lookup and fingerprint routes round-trip

Run it after any change to canonical_id derivation, identity signing,
or `/api/identity/register`.

```sh
SUDO_PORT=3017 node dist/server.js &
BASE_URL=http://127.0.0.1:3017 npm run smoke:auth
```

## Sign-in failure messaging

After signup, clear the browser's IndexedDB profile and try to sign
in with a handle that doesn't exist on this device. The card must:

- not stay on "working..." longer than ~15s
- produce a clear message such as "account not found on this device.
  restore or link this device." or "network error..."

If the card hangs, check `fetchWithTimeout` in
`src/web/client/api.ts` and the `withFlowTimeout` /
`AUTH_FLOW_TIMEOUT_MS` guard in `src/web/client/main.ts` — both must
fire within 15 seconds.

## Auth-flow Puppeteer regression

`scripts/auth-smoke.cjs` (`npm run smoke:auth-flow`) drives a real
headless browser:

- creates an account end-to-end and asserts signed-in within 15s
- reloads the page and asserts a clean post-reload state
- signs in with an unknown handle and asserts the dialog resolves to
  a clear, user-readable error (never "creating account..." or
  "signing in..." after timeout)

Requires `puppeteer-core` and a Chrome binary. See the file header
for env-var configuration. Browser console errors and failed network
requests during the run are reported in the output.

```sh
SUDO_PORT=3017 node dist/server.js &
BASE_URL=http://127.0.0.1:3017 npm run smoke:auth-flow
```

## Full account-lifecycle Puppeteer torture test

`scripts/auth-lifecycle-smoke.cjs` (`npm run smoke:auth-lifecycle`)
exercises the entire account lifecycle in a real browser, with a
fresh browser context per scenario. Every assertion has a 15 s
ceiling; nothing is allowed to sit on "creating account..." /
"signing in..." / "restoring..." past timeout.

Cases covered:

1. landing page (sudo + sign in + sign up; no restore on landing)
2. create account success (must reach signed-in within 15 s)
3. post-signup state (handle visible, current device set, no
   crypto jargon: IndexedDB / PBKDF2 / AES-GCM / private key)
4. sign out, sign in same device with the same passphrase
5. sign in with unknown handle → friendly error
6. sign in with wrong passphrase → friendly error
7. backup export → encrypted JSON, no plaintext private material
8. restore from backup file → succeeds, sign-in works after restore
9. recovery answer / backup code path UI is honest about not yet
   working — must say so plainly, not look like a working path
10. device-link foundation returns a pairing code (or clear copy)
11. network-timeout simulation: with `/api/devices/register` made to
    hang, signup must still complete (device sync is non-blocking)
12. static module integrity: every `/client/*` and `/protocol/*`
    response is 200 and JS content-type

```sh
SUDO_PORT=3017 node dist/server.js &
BASE_URL=http://127.0.0.1:3017 npm run smoke:auth-lifecycle
```

## Two-account chat lifecycle Puppeteer smoke

`scripts/chat-lifecycle-smoke.cjs` (`npm run smoke:chat-lifecycle`) drives
two isolated browser contexts through the full chat path:

1. create account A
2. create account B
3. assert neither user sees demo posts (no `@northcatalog`, `@linebreak`,
   "wired the registry", etc.)
4. assert both users see "no chats yet" before any send
5. A sends a message to B (relay submits the encrypted envelope)
6. B's inbox poll picks the message up; chat popup auto-opens with sender
7. assert B sees the message text in the popup body
8. assert B's chat list now includes A
9. assert relay inbox is empty after ACK
10. B replies; A's poll picks it up; A's popup body and chat list update

Polling runs every 5 s, with an immediate poll after any send so a fast
reply doesn't wait for the next tick. Notification beeps fire only for
truly new received messages within an active session, not during the
initial historical fetch.

```sh
SUDO_PORT=3017 node dist/server.js &
BASE_URL=http://127.0.0.1:3017 npm run smoke:chat-lifecycle
```

## Production manual checklist

After deploying to sudochat.xyz (or any operator node):

1. **Hard refresh the portal.** Chrome/Firefox: Cmd-Shift-R / Ctrl-F5.
   Safari: option+Cmd-E then Cmd-R. The `Cache-Control: no-store`
   header on `/client` and `/protocol` should also defeat CDN caches
   on the next request, but a one-time hard refresh removes any
   already-cached response.
2. Open devtools → Network. Verify these all return 200, not 404
   HTML, and JavaScript content-type:
   - `/client/main.js`
   - `/protocol/relays.js`
   - `/protocol/constants.js`
   - `/protocol/identity.js`
3. Run the back-end smokes from anywhere with reachable HTTP:

   ```sh
   BASE_URL=https://sudochat.xyz npm run smoke
   BASE_URL=https://sudochat.xyz npm run smoke:auth
   ```

4. Sign-up flow:
   - landing shows sudo + sign in + sign up; no restore button
   - tap sign up, fill a fresh handle + strong passphrase, submit
   - must enter the main app within ~3 s; never hang on
     "creating account..." past 15 s
5. Sign-out flow:
   - tap logout
   - landing returns within ~1 s
6. Sign-in flow on the same device:
   - tap sign in, same handle + passphrase, submit
   - must enter the main app within ~1–2 s
7. Failure paths:
   - sign in with a non-existent handle → "account not found on this
     device. restore or link this device." within ~1 s
   - sign in with the right handle but wrong passphrase → "wrong
     passphrase, or this account is on another device." within ~1 s
8. Backup → restore round-trip:
   - while signed in, click `backup account`
   - clear browser data for the site (or open a private window)
   - tap sign in → restore account → backup file → upload → submit
   - feedback should be `backup restored`; sign-in works for the
     same handle on this fresh browser

## Recovering from a stale `[object Promise]` IndexedDB

Pre-2026-05-08 builds wrote `canonical_id: "sudo:ed25519:[object Promise]"`
to IndexedDB. Server-side registration was always rejected, but the
local crypto record still got stored. Symptoms:

- create account fails with "canonical id does not match identity
  public key"
- sign in fails with "wrong passphrase, or this account is on another
  device." even after the fix is deployed

Fix on the affected browser:

1. Open the portal.
2. Devtools → Application → IndexedDB → `sudo_local_state` → Delete
   database. (Or: `Application → Storage → Clear site data`.)
3. Hard refresh (`Cmd-Shift-R`).
4. Sign up again.

A backup file from a healthy device can be imported instead of
clearing.

## Cache headers

`/client/*` and `/protocol/*` must respond with
`Cache-Control: no-store, no-cache, must-revalidate`. Stale browser
or CDN copies of `main.js` have caused production canonical_id and
auth flow regressions even after a successful deploy.

```sh
curl -sI http://127.0.0.1:3017/client/main.js | grep -i cache-control
```
