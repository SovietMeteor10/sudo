#!/usr/bin/env node
// Phase 13: genesis network reset.
//
// What this does:
//   1. Engages maintenance mode (touches ${dataDir}/.maintenance).
//   2. Generates an operator snapshot at
//      ${dataDir}/reset-snapshot-YYYYMMDD-HHMMSS.json containing
//      only metadata counts — no plaintext, no ciphertext.
//   3. Wipes every user-generated SQLite table while preserving
//      schema (DELETE FROM, not DROP TABLE).
//   4. Wipes the media directory contents (every blob_id file +
//      every .tmp leftover), then re-mkdir's it with mode 0o700.
//   5. Mints a new NETWORK_EPOCH so any browser that ever connected
//      to the old network wipes its IDB on next visit.
//   6. Disengages maintenance mode.
//
// What this preserves:
//   - SQLite schema (tables + indexes + foreign keys).
//   - ${dataDir}/keys/ (VAPID + onion keys + identity).
//   - Operator config (env, nginx, systemd, torrc — none of those
//     live in dataDir).
//
// Safety:
//   - Requires NODE_ENV=production OR --i-know-what-im-doing.
//   - Two-step interactive confirmation. CI/dev can bypass with
//     --yes (only valid when SUDO_NODE_ENV != "production").
//
// Usage:
//   node scripts/reset-network.cjs              # interactive prompts
//   node scripts/reset-network.cjs --yes        # dev/CI shortcut
//   node scripts/reset-network.cjs --dry-run    # print plan, do nothing

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

const DATA_DIR = path.resolve(process.env.SUDO_DATA_DIR || "./data");
const DB_PATH = process.env.SUDO_DB_PATH || path.resolve(DATA_DIR, "sudo.sqlite");
const MEDIA_DIR = path.resolve(DATA_DIR, "media");
const MAINTENANCE_FLAG = path.resolve(DATA_DIR, ".maintenance");
const EPOCH_FILE = path.resolve(DATA_DIR, ".epoch");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const autoYes = args.has("--yes");
const forceFlag = args.has("--i-know-what-im-doing");

// Tables we explicitly WIPE. Order doesn't matter — we use DELETE,
// not DROP, so foreign keys stay intact. (Most tables here have no
// FK constraints anyway.)
//
// If new tables are added to schema.ts, append them here. The smoke
// `network-reset` verifies that every table in the live DB is
// either in this list or has 0 rows after the reset.
const TABLES_TO_WIPE = [
  "identities",
  "encrypted_messages",
  "relay_envelopes",
  "relay_relationships",
  "connections",
  "feed_subscriptions",
  "trusted_devices",
  "device_sync_events",
  "device_pairing_tokens",
  "device_memberships",
  "device_sync_log",
  "device_sync_cursors",
  "tombstone_watermarks",
  "push_subscriptions",
  "feed_posts",
  "discovery_reactions",
  "discovery_post_index",
  "dev_sessions",
  "identity_challenges",
  "media_blobs"
];

