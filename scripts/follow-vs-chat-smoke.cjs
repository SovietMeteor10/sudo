#!/usr/bin/env node
// Pins the follow/chat semantics:
//   1. A follows B from the directory search row → B does NOT appear
//      as a chat target on A's side. B receives a follow notification.
//   2. B follows A back via the notification action → both sides see
//      each other as a chat target after the next notification poll.
//   3. If A unfollows BEFORE B follows back, B's follow-back must NOT
//      promote either side to a chat target (the server's mutual
//      detection is the source of truth and there is no longer a
//      reciprocal subscription).
//   4. Blocking from a follow notification removes the blocker's chat
//      eligibility for the actor.
//
// Drives two browser contexts in one Chrome session.

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
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function signupOn(page, handle) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
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

async function searchAndClickFollow(page, otherHandle) {
  await page.evaluate((h) => {
    const input = document.getElementById("lookup-input");
    if (input) {
      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, otherHandle);
  await page.type("#lookup-input", otherHandle);
  // Wait for the search result row.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ready = await page.evaluate(() => Boolean(document.querySelector(".search-result__add")));
    if (ready) break;
  }
  // Capture the button label *before* the click — the active state
  // shows "follow"/"following"/"following…" depending on whether the
  // viewer already follows this row.
  const beforeLabel = await page.evaluate(() => document.querySelector(".search-result__add")?.textContent?.trim() ?? "");
  await page.click(".search-result__add");
  // Wait for the follow to settle (the button shows "following…" then
  // "following").
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const label = await page.evaluate(() => document.querySelector(".search-result__add")?.textContent?.trim() ?? "");
    if (label === "following") break;
  }
  return beforeLabel;
}

async function chatHandles(page) {
  return page.evaluate(() => {
    const root = document.getElementById("chat-list");
    if (!root) return [];
    return Array.from(root.querySelectorAll("[data-chat-canonical]")).map((row) => row.getAttribute("data-chat-handle") ?? "");
  });
}

async function clickFirstNotificationAction(page, label) {
  // Pull the actor handle from the first notification row so we can
  // assert later. Not all notification rows expose actor in dataset,
  // so we read the lead text.
  const actor = await page.evaluate(() => {
    const row = document.querySelector("#notifications-list .notification-row");
    return row?.querySelector(".notification-row__line")?.textContent ?? "";
  });
  // Click by visible label.
  const clicked = await page.evaluate((wantedLabel) => {
    const buttons = document.querySelectorAll("#notifications-list .notification-row__action");
    for (const button of buttons) {
      if ((button.textContent ?? "").trim().toLowerCase() === wantedLabel) {
        button.click();
        return true;
      }
    }
    return false;
  }, label.toLowerCase());
  return { actor, clicked };
}

async function waitForNotification(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const present = await page.evaluate(() => Boolean(document.querySelector("#notifications-list .notification-row")));
    if (present) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 250));
  }
  return -1;
}

