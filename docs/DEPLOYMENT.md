# Deployment

`sudo` is intentionally simple to deploy, but the current codebase is still a local-dev scaffold. Treat these notes as operating guidance, not a production security guarantee.

## Local

```sh
npm install
npm run build
npm run dev
```

This binds the app on `127.0.0.1:3000` by default.

## LAN

For trusted local-network testing on a laptop:

```sh
HOST=0.0.0.0 npm run dev
```

Only use this on a private LAN you control. It is not private, not Tor-routed, and not suitable for real identities or messages.

## Private VPS via SSH tunnel

Run the app only on localhost on the VPS:

```sh
HOST=127.0.0.1 PORT=3000 npm run dev
```

Then tunnel from your workstation:

```sh
ssh -p 2222 -L 3000:127.0.0.1:3000 ubuntu@YOUR_VPS_IP
```

Open `http://localhost:3000` on your workstation after the tunnel is up.

## Public VPS with nginx

For a public prototype, keep the Node process bound to `127.0.0.1` and place nginx in front of it.

Recommended shape:

```text
client -> https://sudochat.xyz -> nginx -> 127.0.0.1:3000 -> sudo
```

DNS notes for `sudochat.xyz`:

1. Point the `A` record at the public server IP.
2. Keep TTL low while testing.
3. Only flip public traffic once nginx and TLS are working.

Example nginx upstream:

```nginx
server {
  listen 443 ssl http2;
  server_name sudochat.xyz;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Recommended firewall posture for a public web host:

```sh
ufw default deny incoming
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## Docker warning

Be careful with Docker on public hosts. Published ports can bypass a naive UFW setup unless Docker firewall rules are configured deliberately. Assume nothing is safe until you have verified the effective packet path.

## Production posture

Never bind the app directly to `0.0.0.0` on a public VPS unless you are intentionally exposing it.

Use HTTPS in front of the app. Prefer a fresh public VPS or droplet for the public prototype instead of reusing a machine that already hosts sensitive services.
