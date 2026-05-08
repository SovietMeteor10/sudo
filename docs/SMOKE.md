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
