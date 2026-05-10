# nginx reverse proxy

sudo binds to `127.0.0.1:3000` by default. nginx terminates TLS and
forwards requests on the loopback. Replace `example.com` with your own
domain everywhere below.

## 1. Disable version leakage (host-wide)

Edit `/etc/nginx/nginx.conf` and add inside the `http { ... }` block:

```nginx
server_tokens off;
```

Without this, nginx advertises its exact version in the `Server:`
response header, which is unnecessary attack-surface intel.

## 2. Site config

Save as `/etc/nginx/sites-available/sudo` and symlink into
`sites-enabled`.

```nginx
# HTTP -> HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;
    return 301 https://$host$request_uri;
}

# HTTPS reverse proxy to the local sudo node
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name example.com www.example.com;

    # Certbot will fill these in. Until then, sudo runs over plain HTTP
    # behind a self-signed cert or behind a temporary HTTP-only block.
    # ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Reasonable size for signed posts and backup uploads.
    client_max_body_size 4m;

    # Slightly longer than Node's default keep-alive so connections survive.
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Preserve client information for the Node app to log/inspect.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # WebSocket-friendly headers for future relay/sync transport.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## After editing

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Verify the version leak is gone and the site still serves:

```sh
curl -sSI https://example.com/ | grep -i '^Server:'
# want:    Server: nginx
# not:     Server: nginx/1.24.0 (Ubuntu)

curl -sS  https://example.com/health
# want:    {"ok":true,"protocol":"sudo","version":"..."}
```

## Notes

- Keep sudo bound to `127.0.0.1`. Don't expose Node directly to the
  internet.
- Certbot can manage certs for you with
  `sudo certbot --nginx -d example.com -d www.example.com`.
- If you also serve onion traffic, add a separate `server` block on a
  unix socket from `tor`'s `HiddenServicePort` rather than reusing this
  config.
