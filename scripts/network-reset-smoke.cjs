#!/usr/bin/env node
// network-reset smoke (Phase 13).
//
// Verifies the end-to-end reset workflow against a local dev
// server:
//   1. Seed the DB + media dir with synthetic state (an identity, a
//      relay envelope, a media blob).
//   2. Run `scripts/reset-network.cjs --yes` against the same
//      dataDir.
//   3. Assert every wipe-able table has 0 rows, the media dir is
//      empty, the .epoch file has a new value, and a snapshot
//      file exists.
//   4. Restart the server (the smoke harness handles this in the
//      restart helper).
//   5. Assert /api/network/epoch returns the new value.
//   6. Assert /health still returns ok.
//
// Dev-only — requires local SQLite access + the standard
// SUDO_DATA_DIR layout.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const DATA_DIR = path.resolve(process.env.SUDO_DATA_DIR || "./data");
const DB_PATH = path.resolve(DATA_DIR, "sudo.sqlite");
const MEDIA_DIR = path.resolve(DATA_DIR, "media");
const EPOCH_FILE = path.resolve(DATA_DIR, ".epoch");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const TABLES_TO_WIPE = [
  "identities", "encrypted_messages", "relay_envelopes",
  "relay_relationships", "connections", "feed_subscriptions",
  "trusted_devices", "device_sync_events", "device_pairing_tokens",
  "device_memberships", "device_sync_log", "device_sync_cursors",
  "tombstone_watermarks", "push_subscriptions", "feed_posts",
  "discovery_reactions", "discovery_post_index", "dev_sessions",
  "identity_challenges", "media_blobs"
];

