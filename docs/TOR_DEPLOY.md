# Tor / onion deployment guide

This is the long-form companion to `TOR.md`. It walks through what a
production-grade .onion deployment of sudo looks like end-to-end and
flags the parts where browsers/operators behave differently than
clearnet.

sudo never touches Tor itself — the Node process always binds to
`127.0.0.1`. Tor runs as a sibling daemon and forwards a hidden
service port onto the loopback. An optional nginx in between
terminates TLS (clearnet) and adds caching headers; on the .onion
side nginx is usually unnecessary because the hidden service
already provides authenticated transport.

---

## Deployment shapes

sudo supports three deployment models in the same binary:

| Mode | `SUDO_PUBLIC_BASE_URL` | `SUDO_ONION_BASE_URL` | What the node advertises |
| --- | --- | --- | --- |
| **clearnet only** | `https://example.com` | unset | https relay + (in dev) local_dev |
| **onion only** | `http://example.onion` | `http://example.onion` (same) | onion relay only |
| **dual-origin** | `https://example.com` | `http://example.onion` | onion + https; .onion clients see onion only (see Phase 12.1 note below) |

The dual-origin mode is the recommended shape for most operators —
clearnet visitors discover the .onion via the
`/.well-known/sudo/node.json` `onion_base_url` field, and Tor users
get an .onion-only relay list (no clearnet leakage).

### Phase 12.1 origin-aware behavior

As of commit `5a5e3b2`, `GET /.well-known/sudo/node.json` reads
`request.hostname`. When the request lands on a `.onion` host:

- `relay_capabilities` is filtered to onion-only — no `https`, no
  `local_dev`.
- `public_base_url` is normalized to the onion URL so generated
  identity URLs stay onion-native.

When the request lands on clearnet:

- All advertised transports remain (including `onion_base_url`).

This is verified by `smoke:onion-origin-generation`.

---

## Step-by-step: dual-origin deployment

### 1. Provision the hidden service

```text
# /etc/tor/torrc
HiddenServiceDir /var/lib/tor/sudo/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:3000
```

```sh
sudo systemctl restart tor
sudo cat /var/lib/tor/sudo/hostname
```

The output is the v3 onion address (`abc...onion`). Treat it as
public: it's how users discover the node. Treat the contents of
`/var/lib/tor/sudo/hs_ed25519_secret_key` as **private**: anyone
with that key can impersonate the service.

### 2. Configure sudo

```sh
# /etc/sudo/sudo.env (loaded by your service unit)
SUDO_PUBLIC_BASE_URL=https://yourdomain.example
SUDO_ONION_BASE_URL=http://abc...onion
SUDO_PREFER_ONION_RELAYS=true
SUDO_ENABLE_HTTPS_RELAY_FALLBACK=true  # set to false for onion-only nodes
SUDO_NODE_ENV=production
```

Restart the service. Verify:

```sh
curl https://yourdomain.example/.well-known/sudo/node.json | jq
curl http://abc...onion/.well-known/sudo/node.json --socks5-hostname 127.0.0.1:9050 | jq
```

Both responses should be valid; the .onion response should have an
onion-only `relay_capabilities` list.

### 3. nginx reverse proxy (clearnet path only)

The .onion side does not need nginx — Tor's hidden service already
authenticates the endpoint and there's no TLS to terminate. nginx
on the clearnet side handles TLS + lightweight caching.

```nginx
server {
  listen 443 ssl http2;
  server_name yourdomain.example;
  ssl_certificate     /etc/letsencrypt/live/yourdomain.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.example/privkey.pem;

  # sudo-specific: large media uploads (50MB cap, see Phase 8) need
  # this; without it nginx will buffer the entire upload before
  # forwarding, blowing memory.
  client_max_body_size 60M;
  proxy_request_buffering off;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Add an HTTP→HTTPS redirect on the clearnet side. **Do not** add
any redirect between clearnet and onion — leaving a clearnet user
on clearnet and an onion user on onion is the whole point of the
dual-origin shape.

### 4. Certificates

| Origin | Certificate |
| --- | --- |
| clearnet | Let's Encrypt or any CA; standard nginx setup |
| .onion | Optional; modern Tor Browser accepts plain HTTP for v3 onion services because the address itself authenticates the endpoint. EV certificates from HARICA work if you want a padlock |

If you do not use a cert on .onion, `Strict-Transport-Security`
emitted by the response is ignored by browsers for .onion hosts —
no effect.

### 5. Onion-only deployments

For a node that should never be reachable on clearnet:

- Bind nginx (or skip it) only to loopback.
- Set firewall rules to drop inbound :80 / :443 from public.
- `SUDO_PUBLIC_BASE_URL=http://abc...onion` and
  `SUDO_ONION_BASE_URL=http://abc...onion`.
