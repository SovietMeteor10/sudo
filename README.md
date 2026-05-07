# sudo

`sudo` is a privacy-first, text-first identity and messaging prototype built on boring internet primitives.

It is a local-dev scaffold, not a production-secure system.

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
src/server.ts        Express server and static client mounts
src/routes/          Registry, profile, finger, inbox, and dev routes
src/client/          Browser TypeScript client
src/public/          HTML and CSS shell served by Express
docs/                Deployment, security, and roadmap notes
data/                Local runtime state, ignored by Git
dist/                TypeScript build output, ignored by Git
```

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
