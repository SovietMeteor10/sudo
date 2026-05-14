#!/usr/bin/env node
// Device sync health surface smoke. Verifies the Settings → Linked
// devices status line transitions through the expected states:
//
//   syncing → synced   (after a successful backfill)
//   sync will retry…    (during a simulated outage)
//   synced              (after a manual retry-sync click)
//   revoked             (after revoking the peer)
//
// Also asserts:
//   - the default surface never leaks relay/internal terminology
//     (ciphertext, indexeddb, ack, relay_message, encrypted_payload,
//     etc.) — those belong only inside the per-row "advanced"
//     disclosure.
//   - the retry-sync button bypasses backoff and successfully drives
//     a failed device back to "synced".
//   - the advanced disclosure carries the technical fields (id,
//     attempts, last_error) when the user opens it.
//
// Wired up as `npm run smoke:device-sync-health`.

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

async function openDevicesDialog(page) {
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(page, () => document.getElementById("devices-dialog")?.open === true);
}

async function closeDialogs(page) {
  await page.evaluate(() => {
    const dev = document.getElementById("devices-dialog");
    if (dev && dev.open) dev.close();
    const set = document.getElementById("settings-dialog");
    if (set && set.open) set.close();
  });
}

async function startPairingFromOpenDialog(page) {
  await page.evaluate(() => {
    const card = document.getElementById("pairing-card-code");
    if (card !== null) card.textContent = "";
    document.getElementById("device-link-start")?.click();
  });
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

async function snapshotDeviceList(page) {
  return page.evaluate(() => {
    const root = document.getElementById("device-list");
    if (root === null) return { text: "", rows: [] };
    const rows = [];
    for (const row of root.querySelectorAll(".device-row")) {
      const nameEl = row.querySelector(".device-row__name");
      const statusEl = row.querySelector(".device-row__status");
      const retryButton = row.querySelector('[data-device-action="retry-sync"]');
      const revokeButton = row.querySelector('[data-device-action="revoke-prompt"]');
      const linkAgainButton = row.querySelector('[data-device-action="link-again"]');
      const confirmPane = row.querySelector(".device-row__confirm");
      const confirmTitle = confirmPane?.querySelector(".device-row__confirm-title");
      const advancedBody = row.querySelector(".device-row__advanced-body");
      rows.push({
        name: nameEl ? (nameEl.textContent ?? "").trim() : "",
        status: statusEl ? (statusEl.getAttribute("data-device-status") ?? "") : "",
        statusLabel: statusEl ? (statusEl.textContent ?? "").trim() : "",
        hasRetry: retryButton !== null,
        revokeLabel: revokeButton ? (revokeButton.textContent ?? "").trim() : "",
        revokeButtonHidden: revokeButton instanceof HTMLElement ? revokeButton.hidden : false,
        linkAgainLabel: linkAgainButton ? (linkAgainButton.textContent ?? "").trim() : "",
        confirmVisible: confirmPane instanceof HTMLElement ? !confirmPane.hidden : false,
        confirmTitle: confirmTitle ? (confirmTitle.textContent ?? "").trim() : "",
        advancedText: advancedBody ? (advancedBody.textContent ?? "").trim() : ""
      });
    }
    return { text: (root.textContent ?? ""), rows };
  });
}

function findPeer(rows) {
  return rows.find((r) => !/\(current\)$/.test(r.name)) ?? null;
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

  // Sync POST blocker — flipped on / off via window.__failSync. Same
  // pattern as backfill-retry-smoke; lets us drive a failed-then-
  // retried run without touching the relay.
  await pageA.evaluate(() => {
    window.__originalFetch = window.fetch.bind(window);
    window.__failSync = false;
    window.__syncFailureCount = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && typeof input.url === "string") ? input.url : String(input);
      const fromInit = init && typeof init.method === "string" ? init.method : null;
      const fromInput = (input && typeof input === "object" && typeof input.method === "string") ? input.method : null;
      const method = (fromInit || fromInput || "GET").toUpperCase();
      const isSyncPost = method === "POST" && /\/api\/devices\/[^/?]+\/sync(?:[?#]|$)/.test(url);
      if (isSyncPost && window.__failSync) {
        window.__syncFailureCount++;
        return new Response(JSON.stringify({ ok: false, error: "simulated_outage" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return window.__originalFetch(input, init);
    };
  });

  const handleA = `health${Date.now().toString().slice(-7)}`;
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

  // ===== A — seed a contact so backfill has something to broadcast =====
  // Without local state, backfill posts 0 events and trivially
  // succeeds even with /sync POST blocked, so the retry-state phase
  // below would never trigger. Seeding a contact gives the loop a
  // real event to fail on.
  await pageA.evaluate(async (owner) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = new Date().toISOString();
    const tx = db.transaction("contacts", "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: owner,
      canonical_id: `sudo:ed25519:${"e".repeat(64)}`,
      handle: "@healthghost",
      tier: "known",
      added_at: now,
      updated_at: now
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, await pageA.evaluate(() => {
    const handle = document.getElementById("account-button-handle")?.textContent?.trim() ?? "";
    return handle; // smoke uses canonical lookup via the well-known endpoint below
  }) || `pending`);
  // Re-seed using the real canonical id once we have it.
  const lookup = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handleA)}`);
  const lookupBody = await lookup.json().catch(() => ({}));
  const canonicalA = typeof lookupBody?.canonical_id === "string" ? lookupBody.canonical_id : null;
  if (!canonicalA) { fail("1b.canonical", "no canonical for A"); throw new Error(); }
  await pageA.evaluate(async (owner) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const now = new Date().toISOString();
    const tx = db.transaction("contacts", "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: owner,
      canonical_id: `sudo:ed25519:${"e".repeat(64)}`,
      handle: "@healthghost",
      tier: "known",
      added_at: now,
      updated_at: now
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, canonicalA);

  // ===== A → B: happy path link =====
  await openDevicesDialog(pageA);
  const codeAB = await startPairingFromOpenDialog(pageA);
  ok(`2. A's pairing card shows code ${codeAB}`);

  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  pageB.on("pageerror", (err) => console.log("PAGEB-ERR>", err.message));
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageB, codeAB)) {
    fail("3.signed-in", "B did not reach signed-in"); throw new Error();
  }
  ok(`3. B linked + signed in as @${handleA}`);

  // ===== A — status should land on "synced" for B =====
  // The pairing card writes the row but rendering may lag by a tick.
  // Poll for up to 15s for the synced label.
  let snap = null;
  let peer = null;
  for (let i = 0; i < 30; i++) {
    snap = await snapshotDeviceList(pageA);
    peer = findPeer(snap.rows);
    if (peer && peer.status === "synced") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!peer) {
    fail("4.peer-row", `no peer row in device list: ${JSON.stringify(snap)}`); throw new Error();
  }
  if (peer.status !== "synced") {
    fail("4.synced", `expected status=synced after happy-path link, got status='${peer.status}' label='${peer.statusLabel}'`);
  } else {
    ok(`4. peer row shows status=synced ('${peer.statusLabel}')`);
  }

  // ===== Default surface free of internal/relay terminology =====
  // The user-visible textContent of #device-list should never leak
  // implementation terms. The "advanced" details element is in the
  // DOM but its body is closed by default — textContent picks it up
  // regardless, so we exclude expanded advanced sections by scrubbing
  // them via the rendered text alone (which contains "advanced" as
  // the summary trigger but nothing past it until the user clicks).
  // To be defensive we still test the visible surface.
  const visible = await pageA.evaluate(() => {
    const root = document.getElementById("device-list");
    if (root === null) return "";
    const clone = root.cloneNode(true);
    // Strip details bodies so closed ones don't contribute to the
    // "visible by default" string.
    for (const det of clone.querySelectorAll(".device-row__advanced-body")) det.remove();
    return (clone.textContent ?? "").toLowerCase();
  });
  const forbidden = ["ciphertext", "indexeddb", "encrypted_payload", "relay_message", "device_sync_log", "origin_device_seq", "signed_event_json"];
  const leaked = forbidden.filter((term) => visible.includes(term));
  if (leaked.length > 0) {
    fail("5.surface-leak", `default device-panel surface leaks internal terms: ${leaked.join(", ")}`);
  } else {
    ok(`5. default surface is free of internal/relay terminology`);
  }

  // ===== Advanced disclosure carries the technical fields =====
  // Poll until the freshly-paired peer's backfill_state row has been
  // written (attempts becomes available). On a brand-new pair the
  // panel can render with status=synced for a brief window before
  // backfillToNewDevice writes its state row; the advanced disclosure
  // is the source of truth for the technical view.
  let advanced = null;
  for (let i = 0; i < 30; i++) {
    await pageA.evaluate(() => {
      for (const det of document.querySelectorAll("#device-list .device-row__advanced")) {
        det.open = true;
      }
    });
    advanced = await pageA.evaluate(() => {
      const peerRow = [...document.querySelectorAll("#device-list .device-row")].find(
        (row) => !/\(current\)$/.test(row.querySelector(".device-row__name")?.textContent?.trim() ?? "")
      );
      if (peerRow === undefined) return null;
      const body = peerRow.querySelector(".device-row__advanced-body");
      return body ? (body.textContent ?? "").trim() : null;
    });
    if (advanced !== null && /backfill attempts:/i.test(advanced)) break;
    await new Promise((r) => setTimeout(r, 500));
    // Re-open the dialog to force a fresh render (closes any stale
    // state from the previous poll iteration).
    await closeDialogs(pageA);
    await openDevicesDialog(pageA);
  }
  if (!advanced || !/^id:/m.test(advanced)) {
    fail("5b.advanced", `advanced disclosure missing 'id:' line; got '${advanced?.slice(0, 120) ?? "null"}'`);
  } else if (!/backfill attempts:/i.test(advanced)) {
    fail("5b.advanced-attempts", `advanced disclosure missing 'backfill attempts:' line; got '${advanced.slice(0, 160)}'`);
  } else if (!/events sent:/i.test(advanced)) {
    fail("5b.advanced-events", `advanced disclosure missing 'events sent:' line; got '${advanced.slice(0, 160)}'`);
  } else {
    ok(`5b. advanced disclosure carries id + attempts + events lines`);
  }
  // Peer-progress lines should land once the live-refresh tick has
  // fetched /sync/peer-progress for the peer. We poll briefly so this
  // assertion is robust to the first-tick race.
  let progressAdvanced = advanced ?? "";
  for (let i = 0; i < 20; i++) {
    if (/inbound behind:/i.test(progressAdvanced) && /progress refreshed:/i.test(progressAdvanced)) break;
    await new Promise((r) => setTimeout(r, 500));
    await pageA.evaluate(() => {
      for (const det of document.querySelectorAll("#device-list .device-row__advanced")) det.open = true;
    });
    progressAdvanced = await pageA.evaluate(() => {
      const peerRow = [...document.querySelectorAll("#device-list .device-row")].find(
        (row) => !/\(current\)$/.test(row.querySelector(".device-row__name")?.textContent?.trim() ?? "")
      );
      if (peerRow === undefined) return "";
      const body = peerRow.querySelector(".device-row__advanced-body");
      return body ? (body.textContent ?? "").trim() : "";
    });
  }
  if (!/inbound behind:/i.test(progressAdvanced) || !/progress refreshed:/i.test(progressAdvanced)) {
    fail("5c.peer-progress-lines", `advanced disclosure missing peer-progress lines after 10s; got '${progressAdvanced.slice(0, 240)}'`);
  } else {
    ok(`5c. advanced disclosure carries peer-progress lines (inbound behind, progress refreshed)`);
  }

  // ===== Trigger a failed backfill via the fetch patch =====
  // We re-pair (link a fresh C) with /sync POST blocked, so the
  // backfill records a pending row. Status should flip to a retry
  // label. Then unblock + click retry → synced.
  await closeDialogs(pageA);
  await pageA.evaluate(() => { window.__failSync = true; });
  await openDevicesDialog(pageA);
  const codeAC = await startPairingFromOpenDialog(pageA);
  ok(`6. A's pairing card (under failure) shows code ${codeAC}`);

  const ctxC = await browser.createBrowserContext();
  const pageC = await ctxC.newPage();
  await pageC.setViewport({ width: 980, height: 820 });
  pageC.on("pageerror", (err) => console.log("PAGEC-ERR>", err.message));
  await pageC.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageC, codeAC)) {
    fail("6b.c-signed-in", "C did not reach signed-in"); throw new Error();
  }

  // Wait for the failed backfill to record its state (~6s for the
  // pairing-completion poll to fire + backfill to give up).
  await new Promise((r) => setTimeout(r, 6000));
  // Re-open Settings on A so we see the latest panel render.
  await closeDialogs(pageA);
  await openDevicesDialog(pageA);
  let failedSnap = null;
  let failedPeer = null;
  for (let i = 0; i < 30; i++) {
    failedSnap = await snapshotDeviceList(pageA);
    failedPeer = failedSnap.rows.find((r) => r.status === "retry_pending" || r.status === "failed");
    if (failedPeer) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!failedPeer) {
    fail("7.retry-state", `no row reached retry_pending/failed: ${JSON.stringify(failedSnap)}`);
  } else {
    if (!failedPeer.hasRetry) fail("7b.retry-button", `expected retry button on row with status=${failedPeer.status}`);
    else if (failedPeer.statusLabel !== "sync will retry soon" && failedPeer.statusLabel !== "sync paused — retry available") {
      fail("7c.retry-copy", `expected calm retry copy, got '${failedPeer.statusLabel}'`);
    } else ok(`7. row with simulated outage shows status='${failedPeer.statusLabel}' + retry button`);
  }

  // ===== Unblock fetch + click retry =====
  await pageA.evaluate(() => { window.__failSync = false; });
  if (failedPeer) {
    await pageA.evaluate((statusKey) => {
      const root = document.getElementById("device-list");
      if (root === null) return;
      const target = [...root.querySelectorAll(".device-row")].find(
        (row) => row.querySelector(".device-row__status")?.getAttribute("data-device-status") === statusKey
      );
      target?.querySelector('[data-device-action="retry-sync"]')?.click();
    }, failedPeer.status);
    // Wait for status to flip to synced on any row that had been
    // retry_pending/failed.
    let recovered = false;
    for (let i = 0; i < 40; i++) {
      const s = await snapshotDeviceList(pageA);
      if (s.rows.every((r) => r.status !== "retry_pending" && r.status !== "failed")) {
        recovered = s.rows.some((r) => r.status === "synced");
        if (recovered) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!recovered) {
      const after = await snapshotDeviceList(pageA);
      fail("8.retry-recovered", `manual retry did not return any row to synced: ${JSON.stringify(after.rows.map((r) => ({ name: r.name, status: r.status })))}`);
    } else {
      ok(`8. manual retry click drove the failed row back to synced`);
    }
  }

  // ===== Live refresh while dialog stays open =====
  // Externally mutate backfill_state for a peer (simulate the
  // coordinator marking a row "running" mid-session). The 5s
  // interval should pick up the change and flip the status to
  // "retrying sync…" without the user re-opening the dialog.
  const peerRowsForLive = await snapshotDeviceList(pageA);
  const livePeer = peerRowsForLive.rows.find((r) => r.status === "synced");
  if (!livePeer) {
    fail("9a.live-peer-missing", "no synced peer to drive live-refresh test");
  } else {
    // Read the row's data-device-id from DOM.
    const livePeerId = await pageA.evaluate((name) => {
      const root = document.getElementById("device-list");
      if (root === null) return null;
      const row = [...root.querySelectorAll(".device-row")].find(
        (r) => (r.querySelector(".device-row__name")?.textContent ?? "").trim() === name
      );
      return row instanceof HTMLElement ? (row.dataset.deviceId ?? null) : null;
    }, livePeer.name);
    if (!livePeerId) {
      fail("9a.live-peer-id", `couldn't read data-device-id for '${livePeer.name}'`);
    } else {
      // Write a backfill_state row with status=running and attempts=2
      // so the helper picks "retrying sync…" copy.
      await pageA.evaluate(async (owner, deviceId) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("sudo_local_state");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const tx = db.transaction("backfill_state", "readwrite");
        const existing = await new Promise((resolve) => {
          const r = tx.objectStore("backfill_state").get([owner, deviceId]);
          r.onsuccess = () => resolve(r.result ?? null);
          r.onerror = () => resolve(null);
        });
        const row = existing ?? { owner_canonical_id: owner, target_device_id: deviceId };
        row.status = "running";
        row.attempts = 2;
        row.last_attempt_at = new Date().toISOString();
        tx.objectStore("backfill_state").put(row);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      }, canonicalA, livePeerId);
      // Wait up to 8s (one full 5s interval + render slack) for the
      // panel to flip without any user action.
      let flipped = null;
      for (let i = 0; i < 16; i++) {
        const s = await snapshotDeviceList(pageA);
        const r = s.rows.find((row) => row.name === livePeer.name);
        if (r && r.status === "syncing") { flipped = r; break; }
        await new Promise((rr) => setTimeout(rr, 500));
      }
      if (!flipped) {
        const after = await snapshotDeviceList(pageA);
        fail("9a.live-refresh", `panel did not auto-refresh to syncing status: ${JSON.stringify(after.rows.find((r) => r.name === livePeer.name))}`);
      } else if (flipped.statusLabel !== "retrying sync…") {
        fail("9a.live-copy", `expected 'retrying sync…' label, got '${flipped.statusLabel}'`);
      } else {
        ok(`9a. dialog auto-refreshed status to '${flipped.statusLabel}' without close/reopen`);
      }
      // Restore the row so subsequent phases see a clean state.
      await pageA.evaluate(async (owner, deviceId) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("sudo_local_state");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const tx = db.transaction("backfill_state", "readwrite");
        const existing = await new Promise((resolve) => {
          const r = tx.objectStore("backfill_state").get([owner, deviceId]);
          r.onsuccess = () => resolve(r.result ?? null);
          r.onerror = () => resolve(null);
        });
        if (existing) {
          existing.status = "complete";
          tx.objectStore("backfill_state").put(existing);
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      }, canonicalA, livePeerId);
    }
  }

  // ===== Open/close twice should not produce duplicate rows or
  // stale timers. The visible symptom of a stacked timer is wrong
  // row count (the live-refresh callback writing on top of itself
  // mid-render), so the strongest probe is "after open + close +
  // open, do we still see the expected single set of rows AND does
  // live refresh still work?"
  await closeDialogs(pageA);
  await new Promise((r) => setTimeout(r, 250));
  await openDevicesDialog(pageA);
  await new Promise((r) => setTimeout(r, 250));
  const reopenSnap = await snapshotDeviceList(pageA);
  // Row count expectations: 1 current + N peers. We pair B and C in
  // this smoke, so we expect exactly 3 rows.
  if (reopenSnap.rows.length !== 3) {
    fail("9b.duplicate-rows", `expected 3 rows after open/close/open, got ${reopenSnap.rows.length}: ${JSON.stringify(reopenSnap.rows.map((r) => r.name))}`);
  } else {
    ok(`9b. open/close/open produced exactly 3 rows (no duplicates)`);
  }

  // ===== Attempt history caps at 5 =====
  // Seed 5 synthetic attempt_history entries on a peer row; trigger
  // a real backfill via retry; verify oldest synthetic is dropped
  // and the new attempt is appended at the end.
  const histPeer = peerRowsForLive.rows.find((r) => r.status === "synced");
  const histPeerId = histPeer ? await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return null;
    const row = [...root.querySelectorAll(".device-row")].find(
      (r) => (r.querySelector(".device-row__name")?.textContent ?? "").trim() === name
    );
    return row instanceof HTMLElement ? (row.dataset.deviceId ?? null) : null;
  }, histPeer.name) : null;
  if (!histPeerId) {
    fail("9c.history-peer", "no peer to drive ring buffer test");
  } else {
    const oldestMarker = "OLDEST-DROPPED";
    await pageA.evaluate(async (owner, deviceId, marker) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("sudo_local_state");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction("backfill_state", "readwrite");
      const existing = await new Promise((resolve) => {
        const r = tx.objectStore("backfill_state").get([owner, deviceId]);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => resolve(null);
      });
      const row = existing ?? { owner_canonical_id: owner, target_device_id: deviceId, status: "complete", attempts: 1, last_attempt_at: new Date().toISOString() };
      const now = Date.now();
      row.attempt_history = [
        { at: new Date(now - 60_000).toISOString(), ok: false, error: marker },
        { at: new Date(now - 50_000).toISOString(), ok: false, error: "fake-2" },
        { at: new Date(now - 40_000).toISOString(), ok: true, total_events: 3 },
        { at: new Date(now - 30_000).toISOString(), ok: false, error: "fake-4" },
        { at: new Date(now - 20_000).toISOString(), ok: true, total_events: 7 }
      ];
      tx.objectStore("backfill_state").put(row);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }, canonicalA, histPeerId, oldestMarker);
    // Force a new backfill attempt (clicks retry on the row).
    await pageA.evaluate((name) => {
      const root = document.getElementById("device-list");
      if (root === null) return;
      const row = [...root.querySelectorAll(".device-row")].find(
        (r) => (r.querySelector(".device-row__name")?.textContent ?? "").trim() === name
      );
      // The retry button isn't visible on a synced row. So we
      // dispatch the backfill directly: open the row's advanced
      // disclosure and check the rendered history list after a
      // refresh. Then we drive a real attempt via the underlying
      // function bound on window.
    }, histPeer.name);
    // Trigger backfill via dynamic import (cleanest path; same
    // approach used by message-tombstone smoke).
    await pageA.evaluate(async (owner, deviceId) => {
      // backfillToNewDevice isn't exported; instead reach into the
      // pairing-completion code path by calling the dialog's retry
      // helper indirectly. We force a re-render then rely on the
      // existing retry-on-pending behavior: write status=pending so
      // the auto-retry's normal entry-points qualify.
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("sudo_local_state");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      // Mark the row as failed (attempts < max) so the retry button
      // appears, then click it.
      const tx = db.transaction("backfill_state", "readwrite");
      const existing = await new Promise((resolve) => {
        const r = tx.objectStore("backfill_state").get([owner, deviceId]);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => resolve(null);
      });
      if (existing) {
        existing.status = "pending";
        existing.last_attempt_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        tx.objectStore("backfill_state").put(existing);
      }
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }, canonicalA, histPeerId);
    // Wait for live-refresh to surface the pending row + retry button.
    let retryClicked = false;
    for (let i = 0; i < 16; i++) {
      const clickedNow = await pageA.evaluate((name) => {
        const root = document.getElementById("device-list");
        if (root === null) return false;
        const row = [...root.querySelectorAll(".device-row")].find(
          (r) => (r.querySelector(".device-row__name")?.textContent ?? "").trim() === name
        );
        const btn = row?.querySelector('[data-device-action="retry-sync"]');
        if (btn instanceof HTMLElement) { btn.click(); return true; }
        return false;
      }, histPeer.name);
      if (clickedNow) { retryClicked = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!retryClicked) fail("9c.retry-click", "could not find retry button to drive ring-buffer test");
    // Wait for the new backfill to land in attempt_history.
    let finalHistory = null;
    for (let i = 0; i < 20; i++) {
      finalHistory = await pageA.evaluate(async (owner, deviceId) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("sudo_local_state");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const tx = db.transaction("backfill_state", "readonly");
        const r = tx.objectStore("backfill_state").get([owner, deviceId]);
        return await new Promise((res) => {
          r.onsuccess = () => res(r.result?.attempt_history ?? null);
          r.onerror = () => res(null);
        });
      }, canonicalA, histPeerId);
      if (Array.isArray(finalHistory) && finalHistory.length === 5 && !finalHistory.some((e) => e.error === oldestMarker)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!Array.isArray(finalHistory)) {
      fail("9c.history-readback", "could not read attempt_history after retry");
    } else if (finalHistory.length !== 5) {
      fail("9c.history-cap", `ring buffer not capped at 5; got ${finalHistory.length} entries`);
    } else if (finalHistory.some((e) => e.error === oldestMarker)) {
      fail("9c.history-rotate", `oldest synthetic entry was not dropped; got ${JSON.stringify(finalHistory)}`);
    } else {
      ok(`9c. ring buffer capped at 5; oldest dropped after new attempt`);
    }
  }

  // ===== Two-step revoke: first click opens confirm pane, doesn't revoke =====
  const beforeRevoke = await snapshotDeviceList(pageA);
  const revocable = beforeRevoke.rows.find((r) => r.status === "synced" && r.revokeLabel === "revoke");
  if (!revocable) {
    fail("9d.revoke-target", `no synced peer to revoke: ${JSON.stringify(beforeRevoke.rows)}`);
    throw new Error();
  }
  await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => (row.querySelector(".device-row__name")?.textContent?.trim() ?? "") === name
    );
    target?.querySelector('[data-device-action="revoke-prompt"]')?.click();
  }, revocable.name);
  const afterPrompt = await snapshotDeviceList(pageA);
  const promptRow = afterPrompt.rows.find((r) => r.name === revocable.name);
  if (!promptRow) {
    fail("9d.row-missing", "row disappeared after revoke-prompt click");
  } else if (promptRow.status === "revoked") {
    fail("9d.first-click-revoked", "first click revoked the device without confirmation");
  } else if (!promptRow.confirmVisible) {
    fail("9d.confirm-missing", `confirm pane did not open: ${JSON.stringify(promptRow)}`);
  } else if (!promptRow.confirmTitle.includes(revocable.name)) {
    fail("9d.confirm-name", `confirm title doesn't name the target: '${promptRow.confirmTitle}'`);
  } else {
    ok(`9d. first click opens confirm pane ('${promptRow.confirmTitle}') without revoking`);
  }

  // ===== Cancel preserves active state =====
  await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => (row.querySelector(".device-row__name")?.textContent?.trim() ?? "") === name
    );
    target?.querySelector('[data-device-action="revoke-cancel"]')?.click();
  }, revocable.name);
  const afterCancel = await snapshotDeviceList(pageA);
  const cancelRow = afterCancel.rows.find((r) => r.name === revocable.name);
  if (!cancelRow || cancelRow.status !== "synced" || cancelRow.confirmVisible) {
    fail("9e.cancel", `cancel did not restore active state: ${JSON.stringify(cancelRow)}`);
  } else {
    ok(`9e. cancel restored the row to synced, confirm pane hidden`);
  }

  // ===== Confirm revoke commits =====
  await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => (row.querySelector(".device-row__name")?.textContent?.trim() ?? "") === name
    );
    target?.querySelector('[data-device-action="revoke-prompt"]')?.click();
  }, revocable.name);
  await new Promise((r) => setTimeout(r, 100));
  await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => (row.querySelector(".device-row__name")?.textContent?.trim() ?? "") === name
    );
    target?.querySelector('[data-device-action="revoke-confirm"]')?.click();
  }, revocable.name);
  let revokedRow = null;
  for (let i = 0; i < 30; i++) {
    const s = await snapshotDeviceList(pageA);
    revokedRow = s.rows.find((r) => r.name === revocable.name && r.status === "revoked");
    if (revokedRow) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!revokedRow) {
    const after = await snapshotDeviceList(pageA);
    fail("9f.revoke-confirm", `peer never flipped to revoked: ${JSON.stringify(after.rows)}`);
    throw new Error();
  }
  ok(`9f. revoke-confirm flipped row to revoked ('${revokedRow.statusLabel}')`);
  if (!revokedRow.linkAgainLabel) {
    fail("9g.link-again-button", "revoked row missing 'link again' button");
  } else {
    ok(`9g. revoked row exposes '${revokedRow.linkAgainLabel}' action`);
  }

  // ===== Server enforces revoke: revoked device sees 403 on /sync GET =====
  // Server's resolveActiveMembership gate returns 403 for any
  // /sync read against a revoked device_id. We grab the device_id
  // from the row whose status is now "revoked" — name alone is
  // ambiguous because both peer rows render as "This device" and
  // after the new three-section layout the revoked row lives in a
  // separate section than the still-active peer.
  const revokedDeviceId = await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return null;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => {
        const rowName = row.querySelector(".device-row__name")?.textContent?.trim() ?? "";
        const status = row.querySelector(".device-row__status")?.getAttribute("data-device-status") ?? "";
        return rowName === name && status === "revoked";
      }
    );
    return target instanceof HTMLElement ? (target.dataset.deviceId ?? null) : null;
  }, revocable.name);
  if (revokedDeviceId) {
    // Phase 14 HIGH-6: unauth direct fetch is 401 missing_signature
    // before the route's revoked-device 403 check fires. The
    // "revoked device → 403" gate is exercised end-to-end by the
    // sync slice smokes (contact/subscription/message-sync) which
    // sign as the revoked device.
    const resp = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync?device_id=${encodeURIComponent(revokedDeviceId)}&since=0&limit=1`, {
      headers: { accept: "application/json" }
    });
    if (resp.status !== 401) {
      fail("9h.server-401", `unauth direct /sync GET expected 401 missing_signature, got ${resp.status}`);
    } else {
      ok(`9h. unauth /sync GET returns 401 missing_signature (sig gate)`);
    }
  }

  // ===== Link again → fresh active membership at higher sequence =====
  // Click the "link again" button. That generates a new temporary
  // passcode (using the same startPairingFlow code path). A fresh
  // browser context completes collect-account; the server stores a
  // new device row + active membership at sequence > the revoked
  // membership's sequence.
  // Find the revoked row specifically (status=revoked), since name
  // alone is ambiguous with other "This device" rows.
  await pageA.evaluate((name) => {
    const root = document.getElementById("device-list");
    if (root === null) return;
    const target = [...root.querySelectorAll(".device-row")].find(
      (row) => {
        const rowName = row.querySelector(".device-row__name")?.textContent?.trim() ?? "";
        const status = row.querySelector(".device-row__status")?.getAttribute("data-device-status") ?? "";
        return rowName === name && status === "revoked";
      }
    );
    // The revoked section is wrapped in <details>; ensure it's open
    // so a future scroll/visual check would see the row, then click.
    const details = target?.closest("details");
    if (details instanceof HTMLDetailsElement) details.open = true;
    target?.querySelector('[data-device-action="link-again"]')?.click();
  }, revocable.name);
  await waitFor(pageA, () => /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""), 15000);
  const relinkCode = await pageA.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
  ok(`9i. 'link again' generated fresh pairing code ${relinkCode}`);
  // Record membership state before the relink so we can confirm a
  // NEW active device appears. Collect-account on a fresh browser
  // mints a fresh device_id; the revoked membership stays revoked
  // and a new active membership lands for the new device. The
  // important invariant is: the relinked device is recognized as
  // active and can sync, the revoked one stays cryptographically
  // gated. We capture the set of active device_ids before, then
  // assert it grew (and the new one is NOT the previously-revoked id).
  const membershipsBefore = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`, {
    headers: { accept: "application/json" }
  }).then((r) => r.json()).then((j) => j?.memberships ?? []).catch(() => []);
  const activeBefore = new Set(membershipsBefore.filter((m) => m.trust_state === "active").map((m) => m.device_id));
  const ctxE = await browser.createBrowserContext();
  const pageE = await ctxE.newPage();
  await pageE.setViewport({ width: 980, height: 820 });
  pageE.on("pageerror", (err) => console.log("PAGEE-ERR>", err.message));
  await pageE.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageE, relinkCode)) {
    fail("9j.relink-signed-in", "relinked browser did not reach signed-in");
  } else {
    ok(`9j. relinked browser completed collect-account`);
  }
  // Verify a new active membership appears, the previously-revoked
  // device_id is still revoked, and the new device is not the
  // revoked one.
  let newActive = null;
  for (let i = 0; i < 30; i++) {
    const json = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`, {
      headers: { accept: "application/json" }
    }).then((r) => r.json()).catch(() => null);
    const memberships = json?.memberships ?? [];
    newActive = memberships.find((m) => m.trust_state === "active" && !activeBefore.has(m.device_id));
    if (newActive) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!newActive) {
    fail("9k.new-membership", `no new active membership after relink (active before: ${[...activeBefore].length})`);
  } else if (revokedDeviceId !== null && newActive.device_id === revokedDeviceId) {
    fail("9k.same-device", `relink silently restored revoked device_id ${revokedDeviceId}`);
  } else {
    ok(`9k. new active membership posted for fresh device_id=${newActive.device_id.slice(0, 8)} (revoked id ${revokedDeviceId?.slice(0, 8)} still revoked)`);
  }
  // And the revoked one must still be revoked on the server.
  if (revokedDeviceId !== null) {
    const json = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`, {
      headers: { accept: "application/json" }
    }).then((r) => r.json()).catch(() => null);
    const memberships = json?.memberships ?? [];
    const revokedAfter = memberships.find((m) => m.device_id === revokedDeviceId && m.trust_state === "revoked");
    if (!revokedAfter) {
      fail("9l.revoked-still-revoked", "previously-revoked device's revoked membership is gone");
    } else {
      ok(`9l. relink did not un-revoke the original device (still revoked at seq=${revokedAfter.sequence})`);
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nDEVICE-SYNC-HEALTH SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nDEVICE-SYNC-HEALTH SMOKE PASSED");
})().catch((error) => { console.error("DEVICE-SYNC-HEALTH SMOKE ERROR", error); process.exit(2); });
