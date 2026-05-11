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
      const revokeButton = row.querySelector('[data-device-action="revoke"]');
      const advancedBody = row.querySelector(".device-row__advanced-body");
      rows.push({
        name: nameEl ? (nameEl.textContent ?? "").trim() : "",
        status: statusEl ? (statusEl.getAttribute("data-device-status") ?? "") : "",
        statusLabel: statusEl ? (statusEl.textContent ?? "").trim() : "",
        hasRetry: retryButton !== null,
        revokeLabel: revokeButton ? (revokeButton.textContent ?? "").trim() : "",
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
    else ok(`7. row with simulated outage shows status='${failedPeer.statusLabel}' + retry button`);
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

  // ===== Revoke a peer and confirm status flips =====
  // Revoke whichever peer row currently shows as synced (B, since C
  // just recovered). The revoke button is on every non-current row.
  const beforeRevoke = await snapshotDeviceList(pageA);
  const revocable = beforeRevoke.rows.find((r) => r.status === "synced" && r.revokeLabel === "revoke");
  if (!revocable) {
    fail("9.revoke-target", `no synced peer to revoke: ${JSON.stringify(beforeRevoke.rows)}`);
  } else {
    await pageA.evaluate((name) => {
      const root = document.getElementById("device-list");
      if (root === null) return;
      const target = [...root.querySelectorAll(".device-row")].find(
        (row) => (row.querySelector(".device-row__name")?.textContent?.trim() ?? "") === name
      );
      target?.querySelector('[data-device-action="revoke"]')?.click();
    }, revocable.name);
    let revoked = null;
    for (let i = 0; i < 30; i++) {
      const s = await snapshotDeviceList(pageA);
      revoked = s.rows.find((r) => r.name === revocable.name && r.status === "revoked");
      if (revoked) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!revoked) {
      const after = await snapshotDeviceList(pageA);
      fail("9.revoke", `peer never flipped to revoked status: ${JSON.stringify(after.rows)}`);
    } else {
      ok(`9. revoked peer row shows status=revoked ('${revoked.statusLabel}')`);
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
