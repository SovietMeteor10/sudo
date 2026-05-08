# Tor / Onion Operator Notes

sudo does not manage Tor for you. The current app keeps Node/Express on
`127.0.0.1` and expects an operator to place Tor or nginx in front of it when
onion delivery is desired.

## Shape

- Node runs the sudo app locally.
- nginx can terminate HTTPS and proxy to Node.
- Tor exposes an onion service that points to nginx or directly to the local
  app, depending on the operator's deployment.
- The onion service is transport only. It does not replace identity keys,
  relay storage, or feed signing.

## Example torrc

```text
HiddenServiceDir /var/lib/tor/sudo_hidden_service/
HiddenServicePort 80 127.0.0.1:3000
HiddenServicePort 443 127.0.0.1:3000
```

If nginx is in front of Node, point the onion service at nginx instead of the
Node process directly.

## Operational notes

- Keep Node bound to `127.0.0.1`.
- Do not expose the Node process directly to the public internet.
- Publish the onion base URL through `SUDO_ONION_BASE_URL` when you want sudo
  to advertise onion delivery capability.
- Keep `SUDO_ENABLE_HTTPS_RELAY_FALLBACK=true` only if you want a lower-privacy
  relay path alongside onion transport.

The current sudo build does not create, restart, or monitor Tor. That remains
an external operator responsibility.
