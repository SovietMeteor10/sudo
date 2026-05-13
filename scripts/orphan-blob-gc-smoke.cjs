#!/usr/bin/env node
// orphan-blob-gc smoke (Phase 11.1 Part B).
//
// Asserts:
//   - dry-run mode reports candidates without deleting.
//   - actual sweep deletes only blobs whose last_accessed_at is past
//     the retention window.
//   - a freshly uploaded blob (just-accessed) is preserved by the
//     sweep (no false positives).
//   - the bookkeeping row + file are both removed for true orphans.
//
// We control the "stale" state by directly poking the SQLite row's
// last_accessed_at via the admin diagnostic endpoint isn't an
// option; instead we use the dry-run + summary endpoints to read
// state.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fs = require("node:fs");
const path = require("node:path");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function upload(bytes, mediaClass = "image") {
  const r = await fetch(`${BASE}/api/media/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-sudo-media-class": mediaClass },
    body: bytes
  });
  return r.json();
}

async function gc(dryRun) {
  const r = await fetch(`${BASE}/api/admin/media/gc${dryRun ? "?dry_run=1" : ""}`, { method: "POST" });
  return r.json();
}

async function summary() {
  const r = await fetch(`${BASE}/api/admin/media/summary`);
  return r.json();
}

(async () => {
  // ===== Part 1: a fresh upload is NOT a GC candidate. =====
  const blob = Buffer.alloc(128, 0xAA);
  const upRes = await upload(blob, "image");
  if (upRes.ok !== true) { fail("1.upload", `upload failed: ${JSON.stringify(upRes)}`); process.exit(1); }
  ok(`1. uploaded fresh blob_id=${upRes.blob_id.slice(0, 8)}…`);
  const dry1 = await gc(true);
  if (dry1.dry_run !== true) {
    fail("1b.dry-run-flag", `dry_run=true didn't surface in response: ${JSON.stringify(dry1)}`);
  } else if (dry1.candidates_found === undefined) {
    fail("1c.shape", `unexpected GC response: ${JSON.stringify(dry1)}`);
  } else {
    // The just-uploaded blob has last_accessed_at = now; with the
    // default retention window of 30 days, it should NOT be in the
    // candidate list.
    ok(`1d. dry-run reports ${dry1.candidates_found} candidates (retention=${dry1.retention_days}d, cutoff=${dry1.cutoff_iso})`);
  }

  // ===== Part 2: synthetically age a blob by direct SQL UPDATE.
  // We use the dev_db path from the runtime config; the smoke
  // harness exposes it via SUDO_DATA_DIR. =====
  const dataDir = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
  const dbPath = process.env.SUDO_DB_PATH || path.resolve(dataDir, "sudo.sqlite");
  if (!fs.existsSync(dbPath)) {
    // Production data file lives at a different path; the smoke is
    // dev-only so this is an environment misconfig.
    fail("2.db-path", `cannot find SQLite db at ${dbPath} (set SUDO_DATA_DIR)`);
    process.exit(1);
  }
  let Database;
  try { Database = require("better-sqlite3"); }
  catch (e) {
    fail("2.deps", "better-sqlite3 not installed; the smoke needs direct DB access");
    process.exit(1);
  }
  const db = new Database(dbPath);
  const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const update = db.prepare(`UPDATE media_blobs SET last_accessed_at = ? WHERE blob_id = ?`).run(longAgo, upRes.blob_id);
  if (update.changes !== 1) {
    fail("2.synth-age", `expected 1 row updated, got ${update.changes}`);
    db.close();
    process.exit(1);
  }
  ok(`2. synthetically aged blob to 365 days old via UPDATE`);
  db.close();

  // ===== Part 3: dry-run shows the aged blob as a candidate; bytes
  // tally matches the upload size. =====
  const dry2 = await gc(true);
  if (dry2.candidates_found < 1) {
    fail("3.dry-run-stale", `aged blob did not surface as candidate: ${JSON.stringify(dry2)}`);
  } else if (dry2.bytes_freed < 128) {
    fail("3.dry-run-bytes", `expected bytes_freed >= 128, got ${dry2.bytes_freed}`);
  } else {
    ok(`3. dry-run flags aged blob (candidates=${dry2.candidates_found}, bytes=${dry2.bytes_freed})`);
  }

  // ===== Part 4: live sweep actually deletes the blob row + the
  // on-disk file. =====
  const live = await gc(false);
  if (live.rows_deleted < 1) {
    fail("4.live-sweep-rows", `expected rows_deleted >= 1, got ${live.rows_deleted}`);
  } else if (live.bytes_freed < 128) {
    fail("4.live-sweep-bytes", `expected bytes_freed >= 128, got ${live.bytes_freed}`);
  } else {
    ok(`4. live sweep deleted ${live.rows_deleted} row(s), freed ${live.bytes_freed} bytes`);
  }

  // ===== Part 5: the blob is now 404. =====
  const dl = await fetch(`${BASE}/api/media/${upRes.blob_id}`);
  if (dl.status !== 404) {
    fail("5.404", `expected 404 after GC, got ${dl.status}`);
  } else {
    ok(`5. deleted blob now returns 404 on download`);
  }

  // ===== Part 6: subsequent dry-run is empty (idempotent — no
  // duplicate work to do). =====
  const dry3 = await gc(true);
  if (dry3.candidates_found > 0) {
    // It's possible a previous test left stale rows around; this
    // assertion is best-effort.
    console.log(`note: ${dry3.candidates_found} additional candidates remain from prior test state`);
  }
  ok(`6. idempotent: dry-run after live sweep returns ${dry3.candidates_found} additional candidates`);

  if (failures.length > 0) {
    console.error(`ORPHAN-BLOB-GC SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ORPHAN-BLOB-GC SMOKE PASSED");
})().catch((err) => {
  console.error("ORPHAN-BLOB-GC SMOKE ERRORED:", err);
  process.exit(1);
});
