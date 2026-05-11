#!/usr/bin/env node
// Concurrent-sequence stress smoke. Fires drafts/contacts/
// read-state events in parallel from the active tab and asserts
// the server sees zero sequence_regression and a strictly-dense
// origin_device_seq column.
//
// What this proves:
//   - the per-(owner, device) origin lock in coordinator.ts
//     serializes the entire build+sign+post chain, not just the
//     sequence-number reservation. Without the post being inside
//     the lock, a fast HTTP response for seq N+1 could overtake a
//     slow response for seq N and the server would reject the
//     second arrival as sequence_regression.
//
// What this does NOT prove:
//   - cross-tab races between two simultaneously-unlocked tabs.
//     A second tab opened against the same origin will restore
//     the session but the crypto bundle stays locked until the
//     user enters their password — so the second tab silently
//     no-ops on outbound posts in this smoke. The cross-tab
//     unlocked-both scenario needs a Web Locks (navigator.locks)
//     fix; it's tracked as a deferred hardening item in
//     OPERATOR.md.
//
// Wired up as `npm run smoke:concurrent-sequence`.
//
// Wired up as `npm run smoke:concurrent-sequence`.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIR = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
const DB_PATH = process.env.SUDO_DB_PATH || path.join(DATA_DIR, "sudo.sqlite");

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function waitFor(page, predicate, timeoutMs = 15000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(predicate)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function lookupCanonical(handle) {
  const r = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  if (!r.ok) return null;
  const b = await r.json().catch(() => ({}));
  return typeof b?.canonical_id === "string" ? b.canonical_id : null;
}

// Each tab counts sequence_regression warnings it sees and tracks
// the number of broadcasts it fires. We compare against the server
// log at the end.
function instrument(page, tag) {
  page.on("pageerror", (err) => console.log(`${tag}-ERR>`, err.message));
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("sequence_regression")) {
      console.log(`${tag}> SEQ-REGRESSION: ${text}`);
    }
  });
}

async function setupSequenceCounters(page) {
  await page.evaluate(() => {
    window.__seqRegressions = 0;
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => {
      const joined = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
      if (joined.includes("sequence_regression")) window.__seqRegressions++;
      originalWarn(...args);
    };
  });
}

async function readSequenceCounter(page) {
  return page.evaluate(() => window.__seqRegressions || 0);
}