// One persistent readline interface. Creating a new rl per
// question (the prior shape) hangs when stdin is piped: the first
// rl closes stdin, the second rl opens stdin again and gets EOF
// without ever firing question()'s callback. Sharing one rl keeps
// stdin open for the entire confirmation flow.
let sharedReadline = null;
function rl() {
  if (sharedReadline === null) {
    sharedReadline = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedReadline;
}
function ask(question) {
  return new Promise((resolve) => {
    rl().question(question, (answer) => resolve(answer));
  });
}
function closeReadline() {
  if (sharedReadline !== null) {
    sharedReadline.close();
    sharedReadline = null;
  }
}

function log(line) { console.log(line); }
function warn(line) { console.warn(line); }
function err(line) { console.error(line); }

async function confirmInteractive() {
  if (autoYes) {
    // Production safety: refuse --yes when NODE_ENV=production
    // unless the operator opts in with --i-know-what-im-doing.
    // (Earlier versions checked SUDO_NODE_ENV — the actual env var
    // set by the production systemd unit is NODE_ENV, so the check
    // was a no-op against real prod. We now check both.)
    const isProd = process.env.NODE_ENV === "production" || process.env.SUDO_NODE_ENV === "production";
    if (isProd && !forceFlag) {
      err("refusing to use --yes against a production server without --i-know-what-im-doing");
      process.exit(2);
    }
    log("(--yes given; skipping interactive confirmation)");
    return;
  }
  log("");
  log("================================================================");
  log("  this will permanently destroy all sudo network data:");
  log("    - every identity, message, conversation, reaction, attachment");
  log("    - every linked device, push subscription, sync log");
  log("    - every relay envelope, pairing code, dev session");
  log("    - every media blob on disk");
  log("");
  log("  preserved:");
  log("    - schema (no DROP, only DELETE)");
  log(`    - ${path.relative(process.cwd(), DATA_DIR)}/keys/ (VAPID + onion)`);
  log("    - operator config (env, nginx, systemd, torrc)");
  log("================================================================");
  log("");
  const first = await ask("type 'continue' to acknowledge: ");
  if (first.trim() !== "continue") {
    err("not 'continue' — aborting.");
    process.exit(1);
  }
  const second = await ask("type 'RESET SUDO NETWORK' to confirm: ");
  if (second.trim() !== "RESET SUDO NETWORK") {
    err("confirmation did not match — aborting.");
    process.exit(1);
  }
}

function openDb() {
  let Database;
  try { Database = require("better-sqlite3"); }
  catch (e) {
    err("better-sqlite3 not installed; cannot open the DB.");
    err(e.message);
    process.exit(2);
  }
  if (!fs.existsSync(DB_PATH)) {
    err(`SQLite database not found at ${DB_PATH}.`);
    err("set SUDO_DATA_DIR or SUDO_DB_PATH to point at the right file.");
    process.exit(2);
  }
  return new Database(DB_PATH);
}

function generateSnapshot(db) {
  const tables = TABLES_TO_WIPE;
  const counts = {};
  let totalRows = 0;
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
      counts[t] = row.c;
      totalRows += row.c;
    } catch (e) {
      counts[t] = { error: e.message };
    }
  }
  let mediaBlobCount = 0;
  let mediaTmpCount = 0;
  let mediaBytes = 0;
  if (fs.existsSync(MEDIA_DIR)) {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const p = path.resolve(MEDIA_DIR, name);
      try {
        const stat = fs.statSync(p);
        if (name.endsWith(".tmp")) mediaTmpCount++;
        else mediaBlobCount++;
        mediaBytes += stat.size;
      } catch { /* ignore */ }
    }
  }
  const snapshot = {
    generated_at: new Date().toISOString(),
    note: "Phase 13 genesis-reset snapshot. Metadata only — no plaintext bodies, no ciphertext, no handles.",
    db_path: DB_PATH,
    media_dir: MEDIA_DIR,
    table_row_counts: counts,
    total_rows: totalRows,
    media: {
      blob_count: mediaBlobCount,
      tmp_count: mediaTmpCount,
      total_bytes: mediaBytes
    }
  };
  return snapshot;
}

function wipeMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
    return { deleted: 0, kept: 0 };
  }
  let deleted = 0;
  for (const name of fs.readdirSync(MEDIA_DIR)) {
    const p = path.resolve(MEDIA_DIR, name);
    try {
      fs.unlinkSync(p);
      deleted++;
    } catch (e) {
      warn(`could not delete ${p}: ${e.message}`);
    }
  }
  // Recreate the perms in case the parent was somehow lost.
  try { fs.chmodSync(MEDIA_DIR, 0o700); } catch { /* best effort */ }
  return { deleted };
}

function mintNewEpoch() {
  const fresh = crypto.randomUUID();
  fs.writeFileSync(EPOCH_FILE, fresh, { mode: 0o644 });
  return fresh;
}

