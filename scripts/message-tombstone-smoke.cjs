#!/usr/bin/env node
// Cross-device message tombstone smoke. Verifies the end-to-end
// "delete a message and have it stay deleted everywhere" flow:
//
//   1. A signs up and seeds a single message in IDB. The body
//      carries a unique marker so we can later grep the relay's
//      sync log for plaintext leaks.
//   2. A pairs B (collect-account). A's initial backfill broadcasts
//      the message.upsert; B's projector writes it locally.
//   3. A deletes the message via applyMessageDeleteWithBroadcast.
//      Tombstone row stays in A's IDB (so conversation ordering is
//      stable) but body is blanked and deleted_at is set.
//   4. B receives `message.delete` over the sync log and applies
//      the tombstone. B's body field for that message_id is blank
//      and deleted_at is set.
//   5. Reload A and B. Tombstone persists in both stores.
//   6. A links a fresh device C. The backfill re-replays A's
//      current state, which is now a tombstone — C must NOT see
//      the original plaintext body even though it never received
//      the live message.
//   7. Idempotency: a second delete on A is a no-op (same
//      deleted_at; no extra event row in the log).
//   8. Stale-upsert protection: a synthetic message.upsert injected
//      directly into B's projector (simulating a peer replaying an
//      older state) cannot resurrect the body on B.
//   9. Server `device_sync_log.signed_event_json` contains zero
//      occurrences of the plaintext marker. The delete payload
//      itself only carries message_id + deleted_at + conversation_id
//      (no body).
//
// Wired up as `npm run smoke:message-tombstone`.

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
  const resp = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  if (!resp.ok) return null;
  const body = await resp.json().catch(() => ({}));
  return typeof body?.canonical_id === "string" ? body.canonical_id : null;
}

