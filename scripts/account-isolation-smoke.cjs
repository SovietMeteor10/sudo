#!/usr/bin/env node
// Account-isolation smoke. In a single browser profile, create accounts A
// and B, give A some PURELY-LOCAL state (a contact A adds via directory),
// sign out, sign in as B, and assert B can not see A's local-only data.
// Then flip back to A and assert A still owns its state. Backup taken from
// A must be stamped with owner=A and must not contain B's data in the
// envelope metadata.
//
// We deliberately test PURELY-LOCAL state (not relay-delivered messages),
// because messages A sends to B through the relay are legitimately
// received by B's poller and are NOT a privacy leak. The owner-scoped IDB
// queries are also asserted directly.
//
// Assumes:
// - the local server is up and BASE_URL points at it
// - puppeteer-core + a Chrome binary are reachable (see docs/SMOKE.md)

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const passes = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { passes.push(label); console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function signupOnPage(page, handle) {
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = await page.evaluate(() => document.body.dataset.authState);
    if (a === "signed-in") return;
  }
  throw new Error(`signup hung for @${handle}`);
}

async function signinOnPage(page, handle) {
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const h = document.getElementById("signin-handle");
    const p = document.getElementById("signin-password");
    if (h instanceof HTMLInputElement) h.value = "";
    if (p instanceof HTMLInputElement) p.value = "";
  });
  await page.type("#signin-handle", handle);
  await page.type("#signin-password", PASSPHRASE);
  await page.click("#signin-submit");
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = await page.evaluate(() => document.body.dataset.authState);
    if (a === "signed-in") return;
    const err = await page.evaluate(() => document.getElementById("signin-state")?.textContent ?? "");
    if (err && /error|fail|not found|wrong/i.test(err)) throw new Error(`signin error for @${handle}: ${err}`);
  }
  throw new Error(`signin hung for @${handle}`);
}

async function signoutOnPage(page) {
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-logout")?.click();
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = await page.evaluate(() => document.body.dataset.authState);
    if (a !== "signed-in") return;
  }
  throw new Error("signout did not return to landing");
}

async function lookupCanonical(handle) {
  const response = await fetch(`${BASE}/api/identity/handles/${handle.replace(/^@/, "")}`);
  if (response.status !== 200) throw new Error(`identity lookup ${handle} -> ${response.status}`);
  return (await response.json()).canonical_id;
}

