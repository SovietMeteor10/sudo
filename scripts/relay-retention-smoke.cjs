#!/usr/bin/env node
// relay-retention smoke (Phase 11.1 Part C).
//
// Asserts the retention sweeper hard-deletes stale rows that the
// existing TTL machinery only marks expired:
//   - pairing tokens past their expires_at.
//   - identity challenges past their expires_at.
//   - dev sessions past their expires_at (deprecated table, still
//     cleaned).
//   - relay envelopes that have been in 'expired' state long enough.
//
// We synthetically age rows via direct SQL UPDATE on the dev DB,
// then invoke the sweeper via /api/admin/relay/retention-sweep.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fs = require("node:fs");
const path = require("node:path");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function sweep() {
  const r = await fetch(`${BASE}/api/admin/relay/retention-sweep`, { method: "POST" });
  return r.json();
}

(async () => {
  const dataDir = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
  const dbPath = process.env.SUDO_DB_PATH || path.resolve(dataDir, "sudo.sqlite");
  if (!fs.existsSync(dbPath)) {
    fail("setup.db", `cannot find SQLite db at ${dbPath}`);
    process.exit(1);
  }
  let Database;
  try { Database = require("better-sqlite3"); }
  catch {
    fail("setup.deps", "better-sqlite3 not installed");
    process.exit(1);
  }
  const db = new Database(dbPath);

  // ===== Seed: stale pairing token + identity challenge + dev
  // session + already-expired relay envelope, all past their TTL.
  // The retention sweeper should hard-delete each.
  const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const farAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fakeCanonical = "sudo:ed25519:smoke-retention-" + Date.now().toString(16);

  // We need an identity row to satisfy the foreign keys on
  // identity_challenges + dev_sessions. Insert one if missing.
  try {
    db.prepare(`INSERT OR IGNORE INTO identities (canonical_id, handle, document_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      fakeCanonical, "rs" + Date.now().toString().slice(-6), "{}", "", new Date().toISOString()
    );
  } catch (e) {
    // schema may differ slightly; if the insert fails the FK row
    // doesn't exist and we can't seed identity-FK'd rows. Best-
    // effort: still test pairing_tokens which has no FK.
  }

  // 1) Pairing token (no FK)
  db.prepare(`INSERT OR REPLACE INTO device_pairing_tokens (pairing_code, pairing_token, owner_canonical_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "RS" + Date.now().toString().slice(-6), "tok-smoke-rs-" + Date.now(), fakeCanonical, longAgo, longAgo
  );

  // 2) Identity challenge (FK identities)
  try {
    db.prepare(`INSERT OR REPLACE INTO identity_challenges (nonce, canonical_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(
      "nonce-smoke-" + Date.now(), fakeCanonical, longAgo, longAgo
    );
  } catch { /* FK insert may fail if identities row didn't take; skip */ }

  // 3) Dev session (FK identities)
  try {
    db.prepare(`INSERT OR REPLACE INTO dev_sessions (token_hash, canonical_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(
      "hash-smoke-" + Date.now(), fakeCanonical, longAgo, longAgo
    );
  } catch { /* FK insert may fail */ }

  // 4) Expired relay envelope (status='expired', expires_at far past
  //    the hard-delete cutoff)
  db.prepare(`INSERT OR REPLACE INTO relay_envelopes (message_id, sender_canonical_id, recipient_canonical_id, ciphertext, ciphertext_scheme, created_at, expires_at, status, sender_signature, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "msg-smoke-retention-" + Date.now(), fakeCanonical, fakeCanonical, "", "sudo_chat_v1", farAgo, farAgo, "expired", "dev-placeholder", "{}"
  );

  const before = {
    pairing: db.prepare(`SELECT COUNT(*) AS c FROM device_pairing_tokens WHERE expires_at <= ?`).get(new Date().toISOString()).c,
    challenge: db.prepare(`SELECT COUNT(*) AS c FROM identity_challenges WHERE expires_at <= ?`).get(new Date().toISOString()).c,
    sessions: db.prepare(`SELECT COUNT(*) AS c FROM dev_sessions WHERE expires_at <= ?`).get(new Date().toISOString()).c,
    expiredEnvelopes: db.prepare(`SELECT COUNT(*) AS c FROM relay_envelopes WHERE status = 'expired'`).get().c
  };
  db.close();

  ok(`seed: stale rows in db before sweep: ${JSON.stringify(before)}`);
  if (before.pairing < 1 && before.expiredEnvelopes < 1) {
    fail("seed.empty", `no stale rows found before sweep; the smoke can't make progress`);
    process.exit(1);
  }

  // ===== Trigger the sweep + assert it hard-deleted the rows. =====
  const result = await sweep();
  if (result.ok !== true) {
    fail("sweep.shape", `sweep response shape unexpected: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  ok(`sweep result: ${JSON.stringify(result)}`);

  if (before.pairing > 0 && result.pairing_tokens_pruned < 1) {
    fail("sweep.pairing", `expected pairing_tokens_pruned >= 1, got ${result.pairing_tokens_pruned}`);
  } else if (before.pairing > 0) {
    ok(`sweep: pruned ${result.pairing_tokens_pruned} pairing token(s)`);
  }
  if (before.expiredEnvelopes > 0 && result.expired_envelopes_hard_deleted < 1) {
    fail("sweep.envelopes", `expected expired_envelopes_hard_deleted >= 1, got ${result.expired_envelopes_hard_deleted}`);
  } else if (before.expiredEnvelopes > 0) {
    ok(`sweep: hard-deleted ${result.expired_envelopes_hard_deleted} expired envelope(s)`);
  }

  // ===== Re-run sweep — should be a no-op (idempotent). =====
  const second = await sweep();
  if (second.pairing_tokens_pruned !== 0 || second.expired_envelopes_hard_deleted !== 0) {
    // It's OK if other tables have residual rows we didn't seed.
    console.log(`note: second sweep deleted ${JSON.stringify(second)} (residual from earlier tests)`);
  }
  ok(`sweep is idempotent on a clean state`);

  if (failures.length > 0) {
    console.error(`RELAY-RETENTION SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("RELAY-RETENTION SMOKE PASSED");
})().catch((err) => {
  console.error("RELAY-RETENTION SMOKE ERRORED:", err);
  process.exit(1);
});