async function waitForChatPartner(page, partnerHandle, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const handles = await chatHandles(page);
    if (handles.includes(partnerHandle)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 250));
  }
  return -1;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);
    const aHandle = `alice${stamp}`;
    const bHandle = `bob${stamp}`;
    const cHandle = `cara${stamp}`;
    const dHandle = `dale${stamp}`;
    const eHandle = `eli${stamp}`;
    const fHandle = `fox${stamp}`;

    // ===== Scenario 1: A follows B → no chat for A =====
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.setViewport({ width: 980, height: 820 });
    await signupOn(pageA, aHandle);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    await signupOn(pageB, bHandle);
    ok(`signed up @${aHandle} and @${bHandle}`);

    const beforeAFollowsB = await searchAndClickFollow(pageA, bHandle);
    if (beforeAFollowsB === "follow") ok(`A's directory row showed 'follow' before click`);
    else fail("button-label-pre", `expected 'follow', got '${beforeAFollowsB}'`);

    const aChatsAfterFollow = await chatHandles(pageA);
    if (!aChatsAfterFollow.some((h) => h.includes(bHandle))) {
      ok(`A has no chat target for @${bHandle} after follow alone`);
    } else {
      fail("follow-creates-chat", `A's chat list contains @${bHandle} after a one-sided follow: ${aChatsAfterFollow.join(", ")}`);
    }

    const bGotNotifMs = await waitForNotification(pageB);
    if (bGotNotifMs >= 0) ok(`B saw the follow notification in ${bGotNotifMs}ms`);
    else fail("follow-notif", `B never saw a follow notification within timeout`);

    // ===== Scenario 2: B follows A back → both sides get a chat =====
    const beforeFollowBack = await clickFirstNotificationAction(pageB, "follow back");
    if (!beforeFollowBack.clicked) fail("follow-back-click", "could not find follow-back button on B's notification");
    if (!beforeFollowBack.actor.includes(aHandle)) {
      fail("follow-back-actor", `B's notification did not name @${aHandle}, got '${beforeFollowBack.actor}'`);
    } else {
      ok(`B clicked follow-back on @${aHandle}'s notification`);
    }

    const bGotChatMs = await waitForChatPartner(pageB, `@${aHandle}`);
    if (bGotChatMs >= 0) ok(`B's chat list now contains @${aHandle} (${bGotChatMs}ms)`);
    else fail("b-chat-missing", `B did not get @${aHandle} in chat after follow-back`);

    const aGotChatMs = await waitForChatPartner(pageA, `@${bHandle}`, 30000);
    if (aGotChatMs >= 0) ok(`A's chat list now contains @${bHandle} (${aGotChatMs}ms; via connection_confirmed)`);
    else fail("a-chat-missing", `A did not get @${bHandle} in chat after server-derived mutual confirmation`);

    // ===== Scenario 3: C follows D, then C unfollows BEFORE D follows back. =====
    const ctxC = await browser.createBrowserContext();
    const pageC = await ctxC.newPage();
    await pageC.setViewport({ width: 980, height: 820 });
    await signupOn(pageC, cHandle);

    const ctxD = await browser.createBrowserContext();
    const pageD = await ctxD.newPage();
    await pageD.setViewport({ width: 980, height: 820 });
    await signupOn(pageD, dHandle);
    ok(`signed up @${cHandle} and @${dHandle}`);

    await searchAndClickFollow(pageC, dHandle);
    const dGotNotif = await waitForNotification(pageD);
    if (dGotNotif < 0) fail("d-follow-notif", `D never saw the follow notification`);

    // C unfollows D from the search row before D acts.
    await searchAndClickFollow(pageC, dHandle); // toggles back to "follow"
    const cChatsAfterUnfollow = await chatHandles(pageC);
    if (!cChatsAfterUnfollow.some((h) => h.includes(dHandle))) {
      ok(`C has no chat target for @${dHandle} after unfollow`);
    } else {
      fail("unfollow-leaves-chat", `C still has @${dHandle} in chat: ${cChatsAfterUnfollow.join(", ")}`);
    }

    // D now clicks follow back. Server should NOT see mutual since C
    // already unfollowed, so connection_confirmed must NOT fire.
    const fb = await clickFirstNotificationAction(pageD, "follow back");
    if (!fb.clicked) {
      // The notification was kept; that's also acceptable as long as
      // no chat unlocks. But we expect the row to still be present
      // since D never confirmed.
      ok(`D's follow-back action absent or notification gone (acceptable)`);
    }

    // Wait one notification poll cycle (~12s default; we accept up to 30s).
    await new Promise((r) => setTimeout(r, 14000));
    const dChats = await chatHandles(pageD);
    const cChats = await chatHandles(pageC);
    if (!dChats.some((h) => h.includes(cHandle)) && !cChats.some((h) => h.includes(dHandle))) {
      ok(`unfollow-before-followback: neither side has a chat target (correct)`);
    } else {
      fail("ghost-chat", `chat appeared after a stale follow-back. C=${cChats.join(",")} D=${dChats.join(",")}`);
    }

    // ===== Scenario 4: E follows F, then F blocks from notification. =====
    const ctxE = await browser.createBrowserContext();
    const pageE = await ctxE.newPage();
    await pageE.setViewport({ width: 980, height: 820 });
    await signupOn(pageE, eHandle);

    const ctxF = await browser.createBrowserContext();
    const pageF = await ctxF.newPage();
    await pageF.setViewport({ width: 980, height: 820 });
    await signupOn(pageF, fHandle);
    ok(`signed up @${eHandle} and @${fHandle}`);

    await searchAndClickFollow(pageE, fHandle);
    const fGotNotif = await waitForNotification(pageF);
    if (fGotNotif < 0) fail("f-follow-notif", `F never saw the follow notification`);

    const blockResult = await clickFirstNotificationAction(pageF, "block");
    if (!blockResult.clicked) fail("block-click", `could not click block on F's notification`);

    // Block on F's side suppresses chat eligibility AND clears the
    // server-side subscription. Since E has not been mutually
    // confirmed, E should not have F in chat either.
    await new Promise((r) => setTimeout(r, 14000));
    const fChats = await chatHandles(pageF);
    const eChats = await chatHandles(pageE);
    if (!fChats.some((h) => h.includes(eHandle))) {
      ok(`F (blocker) has no chat target for @${eHandle}`);
    } else {
      fail("block-keeps-chat", `F still has @${eHandle} in chat after blocking`);
    }
    if (!eChats.some((h) => h.includes(fHandle))) {
      ok(`E (follower) has no chat target for @${fHandle} (no mutual ever happened)`);
    } else {
      fail("block-leaves-chat", `E still has @${fHandle} in chat`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`FOLLOW-VS-CHAT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("FOLLOW-VS-CHAT SMOKE PASSED");
})();
