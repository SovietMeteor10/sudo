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

echo "smoke ok"
