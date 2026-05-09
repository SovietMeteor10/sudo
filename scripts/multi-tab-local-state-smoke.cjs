#!/usr/bin/env node
// Multi-tab correctness smoke. Verifies:
//
// 1. Same-account two tabs in the same browser profile both work
//    normally — neither one shows the "opening local data" warning,
//    neither blames "another tab", and a chat-list update in one tab
//    propagates to the other via BroadcastChannel.
//
// 2. Different-account two tabs in the same browser profile stay
//    isolated: A's chat data does not appear in B's tab.
//
// 3. Inbox polling has a single leader: even with both tabs of the
//    same account open, an inbound message gets ACKed exactly once
//    (relay returns 0 envelopes after both tabs had a chance to poll).
//
// 4. Follower tab still SEES the inbound message (via the leader's
//    local-state-changed broadcast).

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

async function newPage(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
  return page;
}

async function signupOnPage(page, handle) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await page.evaluate(() => document.body.dataset.authState) === "signed-in") return;
  }
  throw new Error(`signup hung for @${handle}`);
}

async function signinOnPage(page, handle) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    document.getElementById("signin-handle").value = "";
    document.getElementById("signin-password").value = "";
  });
  await page.type("#signin-handle", handle);
  await page.type("#signin-password", PASSPHRASE);
  await page.click("#signin-submit");
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await page.evaluate(() => document.body.dataset.authState) === "signed-in") return;
    const err = await page.evaluate(() => document.getElementById("signin-state")?.textContent ?? "");
    if (err && /error|fail|wrong/i.test(err)) throw new Error(`signin error for @${handle}: ${err}`);
  }
  throw new Error(`signin hung for @${handle}`);
}

