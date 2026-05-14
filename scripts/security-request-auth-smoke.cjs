#!/usr/bin/env node
// Phase 14 security smoke — per-request signed auth gates.
//
// Asserts the X-Sudo-Auth middleware is wired correctly on every
// route that mutates trust state. For each gate we check four
// canonical failure modes plus the success path:
//
//   1. missing signature       → 401 missing_signature
//   2. wrong signer             → 403 canonical_id_mismatch (or 401)
//   3. replay (same nonce)      → 401 replayed_signature
//   4. expired ts (out of skew) → 401 expired_signature
//   5. valid signature          → 2xx
//
// Covers Critical 2, 3, 4, 5 and High 2, 3, 4 server gates plus
// HIGH-6 device-signed gates.

const { registerClientIdentity } = require("./lib/register-client-identity.cjs");
const { signIdentityRequest, signDeviceRequest } = require("./lib/request-auth-helpers.cjs");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const pass = (label) => console.log("ok:", label);
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };

async function rawFetch(method, path, opts) {
  const headers = { ...(opts?.headers ?? {}) };
  if (opts?.bodyJson !== undefined) headers["content-type"] = "application/json";
  const init = { method, headers };
  if (opts?.bodyJson !== undefined) init.body = JSON.stringify(opts.bodyJson);
  const r = await fetch(BASE + path, init);
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

function expect(label, r, predicate) {
  if (predicate(r)) {
    pass(`${label} [status=${r.status} error=${r.body?.error ?? "-"}]`);
    return true;
  }
  fail(label, `unexpected status=${r.status} body=${JSON.stringify(r.body)}`);
  return false;
}

const isOk = (r) => r.status >= 200 && r.status < 300;
const is401Missing = (r) => r.status === 401 && r.body?.error === "missing_signature";
const is401Invalid = (r) => r.status === 401 && r.body?.error === "invalid_signature";
const is401Replay = (r) => r.status === 401 && r.body?.error === "replayed_signature";
const is401Expired = (r) => r.status === 401 && r.body?.error === "expired_signature";
const is403Mismatch = (r) => r.status === 403 && r.body?.error === "canonical_id_mismatch";
const is403DeviceMismatch = (r) => r.status === 403 && r.body?.error === "device_id_mismatch";
const is401UnknownDevice = (r) => r.status === 401 && r.body?.error === "unknown_device";

// ---- generic test scaffold for an identity-signed write -----------
async function testIdentitySignedRoute(label, opts) {
  const { method, path, bodyJson, owner, attacker, expectSuccessStatus = isOk } = opts;

  // 1. Missing header.
  let r = await rawFetch(method, path, { bodyJson });
  expect(`${label} :: missing header`, r, is401Missing);

  // 2. Wrong signer (eve signs but body/URL still names alice).
  // Acceptable outcomes:
  //   - 401 / 403 from the middleware cross-check (body/URL owner mismatch)
  //   - For routes where the cross-check is in the route handler
  //     (e.g. feeds.posts.delete checks authenticatedCanonicalId vs
  //      post.author_canonical_id), a 4xx that isn't 2xx is fine.
  // The smoke is asserting "eve cannot complete a write under alice's
  // identifier", not that any specific status code fires.
  const wrongHeader = signIdentityRequest({
    method,
    path,
    body: bodyJson,
    canonicalId: attacker.canonical_id,
    privateKey: attacker.identity_key.privateKey
  });
  r = await rawFetch(method, path, { bodyJson, headers: { "x-sudo-auth": wrongHeader } });
  expect(`${label} :: wrong signer rejected`, r, (resp) =>
    resp.status >= 400 && resp.status < 500
  );

  // 3. Expired ts (forced 1 hour in the past).
  const expiredHeader = signIdentityRequest({
    method,
    path,
    body: bodyJson,
    canonicalId: owner.canonical_id,
    privateKey: owner.identity_key.privateKey,
    ts: Math.floor(Date.now() / 1000) - 3600
  });
  r = await rawFetch(method, path, { bodyJson, headers: { "x-sudo-auth": expiredHeader } });
  expect(`${label} :: expired ts rejected`, r, is401Expired);

  // 4. Valid signature.
  const validHeader = signIdentityRequest({
    method,
    path,
    body: bodyJson,
    canonicalId: owner.canonical_id,
    privateKey: owner.identity_key.privateKey
  });
  r = await rawFetch(method, path, { bodyJson, headers: { "x-sudo-auth": validHeader } });
  expect(`${label} :: valid signature accepted`, r, expectSuccessStatus);

  // 5. Replay (same nonce reused) — issue a fresh signature but reuse
  // the nonce + ts from the same instant.
  const ts = Math.floor(Date.now() / 1000);
  const nonce = require("node:crypto").randomBytes(16).toString("base64url");
  const replayHeader = signIdentityRequest({
    method,
    path,
    body: bodyJson,
    canonicalId: owner.canonical_id,
    privateKey: owner.identity_key.privateKey,
    ts,
    nonce
  });
  const r1 = await rawFetch(method, path, { bodyJson, headers: { "x-sudo-auth": replayHeader } });
  expect(`${label} :: replay attempt #1 (success or shape-failure)`, r1, (resp) => resp.status !== 401 || resp.body?.error !== "replayed_signature");
  const r2 = await rawFetch(method, path, { bodyJson, headers: { "x-sudo-auth": replayHeader } });
  expect(`${label} :: replay attempt #2 (rejected)`, r2, is401Replay);
}

async function run() {
  console.log(`BASE=${BASE}`);

  const tag = Math.random().toString(36).slice(2, 10);
  const alice = await registerClientIdentity(BASE, `ph14a_${tag}`);
  const eve = await registerClientIdentity(BASE, `ph14e_${tag}`);

  // CRIT-4 :: POST /api/connections (identity sig owner field)
  await testIdentitySignedRoute("CRIT-4 connections.post", {
    method: "POST",
    path: "/api/connections",
    bodyJson: {
      owner_canonical_id: alice.canonical_id,
      subject_canonical_id: eve.canonical_id,
      subject_handle: eve.handle,
      tier: "known"
    },
    owner: alice,
    attacker: eve,
    expectSuccessStatus: (r) => r.status === 201
  });

  // CRIT-4 :: DELETE /api/connections/:owner/:subject (URL owner field)
  await testIdentitySignedRoute("CRIT-4 connections.delete", {
    method: "DELETE",
    path: `/api/connections/${encodeURIComponent(alice.canonical_id)}/${encodeURIComponent(eve.canonical_id)}`,
    owner: alice,
    attacker: eve
  });

  // CRIT-4 :: POST /api/relay/relationships (sender_canonical_id field)
  await testIdentitySignedRoute("CRIT-4 relay.relationships.post", {
    method: "POST",
    path: "/api/relay/relationships",
    bodyJson: {
      sender_canonical_id: alice.canonical_id,
      recipient_canonical_id: eve.canonical_id,
      tier: "known"
    },
    owner: alice,
    attacker: eve
  });

  // HIGH-3 :: DELETE /api/discovery/reactions/:postId/:actor/vote (URL actor field)
  await testIdentitySignedRoute("HIGH-3 discovery.vote.delete", {
    method: "DELETE",
    path: `/api/discovery/reactions/${encodeURIComponent("nonexistent-post")}/${encodeURIComponent(alice.canonical_id)}/vote`,
    owner: alice,
    attacker: eve,
    // The route returns ok:true with cleared:false when the row doesn't exist —
    // we only care that the sig gate fired correctly.
    expectSuccessStatus: (r) => r.status === 200
  });

  // HIGH-4 :: GET /api/notifications/incoming/:victim?limit=N (URL victim field)
  await testIdentitySignedRoute("HIGH-4 notifications.incoming.get", {
    method: "GET",
    path: `/api/notifications/incoming/${encodeURIComponent(alice.canonical_id)}?limit=10`,
    owner: alice,
    attacker: eve,
    expectSuccessStatus: (r) => r.status === 200
  });

  // HIGH-2 :: DELETE /api/feeds/posts/:postId (no owner field — uses
  // authenticatedCanonicalId vs the post's author). Caller is alice;
  // the post lookup returns 404 because we never created it. The smoke
  // still exercises the gate (missing/expired/replay branches above).
  // We expect 404 for the valid-signature branch since no such post.
  await testIdentitySignedRoute("HIGH-2 feeds.posts.delete", {
    method: "DELETE",
    path: `/api/feeds/posts/${encodeURIComponent("post-does-not-exist")}`,
    owner: alice,
    attacker: eve,
    expectSuccessStatus: (r) => r.status === 404 && r.body?.error === "post_not_found"
  });

  // CRIT-5 :: POST /api/push/subscriptions — endpoint URL validation
  // is exercised separately in security-push-ssrf-smoke.cjs. Here we
  // only assert the signature gate.
  await testIdentitySignedRoute("CRIT-5 push.subscriptions.post", {
    method: "POST",
    path: "/api/push/subscriptions",
    bodyJson: {
      owner_canonical_id: alice.canonical_id,
      device_id: "abcdef0123456789abcdef0123456789",
      endpoint: "https://updates.push.services.mozilla.com/fakeendpoint",
      p256dh: "BCBxLqUS8xCkQOJZRfP8x1234567890fakekeyBCBxLqUS8xCkQOJZRfP",
      auth: "fake-auth-base64-string"
    },
    owner: alice,
    attacker: eve,
    expectSuccessStatus: (r) => r.status === 200 || r.body?.error === "invalid_endpoint"
  });

  // HIGH-6 :: device-signed sync log. We can't easily exercise this
  // end-to-end without a real device membership; assert the gate is
  // present by checking that an unauthenticated GET returns 401.
  const syncPath = `/api/devices/${encodeURIComponent(alice.canonical_id)}/sync?device_id=abcdef0123456789abcdef0123456789&since=0&limit=10`;
  const syncMissing = await rawFetch("GET", syncPath);
  expect("HIGH-6 sync.get :: missing header", syncMissing, is401Missing);

  const syncWrongDevice = signDeviceRequest({
    method: "GET",
    path: syncPath,
    canonicalId: alice.canonical_id,
    deviceId: "0123456789abcdef0123456789abcdef",  // disagrees with the query param
    privateKey: alice.identity_key.privateKey
  });
  const syncWrong = await rawFetch("GET", syncPath, { headers: { "x-sudo-auth": syncWrongDevice } });
  // We accept either device_id_mismatch (if cross-check fires first)
  // or unknown_device (if the membership lookup misses first).
  expect("HIGH-6 sync.get :: device mismatch rejected", syncWrong, (r) =>
    is403DeviceMismatch(r) || is401UnknownDevice(r) || r.status === 401 || r.status === 403
  );

  // Header-shape robustness: a malformed header is rejected as
  // missing_signature (parser returns null, middleware treats as
  // absent).
  const garbageHeader = await rawFetch("POST", "/api/connections", {
    bodyJson: { owner_canonical_id: alice.canonical_id, subject_canonical_id: eve.canonical_id, tier: "known" },
    headers: { "x-sudo-auth": "not-a-valid-base64url-header" }
  });
  expect("malformed header rejected", garbageHeader, is401Missing);

  if (failures.length > 0) {
    console.error(`SECURITY-REQUEST-AUTH SMOKE FAILED (${failures.length} failures)`);
    process.exit(1);
  }
  console.log("SECURITY-REQUEST-AUTH SMOKE PASSED");
}

run().catch((err) => {
  console.error("SMOKE ERRORED:", err);
  process.exit(1);
});
