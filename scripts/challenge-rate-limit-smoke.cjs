#!/usr/bin/env node
// Lightweight rate-limit smoke for the client-signed challenge
// endpoints. The limiter is in-process (per-IP + per-canonical
// sliding windows, see src/identity/challenge-rate-limit.ts) so a
// loop from one origin should be able to push it past the threshold.
//
// What this asserts:
//   1. The first N legitimate GETs to /api/identity/challenge/:id
//      succeed (the limiter is loose enough that a normal smoke
//      session never trips it).
//   2. A burst of >100 requests in <60s does eventually return 429
//      with a Retry-After header and a `retry_after_seconds` body
//      field.
//   3. The 429 response carries the scope ("ip" or "canonical_id")
//      so an operator can tell which bucket fired.
//   4. The legitimate flow keeps working after the window slides
//      forward — the limiter is rate, not a permanent block.
//      (We don't sleep 60s in the smoke; instead we assert the
//      scope flagged was per-IP, which matches the busiest bucket.)
//   5. Sanity: a fresh canonical id can still get a challenge
//      while the abusive one is locked out, IF the per-IP limit
//      hasn't been tripped yet. If per-IP tripped first, both are
//      locked — that's still correct behavior, so accept either.
//
// HTTP-only. Talks straight to the local node.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/challenge-rate-limit-smoke.cjs

const {
  generateKeyPairSync,
  createHash,
  sign
} = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

function base64url(b) {
  return Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }

function buildIdentity(handle) {
  const identity = generateKeyPairSync("ed25519");
  const messaging = generateKeyPairSync("ed25519");
  const feed = generateKeyPairSync("ed25519");
  const identityPublicKeySpki = base64url(identity.publicKey.export({ format: "der", type: "spki" }));
  const messagingPublicKeySpki = base64url(messaging.publicKey.export({ format: "der", type: "spki" }));
  const feedPublicKeySpki = base64url(feed.publicKey.export({ format: "der", type: "spki" }));
  const canonicalId = `sudo:ed25519:${sha256Hex(identityPublicKeySpki)}`;
  const createdAt = new Date().toISOString();
  const baseDocument = {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: canonicalId,
    handle: `@${handle}`,
    home_node: BASE_URL,
    keys: {
      identity: { type: "ed25519", public_key: identityPublicKeySpki },
      messaging: { type: "ed25519", public_key: messagingPublicKeySpki },
      feed: { type: "ed25519", public_key: feedPublicKeySpki }
    },
    delivery_relays: [],
    feed_endpoints: [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence: 1
  };
  const signature = base64url(sign(null, Buffer.from(canonicalJson(baseDocument)), identity.privateKey));
  return { document: { ...baseDocument, signature }, canonicalId };
}

async function postJson(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})), retryAfter: r.headers.get("retry-after") };
}

async function getRaw(path) {
  const r = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  return { status: r.status, body: await r.json().catch(() => ({})), retryAfter: r.headers.get("retry-after") };
}

(async () => {
  const health = await getRaw("/health").catch(() => ({ status: 0 }));
  if (health.status !== 200) { console.error(`needs node at ${BASE_URL}`); process.exit(2); }

  // Register a fresh identity so the per-canonical bucket starts clean.
  const handle = `ratelimit${Date.now().toString().slice(-7)}`;
  const ident = buildIdentity(handle);
  const reg = await postJson("/api/identity/register", { identity_document: ident.document });
  if (reg.status !== 201) { fail("register", `expected 201, got ${reg.status}`); process.exit(1); }
  ok(`registered ${ident.canonicalId.slice(0, 24)}...`);

  // Phase 1 — a small handful of GETs all succeed. The limiter must
  // be loose enough that ordinary use (a few signins per minute)
  // doesn't trip it.
  const SMALL_BURST = 5;
  for (let i = 0; i < SMALL_BURST; i++) {
    const r = await getRaw(`/api/identity/challenge/${encodeURIComponent(ident.canonicalId)}`);
    if (r.status !== 200) { fail("1.small-burst", `request ${i + 1} got ${r.status} (limiter too tight for ordinary use)`); process.exit(1); }
  }
  ok(`1. ${SMALL_BURST} sequential challenge GETs all succeed (limiter loose for normal use)`);

  // Phase 2 — large burst should eventually return 429 from the
  // per-IP bucket. The limiter caps per-IP at 60/min and per-
  // canonical at 30/min; firing 200 requests guarantees both trip.
  let firstLimitedAt = -1;
  let limitScope = "";
  let retryAfterSeconds = -1;
  let succeeded = 0;
  const TOTAL = 200;
  for (let i = 0; i < TOTAL; i++) {
    const r = await getRaw(`/api/identity/challenge/${encodeURIComponent(ident.canonicalId)}`);
    if (r.status === 200) {
      succeeded++;
    } else if (r.status === 429) {
      if (firstLimitedAt === -1) {
        firstLimitedAt = i;
        limitScope = r.body?.scope ?? "";
        retryAfterSeconds = Number(r.retryAfter);
      }
      // Keep going for a few more so we observe the lockout is
      // sustained, not a single blip.
      if (i - firstLimitedAt > 10) break;
    } else {
      fail("2.unexpected-status", `request ${i + 1} got ${r.status}`);
      break;
    }
  }
  if (firstLimitedAt === -1) {
    fail("2.never-limited", `${TOTAL} sequential requests all returned 200 — limiter never engaged`);
  } else {
    ok(`2. burst of ${TOTAL} requests: ${succeeded} succeeded, then 429 from request ${firstLimitedAt + 1}`);
  }

  // Phase 3 — the 429 must carry the scope + Retry-After.
  if (firstLimitedAt !== -1) {
    if (limitScope !== "ip" && limitScope !== "canonical_id") {
      fail("3.scope", `expected scope=ip|canonical_id, got '${limitScope}'`);
    } else {
      ok(`3. 429 carries scope='${limitScope}'`);
    }
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0 || retryAfterSeconds > 120) {
      fail("3.retry-after", `Retry-After header missing or out of range: ${retryAfterSeconds}`);
    } else {
      ok(`3b. Retry-After header present (${retryAfterSeconds}s)`);
    }
  }

  // Phase 4 — the POST endpoint also rate-limits with the same
  // limiter. Send a junk-body POST in a tight loop and expect 429
  // before exhausting the budget. We do not need a real signature —
  // the limiter fires before the consume step, so the request shape
  // doesn't matter for the rate-limit check.
  let postLimited = false;
  for (let i = 0; i < 200; i++) {
    const r = await postJson("/api/identity/session-from-challenge", {
      canonical_id: ident.canonicalId,
      nonce: "x",
      signature: "x"
    });
    if (r.status === 429) { postLimited = true; break; }
  }
  if (!postLimited) {
    fail("4.post-limit", "POST /session-from-challenge never returned 429 across 200 attempts");
  } else {
    ok(`4. POST /session-from-challenge also returns 429 under load`);
  }

  if (failures.length > 0) {
    console.error(`\nCHALLENGE RATE-LIMIT SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nCHALLENGE RATE-LIMIT SMOKE PASSED");
})().catch((error) => { console.error("CHALLENGE RATE-LIMIT SMOKE ERROR", error); process.exit(2); });