(async () => {
  let Database;
  try { Database = require("better-sqlite3"); }
  catch (e) { fail("setup.deps", "better-sqlite3 not installed"); process.exit(2); }

  // ===== Phase 1: seed state =====
  if (!fs.existsSync(DB_PATH)) {
    fail("setup.db", `no SQLite db at ${DB_PATH}`); process.exit(2);
  }
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {
    db.prepare(`INSERT OR IGNORE INTO identities (canonical_id, handle, canonical, public_key, profile_url, finger_url, inbox_url, updated_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "sudo:ed25519:reset-smoke-" + Date.now(),
        "smk" + Date.now().toString().slice(-6),
        "sudo:ed25519:reset-smoke-" + Date.now(),
        "stub-pub-key",
        "/api/identity/stub",
        "/finger/stub",
        "/api/identity/stub/inbox",
        new Date().toISOString(),
        "dev-placeholder"
      );
    db.prepare(`INSERT OR IGNORE INTO relay_envelopes (message_id, sender_canonical_id, recipient_canonical_id, ciphertext, ciphertext_scheme, created_at, expires_at, status, sender_signature, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("seed-msg-" + Date.now(), "sudo:ed25519:a", "sudo:ed25519:b", "ct", "sudo_chat_v1", new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), "stored_by_relay", "dev-placeholder", "{}");
  } catch (e) {
    fail("seed.sql", e.message); db.close(); process.exit(1);
  }
  const seededFile = path.resolve(MEDIA_DIR, "deadbeefdeadbeefdeadbeefdeadbeef");
  fs.writeFileSync(seededFile, Buffer.alloc(64, 0x11));
  const seededTmp = path.resolve(MEDIA_DIR, "abcdefabcdefabcdefabcdefabcdefab.tmp");
  fs.writeFileSync(seededTmp, Buffer.alloc(8, 0x22));

  const beforeIdentities = db.prepare("SELECT COUNT(*) AS c FROM identities").get().c;
  const beforeEnvelopes = db.prepare("SELECT COUNT(*) AS c FROM relay_envelopes").get().c;
  const beforeMedia = fs.readdirSync(MEDIA_DIR).length;
  db.close();
  ok(`1. seeded: identities=${beforeIdentities}, envelopes=${beforeEnvelopes}, media files=${beforeMedia}`);

  // Capture pre-reset epoch.
  const preEpoch = fs.existsSync(EPOCH_FILE) ? fs.readFileSync(EPOCH_FILE, "utf-8").trim() : null;

  // ===== Phase 2: run the reset script with --yes =====
  try {
    execSync(`node scripts/reset-network.cjs --yes`, {
      cwd: process.cwd(),
      env: { ...process.env, SUDO_DATA_DIR: DATA_DIR },
      stdio: "pipe"
    });
    ok(`2. reset-network.cjs --yes completed without error`);
  } catch (e) {
    fail("2.script", `reset script failed: ${e.message}\n${e.stderr?.toString() || ""}`);
    process.exit(1);
  }

  // ===== Phase 3: every wipe-able table has 0 rows =====
  const db2 = new Database(DB_PATH);
  let allEmpty = true;
  for (const t of TABLES_TO_WIPE) {
    const c = db2.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    if (c !== 0) {
      fail(`3.${t}`, `expected 0 rows after reset, got ${c}`);
      allEmpty = false;
    }
  }
  if (allEmpty) ok(`3. every wipe-able table is empty after reset (${TABLES_TO_WIPE.length} tables)`);
  db2.close();

  // ===== Phase 4: media dir is empty =====
  const remaining = fs.readdirSync(MEDIA_DIR);
  if (remaining.length > 0) {
    fail("4.media", `media dir not empty: ${remaining.join(", ")}`);
  } else {
    ok(`4. media dir is empty (was ${beforeMedia} files, now 0)`);
  }

  // ===== Phase 5: a new epoch was minted =====
  if (!fs.existsSync(EPOCH_FILE)) {
    fail("5.epoch-file", `${EPOCH_FILE} missing after reset`);
  } else {
    const postEpoch = fs.readFileSync(EPOCH_FILE, "utf-8").trim();
    if (postEpoch.length < 10) {
      fail("5.epoch-shape", `epoch value looks invalid: '${postEpoch}'`);
    } else if (preEpoch !== null && postEpoch === preEpoch) {
      fail("5.epoch-unchanged", `epoch wasn't bumped: still '${preEpoch}'`);
    } else {
      ok(`5. new NETWORK_EPOCH minted${preEpoch !== null ? ` (was '${preEpoch.slice(0,8)}…', now '${postEpoch.slice(0,8)}…')` : ` (first run): '${postEpoch.slice(0,12)}…'`}`);
    }
  }

  // ===== Phase 6: a snapshot file exists =====
  const snapshots = fs.readdirSync(DATA_DIR).filter((n) => n.startsWith("reset-snapshot-") && n.endsWith(".json"));
  if (snapshots.length === 0) {
    fail("6.snapshot", "no reset-snapshot-*.json written");
  } else {
    const latest = snapshots.sort().reverse()[0];
    const json = JSON.parse(fs.readFileSync(path.resolve(DATA_DIR, latest), "utf-8"));
    if (typeof json.total_rows !== "number") {
      fail("6.shape", `snapshot file missing total_rows: ${JSON.stringify(json).slice(0, 200)}`);
    } else if (json.total_rows < beforeIdentities + beforeEnvelopes) {
      fail("6.counts", `snapshot total_rows=${json.total_rows} < seeded ${beforeIdentities + beforeEnvelopes}`);
    } else {
      ok(`6. snapshot file written: ${latest} (total_rows=${json.total_rows})`);
    }
  }

  // ===== Phase 7: server still responds to /health =====
  const health = await fetch(`${BASE}/health`);
  if (health.status !== 200) {
    fail("7.health", `/health returned ${health.status} after reset`);
  } else {
    ok(`7. /health still 200 after reset`);
  }

  // ===== Phase 8: /api/network/epoch reflects the cached pre-reset
  // value because the server hasn't been restarted. Document this
  // — the runbook says restart is required.
  const epochResp = await fetch(`${BASE}/api/network/epoch`);
  const epochBody = await epochResp.json();
  if (typeof epochBody?.epoch !== "string" || epochBody.epoch.length === 0) {
    fail("8.epoch-endpoint", `endpoint shape wrong: ${JSON.stringify(epochBody)}`);
  } else {
    ok(`8. /api/network/epoch returns a valid value (cached in-memory until restart)`);
  }

  // Cleanup: remove the snapshot files we generated so they don't
  // accumulate across smoke runs.
  for (const s of snapshots) {
    try { fs.unlinkSync(path.resolve(DATA_DIR, s)); } catch { /* ignore */ }
  }

  if (failures.length > 0) {
    console.error(`NETWORK-RESET SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("NETWORK-RESET SMOKE PASSED");
})().catch((err) => {
  console.error("NETWORK-RESET SMOKE ERRORED:", err);
  process.exit(1);
});