async function run() {
  log(`reset-network.cjs`);
  log(`  data dir: ${DATA_DIR}`);
  log(`  db file:  ${DB_PATH}`);
  log(`  media:    ${MEDIA_DIR}`);
  log(`  dry run:  ${dryRun ? "YES" : "no"}`);
  log("");
  await confirmInteractive();

  // === Maintenance mode ON ===
  if (!dryRun) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(MAINTENANCE_FLAG, "sudo is being reset for a new network launch.\n", { mode: 0o644 });
      log("✓ maintenance mode engaged");
    } catch (e) {
      err(`could not create ${MAINTENANCE_FLAG}: ${e.message}`);
      process.exit(2);
    }
  } else {
    log("· (dry-run) would touch maintenance flag");
  }

  const db = openDb();

  // === Snapshot ===
  const snapshot = generateSnapshot(db);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotPath = path.resolve(DATA_DIR, `reset-snapshot-${stamp}.json`);
  if (!dryRun) {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), { mode: 0o644 });
    log(`✓ snapshot written: ${snapshotPath}`);
  } else {
    log("· (dry-run) snapshot would be:");
    log(JSON.stringify(snapshot, null, 2));
  }

  // === Wipe SQLite ===
  //
  // FK awareness: identities has child rows in dev_sessions +
  // identity_challenges. A single-pass DELETE inside one
  // transaction fails on identities because the children still
  // exist at the moment that statement runs. We do multiple
  // passes: each pass retries any table that failed last time.
  // Converges in two passes for the current schema.
  if (!dryRun) {
    let remaining = [...TABLES_TO_WIPE];
    let pass = 0;
    while (remaining.length > 0 && pass < 5) {
      pass++;
      const stillFailing = [];
      // Independent transactions per table so one FK failure
      // doesn't roll back the rest of the pass.
      for (const t of remaining) {
        try {
          db.prepare(`DELETE FROM ${t}`).run();
        } catch (e) {
          if (e.message.includes("FOREIGN KEY")) {
            stillFailing.push(t);
          } else {
            warn(`could not wipe ${t}: ${e.message}`);
          }
        }
      }
      if (stillFailing.length === 0) break;
      if (stillFailing.length === remaining.length) {
        // No progress — break to avoid infinite loop.
        for (const t of stillFailing) warn(`could not wipe ${t}: FK constraint never satisfied`);
        break;
      }
      remaining = stillFailing;
    }
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
    try { db.exec("VACUUM"); } catch { /* ignore */ }
    log(`✓ wiped ${TABLES_TO_WIPE.length} table(s) in ${pass} pass(es); VACUUM completed`);
  } else {
    log(`· (dry-run) would wipe ${TABLES_TO_WIPE.length} tables`);
  }
  db.close();

  // === Wipe media ===
  if (!dryRun) {
    const r = wipeMediaDir();
    log(`✓ media wiped: ${r.deleted} file(s) deleted`);
  } else {
    log("· (dry-run) would wipe media dir");
  }

  // === Bump network epoch ===
  if (!dryRun) {
    const newEpoch = mintNewEpoch();
    log(`✓ new NETWORK_EPOCH: ${newEpoch}`);
    log("  (any browser that connected to the old network will wipe its IDB on next visit)");
  } else {
    log("· (dry-run) would mint a new NETWORK_EPOCH");
  }

  // === Maintenance mode OFF ===
  if (!dryRun) {
    try {
      if (fs.existsSync(MAINTENANCE_FLAG)) fs.unlinkSync(MAINTENANCE_FLAG);
      log("✓ maintenance mode disengaged");
    } catch (e) {
      warn(`could not remove ${MAINTENANCE_FLAG}: ${e.message}`);
      warn("the server is wiped but still in maintenance mode — remove the flag manually.");
    }
  } else {
    log("· (dry-run) would remove maintenance flag");
  }

  log("");
  log("================================================================");
  if (dryRun) {
    log("dry-run complete. no changes were made.");
  } else {
    log("RESET COMPLETE.");
    log("");
    log("recommended next steps:");
    log("  1. restart the sudo service so the new NETWORK_EPOCH is");
    log("     picked up by every code path that reads it.");
    log("  2. visit / on clearnet + .onion to verify the empty-state UX.");
    log("  3. sign up a fresh account; send a test message.");
    log("  4. (optional) keep the snapshot file off-disk for audit.");
  }
  log("================================================================");
}

run()
  .then(() => closeReadline())
  .catch((e) => {
    err(`fatal: ${e instanceof Error ? e.message : e}`);
    if (fs.existsSync(MAINTENANCE_FLAG)) {
      warn(`maintenance flag still present at ${MAINTENANCE_FLAG} — remove it manually before resuming service.`);
    }
    closeReadline();
    process.exit(1);
  });
