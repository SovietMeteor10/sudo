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
  // owner_canonical_id missing -> field=owner_canonical_id
  await expectInvalidField("push.subscribe:missing-owner",
    await req("POST", "/api/push/subscriptions", { device_id: randDeviceId(), endpoint: "https://x.test/p", p256dh: "a", auth: "b" }),
    "owner_canonical_id");

  // owner_canonical_id wrong format
  await expectInvalidField("push.subscribe:bad-owner",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: "not-a-canonical-id",
      device_id: randDeviceId(), endpoint: "https://x.test/p", p256dh: "a", auth: "b"
    }), "owner_canonical_id");

  // device_id wrong format (too short)
  await expectInvalidField("push.subscribe:bad-device",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: randCanonicalId(),
      device_id: "abc", endpoint: "https://x.test/p", p256dh: "a", auth: "b"
    }), "device_id");

  // endpoint not http(s)
  await expectInvalidField("push.subscribe:bad-endpoint",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: randCanonicalId(),
      device_id: randDeviceId(), endpoint: "ftp://evil.example/", p256dh: "a", auth: "b"
    }), "endpoint");

  // p256dh empty
  await expectInvalidField("push.subscribe:empty-p256dh",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: randCanonicalId(),
      device_id: randDeviceId(), endpoint: "https://x.test/p", p256dh: "", auth: "b"
    }), "p256dh");

  // wrong types
  await expectInvalidField("push.subscribe:wrong-types",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: 123, device_id: 456, endpoint: ["array"], p256dh: { obj: 1 }, auth: null
    }), "owner_canonical_id");

  // oversized endpoint
  await expectInvalidField("push.subscribe:oversized-endpoint",
    await req("POST", "/api/push/subscriptions", {
      owner_canonical_id: randCanonicalId(),
      device_id: randDeviceId(),
      endpoint: "https://x.test/" + "A".repeat(5000),
      p256dh: "a", auth: "b"
    }), "endpoint");

  // DELETE: missing device_id
  await expectInvalidField("push.unsubscribe:missing-device",
    await req("DELETE", "/api/push/subscriptions", { endpoint: "https://x.test/p" }),
    "device_id");

  // DELETE: invalid device_id format
  await expectInvalidField("push.unsubscribe:bad-device",
    await req("DELETE", "/api/push/subscriptions", { device_id: "not-hex", endpoint: "https://x.test/p" }),
    "device_id");

  // DELETE: empty endpoint
  await expectInvalidField("push.unsubscribe:empty-endpoint",
    await req("DELETE", "/api/push/subscriptions", { device_id: randDeviceId(), endpoint: "" }),
    "endpoint");

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