// Force the chat list to repaint from current account state. refreshLocalChats
// is called inside setSignedIn but it's fired-and-forgotten, so we wait for
// the DOM to actually settle before asserting.
async function waitForChatListSettle(page, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await page.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
    if (text.length > 0) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await page.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // One persistent browser context simulates the same browser profile being
  // used by two different sudo accounts back-to-back.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  const handleA = "alpha" + Date.now().toString().slice(-6);
  const handleB = "bravo" + Date.now().toString().slice(-6);

  // Both accounts must live in the same browser profile so they each have a
  // locally-stored crypto bundle to sign in with. Create B first, sign B
  // out, then create A on top so A is the active account.
  await signupOnPage(page, handleB);
  ok(`account B created: @${handleB} on this browser profile`);
  await signoutOnPage(page);

  await signupOnPage(page, handleA);
  ok(`account A created: @${handleA} on this browser profile`);

  const canonicalA = await lookupCanonical(handleA);
  const canonicalB = await lookupCanonical(handleB);

  // ----- A creates PURELY-LOCAL state on this browser profile -----
  // We use a fabricated "ghost" canonical id that has nothing to do with B
  // and never goes through the relay. This contact is local-only state
  // owned by A. If account isolation is correct, B will never see it.
  const ghostCanonical = `sudo:ed25519:${"a".repeat(64)}`;
  const ghostHandle = "@ghostcontact";
  await page.evaluate(async (canonical, handle, ownerCanonical) => {
    const dbReq = indexedDB.open("sudo_local_state");
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    const tx = db.transaction("contacts", "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: ownerCanonical,
      canonical_id: canonical,
      handle,
      tier: "known",
      added_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  }, ghostCanonical, ghostHandle, canonicalA);
  ok(`A wrote a local-only ghost contact (@${ghostHandle.replace(/^@/, "")})`);

  // ----- Sign A out -----
  await signoutOnPage(page);
  ok("A signed out");

  // After signout the rendered chat list and stream must be empty
  const afterSignout = await page.evaluate(() => ({
    chats: document.getElementById("chat-list")?.innerText ?? "",
    popupHidden: document.getElementById("chat-popup")?.hidden ?? true
  }));
  if (!/no chats yet/.test(afterSignout.chats.toLowerCase())) fail("post-signout-chats", `chats not cleared: '${afterSignout.chats}'`);
  else ok("after signout: chat list cleared");
  if (!afterSignout.popupHidden) fail("post-signout-popup", "chat popup still visible after signout");
  else ok("after signout: chat popup hidden");

  // ----- Sign in as B in the SAME browser profile -----
  await signinOnPage(page, handleB);
  // refreshLocalChats is fire-and-forget inside setSignedIn; wait for the
  // DOM to settle before asserting.
  await new Promise((r) => setTimeout(r, 1500));
  ok(`signed in as @${handleB} in A's browser profile`);

  // Critical privacy check: B must NOT see A's ghost contact.
  const bChatList = await page.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  if (bChatList.includes(ghostHandle)) fail("B-leak-chat", `B sees A's local-only contact in chat list: '${bChatList}'`);
  else ok(`B does not see A's local-only ghost contact`);
  if (!/no chats yet/.test(bChatList.toLowerCase())) fail("B-chat-empty", `B's chat list expected 'no chats yet', got '${bChatList}'`);
  else ok("B's chat list correctly shows 'no chats yet'");

  // Inspect IDB through B's lens — owner-scoped queries should never return
  // any rows belonging to A's canonical id.
  const idbByOwnerB = await page.evaluate(async (ownerB, ownerA) => {
    const dbReq = indexedDB.open("sudo_local_state");
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    const byOwner = (store, indexName, owner) => new Promise((res, rej) => {
      const req = db.transaction(store, "readonly").objectStore(store).index(indexName).getAll(owner);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return {
      bMessages: await byOwner("messages", "by_owner", ownerB),
      bContacts: await byOwner("contacts", "by_owner", ownerB),
      bPending: await byOwner("pending_outbound", "by_owner", ownerB),
      aMessages: await byOwner("messages", "by_owner", ownerA),
      aContacts: await byOwner("contacts", "by_owner", ownerA)
    };
  }, canonicalB, canonicalA);

  for (const m of idbByOwnerB.bMessages) {
    if (m.owner_canonical_id !== canonicalB) fail("B-owner-stamp", `non-B message visible to B's by_owner: ${JSON.stringify(m)}`);
  }
  for (const c of idbByOwnerB.bContacts) {
    if (c.owner_canonical_id !== canonicalB) fail("B-contact-stamp", `non-B contact visible to B's by_owner: ${JSON.stringify(c)}`);
  }
  // A's data must still exist in IDB (we never wiped it) — and must be
  // accessible only via A's by_owner key.
  if (!idbByOwnerB.aContacts.some((c) => c.canonical_id === ghostCanonical)) {
    fail("A-contact-persisted", "A's ghost contact is missing from A's by_owner index after B signed in");
  } else ok("A's ghost contact is still present under A's by_owner key");
  ok(`B by_owner queries are clean (${idbByOwnerB.bMessages.length}m / ${idbByOwnerB.bContacts.length}c / ${idbByOwnerB.bPending.length}o)`);

  // ----- B creates a contact of its own (purely local) -----
  const bGhostCanonical = `sudo:ed25519:${"b".repeat(64)}`;
  const bGhostHandle = "@bghost";
  await page.evaluate(async (canonical, handle, ownerCanonical) => {
    const dbReq = indexedDB.open("sudo_local_state");
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    const tx = db.transaction("contacts", "readwrite");
    tx.objectStore("contacts").put({
      owner_canonical_id: ownerCanonical,
      canonical_id: canonical,
      handle,
      tier: "known",
      added_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  }, bGhostCanonical, bGhostHandle, canonicalB);

  // ----- Backup B and assert it's stamped owner=B and does NOT mention A -----
  const bBackupText = await page.evaluate((p) => new Promise((resolve) => {
    window.prompt = () => p;
    const origCreate = URL.createObjectURL.bind(URL);
    let captured = null;
    URL.createObjectURL = (blob) => {
      const reader = new FileReader();
      reader.onload = () => { captured = reader.result; };
      reader.readAsText(blob);
      return origCreate(blob);
    };
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
    setTimeout(() => document.getElementById("settings-backup")?.click(), 100);
    const start = Date.now();
    const tick = () => {
      if (captured !== null) { resolve(captured); return; }
      if (Date.now() - start > 8000) { resolve(""); return; }
      setTimeout(tick, 100);
    };
    tick();
  }), PASSPHRASE);
  if (!bBackupText) fail("B-backup", "could not capture B's backup blob");
  else {
    let bBackup;
    try { bBackup = JSON.parse(bBackupText); } catch (e) { fail("B-backup", `invalid JSON: ${e.message}`); }
    if (bBackup) {
      if (bBackup.owner_canonical_id !== canonicalB) fail("B-backup-owner", `backup owner is '${bBackup.owner_canonical_id}', expected B '${canonicalB}'`);
      else ok(`B backup is stamped owner=${canonicalB}`);
      const envelopeJson = JSON.stringify(bBackup);
      if (envelopeJson.includes(handleA) || envelopeJson.includes(canonicalA) || envelopeJson.includes(ghostHandle)) {
        fail("B-backup-leak", `B backup envelope mentions A's identifiers (handleA/canonicalA/ghostHandle)`);
      } else ok("B backup envelope does not mention A's handle, canonical id, or ghost contact");
    }
  }

  // ----- Sign back into A and confirm A still owns its state -----
  await signoutOnPage(page);
  await signinOnPage(page, handleA);
  await new Promise((r) => setTimeout(r, 1500));
  ok(`signed back in as @${handleA}`);
  const aChatList = await waitForChatListSettle(page);
  if (!aChatList.includes(ghostHandle)) fail("A-return-ghost", `A returning does not see its own ghost contact: '${aChatList}'`);
  else ok(`A returning still sees its own ghost contact (${ghostHandle})`);
  if (aChatList.includes(bGhostHandle)) fail("A-return-leak", `A returning sees B's local-only contact: '${aChatList}'`);
  else ok(`A does not see B's local-only contact`);

  await context.close();
  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("ACCOUNT ISOLATION SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("ACCOUNT ISOLATION SMOKE PASSED");
})().catch((error) => { console.error("ACCOUNT ISOLATION SMOKE ERROR", error); process.exit(2); });