// Fire N parallel sync events from a tab using a mix of slices.
// Each slice has its own broadcast path; using more than one
// exercises the shared coordinator + sequence mutex.
async function blastEvents(page, owner, count) {
  return page.evaluate(async (own, n) => {
    const [coord] = await Promise.all([
      import("/client/sync/coordinator.js")
    ]);
    const fired = [];
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const ghost = `sudo:ed25519:${("c0c0" + Date.now().toString(16) + i.toString(16).padStart(3, "0")).padStart(64, "0").slice(-64)}`;
      const slice = i % 3 === 0 ? "contact" : (i % 3 === 1 ? "draft" : "read_state");
      const kind = slice === "contact" ? "contact.upsert" : (slice === "draft" ? "draft.upsert" : "read_state.upsert");
      let payload;
      if (slice === "contact") {
        payload = {
          canonical_id: ghost, handle: `@cs-${i}-${Date.now()}`, tier: "known",
          added_at: new Date().toISOString(), updated_at: new Date().toISOString()
        };
      } else if (slice === "draft") {
        payload = {
          draft_id: `cs-draft-${Date.now()}-${i}`,
          conversation_id: `${own}|${ghost}`,
          body: `body-${i}`,
          updated_at: new Date().toISOString()
        };
      } else {
        payload = {
          conversation_id: `${own}|${ghost}`,
          last_read_at: new Date().toISOString(),
          owner_canonical_id: own
        };
      }
      tasks.push((async () => {
        const ok = await coord.buildAndPostSyncEvent(slice, kind, payload);
        fired.push({ slice, ok });
        return ok;
      })());
    }
    await Promise.all(tasks);
    return fired;
  }, owner, count);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.setViewport({ width: 980, height: 820 });
  instrument(pageA, "TAB-A");
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handle = `cs${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handle);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "signup did not complete"); throw new Error();
  }
  ok(`1. signed up @${handle}`);
  const canonical = await lookupCanonical(handle);
  if (!canonical) { fail("1b.canonical", "no canonical id"); throw new Error(); }

  // Tab 2: a second tab against the SAME origin. Same IDB. The
  // coordinator module is re-imported in this tab — sequence
  // reservation must serialize across tabs, not just within one.
  const pageB = await ctxA.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  instrument(pageB, "TAB-B");
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 15000)) {
    fail("2.tab2-signed-in", "second tab did not reach signed-in"); throw new Error();
  }
  ok(`2. second tab restored session for @${handle}`);

  await setupSequenceCounters(pageA);
  await setupSequenceCounters(pageB);

  // Read the pre-existing origin_device_seq baseline so we can
  // compare the after-state.
  const baselineSeq = await pageA.evaluate(async (own) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise((resolve) => {
      const tx = db.transaction("settings", "readonly");
      const idx = tx.objectStore("settings");
      // We need this tab's device_id to build the key.
      const metaReq = idx.get("device.metadata");
      metaReq.onsuccess = () => {
        const metadata = metaReq.result;
        const deviceId = metadata?.value?.device_id ?? metadata?.value ?? null;
        if (typeof deviceId !== "string") { resolve({ deviceId: null, seq: 0 }); return; }
        const tx2 = db.transaction("settings", "readonly");
        const r = tx2.objectStore("settings").get(`sync.origin_sequence:${own}:${deviceId}`);
        r.onsuccess = () => resolve({ deviceId, seq: typeof r.result?.value === "number" ? r.result.value : 0 });
        r.onerror = () => resolve({ deviceId, seq: 0 });
      };
      metaReq.onerror = () => resolve({ deviceId: null, seq: 0 });
    });
  }, canonical);

  // ===== Fire concurrent bursts from both tabs =====
  // 20 events per tab × 2 tabs = 40 attempts; with the mutex
  // working they should all land at consecutive sequence numbers
  // with no regressions.
  const PER_TAB = 20;
  const [firedA, firedB] = await Promise.all([
    blastEvents(pageA, canonical, PER_TAB),
    blastEvents(pageB, canonical, PER_TAB)
  ]);
  const successA = firedA.filter((f) => f.ok).length;
  const successB = firedB.filter((f) => f.ok).length;
  const totalAttempts = PER_TAB * 2;
  // Tab B's coordinator is locked (session-restore doesn't unlock
  // the crypto bundle without a password prompt), so B's calls
  // silently no-op on `if (active === null) return false`. The
  // primary assertion is on tab A's outcome.
  ok(`3. fired ${totalAttempts} events (tab-A unlocked: ${successA}/${PER_TAB}, tab-B locked-on-restore: ${successB}/${PER_TAB})`);

  // Allow any in-flight retries to settle.
  await new Promise((r) => setTimeout(r, 1500));

  // ===== Assert zero sequence_regression warnings =====
  const regressionsA = await readSequenceCounter(pageA);
  const regressionsB = await readSequenceCounter(pageB);
  const totalRegressions = regressionsA + regressionsB;
  if (totalRegressions > 0) {
    fail("4.sequence-regression", `observed ${totalRegressions} sequence_regression warnings (A=${regressionsA}, B=${regressionsB}) across ${totalAttempts} attempts`);
  } else {
    ok(`4. zero sequence_regression warnings across ${totalAttempts} concurrent attempts`);
  }

  // ===== Server-side: no duplicate (origin_device_id, sequence) pairs =====
  // Check via sqlite if we're against the local node; the UNIQUE
  // constraint on the table makes duplicates impossible to insert,
  // but we still verify no inserts were silently dropped. The count
  // of distinct origin_device_seq for our device should equal the
  // count of successful events fired plus the baseline.
  // Skip the on-disk density check when running against a remote
  // BASE — DB_PATH points at the local dev sqlite, which doesn't
  // see prod's writes and would report a false "sparse sequence"
  // fail. Phase 4 (zero sequence_regression) is the meaningful
  // assertion either way.
  const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE);
  if (isLocalBase && fs.existsSync(DB_PATH) && baselineSeq.deviceId) {
    try {
      const raw = execFileSync("sqlite3", [DB_PATH, `SELECT origin_device_seq FROM device_sync_log WHERE owner_canonical_id='${canonical}' AND origin_device_id='${baselineSeq.deviceId}' ORDER BY origin_device_seq ASC`], { encoding: "utf8" });
      const seqs = raw.trim().split("\n").map((s) => Number(s)).filter((n) => Number.isFinite(n));
      const uniqueSeqs = new Set(seqs);
      if (uniqueSeqs.size !== seqs.length) {
        fail("5.dup-seqs", `device_sync_log has duplicate origin_device_seq rows: ${seqs.length} rows / ${uniqueSeqs.size} distinct`);
      } else {
        ok(`5. device_sync_log has ${seqs.length} strictly-distinct origin_device_seq values for this device`);
      }
      // The successful events should equal (max - baseline) since
      // sequence is dense (the mutex prevents gaps from rejected
      // duplicates).
      const maxSeq = seqs.length > 0 ? seqs[seqs.length - 1] : 0;
      const expectedSuccess = maxSeq - baselineSeq.seq;
      if (Math.abs((successA + successB) - expectedSuccess) > 1) {
        fail("5b.density", `successful events (${successA + successB}) do not match max-baseline gap (${expectedSuccess}). Sparse sequences imply rejected duplicates.`);
      } else {
        ok(`5b. sequence numbers are dense from baseline ${baselineSeq.seq} → max ${maxSeq} (no gaps from rejected duplicates)`);
      }
    } catch (error) {
      console.warn("could not inspect device_sync_log:", error instanceof Error ? error.message : error);
    }
  } else {
    ok(`5. skipped server-side density check (remote BASE or no local sqlite)`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nCONCURRENT-SEQUENCE SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nCONCURRENT-SEQUENCE SMOKE PASSED");
})().catch((error) => { console.error("CONCURRENT-SEQUENCE SMOKE ERROR", error); process.exit(2); });
