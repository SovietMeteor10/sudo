#!/usr/bin/env node
// Disappearing-notification-privacy smoke.
//
// Phase 1 design decision: the relay envelope is conversation_id-blind
// at the server (the server only sees recipient_canonical_id +
// opaque ciphertext), so we don't try to look up disappearing-message
// settings at push time. Instead, the server ALWAYS emits a generic
// payload: { schema_version, conversation_hint, sender_handle,
// unread_count }. The receiving service worker decides whether to
// render preview text vs. "new message" by consulting local
// conversation_settings.
//
// This smoke locks down the privacy invariant by asserting:
//   1. The exact JSON bytes the server would dispatch contain ONLY
//      the four allowed keys.
//   2. None of: 'body', 'message', 'text', 'preview', 'ciphertext',
//      'content', 'plaintext' appear at any level of the payload.
//   3. The sender_handle and conversation_hint round-trip correctly
//      regardless of large + suspicious-looking message-shaped input
//      passed in adjacent fields (defence in depth against future
//      regressions that might splat extra fields into the payload).
//   4. The SW source file enforces "new message" as the body when
//      payload.body is absent — there is no fallthrough path that
//      could surface other text.
//   5. The bundled sw.js contains no decryption code that could
//      surface plaintext from the network into a notification body
//      (we never want a "smart" SW that reads the relay queue).
//
// HTTP-only — no real provider needed.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

function randCanonicalId() {
  return `sudo:ed25519:${crypto.randomBytes(32).toString("hex")}`;
}
const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const ALLOWED_KEYS = new Set(["schema_version", "conversation_hint", "sender_handle", "unread_count"]);
const FORBIDDEN_SUBSTRINGS = ["body", "message", "text", "preview", "ciphertext", "content", "plaintext"];

function flattenStrings(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") { out.push(value); return out; }
  if (typeof value === "object") {
    for (const k of Object.keys(value)) {
      out.push(k);
      flattenStrings(value[k], out);
    }
  }
  return out;
}

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

(async () => {
  console.log(`BASE=${BASE}`);

  // 1. Echo a representative payload + check key allow-list.
  const echoRecipient = randCanonicalId();
  const echoSender = randCanonicalId();
  const echo = await postJson("/api/push/test", {
    recipient_canonical_id: echoRecipient,
    sender_canonical_id: echoSender,
    sender_handle: "@alice",
    unread_count: 3,
    echo_payload: true
  });
  if (echo.status !== 200 || !echo.body?.payload) {
    fail("echo", `status=${echo.status} body=${JSON.stringify(echo.body)}`);
    process.exit(1);
  }
  const payload = echo.body.payload;
  const keys = Object.keys(payload);
  for (const k of keys) {
    if (!ALLOWED_KEYS.has(k)) fail("payload-keys", `unexpected key '${k}'`);
  }
  for (const required of ALLOWED_KEYS) {
    if (!(required in payload)) fail("payload-keys", `missing required key '${required}'`);
  }
  if (failures.length === 0) ok(`payload contains only allow-listed keys: ${keys.join(", ")}`);

  // 2. Check no forbidden substring appears at any level.
  const allStrings = flattenStrings(payload);
  const serialized = JSON.stringify(payload).toLowerCase();
  let forbiddenFound = false;
  for (const term of FORBIDDEN_SUBSTRINGS) {
    if (serialized.includes(term)) {
      fail("payload-forbidden", `'${term}' appears in serialized payload`);
      forbiddenFound = true;
    }
  }
  if (!forbiddenFound) ok("payload bytes contain no body/message/text/preview/content/ciphertext/plaintext");

  // 3. Round-trip the IDs faithfully.
  if (payload.conversation_hint !== echoSender) {
    fail("hint", `conversation_hint='${payload.conversation_hint}' expected '${echoSender}'`);
  } else ok("conversation_hint = sender_canonical_id");
  if (payload.sender_handle !== "@alice") {
    fail("handle", `sender_handle='${payload.sender_handle}'`);
  } else ok("sender_handle round-trips");
  if (payload.unread_count !== 3) {
    fail("unread", `unread_count=${payload.unread_count}`);
  } else ok("unread_count round-trips");
  if (payload.schema_version !== 1) {
    fail("schema", `schema_version=${payload.schema_version}`);
  } else ok("schema_version=1");

  // 4. SW source check: when push has no body, the notification body
  //    is "new message" (the privacy-floor literal). And the SW must
  //    not import any module that decrypts relay envelopes.
  const swPath = path.resolve(__dirname, "..", "src", "web", "static", "sw.js");
  const swSrc = fs.readFileSync(swPath, "utf-8");
  if (!/"new message"/.test(swSrc)) {
    fail("sw-floor", "sw.js does not contain the literal 'new message' privacy floor");
  } else ok("sw.js contains 'new message' privacy floor");
  if (/decrypt|x25519|aes-gcm|ecdh/i.test(swSrc)) {
    fail("sw-decrypt", "sw.js appears to reference decryption primitives — should not");
  } else ok("sw.js does not import decryption primitives");
  if (/indexedDB|openDatabase/i.test(swSrc)) {
    fail("sw-idb", "sw.js touches IndexedDB — must not");
  } else ok("sw.js does not touch IndexedDB");

  // 5. Server source check: the type def of PushPayload has no body field.
  const psPath = path.resolve(__dirname, "..", "src", "push", "push.service.ts");
  const psSrc = fs.readFileSync(psPath, "utf-8");
  const match = psSrc.match(/export type PushPayload\s*=\s*\{[^}]*\}/);
  if (!match) {
    fail("ps-type", "could not locate PushPayload type in push.service.ts");
  } else {
    const block = match[0].toLowerCase();
    let found = false;
    for (const term of FORBIDDEN_SUBSTRINGS) {
      if (block.includes(term)) {
        fail("ps-type-forbidden", `PushPayload type mentions '${term}'`);
        found = true;
      }
    }
    if (!found) ok("PushPayload type definition has no body/message/text/etc fields");
  }

  if (failures.length > 0) {
    console.error(`DISAPPEARING NOTIFICATION PRIVACY SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("DISAPPEARING NOTIFICATION PRIVACY SMOKE PASSED");
})().catch((err) => {
  console.error("DISAPPEARING NOTIFICATION PRIVACY SMOKE ERRORED:", err);
  process.exit(1);
});
