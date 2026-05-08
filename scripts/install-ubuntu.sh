#!/usr/bin/env bash
# Optional Ubuntu helper for installing sudo's userspace bits.
#
# READ THIS BEFORE RUNNING. This script will:
#
#   - run `npm ci`
#   - run `npm run build`
#   - copy .env.example to .env if .env is missing
#
# It does NOT install Node, configure systemd, configure nginx, open
# firewall ports, or request TLS certificates. Those steps are listed
# in docs/DEPLOY_UBUNTU.md so you can run them yourself with eyes on
# what is happening.
#
# Run this from the repo root, as the unprivileged service user.
set -euo pipefail

if [ ! -f package.json ]; then
  echo "run this from the repo root (package.json not found)" >&2
  exit 1
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "created .env from .env.example. Edit it before starting the service."
  else
    echo "WARNING: no .env or .env.example found. Skipping .env bootstrap." >&2
  fi
fi

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo
echo "next steps:"
echo "  1. edit .env (SUDO_PUBLIC_BASE_URL, SUDO_NODE_NAME, etc.)"
echo "  2. run: npm run check:env"
echo "  3. install systemd unit (see docs/SYSTEMD.md)"
echo "  4. front with nginx + TLS (see docs/NGINX.md and docs/DEPLOY_UBUNTU.md)"
