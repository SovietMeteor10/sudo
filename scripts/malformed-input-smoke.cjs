#!/usr/bin/env node
// Malformed-input smoke.
//
// Asserts every public mutation route consistently rejects malformed
// inputs with the central { ok: false, error: "invalid_field", field,
// message } shape (or a status outside 2xx). A regression here is a
// silent contract drift between server and client.
//
// We don't assert on EVERY error code — just that no route accepts a
// wholly bogus payload as valid.

const crypto = require("node:crypto");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

function randCanonicalId() {
  return `sudo:ed25519:${crypto.randomBytes(32).toString("hex")}`;
}
function randDeviceId() {
  return crypto.randomBytes(16).toString("hex");
}

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

function expect4xx(label, r) {
  if (r.status >= 200 && r.status < 300) {
    fail(label, `expected 4xx, got ${r.status} body=${JSON.stringify(r.body)}`);
    return false;
  }
  if (r.status < 400 || r.status >= 500) {
    fail(label, `expected 4xx, got ${r.status} body=${JSON.stringify(r.body)}`);
    return false;
  }
  ok(`${label} -> ${r.status}`);
  return true;
}

function expectInvalidField(label, r, fieldName) {
  if (!expect4xx(label, r)) return false;
  if (r.body?.ok !== false) fail(`${label}:shape`, `expected ok:false, got ${JSON.stringify(r.body)}`);
  if (r.body?.error !== "invalid_field") {
    fail(`${label}:error-code`, `expected error='invalid_field', got '${r.body?.error}'`);
    return false;
  }
  if (fieldName && r.body?.field !== fieldName) {
    fail(`${label}:field`, `expected field='${fieldName}', got '${r.body?.field}'`);
    return false;
  }
  return true;
}

async function pushSubscriptionRoutes() {
  // Phase 14 CRIT-5: POST and DELETE /api/push/subscriptions are now
  // signature-gated. An unauthenticated request gets 401
  // missing_signature before field validation runs. The field-level
  // error contract still exists in the handler (it just runs AFTER
  // the sig check), so this smoke now only asserts that the sig gate
  // is in place — granular field-error testing moved to
  // security-request-auth-smoke.cjs / security-push-ssrf-smoke.cjs.
  const subResp = await req("POST", "/api/push/subscriptions", {
    device_id: randDeviceId(), endpoint: "https://x.test/p", p256dh: "a", auth: "b"
  });
  if (subResp.status !== 401 || subResp.body?.error !== "missing_signature") {
    fail("push.subscribe:sig-gated", `expected 401 missing_signature on unauth POST, got ${subResp.status} ${JSON.stringify(subResp.body)}`);
  } else ok(`push.subscribe sig-gated -> 401 missing_signature`);

  const delResp = await req("DELETE", "/api/push/subscriptions", { device_id: randDeviceId(), endpoint: "https://x.test/p" });
  if (delResp.status !== 401 || delResp.body?.error !== "missing_signature") {
    fail("push.unsubscribe:sig-gated", `expected 401 missing_signature on unauth DELETE, got ${delResp.status} ${JSON.stringify(delResp.body)}`);
  } else ok(`push.unsubscribe sig-gated -> 401 missing_signature`);

  // test route validates recipient_canonical_id
  await expectInvalidField("push.test:bad-recipient",
    await req("POST", "/api/push/test", { recipient_canonical_id: "garbage" }),
    "recipient_canonical_id");

  // test route validates optional sender_canonical_id if present
  await expectInvalidField("push.test:bad-sender",
    await req("POST", "/api/push/test", {
      recipient_canonical_id: randCanonicalId(),
      sender_canonical_id: "garbage"
    }), "sender_canonical_id");

  // test route validates unread_count
  await expectInvalidField("push.test:bad-unread",
    await req("POST", "/api/push/test", {
      recipient_canonical_id: randCanonicalId(),
      unread_count: -3
    }), "unread_count");
  await expectInvalidField("push.test:non-integer-unread",
    await req("POST", "/api/push/test", {
      recipient_canonical_id: randCanonicalId(),
      unread_count: "five"
    }), "unread_count");

  // test route validates sender_handle length
  await expectInvalidField("push.test:oversized-handle",
    await req("POST", "/api/push/test", {
      recipient_canonical_id: randCanonicalId(),
      sender_handle: "@".repeat(1000)
    }), "sender_handle");
}

async function generalSafety() {
  // Oversized JSON body — Express body-parser is configured at 64kb;
  // anything beyond should be 413/4xx.
  const huge = "x".repeat(200_000);
  const r = await req("POST", "/api/push/subscriptions", {
    owner_canonical_id: randCanonicalId(),
    device_id: randDeviceId(),
    endpoint: "https://x.test/" + huge,
    p256dh: "a", auth: "b"
  });
  if (r.status < 400 || r.status >= 500) {
    fail("oversized-body", `expected 4xx for >64kb body, got ${r.status}`);
  } else ok(`oversized JSON body -> ${r.status}`);

  // Non-JSON body to a JSON route — express.json should respond 400.
  const txt = await fetch(BASE + "/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "this is not json"
  });
  if (txt.status < 400 || txt.status >= 500) {
    fail("non-json", `expected 4xx for non-JSON body, got ${txt.status}`);
  } else ok(`non-JSON body -> ${txt.status}`);

  // Missing content-type entirely — also reject.
  const noct = await fetch(BASE + "/api/push/subscriptions", {
    method: "POST",
    body: "no content type",
  });
  // Some clients send a default; the server may treat as empty body
  // (which still fails validation). We accept any 4xx.
  if (noct.status < 400 || noct.status >= 500) {
    fail("no-content-type", `expected 4xx for missing content-type, got ${noct.status}`);
  } else ok(`missing content-type -> ${noct.status}`);
}

(async () => {
  console.log(`BASE=${BASE}`);
  await pushSubscriptionRoutes();
  await generalSafety();
  if (failures.length > 0) {
    console.error(`MALFORMED-INPUT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MALFORMED-INPUT SMOKE PASSED");
})().catch((err) => {
  console.error("MALFORMED-INPUT SMOKE ERRORED:", err);
  process.exit(1);
});
