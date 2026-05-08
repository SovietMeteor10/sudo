# systemd unit

Run sudo as a long-running unprivileged service.

## Unit file

Save the following as `/etc/systemd/system/sudo.service`. Replace the
`User`, `Group`, and `WorkingDirectory` paths with whatever you used in
[DEPLOY_UBUNTU.md](./DEPLOY_UBUNTU.md). The example here uses a
`sudo-node` user; adjust to suit.

```ini
[Unit]
Description=sudo node
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/sudo-node/apps/sudo
EnvironmentFile=/home/sudo-node/apps/sudo/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
User=sudo-node
Group=sudo-node
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Enable and start

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sudo.service
sudo systemctl status sudo.service
```

## Logs

```sh
sudo journalctl -u sudo.service -f
sudo journalctl -u sudo.service -n 200 --no-pager
```

## Restart

```sh
sudo systemctl restart sudo.service
```

## Stop

```sh
sudo systemctl stop sudo.service
```

## Notes

- `EnvironmentFile` reads `.env` in the repo root. Keep it `chmod 600`
  and owned by the service user.
- `Restart=always` covers crashes; `RestartSec=5` avoids tight loops.
- Production deployments should set `NODE_ENV=production` so internal
  defaults (like `inferDefaultPublicBaseUrl`) behave correctly.
- If you want hardening, consider adding
  `ProtectSystem=strict`,
  `ProtectHome=true`,
  `ReadWritePaths=/home/sudo-node/apps/sudo/data`,
  `NoNewPrivileges=true`,
  `PrivateTmp=true`.
  These are optional and can be layered in without changing the app.
