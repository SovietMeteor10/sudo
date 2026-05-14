#!/usr/bin/env node
// Phase 14 HIGH-5 — device register/revoke require signed_membership.
//
// The audit found that POST /api/devices/register and
// POST /api/devices/:deviceId/revoke fell through to a permissive
// branch when signed_membership was absent. Revoke additionally
// deleted push subscriptions as a side-effect, so a missing-sig call
// flipped the device cache state AND silenced pushes. Both routes
// now reject the missing-membership case.

const { registerClientIdentity } = require("./lib/register-client-identity.cjs");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const pass = (label) => console.log("ok:", label);
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };

async function rawFetch(method, path, opts) {
  const headers = { "content-type": "application/json", ...(opts?.headers ?? {}) };
  const init = { method, headers };
  if (opts?.bodyJson !== undefined) init.body = JSON.stringify(opts.bodyJson);
  const r = await fetch(BASE + path, init);
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

async function run() {
  console.log(`BASE=${BASE}`);
  const tag = Math.random().toString(36).slice(2, 10);
  const alice = await registerClientIdentity(BASE, `ph14dev_${tag}`);

  // HIGH-5a: register without signed_membership → 400 missing_signed_membership
  const registerResp = await rawFetch("POST", "/api/devices/register", {
    bodyJson: {
      type: "sudo_trusted_device",
      owner_canonical_id: alice.canonical_id,
      device_id: "abcdef0123456789abcdef0123456789",
      name: "alice-laptop",
      device_public_key: "fake-spki-base64-url",
      capabilities: { can_sync: true, can_decrypt: true }
    }
  });
  if (registerResp.status === 400 && registerResp.body?.error === "missing_signed_membership") {
    pass(`HIGH-5 register without signed_membership rejected`);
  } else {
    fail("HIGH-5 register", `expected 400 missing_signed_membership, got ${registerResp.status} ${JSON.stringify(registerResp.body)}`);
  }

  // HIGH-5b: revoke without signed_membership → 400 missing_signed_membership.
  // We use a device_id that doesn't exist; the check that fires first
  // is the missing_signed_membership reject, before any lookup.
  const revokeResp = await rawFetch("POST", "/api/devices/some-device-id/revoke", {
    bodyJson: { owner_canonical_id: alice.canonical_id }
  });
  if (revokeResp.status === 400 && revokeResp.body?.error === "missing_signed_membership") {
    pass(`HIGH-5 revoke without signed_membership rejected`);
  } else {
    fail("HIGH-5 revoke", `expected 400 missing_signed_membership, got ${revokeResp.status} ${JSON.stringify(revokeResp.body)}`);
  }

  if (failures.length > 0) {
    console.error(`SECURITY-DEVICE-REGISTER-REVOKE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("SECURITY-DEVICE-REGISTER-REVOKE SMOKE PASSED");
}

run().catch((err) => {
  console.error("SMOKE ERRORED:", err);
  process.exit(1);
});