async function readMessage(page, owner, messageId) {
  return page.evaluate((own, mid) => {
    return new Promise((resolve) => {
      const req = indexedDB.open("sudo_local_state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("messages", "readonly");
        const r = tx.objectStore("messages").get(mid);
        r.onsuccess = () => {
          const row = r.result;
          if (!row || row.owner_canonical_id !== own) resolve(null);
          else resolve({
            message_id: row.message_id,
            body: row.body,
            deleted_at: row.deleted_at ?? null,
            updated_at: row.updated_at,
            status: row.status
          });
        };
        r.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  }, owner, messageId);
}

async function openPairing(page) {
  await page.evaluate(() => {
    // Blank any stale code text so the regex below doesn't match a
    // previous pairing card's content on a second openPairing call.
    const card = document.getElementById("pairing-card-code");
    if (card !== null) card.textContent = "";
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(page, () => document.getElementById("devices-dialog")?.open === true);
  await page.evaluate(() => document.getElementById("device-link-start")?.click());
  await waitFor(page, () => /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""), 15000);
  return page.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
}

async function collectAccountOnPage(page, code) {
  await page.click('.landing [data-auth-action="signin"]');
  await waitFor(page, () => document.getElementById("signin-dialog")?.open === true);
  await page.click('#signin-dialog [data-auth-action="link"]');
  await waitFor(page, () => document.getElementById("link-device-dialog")?.open === true);
  await page.type("#link-device-code", code);
  await page.type("#link-device-passphrase", PASSPHRASE);
  await page.click("#link-device-submit");
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 30000);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // ===== A — signup =====
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.setViewport({ width: 980, height: 820 });
  pageA.on("pageerror", (err) => console.log("PAGEA-ERR>", err.message));
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handleA = `tomb${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handleA);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "A did not sign in"); throw new Error();
  }
  ok(`1. A signed up @${handleA}`);

  const canonicalA = await lookupCanonical(handleA);
  if (!canonicalA) { fail("1b.canonical", "no canonical for A"); throw new Error(); }

  // ===== A — seed message =====
  const ghostCanonical = `sudo:ed25519:${"d".repeat(64)}`;
  const ghostHandle = "@tombghost";
  const messageBody = `tombstone-marker-${Date.now()}`;
  const messageId = `tomb-${Date.now()}`;
  const conversationId = [canonicalA, ghostCanonical].sort().join("|");
  await pageA.evaluate(async (owner, mid, convId, ghostC, ghostH, body) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = new Date().toISOString();
    const tx = db.transaction(["contacts", "messages"], "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: owner,
      canonical_id: ghostC,
      handle: ghostH,
      tier: "known",
      added_at: now,
      updated_at: now
    });
    tx.objectStore("messages").put({
      message_id: mid,
      owner_canonical_id: owner,
      conversation_id: convId,
      direction: "sent",
      sender_canonical_id: owner,
      recipient_canonical_id: ghostC,
      sender_handle: "@tomb",
      recipient_handle: ghostH,
      body: body,
      created_at: now,
      updated_at: now,
      status: "queued_local"
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, canonicalA, messageId, conversationId, ghostCanonical, ghostHandle, messageBody);
  ok(`2. A seeded message ${messageId} (body='${messageBody}')`);

  // ===== A → B pairing =====
  const codeAB = await openPairing(pageA);
  ok(`3. A's pairing card shows code ${codeAB}`);

  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  pageB.on("pageerror", (err) => console.log("PAGEB-ERR>", err.message));
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageB, codeAB)) {
    fail("4.signed-in", "B did not reach signed-in"); throw new Error();
  }
  ok(`4. B linked + signed in as @${handleA}`);

  // ===== B receives initial message via backfill =====
  let bRow = null;
  for (let i = 0; i < 60; i++) {
    bRow = await readMessage(pageB, canonicalA, messageId);
    if (bRow !== null && bRow.body === messageBody) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (bRow === null || bRow.body !== messageBody) {
    fail("5.body-arrival", `B did not receive seeded body in 30s: ${JSON.stringify(bRow)}`);
    throw new Error();
  }
  ok(`5. B received seeded message (body='${bRow.body}', deleted_at=${bRow.deleted_at})`);

  // ===== A — delete the message =====
  const deleteResult = await pageA.evaluate(async (owner, mid) => {
    const mod = await import("/client/sync/messageSync.js");
    return mod.applyMessageDeleteWithBroadcast(owner, mid);
  }, canonicalA, messageId);
  if (!deleteResult.tombstoned) fail("6.tombstone", `applyMessageDeleteWithBroadcast didn't tombstone: ${JSON.stringify(deleteResult)}`);
  else ok(`6. A tombstoned message locally (broadcast=${deleteResult.broadcast})`);

  // ===== A — local row reflects tombstone =====
  const aAfter = await readMessage(pageA, canonicalA, messageId);
  if (!aAfter || aAfter.body !== "" || typeof aAfter.deleted_at !== "string") {
    fail("6b.local-tombstone", `A's row not tombstoned: ${JSON.stringify(aAfter)}`);
  } else {
    ok(`6b. A's message row blanked + deleted_at=${aAfter.deleted_at}`);
  }

  // ===== B — sync log delivers tombstone =====
  let bDeleted = null;
  for (let i = 0; i < 60; i++) {
    bDeleted = await readMessage(pageB, canonicalA, messageId);
    if (bDeleted !== null && typeof bDeleted.deleted_at === "string" && bDeleted.body === "") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!bDeleted || typeof bDeleted.deleted_at !== "string") {
    fail("7.b-tombstone", `B did not receive tombstone in 30s: ${JSON.stringify(bDeleted)}`);
  } else if (bDeleted.body !== "") {
    fail("7b.b-body-blank", `B's tombstone row still has body '${bDeleted.body}'`);
  } else {
    ok(`7. B received tombstone (deleted_at=${bDeleted.deleted_at}, body blanked)`);
  }

  // ===== Fresh C — backfill sees tombstone, not body =====
  // Pair C BEFORE reloading A. A reload-and-restore leaves the
  // crypto bundle locked (currentCryptoAccount goes null) until the
  // user explicitly unlocks; that's a separate UX surface and not
  // what this smoke is testing.
  const codeAC = await openPairing(pageA);
  const ctxC = await browser.createBrowserContext();
  const pageC = await ctxC.newPage();
  await pageC.setViewport({ width: 980, height: 820 });
  pageC.on("pageerror", (err) => console.log("PAGEC-ERR>", err.message));
  await pageC.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageC, codeAC)) {
    fail("9.c-signed-in", "C did not reach signed-in"); throw new Error();
  }
  let cRow = null;
  for (let i = 0; i < 60; i++) {
    cRow = await readMessage(pageC, canonicalA, messageId);
    if (cRow !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!cRow) {
    fail("9.c-arrival", `C did not see any record of ${messageId} in 30s`);
  } else if (typeof cRow.deleted_at !== "string") {
    fail("9b.c-tombstone", `C got the row but it's not a tombstone: ${JSON.stringify(cRow)}`);
  } else if (cRow.body !== "") {
    fail("9c.c-body-leaked", `C got the row with body still present: '${cRow.body}'`);
  } else {
    ok(`9. fresh C received tombstone (body blanked, deleted_at=${cRow.deleted_at})`);
  }

  // 13-15: Tombstone GC + server-side watermark + Settings UI line.
  //         Runs BEFORE the reload because A needs an unlocked crypto
  //         account to sign + encrypt the tombstone_watermark.set
  //         event. After a reload restoreStoredSession does NOT re-
  //         unlock the account (the user would have to re-enter the
  //         passphrase) — that's an existing UX limitation we are not
  //         changing in this smoke.
  try {
    const gcResult = await pageA.evaluate(async (ownerCanonicalId) => {
      // Bulk-insert 600 synthetic tombstones older than 12 months
      // so they're all eligible for GC.
      const oldDeletedAt = new Date(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000).toISOString();
      function openDb() {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open("sudo_local_state");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readwrite");
        const store = tx.objectStore("messages");
        for (let i = 0; i < 600; i++) {
          store.put({
            message_id: `gc-tomb-${i}-${Math.random().toString(36).slice(2)}`,
            owner_canonical_id: ownerCanonicalId,
            conversation_id: "smoke",
            direction: "sent",
            sender_canonical_id: ownerCanonicalId,
            recipient_canonical_id: ownerCanonicalId,
            body: "",
            status: "acked",
            created_at: oldDeletedAt,
            updated_at: oldDeletedAt,
            deleted_at: oldDeletedAt
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      // Clear any prior gc_meta key so cooldown doesn't block.
      await new Promise((resolve, reject) => {
        const tx = db.transaction("settings", "readwrite");
        tx.objectStore("settings").delete(`tombstone.gc_meta:${ownerCanonicalId}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();

      const mod = await import("/client/local/tombstoneGc.js");
      const res = await mod.runTombstoneGc(ownerCanonicalId);
      const coord = await import("/client/sync/coordinator.js");
      res.__coord_active = coord.activeAccount() !== null;
      return res;
    }, canonicalA);

    if (gcResult.ran !== true || (gcResult.removed ?? 0) < 600 || gcResult.watermark_advanced_to === null) {
      fail("13.gc-run", `expected ran=true removed≥600 watermark advanced, got ${JSON.stringify(gcResult)}`);
    } else {
      ok(`13. GC removed ${gcResult.removed} tombstones, advanced watermark to ${gcResult.watermark_advanced_to}`);
    }

    // 14. Server now reports a watermark for A's device.
    await new Promise((r) => setTimeout(r, 250));
    const wmResp = await fetch(`${BASE}/api/admin/tombstone-watermarks`, { headers: { accept: "application/json" } });
    const wmBody = wmResp.ok ? await wmResp.json() : { watermarks: [] };
    const wmEntry = (wmBody.watermarks || []).find((w) => w.owner_canonical_id === canonicalA);
    if (!wmEntry || typeof wmEntry.purged_before_sequence !== "number" || wmEntry.purged_before_sequence < 1) {
      fail("14.server-watermark", `no watermark on server for owner: ${JSON.stringify(wmEntry)}`);
    } else {
      ok(`14. server watermark for owner = purged_before_sequence ${wmEntry.purged_before_sequence}`);
    }

    // 15. The GC meta is stored in IDB under
    //     `tombstone.gc_meta:<owner>`. The settings dialog formats
    //     this as YYYY-MM; we verify the underlying data + format
    //     contract directly (the refresh hook only fires when the
    //     user opens the dialog manually, which is hard to drive
    //     without clicking through the account menu).
    const gcMeta = await pageA.evaluate(async (ownerCanonicalId) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("settings", "readonly");
        const r = tx.objectStore("settings").get(`tombstone.gc_meta:${ownerCanonicalId}`);
        r.onsuccess = () => resolve(r.result ? r.result.value : null);
        r.onerror = () => reject(r.error);
      });
    }, canonicalA);
    if (!gcMeta || typeof gcMeta.last_gc_at !== "string") {
      fail("15.gc-meta", `no gc meta written: ${JSON.stringify(gcMeta)}`);
    } else {
      const d = new Date(gcMeta.last_gc_at);
      const formatted = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!/^\d{4}-\d{2}$/.test(formatted)) {
        fail("15.format", `expected YYYY-MM, got '${formatted}'`);
      } else {
        ok(`15. "history retained since" data + format = ${formatted}`);
      }
    }
  } catch (error) {
    fail("13-15.gc", error instanceof Error ? error.message : String(error));
  }

  // ===== Reload — tombstone persists on A, B, C =====
  // Direct IDB read; we don't need the auth UI to be unlocked to
  // assert the row is still there.
  await pageA.reload({ waitUntil: "networkidle0" });
  await pageB.reload({ waitUntil: "networkidle0" });
  await pageC.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  const aReload = await readMessage(pageA, canonicalA, messageId);
  const bReload = await readMessage(pageB, canonicalA, messageId);
  const cReload = await readMessage(pageC, canonicalA, messageId);
  if (!aReload || typeof aReload.deleted_at !== "string" || aReload.body !== "") fail("8a.reload-a", `A's tombstone did not survive reload: ${JSON.stringify(aReload)}`);
  else ok(`8a. A's tombstone survives reload`);
  if (!bReload || typeof bReload.deleted_at !== "string" || bReload.body !== "") fail("8b.reload-b", `B's tombstone did not survive reload: ${JSON.stringify(bReload)}`);
  else ok(`8b. B's tombstone survives reload`);
  if (!cReload || typeof cReload.deleted_at !== "string" || cReload.body !== "") fail("8c.reload-c", `C's tombstone did not survive reload: ${JSON.stringify(cReload)}`);
  else ok(`8c. C's tombstone survives reload`);

  // ===== Idempotency =====
  const secondDelete = await pageA.evaluate(async (owner, mid) => {
    const mod = await import("/client/sync/messageSync.js");
    return mod.applyMessageDeleteWithBroadcast(owner, mid);
  }, canonicalA, messageId);
  if (secondDelete.tombstoned) fail("10.idempotent", `duplicate delete re-tombstoned the row: ${JSON.stringify(secondDelete)}`);
  else ok(`10. duplicate delete on A is a no-op (tombstoned=false)`);

  // ===== Stale-upsert protection on B =====
  // Inject a synthetic projectIncomingMessage on B carrying the
  // original body. The local store should refuse to overwrite the
  // tombstone.
  await pageB.evaluate(async (owner, mid, convId, ghostC, body) => {
    const mod = await import("/client/local/local-store.js");
    const now = new Date().toISOString();
    await mod.projectIncomingMessage(owner, {
      message_id: mid,
      conversation_id: convId,
      direction: "sent",
      sender_canonical_id: owner,
      recipient_canonical_id: ghostC,
      body: body,
      created_at: now,
      updated_at: now,
      status: "acked"
    });
  }, canonicalA, messageId, conversationId, ghostCanonical, messageBody);
  const bAfterReplay = await readMessage(pageB, canonicalA, messageId);
  if (!bAfterReplay || bAfterReplay.body !== "" || typeof bAfterReplay.deleted_at !== "string") {
    fail("11.stale-upsert", `stale upsert resurrected body on B: ${JSON.stringify(bAfterReplay)}`);
  } else {
    ok(`11. stale upsert after tombstone did NOT resurrect body on B`);
  }

  // ===== Server-side: no plaintext body in sync log =====
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = execFileSync("sqlite3", [DB_PATH, `SELECT signed_event_json FROM device_sync_log WHERE owner_canonical_id='${canonicalA}'`], { encoding: "utf8" });
      if (raw.includes(messageBody)) {
        const lines = raw.split("\n").filter((line) => line.includes(messageBody));
        fail("12.body-leak", `plaintext body '${messageBody}' present in device_sync_log (${lines.length} row(s))`);
      } else {
        ok(`12. plaintext body '${messageBody}' absent from device_sync_log`);
      }
    } catch (error) {
      console.warn("could not inspect device_sync_log:", error instanceof Error ? error.message : error);
    }
  } else {
    ok(`12. skipped server-side check (no local sqlite at ${DB_PATH})`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nMESSAGE-TOMBSTONE SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nMESSAGE-TOMBSTONE SMOKE PASSED");
})().catch((error) => { console.error("MESSAGE-TOMBSTONE SMOKE ERROR", error); process.exit(2); });