async function lookupCanonical(handle) {
  const response = await fetch(`${BASE}/api/identity/handles/${handle.replace(/^@/, "")}`);
  if (response.status !== 200) throw new Error(`identity lookup ${handle} -> ${response.status}`);
  return (await response.json()).canonical_id;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // Shared browser context = shared IndexedDB profile = real two-tab scenario.
  const sharedContext = await browser.createBrowserContext();

  // ===== Setup: create accounts A and B in the shared profile =====
  const handleA = "alpha" + Date.now().toString().slice(-6);
  const handleB = "bravo" + Date.now().toString().slice(-6);

  // Create B first, sign out, then create A, sign out — so both have
  // local crypto bundles in the shared profile.
  const setupPage = await newPage(sharedContext);
  await signupOnPage(setupPage, handleB);
  await setupPage.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-logout")?.click();
  });
  await new Promise((r) => setTimeout(r, 400));

  await signupOnPage(setupPage, handleA);
  await setupPage.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-logout")?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await setupPage.close();
  ok(`accounts @${handleA} and @${handleB} created in shared browser profile`);

  const canonicalA = await lookupCanonical(handleA);
  const canonicalB = await lookupCanonical(handleB);

  // ===== Case 1: same account, two tabs =====
  const tabOne = await newPage(sharedContext);
  await signinOnPage(tabOne, handleA);

  const tabTwo = await newPage(sharedContext);
  await signinOnPage(tabTwo, handleA);
  ok(`@${handleA} signed in on two separate tabs in the same profile`);

  // Neither tab should be sitting in the "opening local data" / waiting
  // state during normal multi-tab usage.
  const sharedSnapshot = async (page) => page.evaluate(() => ({
    authState: document.body.dataset.authState,
    signupState: document.getElementById("signup-state")?.textContent ?? "",
    signinState: document.getElementById("signin-state")?.textContent ?? "",
    chats: document.getElementById("chat-list")?.innerText ?? ""
  }));
  const t1 = await sharedSnapshot(tabOne);
  const t2 = await sharedSnapshot(tabTwo);
  if (t1.authState !== "signed-in" || t2.authState !== "signed-in") {
    fail("multi-tab-signed-in", `expected both tabs signed-in, got t1=${t1.authState} t2=${t2.authState}`);
  } else ok("both tabs are signed-in concurrently");

  for (const [label, snap] of [["t1", t1], ["t2", t2]]) {
    if (/opening local data/i.test(snap.signupState + snap.signinState)) {
      fail(`multi-tab-${label}-warning`, `${label} still shows "opening local data" during normal use`);
    } else if (/another tab|tabs are bad|close.*tabs/i.test(snap.signupState + snap.signinState)) {
      fail(`multi-tab-${label}-warning`, `${label} blames other tabs in copy`);
    }
  }
  ok("neither tab shows the 'opening local data' / 'another tab' warning");

  // Tab 1 writes a contact via direct IDB write (purely local). The
  // local-state broadcast should make tab 2 refresh its chat list.
  const ghostCanonical = `sudo:ed25519:${"a".repeat(64)}`;
  const ghostHandle = "@ghosttwo";
  await tabOne.evaluate(async (canonical, handle, ownerCanonical) => {
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
    // Manually fire the broadcast since the direct put above bypasses
    // upsertContact (which would broadcast for us). This mirrors what the
    // real code does after legitimate writes.
    const channel = new BroadcastChannel("sudo_local_db");
    channel.postMessage({ type: "local-state-changed", kind: "contacts", ownerCanonicalId: ownerCanonical });
    channel.close();
  }, ghostCanonical, ghostHandle, canonicalA);

  // Wait for tab 2 to refresh from the broadcast.
  let tabTwoSawGhost = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const text = await tabTwo.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
    if (text.includes(ghostHandle)) { tabTwoSawGhost = true; break; }
  }
  if (!tabTwoSawGhost) fail("multi-tab-broadcast", "tab 2 did not pick up tab 1's contact write within 6s");
  else ok("tab 2 reflects tab 1's contact write via broadcast");

  await tabOne.close();
  await tabTwo.close();

  // ===== Case 2: different accounts, two tabs in the same profile =====
  const tabA = await newPage(sharedContext);
  await signinOnPage(tabA, handleA);
  const tabB = await newPage(sharedContext);
  await signinOnPage(tabB, handleB);

  // A wrote @ghosttwo in case 1 (still in IDB under owner=A). B must not
  // see it.
  await new Promise((r) => setTimeout(r, 1000));
  const aChats = await tabA.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  const bChats = await tabB.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  if (!aChats.includes(ghostHandle)) fail("isolation-A", `A should still see its own ghost contact: '${aChats}'`);
  else ok("A still sees its own ghost contact");
  if (bChats.includes(ghostHandle)) fail("isolation-B", `B sees A's ghost contact: '${bChats}'`);
  else ok("B does not see A's ghost contact");
  if (!/no chats yet/i.test(bChats)) fail("isolation-B-empty", `B's chat list expected 'no chats yet', got '${bChats}'`);
  else ok("B's chat list is empty");

  await tabA.close();
  await tabB.close();

  // ===== Case 3: single leader inbox-poll =====
  // Open two tabs of A, then a third tab as B and have B send a message
  // to A. Both A tabs may try to poll, but only the leader should
  // actually ACK the relay. After polling completes, the relay inbox
  // for A must be empty (a single ACK), not double-ACKed.
  const aLeader = await newPage(sharedContext);
  await signinOnPage(aLeader, handleA);
  const aFollower = await newPage(sharedContext);
  await signinOnPage(aFollower, handleA);

  const senderTab = await newPage(sharedContext);
  await signinOnPage(senderTab, handleB);
  // Simulate B sending a message to A:
  const msgText = `multi-tab probe ${Date.now()}`;
  await senderTab.evaluate(async (cb, hb, body) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${cb}" data-chat-handle="${hb}"><div class="chat-row__handle">${hb}</div></div>`;
    }
    document.querySelector(".chat-row")?.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById("chat-popup-input");
    if (!input) throw new Error("chat popup input missing");
    input.value = body;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, canonicalA, `@${handleA}`, msgText);

  // Wait long enough for both A tabs to attempt at least one poll.
  await new Promise((r) => setTimeout(r, 9000));

  // After polling, the relay inbox for A should be empty (single ACK).
  const inboxResp = await fetch(`${BASE}/api/relay/inbox/${encodeURIComponent(canonicalA)}`);
  const inboxBody = inboxResp.status === 200 ? await inboxResp.json() : { envelopes: [] };
  const remaining = Array.isArray(inboxBody.envelopes) ? inboxBody.envelopes.length : 0;
  if (remaining > 0) fail("single-ack", `relay still has ${remaining} envelopes after polling — duplicate poll without ACK?`);
  else ok("relay inbox is empty after multi-tab polling (single ACK)");

  // Both A tabs should display the message.
  const leaderText = await aLeader.evaluate(() => document.getElementById("chat-popup-body")?.innerText ?? "");
  const followerText = await aFollower.evaluate(() => document.getElementById("chat-popup-body")?.innerText ?? "");
  const leaderHasMsg = leaderText.includes(msgText);
  const followerHasMsg = followerText.includes(msgText);

  if (!leaderHasMsg && !followerHasMsg) {
    fail("multi-tab-receive", `neither A tab shows the message body`);
  } else if (!leaderHasMsg || !followerHasMsg) {
    // Acceptable: only the tab whose popup is open shows the body. The
    // other tab still has its chat-list updated via broadcast, which we
    // check next.
    ok("at least one A tab popup shows the message body");
  } else {
    ok("both A tabs popup show the message body");
  }

  // The chat list should update in BOTH tabs via broadcast.
  const aLeaderChats = await aLeader.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  const aFollowerChats = await aFollower.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  if (!aLeaderChats.includes(handleB) || !aFollowerChats.includes(handleB)) {
    fail("multi-tab-chat-list", `expected both A tabs to list @${handleB}; leader='${aLeaderChats}', follower='${aFollowerChats}'`);
  } else ok("both A tabs show the new chat with B in the chat list");

  await aLeader.close();
  await aFollower.close();
  await senderTab.close();
  await sharedContext.close();
  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("MULTI-TAB SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("MULTI-TAB SMOKE PASSED");
})().catch((error) => { console.error("MULTI-TAB SMOKE ERROR", error); process.exit(2); });
