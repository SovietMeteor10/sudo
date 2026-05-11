#!/usr/bin/env node
// Backfill retry-state smoke. When the first attempt at
// backfillToNewDevice fails (network blip, rate limit, transient
// server error), the originator must:
//
//   - persist a backfill_state IDB row with status="pending",
//     attempts=1, and last_error;
//   - NOT block the user (pairing card still flips to "device linked
//     — sync will retry on next signin");
//   - resume the work later (on next signin, or when Settings opens)
//     and converge the new device.
//
// Phases:
//   1. A signs up and seeds a contact + bio in IDB.
//   2. A installs a window.fetch monkey-patch that makes all
//      POSTs to /api/devices/<owner>/sync return 503 (simulated
//      outage). The patch is gated on window.__failSync.
//   3. A opens pairing. B links.
//   4. A's pairing card eventually settles to a "device linked"
//      state. We assert the backfill_state row for B's device_id
//      is status="pending" with attempts >= 1 and a last_error
//      mentioning a sync failure.
//   5. B's IDB does NOT have A's contact yet (the events never made
//      it past the 503).
//   6. A drops the fetch patch. We open Settings on A, which calls
//      retryPendingBackfills. After the retry succeeds, the
//      backfill_state row flips to status="complete" and B's IDB
//      receives the seeded state.
//
// Wired up as `npm run smoke:backfill-retry`.

const path = require("node:path");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

async function readBackfillState(page, ownerCanonicalId) {
  return page.evaluate((owner) => {
    return new Promise((resolve) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("backfill_state")) { resolve([]); return; }
        const tx = db.transaction("backfill_state", "readonly");
        const store = tx.objectStore("backfill_state");
        const idx = store.index("by_owner");
        const req = idx.getAll(owner);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      };
      r.onerror = () => resolve([]);
    });
  }, ownerCanonicalId);
}

