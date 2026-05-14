#!/usr/bin/env node
// Phase 14 CRIT-5 — push subscription endpoint URL validation.
//
// Asserts /api/push/subscriptions POST rejects endpoints that resolve
// to private/reserved/link-local IPs. The signature gate is exercised
// in security-request-auth-smoke.cjs; this file focuses on the URL
// validator in src/push/endpoint-validation.ts.

const { registerClientIdentity } = require("./lib/register-client-identity.cjs");
const { signIdentityRequest } = require("./lib/request-auth-helpers.cjs");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const pass = (label) => console.log("ok:", label);
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };

async function signedPost(path, body, id) {
  const headers = {
    "content-type": "application/json",
    "x-sudo-auth": signIdentityRequest({
      method: "POST",
      path,
      body,
      canonicalId: id.canonical_id,
      privateKey: id.identity_key.privateKey
    })
  };
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

const sampleSub = (id, endpoint) => ({
  owner_canonical_id: id.canonical_id,
  device_id: "abcdef0123456789abcdef0123456789",
  endpoint,
  p256dh: "BCBxLqUS8xCkQOJZRfP8x1234567890fakekeyBCBxLqUS8xCkQOJZRfP",
  auth: "fake-auth-base64-string"
});

async function run() {
  console.log(`BASE=${BASE}`);
  const tag = Math.random().toString(36).slice(2, 10);
  const alice = await registerClientIdentity(BASE, `ph14ssrf_${tag}`);

  // Each entry: [endpoint URL, expected outcome label]. We hit a few
  // canonical reserved ranges. Hostnames (not just literal IPs) are
  // resolved server-side; using IP literals here avoids DNS dependence.
  const reservedTests = [
    ["http://127.0.0.1/push", "loopback v4"],
    ["http://10.0.0.1/push", "RFC1918 10.0/8"],
    ["http://192.168.1.1/push", "RFC1918 192.168/16"],
    ["http://172.16.0.1/push", "RFC1918 172.16/12"],
    ["http://169.254.169.254/latest/meta-data/", "link-local + AWS metadata"],
    ["http://100.64.0.1/", "CGNAT"],
    ["http://[::1]/push", "IPv6 loopback"]
  ];

  for (const [endpoint, label] of reservedTests) {
    const r = await signedPost("/api/push/subscriptions", sampleSub(alice, endpoint), alice);
    if (r.status === 400 && r.body?.error === "invalid_endpoint" && r.body?.reason === "private_address") {
      pass(`CRIT-5 reject ${label} (${endpoint})`);
    } else {
      fail(`CRIT-5 reject ${label}`, `expected 400 invalid_endpoint private_address, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // Public hostname should NOT trip the private-IP guard. We can't
  // assume the smoke environment has DNS, so we test with a fake but
  // syntactically valid public-looking hostname. The route may still
  // reject it for other reasons (rate limit, unknown provider) — we
  // only assert that the *reason* is not private_address.
  const publicishUrl = "https://updates.push.services.mozilla.com/wpush/v2/fake";
  const r = await signedPost("/api/push/subscriptions", sampleSub(alice, publicishUrl), alice);
  if (r.body?.error === "invalid_endpoint" && r.body?.reason === "private_address") {
    fail("CRIT-5 public endpoint", `unexpectedly flagged as private: ${JSON.stringify(r.body)}`);
  } else {
    pass(`CRIT-5 public hostname not flagged as private_address (status=${r.status} reason=${r.body?.reason ?? "-"})`);
  }

  if (failures.length > 0) {
    console.error(`SECURITY-PUSH-SSRF SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("SECURITY-PUSH-SSRF SMOKE PASSED");
}

run().catch((err) => {
  console.error("SMOKE ERRORED:", err);
  process.exit(1);
});
