#!/usr/bin/env node
// message-quota-behavior smoke (Phase 11.5).
//
// Asserts that normal text message volume does NOT trip the
// "unknown_quota_exceeded" surface anymore, and that when a real
// rate limit IS hit, the user sees calm specific copy rather than
// a raw error code:
//   - 50 text messages in a row succeed (well below the new
//     UNKNOWN_MAX_PENDING_PER_RECIPIENT = 200 cap).
//   - exceeding the per-minute rate limit returns 429/rate_limited.
//   - no response from /api/relay/envelopes contains the substring
//     "unknown_quota_exceeded" — that error code was retired as a
//     user-visible failure mode.
//
// Pure HTTP — no browser needed.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

function syntheticEnvelope(senderCanonical, recipientCanonical) {
  const id = require("crypto").randomUUID();
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  return {
    type: "sudo_relay_envelope",
    protocol_version: "0.1.0",
    message_id: id,
    sender_canonical_id: senderCanonical,
    recipient_canonical_id: recipientCanonical,
    sender_handle: "smk",
    recipient_handle: "smk",
    ciphertext: "dev-placeholder:" + Buffer.from("hello-" + id, "utf8").toString("base64"),
    ciphertext_scheme: "dev-placeholder",
    created_at: now,
    expires_at: exp,
    status: "queued_local",
    sender_signature: "dev-placeholder"
  };
}

async function post(envelope) {
  const r = await fetch(`${BASE}/api/relay/envelopes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  // Reset rate-limit state so a previous smoke doesn't poison the
  // window. The dev-only endpoint is a no-op in prod.
  await fetch(`${BASE}/api/admin/media/reset-rate-limits`, { method: "POST" }).catch(() => null);

  const sender = `sudo:ed25519:smk-mqb-${Date.now().toString(16)}-a`;
  const recipient = `sudo:ed25519:smk-mqb-${Date.now().toString(16)}-b`;

  // ===== Part 1: 50 messages from one sender to one recipient
  // should all succeed. The old unknown-tier cap of 3 would have
  // failed message #4. =====
  let okCount = 0;
  let unknownQuotaSeen = false;
  const responseBodies = [];
  for (let i = 0; i < 50; i++) {
    const r = await post(syntheticEnvelope(sender, recipient));
    responseBodies.push(JSON.stringify(r.body));
    if (r.status === 202 && r.body?.ok === true) okCount++;
    if (typeof r.body?.error === "string" && r.body.error.includes("unknown_quota")) unknownQuotaSeen = true;
    // Don't loop too fast — stay under the 100/min sender rate limit.
    // 50 messages over ~30s easily satisfies it.
    if (i % 5 === 4) await new Promise((res) => setTimeout(res, 50));
  }
  if (okCount < 50) {
    fail("1.fifty-msgs", `expected 50/50 messages to succeed, got ${okCount}/50`);
  } else {
    ok(`1. 50 text messages from one sender accepted (was 3 in Phase 11.4 — the bug)`);
  }
  if (unknownQuotaSeen) {
    fail("1b.unknown-quota-leak", `'unknown_quota' error code appeared in response — it should be retired as a user-visible failure`);
  } else {
    ok(`1b. no 'unknown_quota_exceeded' in any of the 50 responses`);
  }

  // ===== Part 2: bursting past the rate limit returns
  // 429/rate_limited (not unknown_quota_exceeded). =====
  // Reset between phases so phase 1's hits don't pollute phase 2.
  await fetch(`${BASE}/api/admin/media/reset-rate-limits`, { method: "POST" }).catch(() => null);
  const burstSender = `sudo:ed25519:smk-mqb-burst-${Date.now().toString(16)}`;
  const burstResults = await Promise.all(
    Array.from({ length: 150 }, () => post(syntheticEnvelope(burstSender, recipient)))
  );
  const rateLimited = burstResults.filter((r) => r.status === 429 && r.body?.error === "rate_limited");
  if (rateLimited.length === 0) {
    fail("2.burst-no-rl", `150-message burst from one sender did not trip the per-sender rate limiter`);
  } else {
    ok(`2. per-sender rate limit kicked in: ${rateLimited.length} of 150 returned 429/rate_limited`);
  }
  // Check no burst response contained unknown_quota.
  const leakInBurst = burstResults.some((r) => typeof r.body?.error === "string" && r.body.error.includes("unknown_quota"));
  if (leakInBurst) {
    fail("2b.unknown-quota-burst", `burst path leaked 'unknown_quota_exceeded'`);
  } else {
    ok(`2b. burst rejection codes are all 'rate_limited' — no internal quota error leaks`);
  }

  // ===== Part 3: response error code shape is one of a known set.
  // Catches any new error code surface that gets added without a
  // matching client-side humanizer. =====
  const allErrors = new Set();
  for (const r of [...burstResults, ...responseBodies.map((s) => ({ body: JSON.parse(s) }))]) {
    const err = typeof r.body?.error === "string" ? r.body.error : null;
    if (err !== null && err !== "duplicate_message") allErrors.add(err);
  }
  const knownErrors = new Set([
    "rate_limited", "message_too_large", "invalid_envelope", "expired",
    "owner_envelope_quota_exceeded", "sender_blocked", "recipient_inbox_full",
    "sender_outbox_full", "pair_quota_exceeded", "relay_full"
  ]);
  const unexpected = [...allErrors].filter((e) => !knownErrors.has(e));
  if (unexpected.length > 0) {
    fail("3.unknown-codes", `unexpected error codes appeared: ${unexpected.join(", ")}`);
  } else {
    ok(`3. all error codes were in the documented set (${[...allErrors].join(", ") || "none"})`);
  }

  if (failures.length > 0) {
    console.error(`MESSAGE-QUOTA-BEHAVIOR SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MESSAGE-QUOTA-BEHAVIOR SMOKE PASSED");
})().catch((err) => {
  console.error("MESSAGE-QUOTA-BEHAVIOR SMOKE ERRORED:", err);
  process.exit(1);
});
