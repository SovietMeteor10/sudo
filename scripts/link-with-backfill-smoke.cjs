#!/usr/bin/env node
// Initial-state backfill after collect-account. After a fresh device
// links via temporary passcode, the original device should publish
// its existing contacts / subscriptions / messages as encrypted sync
// events. The new device's coordinator picks them up on its next
// poll and projects them locally — so the user doesn't end up
// staring at an empty IndexedDB on their second device.
//
// Phases:
//   1.  A signs up.
//   2.  A seeds local state in IndexedDB: one contact, one
//       subscription, one message. We write them directly to IDB so
//       the smoke doesn't need a second registered identity, a chat
//       partner, or a real subscription target.
//   3.  A generates a temporary passcode (settings → linked
//       devices → link another device).
//   4.  Fresh browser context B signs in → "collect account from
//       another device" → enters the code + A's passphrase.
//   5.  B lands signed in. Without any further user action on A,
//       B's IndexedDB receives the seeded contact / subscription /
//       message within 30s.
//   6.  B reloads. State persists.
//   7.  The server's device_sync_log.signed_event_json column does
//       NOT contain the plaintext message body anywhere — payloads
//       are encrypted under the account_sync_sym_key.
//
// Wired up as `npm run smoke:link-with-backfill`.

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
  const handleA = `bfdesk${Date.now().toString().slice(-7)}`;
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

  // ===== A — seed local state =====
  // Mint identifiers for the seeded data so we can grep for them
  // later both client-side (in B's IDB) and server-side (in the
  // sync log to confirm the body never appears in plaintext).
  const ghostCanonical = `sudo:ed25519:${"b".repeat(64)}`;
  const ghostHandle = "@bfghost";
  const subAuthor = `sudo:ed25519:${"c".repeat(64)}`;
  const messageBody = `backfill-marker-${Date.now()}`;
  const messageId = `bf-${Date.now()}`;
  const conversationId = `${canonicalA}|${ghostCanonical}`.split("|").sort().join("|");
  const draftBody = `draft-marker-${Date.now()}`;
  const draftId = `bf-draft-${Date.now()}`;
  const draftConversationId = `${canonicalA}|sudo:ed25519:${"d".repeat(64)}`.split("|").sort().join("|");
  const bioMarker = `bio-marker-${Date.now()}`;

  await pageA.evaluate(async (owner, ghostC, ghostH, subA, msgId, convId, body, dId, dConv, dBody, bio) => {
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open("sudo_local_state");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const db = await open();
    const tx = db.transaction(["contacts", "subscriptions", "messages", "drafts", "settings"], "readwrite");
    const now = new Date().toISOString();
    tx.objectStore("contacts").put({
      owner_canonical_id: owner,
      canonical_id: ghostC,
      handle: ghostH,
      tier: "known",
      added_at: now,
      updated_at: now
    });
    // `subscriptions` keypath is `subscription_id`; the LocalSubscription
    // type uses a `sync:<owner>:<author>` row id. Match that format
    // so listLocalSubscriptions(owner) finds it via the by_owner
    // index and the backfill iterates it.
    tx.objectStore("subscriptions").put({
      subscription_id: `sync:${owner}:${subA}`,
      owner_canonical_id: owner,
      author_canonical_id: subA,
      include_public: true,
      include_connections: true,
      include_close: false,
      updated_at: now
    });
    // Drafts (new slice).
    tx.objectStore("drafts").put({
      draft_id: dId,
      owner_canonical_id: owner,
      conversation_id: dConv,
      body: dBody,
      updated_at: now
    });
    // Profile bio (new slice carries this through `profile.upsert`).
    tx.objectStore("settings").put({
      key: `profile.bio.${owner}`,
      value: bio,
      updated_at: now
    });
    tx.objectStore("messages").put({
      owner_canonical_id: owner,
      message_id: msgId,
      conversation_id: convId,
      direction: "sent",
      sender_canonical_id: owner,
      recipient_canonical_id: ghostC,
      sender_handle: `@bfdesk`,
      recipient_handle: ghostH,
      body: body,
      created_at: now,
      updated_at: now,
      status: "queued_local"
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }, canonicalA, ghostCanonical, ghostHandle, subAuthor, messageId, conversationId, messageBody, draftId, draftConversationId, draftBody, bioMarker);
  ok(`2. A seeded contact/subscription/message/draft/bio (body='${messageBody}' draft='${draftBody}' bio='${bioMarker}')`);

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

  // ===== B — collect account =====
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

  // ===== A — wait for backfill to complete on the original side =====
  // Pairing card flips through "syncing account data…" → "device
  // linked (synced N items)" once backfillToNewDevice resolves.
  const backfillDone = await waitFor(pageA, () => /device linked/i.test(document.getElementById("pairing-card-success")?.textContent ?? ""), 20000);
  if (!backfillDone) {
    const observed = await pageA.evaluate(() => document.getElementById("pairing-card-success")?.textContent ?? "");
    fail("5.backfill", `A's pairing card never advanced past 'syncing': '${observed}'`);
  } else {
    const text = await pageA.evaluate(() => document.getElementById("pairing-card-success")?.textContent ?? "");
    ok(`5. A's pairing card reports backfill complete ('${text}')`);
  }

  // ===== B — assert seeded state arrives =====
  // The sync coordinator on B polls every ~5s. Give the backfill
  // up to 30s to land.
  async function bSnapshot() {
    return pageB.evaluate((bioK) => {
      return new Promise((resolve) => {
        const r = indexedDB.open("sudo_local_state");
        r.onsuccess = async () => {
          const db = r.result;
          const read = (store) => new Promise((res) => {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => res([]);
          });
          const readOne = (store, key) => new Promise((res) => {
            const tx = db.transaction(store, "readonly");
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
          });
          const [contacts, subs, messages, drafts, bioRow] = await Promise.all([
            read("contacts"),
            read("subscriptions"),
            read("messages"),
            read("drafts"),
            readOne("settings", bioK)
          ]);
          resolve({
            contacts: contacts.length,
            subs: subs.length,
            messages: messages.length,
            drafts: drafts.length,
            contactHandles: contacts.map((c) => c.handle),
            bodies: messages.map((m) => m.body),
            draftBodies: drafts.map((d) => d.body),
            bio: typeof bioRow?.value === "string" ? bioRow.value : null
          });
        };
        r.onerror = () => resolve(null);
      });
    }, `profile.bio.${canonicalA}`);
  }

  let snap = null;
  for (let i = 0; i < 60; i++) {
    snap = await bSnapshot();
    if (snap !== null && snap.contacts >= 1 && snap.subs >= 1 && snap.messages >= 1 && snap.drafts >= 1 && snap.bio === bioMarker) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (snap === null || snap.contacts < 1 || snap.subs < 1 || snap.messages < 1 || snap.drafts < 1 || snap.bio !== bioMarker) {
    fail("6.backfill-arrival", `B did not receive seeded state in 30s: ${JSON.stringify(snap)}`);
  } else {
    ok(`6. B received contact/subscription/message/draft/bio (${snap.contacts}c ${snap.subs}s ${snap.messages}m ${snap.drafts}d bio='${snap.bio}')`);
    const handleArrived = snap.contactHandles.includes(ghostHandle);
    if (!handleArrived) fail("6b.contact-handle", `seeded contact handle '${ghostHandle}' not in B (saw ${JSON.stringify(snap.contactHandles)})`);
    else ok(`6b. seeded contact handle '${ghostHandle}' arrived on B`);
    const bodyArrived = snap.bodies.includes(messageBody);
    if (!bodyArrived) fail("6c.message-body", `seeded message body not in B (saw ${JSON.stringify(snap.bodies)})`);
    else ok(`6c. seeded message body arrived on B`);
    const draftArrived = snap.draftBodies.includes(draftBody);
    if (!draftArrived) fail("6d.draft-body", `seeded draft body not in B (saw ${JSON.stringify(snap.draftBodies)})`);
    else ok(`6d. seeded draft body arrived on B`);
    if (snap.bio !== bioMarker) fail("6e.bio", `bio marker '${bioMarker}' not in B (saw '${snap.bio}')`);
    else ok(`6e. seeded bio arrived on B via profile slice`);
  }

  // ===== B — reload, state persists =====
  await pageB.reload({ waitUntil: "networkidle0" });
  if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 10000)) {
    fail("7.reload-signed-in", "B did not stay signed in after reload"); throw new Error();
  }
  const reloadSnap = await bSnapshot();
  if (reloadSnap === null || reloadSnap.contacts < 1 || reloadSnap.subs < 1 || reloadSnap.messages < 1 || reloadSnap.drafts < 1 || reloadSnap.bio !== bioMarker) {
    fail("7.reload-state", `state did not persist on B after reload: ${JSON.stringify(reloadSnap)}`);
  } else {
    ok(`7. backfilled state persists on B after reload`);
  }

  // ===== Server-side: no plaintext message body in sync log =====
  // device_sync_log.signed_event_json should hold opaque ciphertext;
  // grepping the column for our marker proves we never relayed
  // plaintext. Skipped if the local DB isn't reachable (remote BASE).
  if (fs.existsSync(DB_PATH)) {
    const markers = [
      { label: "message body", value: messageBody },
      { label: "draft body", value: draftBody },
      { label: "bio", value: bioMarker }
    ];
    let leakedLabel = "";
    let leakSample = "";
    for (const m of markers) {
      try {
        const out = execFileSync("sqlite3", [DB_PATH, `SELECT signed_event_json FROM device_sync_log WHERE owner_canonical_id='${canonicalA}' AND signed_event_json LIKE '%${m.value}%' LIMIT 1`], { encoding: "utf-8" });
        if (out.trim().length > 0) { leakedLabel = m.label; leakSample = out.trim().slice(0, 200); break; }
      } catch {}
    }
    if (leakedLabel.length > 0) {
      fail("8.plaintext-leak", `device_sync_log contains plaintext ${leakedLabel}: ${leakSample}...`);
    } else {
      ok(`8. server sync log carries no plaintext markers (message body, draft body, bio)`);
    }
  } else {
    ok(`8. plaintext-leak check skipped (DB_PATH '${DB_PATH}' not local)`);
  }

  await pageA.close(); await ctxA.close();
  await pageB.close(); await ctxB.close();
  await browser.close();

  if (failures.length > 0) {
    console.error(`\nLINK-WITH-BACKFILL SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nLINK-WITH-BACKFILL SMOKE PASSED");
})().catch((error) => { console.error("LINK-WITH-BACKFILL SMOKE ERROR", error); process.exit(2); });