- `SUDO_ENABLE_HTTPS_RELAY_FALLBACK=false` to remove the https
  capability entirely.

---

## Browser caveats

### iOS Safari

iOS does not support Tor natively. Onion Browser (an iOS app from
Mike Tigas) is the only option. Onion Browser deliberately
disables several APIs sudo uses:

- **Service Worker / PWA install**: not available. Sudo falls back
  to in-page polling; push notifications won't work.
- **`navigator.storage.persist()`**: returns false; the
  auto-unlock path (Phase 11.6) reads this as "private mode
  likely" and may upgrade the incognito-linking note copy.
- **WebRTC**: disabled (irrelevant — sudo doesn't use it).

### Android Chrome via Orbot/Tor

Orbot can route Chrome through Tor. Chrome itself runs normally,
so service worker / PWA install / push notifications all work.
However:

- **Push delivery**: when the device is connected via Orbot, the
  push subscription endpoint Chrome registers points to FCM. FCM
  delivery is over Google's network, not Tor. Sudo's push payload
  is generic ("new message"); no plaintext leaks. If this is an
  unacceptable metadata leak, instruct users to disable push in
  Settings.

### Tor Browser (desktop)

Best supported. Tor Browser Bundle's hardened build allows the
PWA shell to function; service worker works; push notifications
do not (Tor Browser disables them entirely).

---

## Operator hardening checklist

Before opening a node to the public:

- [ ] `SUDO_NODE_ENV=production` (this kills the `/dev/*` and
  `/api/admin/*` routes — verify with the
  `diagnostics-hardening` smoke).
- [ ] `bash scripts/smoke.sh` against the public URL: 9/9 ok.
- [ ] `npm run smoke:csp` against the public URL: 7/7 ok.
- [ ] `npm run smoke:onion-csp` against the public URL: all ok.
- [ ] `npm run smoke:onion-origin-generation` against the public
  URL: all ok.
- [ ] VAPID keys generated and stored read-only: `chmod 400
  ${SUDO_DATA_DIR}/keys/vapid.json`.
- [ ] Backup the sqlite file + the media directory on a schedule
  (see `OPERATOR.md` for ordering).
- [ ] Rotate the Tor hidden-service key if it has ever been on
  shared infrastructure or untrusted disks.
- [ ] Configure firewall: only :80/:443 from clearnet (if dual-
  origin) and the Tor SocksPort from localhost.
- [ ] Set up a separate monitoring user with sudo permissions only
  for restarts.

---

## Bandwidth + storage notes

Tor hidden services have lower throughput than clearnet — expect
~1-5 MB/s per circuit on a healthy onion. Phase 8 media uploads
(up to 50MB for video) will be noticeably slower on .onion. This
is mitigated by:

- Phase 11.1 per-owner media quotas (default 500MB) keep one
  account from dominating bandwidth.
- Phase 11.5 per-minute rate limits cap burst send patterns.
- nginx is NOT on the .onion path in the recommended deployment;
  Node serves the bytes directly. Make sure your `ulimit -n` is
  large (≥4096) on the service unit.

---

## Push limitations under onion

Web Push as a protocol is designed around browser↔Mozilla autopush
/ Apple APNs / Google FCM endpoints. None of these endpoints are
on .onion. When a user installed sudo as a PWA over .onion:

- The push subscription's `endpoint` field still resolves to one
  of the three vendor services.
- Push payloads leave sudo's `pushService` over clearnet → reach
  the vendor → reach the user device.
- Sudo's payload is generic ("new message"); no plaintext sender
  / body leak.

If your threat model excludes the vendor push services, instruct
users to disable push in Settings (sudo will fall back to
in-page polling when the tab is open).

---

## Disaster recovery

If the Tor hidden-service key is lost or stolen:

1. Stop tor + sudo immediately.
2. Generate a new hidden service in a new `HiddenServiceDir`.
3. Update `SUDO_ONION_BASE_URL` in the service env.
4. Restart sudo + tor.
5. Announce the new onion address. The old one cannot be
   reactivated; the .onion address IS the public key fingerprint.

Linked devices and identity keys are NOT affected — they live in
the user's browsers, not on the node. Users will need to update
their bookmarks / QR codes manually.
