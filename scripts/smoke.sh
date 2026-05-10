#!/usr/bin/env bash
# Probe a sudo node's public surface. Exits non-zero if any required
# endpoint fails. Pass BASE_URL to override the target.
set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ENDPOINTS=(
  "/health"
  "/api/health"
  "/.well-known/sudo/node.json"
  "/client/main.js"
)

failed=0

echo "smoke target: ${BASE_URL}"

for path in "${ENDPOINTS[@]}"; do
  url="${BASE_URL}${path}"
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$url" || echo "000")
  if [ "$status" = "200" ]; then
    echo "ok    ${status} ${path}"
  else
    echo "FAIL  ${status} ${path}"
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "smoke failed: ${failed} endpoint(s) did not return 200" >&2
  exit 1
fi

# Production hardening assertions. Skip when SUDO_SMOKE_LOCAL_DEV=1
# (set this when smoking a dev/local build whose isLocalDevelopment is true).
if [ "${SUDO_SMOKE_LOCAL_DEV:-0}" != "1" ]; then
  status=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}/dev/sync/counts" || echo "000")
  if [ "$status" = "404" ]; then
    echo "ok    ${status} /dev/sync/counts (gated off in prod)"
  else
    echo "FAIL  ${status} /dev/sync/counts should 404 in prod" >&2
    failed=$((failed + 1))
  fi
fi

# Baseline security headers. These ship to all responses and are
# cheap to assert.
headers=$(curl -sSI "${BASE_URL}/" || true)
for h in "X-Content-Type-Options" "Referrer-Policy" "X-Frame-Options"; do
  if echo "$headers" | grep -qi "^${h}:"; then
    echo "ok    header ${h}"
  else
    echo "FAIL  missing header ${h}" >&2
    failed=$((failed + 1))
  fi
done

# CSP must include a sha256 hash for the inline importmap. If this
# slot is empty, either CSP regressed or the importmap edit broke the
# hash and the page won't load in browsers.
if echo "$headers" | grep -qi "^Content-Security-Policy:.*'sha256-"; then
  echo "ok    header Content-Security-Policy with sha256 importmap hash"
else
  echo "FAIL  Content-Security-Policy missing or has no sha256 importmap hash" >&2
  failed=$((failed + 1))
fi

if [ "$failed" -gt 0 ]; then
  echo "smoke failed: ${failed} hardening check(s) failed" >&2
  exit 1
fi

echo "smoke ok"
