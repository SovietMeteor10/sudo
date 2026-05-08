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

## Cache headers

`/client/*` and `/protocol/*` must respond with
`Cache-Control: no-store, no-cache, must-revalidate`. Stale browser
or CDN copies of `main.js` have caused production canonical_id and
auth flow regressions even after a successful deploy.

```sh
curl -sI http://127.0.0.1:3017/client/main.js | grep -i cache-control
```