async function readBSnapshot(page) {
  return page.evaluate(() => {
    return new Promise((resolve) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => {
        const db = r.result;
        const read = (store) => new Promise((res) => {
          const tx = db.transaction(store, "readonly");
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => res([]);
        });
        read("contacts").then((contacts) => resolve({
          contacts: contacts.length,
          handles: contacts.map((c) => c.handle)
        }));
      };
      r.onerror = () => resolve(null);
    });
  });
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
  pageA.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === "warning" || type === "error" || /\[sync\]|\[backfill\]|\[devices\]|FETCHPATCH/i.test(text)) {
      console.log("PAGEA>", type, text);
    }
  });
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });

  // Install the fetch failure patch BEFORE signup so it's in place
  // by the time the backfill fires from the pairing-completion poll.
  // Returns 503 with a JSON body shaped like the server's rate-limit
  // response so the client treats it as a transient failure.
  await pageA.evaluate(() => {
    window.__originalFetch = window.fetch.bind(window);
    window.__failSync = true;
    window.__syncFailureCount = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && typeof input.url === "string") ? input.url : String(input);
      const fromInit = init && typeof init.method === "string" ? init.method : null;
      const fromInput = (input && typeof input === "object" && typeof input.method === "string") ? input.method : null;
      const method = (fromInit || fromInput || "GET").toUpperCase();
      const isSyncPost = method === "POST" && /\/api\/devices\/[^/?]+\/sync(?:[?#]|$)/.test(url);
      if (isSyncPost) {
        if (window.__failSync) {
          window.__syncFailureCount++;
          console.warn("FETCHPATCH blocking sync POST", url);
          return new Response(JSON.stringify({ ok: false, error: "simulated_outage" }), {
            status: 503,
            headers: { "content-type": "application/json" }
          });
        }
        console.warn("FETCHPATCH passing sync POST", url);
      }
      return window.__originalFetch(input, init);
    };
  });

  const handleA = `retry${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handleA);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "A did not sign in"); throw new Error();
  }
  ok(`1. A signed up @${handleA} (with /sync POST blocked)`);

  const canonicalA = await lookupCanonical(handleA);
  if (!canonicalA) { fail("1b.canonical", "no canonical for A"); throw new Error(); }

  // ===== A — seed contact + bio so there's something to backfill =====
  const ghostCanonical = `sudo:ed25519:${"f".repeat(64)}`;
  const ghostHandle = `@retryghost${Date.now().toString().slice(-5)}`;
  const bioMarker = `bio-retry-${Date.now()}`;
  await pageA.evaluate(async (owner, ghostC, ghostH, bio) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = new Date().toISOString();
    const tx = db.transaction(["contacts", "settings"], "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: owner,
      canonical_id: ghostC,
      handle: ghostH,
      tier: "connection",
      added_at: now,
      updated_at: now
    });
    tx.objectStore("settings").put({ key: `profile.bio.${owner}`, value: bio, updated_at: now });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, canonicalA, ghostCanonical, ghostHandle, bioMarker);
  ok(`2. A seeded contact + bio`);

  // ===== A — open pairing =====
  await pageA.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(pageA, () => document.getElementById("settings-dialog")?.open === true);
  await pageA.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(pageA, () => document.getElementById("devices-dialog")?.open === true);
  await pageA.evaluate(() => document.getElementById("device-link-start")?.click());
  await waitFor(pageA, () => /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""), 10000);
  const pairingCode = await pageA.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
  ok(`3. A's pairing card shows code ${pairingCode}`);

  // ===== B — link =====
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  await pageB.click('.landing [data-auth-action="signin"]');
  await waitFor(pageB, () => document.getElementById("signin-dialog")?.open === true);
  await pageB.click('#signin-dialog [data-auth-action="link"]');
  await waitFor(pageB, () => document.getElementById("link-device-dialog")?.open === true);
  await pageB.type("#link-device-code", pairingCode);
  await pageB.type("#link-device-passphrase", PASSPHRASE);
  await pageB.click("#link-device-submit");
  if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 30000)) {
    fail("4.signed-in", "B did not reach signed-in"); throw new Error();
  }
  ok(`4. B linked + signed in as @${handleA}`);

  // ===== A — wait for the (failing) backfill to settle =====
  // Pairing card still announces device-linked even on partial sync,
  // just with copy that flags the user to expect a retry. Give the
  // backfillToNewDevice promise time to write its final pending state.
  await new Promise((r) => setTimeout(r, 6000));
  const cardText = await pageA.evaluate(() => document.getElementById("pairing-card-success")?.textContent ?? "");
  if (!/device linked/i.test(cardText)) {
    fail("5.card", `pairing card did not advance past 'syncing': '${cardText}'`);
  } else {
    ok(`5. pairing card reports linked even with sync blocked ('${cardText}')`);
  }

  // ===== A — verify backfill_state is pending with attempts>=1 =====
  let rows = await readBackfillState(pageA, canonicalA);
  if (rows.length === 0) {
    fail("6.state-row", "no backfill_state row written");
  } else {
    const row = rows[0];
    if (row.status !== "pending") fail("6.status", `expected status=pending after blocked attempt, got '${row.status}'`);
    else ok(`6. backfill_state row written: status=pending, attempts=${row.attempts}, last_error='${(row.last_error || "").slice(0, 60)}'`);
    if (!row.attempts || row.attempts < 1) fail("6b.attempts", `expected attempts>=1, got ${row.attempts}`);
    else ok(`6b. attempts counter advanced (${row.attempts})`);
    if (typeof row.last_error !== "string" || row.last_error.length === 0) fail("6c.last-error", "expected last_error to be populated");
    else ok(`6c. last_error captured`);
  }

  // ===== B — verify nothing arrived during the blocked window =====
  const failureCount = await pageA.evaluate(() => window.__syncFailureCount || 0);
  if (failureCount === 0) fail("7.outage", "fetch patch never fired — backfill never tried to POST");
  else ok(`7. /sync POST blocked ${failureCount} time(s) by simulated outage`);
  const bDuringBlock = await readBSnapshot(pageB);
  if (bDuringBlock && bDuringBlock.contacts > 0) {
    fail("7b.no-arrival", `B should have 0 contacts while /sync is blocked, got ${bDuringBlock.contacts}`);
  } else {
    ok(`7b. B has 0 contacts during the blocked window (expected)`);
  }

  // ===== A — drop the patch and trigger retry via Settings =====
  await pageA.evaluate(() => { window.__failSync = false; });
  // Close the existing Settings dialog (if open) and re-open to fire
  // retryPendingBackfills cleanly. The card's "close" handler in
  // device-pairing UI lives outside the settings dialog, so just
  // toggle the dialog.
  await pageA.evaluate(() => {
    const dlg = document.getElementById("settings-dialog");
    if (dlg && dlg.open) dlg.close();
  });
  await new Promise((r) => setTimeout(r, 150));
  await pageA.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(pageA, () => document.getElementById("settings-dialog")?.open === true);
  ok(`8. A's Settings re-opened — retry triggered`);

  // ===== Wait for retry to converge =====
  // The backoff is 30s for the first retry, but the retry runs only
  // when (now - last_attempt_at) >= backoff. The blocked attempt
  // wrote last_attempt_at ~6s ago, so the first reopen-of-settings
  // may be a no-op. Poll backfill_state for status flipping to
  // "complete"; if it stays pending past 35s, fail.
  let finalRow = null;
  for (let i = 0; i < 80; i++) {
    const r = await readBackfillState(pageA, canonicalA);
    if (r.length > 0 && r[0].status === "complete") { finalRow = r[0]; break; }
    // Re-trigger retry by closing+reopening settings every 5s — in
    // real use the user would re-open it themselves; this hurries
    // the smoke without bypassing the production code path.
    if (i % 10 === 9) {
      await pageA.evaluate(() => {
        const dlg = document.getElementById("settings-dialog");
        if (dlg && dlg.open) dlg.close();
      });
      await new Promise((r) => setTimeout(r, 150));
      await pageA.evaluate(() => {
        document.getElementById("account-button")?.click();
        document.getElementById("account-menu-settings")?.click();
      });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (finalRow === null) {
    const last = await readBackfillState(pageA, canonicalA);
    fail("9.complete", `backfill_state never reached status=complete: ${JSON.stringify(last)}`);
  } else {
    if (finalRow.attempts < 2) fail("9b.attempts", `expected attempts>=2 after retry, got ${finalRow.attempts}`);
    else ok(`9. backfill_state flipped to status=complete after ${finalRow.attempts} attempts (total_events=${finalRow.total_events ?? "n/a"})`);
  }

  // ===== B — confirm seeded state finally arrived =====
  let bFinal = null;
  for (let i = 0; i < 30; i++) {
    bFinal = await readBSnapshot(pageB);
    if (bFinal && bFinal.contacts >= 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!bFinal || bFinal.contacts < 1) {
    fail("10.arrival", `B did not receive contact after retry: ${JSON.stringify(bFinal)}`);
  } else if (!bFinal.handles.includes(ghostHandle)) {
    fail("10.handle", `B received contacts but not '${ghostHandle}': ${JSON.stringify(bFinal.handles)}`);
  } else {
    ok(`10. B received contact '${ghostHandle}' after retry`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nBACKFILL-RETRY SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nBACKFILL-RETRY SMOKE PASSED");
})().catch((error) => { console.error("BACKFILL-RETRY SMOKE ERROR", error); process.exit(2); });
