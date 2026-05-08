# Manual Smoke Checks

The repo currently has no frontend test harness, so the portal smoke is
documented manually. Run these after any change that touches
`src/web/`, `src/portal/`, or files imported by `dist/web/client/**`.

## Setup

```sh
npm run build
PORT=3017 node dist/server.js
```

Open `http://127.0.0.1:3017/` in a fresh browser profile (clear local
storage / IndexedDB so the page lands on the unauthenticated state).

## Network sanity

Open devtools → Network. Reload. Confirm none of these 404:

- `/client/main.js`
- `/protocol/relays.js`
- `/protocol/constants.js`

If `/protocol/*.js` 404s, `main.js` will not execute and no landing
buttons will respond. The static portal must mount `dist/protocol`.

## Landing auth-button regression smoke

1. Body should reach `data-auth-state="menu"` on load.
2. Initial landing shows only `sign in` and `sign up`. There is no
   `restore` button on the landing itself.
3. Click `sign in` → sign-in dialog opens.
4. Click `back` inside the dialog → landing is visible again, no
   dialog open.
5. Click `sign up` → sign-up dialog opens. The dialog contains a
   `restore account` button.
6. Click `back` → returns to landing.
7. Tab to `sign in`, press `Enter` → sign-in dialog opens.
8. Tab to `sign up`, press `Space` → sign-up dialog opens.
9. Hover the `sudo` brand to start the flicker animation, then click
   `sign in` → dialog opens (flicker must not capture clicks).
10. Open sign-up, click `restore account` → restore dialog opens.
