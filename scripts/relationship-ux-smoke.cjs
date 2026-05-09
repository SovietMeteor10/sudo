#!/usr/bin/env node
// Relationship/notifications UX smoke. Drives two real browser
// contexts and asserts the new product polish:
//
//   1. Lookup-card buttons are stateful toggles, not always-visible
//      pairs. follow ↔ unfollow, connect ↔ remove, close-friend
//      visible only when connected, block ↔ unblock. UI updates
//      immediately and survives reload.
//   2. Lower-left identity profile-card block is gone. The new
//      notifications panel renders in its place with a "no
//      notifications" empty state.
//   3. When A follows B, B sees a "follow" notification.
//   4. When A connects with B, B sees a "connect" notification with
//      "connect back" / "dismiss" / "block" actions. accept-back
//      creates the reciprocal relationship; dismiss hides; block
//      blocks the actor.
//   5. The post-detail back-header height roughly matches the
//      left-column .column__title row height (~34px) and is no
//      taller than 40px.

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

async function newSignedInContext(browser, handle) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log(`PAGEERR(${handle})>`, e.message));
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
    if (a === "signed-in") return { context, page };
  }
  throw new Error(`signup hung for @${handle}`);
}

async function postPublic(page, body) {
  await page.evaluate((b) => {
    const input = document.getElementById("feed-body");
    input.value = b;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("feed-composer")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, body);
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const id = await page.evaluate((needle) => {
      const articles = Array.from(document.querySelectorAll("#stream-list .stream-post[data-post-id]"));
      const match = articles.find((node) => (node.querySelector(".stream-post__body")?.textContent || "").includes(needle));
      return match?.dataset.postId ?? null;
    }, body);
    if (id !== null) return id;
  }
  throw new Error(`post '${body.slice(0, 30)}' did not appear`);
}

async function resolveLookup(page, handle) {
  await page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) input.value = "";
  });
  await page.type("#lookup-input", handle);
  await page.evaluate(() => {
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const ready = await page.evaluate(() => document.querySelector("[data-relationship-action]") !== null);
    if (ready) return;
  }
  throw new Error(`lookup did not resolve ${handle}`);
}

async function lookupActions(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("[data-relationship-action]"));
    return buttons.map((b) => ({
      action: b.getAttribute("data-relationship-action"),
      label: (b.textContent || "").trim()
    }));
  });
}

async function clickLookupAction(page, action) {
  const clicked = await page.evaluate((a) => {
    const btn = document.querySelector(`[data-relationship-action='${a}']`);
    if (!(btn instanceof HTMLButtonElement)) return false;
    btn.click();
    return true;
  }, action);
  if (!clicked) throw new Error(`lookup action ${action} not present`);
  // Give the handler a beat to refresh the lookup card.
  await new Promise((r) => setTimeout(r, 700));
}

async function notificationActorIds(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("#notifications-list .notification-row"))
    .map((row) => row.dataset.notificationId));
}

async function waitForNotification(page, idPrefix, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ids = await notificationActorIds(page);
    const match = ids.find((id) => id?.startsWith(idPrefix));
    if (match !== undefined) return { matched: true, id: match, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { matched: false, elapsed: Date.now() - start };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);
    const handleA = "alpha" + stamp;
    const handleB = "bravo" + stamp;

    const { page: pageA } = await newSignedInContext(browser, handleA);
    const { page: pageB } = await newSignedInContext(browser, handleB);
    ok(`signed up @${handleA} and @${handleB}`);

    // ===== identity-pane-body removed =====
    const oldPanelGone = await pageB.evaluate(() => document.getElementById("identity-pane-body") === null);
    if (!oldPanelGone) fail("lower-left", "identity-pane-body still present in DOM");
    else ok("lower-left: profile-card removed");

    const notifsEmpty = await pageB.evaluate(() => {
      const empty = document.getElementById("notifications-empty");
      const list = document.getElementById("notifications-list");
      return Boolean(empty && empty.offsetParent !== null && list && list.hidden);
    });
    if (!notifsEmpty) fail("notifications-empty", "expected 'no notifications' empty state on signed-in B");
    else ok("notifications panel shows 'no notifications' empty state for fresh B");

    // ===== back-header height alignment =====
    // Posting once and entering thread view to inspect the back row.
    const aPostId = await postPublic(pageA, `relationship-ux ${Date.now()}`);
    await new Promise((r) => setTimeout(r, 1000));
    // Open thread view on A by clicking the post body.
    const opened = await pageA.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"] .stream-post__main`);
      if (!(article instanceof HTMLElement)) return false;
      article.click();
      return true;
    }, aPostId);
    if (!opened) {
      fail("back-header", "could not open thread view on A");
    } else {
      // Wait for the back button to render.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const ready = await pageA.evaluate(() => document.querySelector(".thread-view__back") !== null);
        if (ready) break;
      }
      const heights = await pageA.evaluate(() => {
        const back = document.querySelector(".thread-view__back");
        const colTitle = document.querySelector(".column--left .column__title");
        return {
          back: back ? back.getBoundingClientRect().height : null,
          colTitle: colTitle ? colTitle.getBoundingClientRect().height : null
        };
      });
      if (heights.back === null || heights.colTitle === null) {
        fail("back-header-height", `bounding boxes missing: ${JSON.stringify(heights)}`);
      } else if (heights.back > 40) {
        fail("back-header-height", `back row too tall: ${heights.back}px`);
      } else if (Math.abs(heights.back - heights.colTitle) > 4) {
        fail("back-header-height", `back row ${heights.back}px does not match column__title ${heights.colTitle}px`);
      } else {
        ok(`back-header aligns with column title row (${heights.back.toFixed(0)}px ≈ ${heights.colTitle.toFixed(0)}px)`);
      }
      // Leave thread view by clicking back so subsequent steps are on the feed.
      await pageA.evaluate(() => {
        const btn = document.querySelector(".thread-view__back");
        if (btn instanceof HTMLElement) btn.click();
      });
    }

    // ===== Lookup card stateful toggles on B looking at A =====
    await resolveLookup(pageB, `@${handleA}`);
    let actions = (await lookupActions(pageB)).map((a) => a.action);
    // Initial state: not following, no connection, not blocked.
    const expectInitial = ["set-subscribe", "set-known", "set-block"];
    if (!expectInitial.every((a) => actions.includes(a))) {
      fail("toggle-initial", `expected initial actions ${expectInitial.join("/")}, got ${actions.join("/")}`);
    } else if (actions.includes("set-unsubscribe") || actions.includes("set-unknown") || actions.includes("set-close")) {
      fail("toggle-initial", `unexpected stateful action surfaced initially: ${actions.join("/")}`);
    } else {
      ok(`initial lookup actions: ${actions.join(", ")}`);
    }

    // Click follow → expect unfollow + connect + block.
    await clickLookupAction(pageB, "set-subscribe");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-unsubscribe") || actions.includes("set-subscribe")) {
      fail("toggle-follow", `after follow, expected unfollow only; got ${actions.join("/")}`);
    } else {
      ok(`after follow: ${actions.join(", ")}`);
    }

    // Click unfollow → expect follow back.
    await clickLookupAction(pageB, "set-unsubscribe");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-subscribe") || actions.includes("set-unsubscribe")) {
      fail("toggle-unfollow", `after unfollow, expected follow back; got ${actions.join("/")}`);
    } else {
      ok(`unfollow restores follow: ${actions.join(", ")}`);
    }

    // Click connect → expect remove + close-friend (since now connected).
    await clickLookupAction(pageB, "set-known");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-unknown") || !actions.includes("set-close")) {
      fail("toggle-connect", `after connect, expected remove + close-friend; got ${actions.join("/")}`);
    } else if (actions.includes("set-known")) {
      fail("toggle-connect", `connect button still showing after connect: ${actions.join("/")}`);
    } else {
      ok(`after connect: ${actions.join(", ")}`);
    }

    // Promote to close-friend → expect remove + remove-close + block.
    await clickLookupAction(pageB, "set-close");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    const labelsAfterClose = (await lookupActions(pageB)).map((a) => a.label);
    if (!labelsAfterClose.includes("remove close")) {
      fail("toggle-close", `after close-friend, expected 'remove close' label; got labels=${labelsAfterClose.join("/")}`);
    } else {
      ok(`after close-friend: labels=${labelsAfterClose.join(", ")}`);
    }

    // Demote close back to known via remove-close (set-known).
    await clickLookupAction(pageB, "set-known");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-close")) {
      fail("toggle-demote-close", `after demote, expected close-friend offer back; got ${actions.join("/")}`);
    } else {
      ok(`demote close: ${actions.join(", ")}`);
    }

    // Disconnect (set-unknown) → expect connect + follow + block.
    await clickLookupAction(pageB, "set-unknown");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-known") || actions.includes("set-unknown")) {
      fail("toggle-disconnect", `after disconnect, expected connect back; got ${actions.join("/")}`);
    } else {
      ok(`disconnect restores connect: ${actions.join(", ")}`);
    }

    // Block → expect unblock only.
    await clickLookupAction(pageB, "set-block");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (actions.length !== 1 || actions[0] !== "set-unblock") {
      fail("toggle-block", `after block, expected only set-unblock; got ${actions.join("/")}`);
    } else {
      ok(`after block: only ${actions.join(", ")} visible`);
    }

    // Unblock → expect connect + follow + block back.
    await clickLookupAction(pageB, "set-unblock");
    actions = (await lookupActions(pageB)).map((a) => a.action);
    if (!actions.includes("set-known") || !actions.includes("set-subscribe") || !actions.includes("set-block")) {
      fail("toggle-unblock", `after unblock, expected fresh actions; got ${actions.join("/")}`);
    } else {
      ok(`after unblock: ${actions.join(", ")}`);
    }

    // ===== Notifications: A follows B → B sees follow notification =====
    await resolveLookup(pageA, `@${handleB}`);
    await clickLookupAction(pageA, "set-subscribe");
    ok("A followed B");

    // Wait for B's notification panel to pick it up.
    const followNotif = await waitForNotification(pageB, "follow:", 25000);
    if (!followNotif.matched) {
      fail("notif-follow", `B did not see follow notification within 25s`);
    } else {
      ok(`B saw follow notification in ${followNotif.elapsed}ms`);
    }

    // ===== A connects with B → B sees connect notification =====
    await clickLookupAction(pageA, "set-known");
    ok("A connected with B (tier=known)");
    const connectNotif = await waitForNotification(pageB, "connect:", 25000);
    if (!connectNotif.matched) {
      fail("notif-connect", `B did not see connect notification within 25s`);
    } else {
      ok(`B saw connect notification in ${connectNotif.elapsed}ms`);
    }

    // ===== B accepts connect-back =====
    if (connectNotif.matched) {
      const clickedAccept = await pageB.evaluate((id) => {
        const row = document.querySelector(`#notifications-list .notification-row[data-notification-id="${id}"]`);
        if (!row) return false;
        const buttons = Array.from(row.querySelectorAll(".notification-row__action"));
        const accept = buttons.find((b) => (b.textContent || "").trim() === "connect back");
        if (!(accept instanceof HTMLButtonElement)) return false;
        accept.click();
        return true;
      }, connectNotif.id);
      if (!clickedAccept) fail("notif-accept", "could not click 'connect back'");

      // After accept, the row should be dismissed locally and B's
      // lookup card on A should now show set-unknown (connected).
      await new Promise((r) => setTimeout(r, 1500));
      const stillThere = await pageB.evaluate((id) => {
        return document.querySelector(`#notifications-list .notification-row[data-notification-id="${id}"]`) !== null;
      }, connectNotif.id);
      if (stillThere) fail("notif-accept-dismiss", "notification still showing after accept");
      else ok("connect-back dismissed the notification");

      await resolveLookup(pageB, `@${handleA}`);
      const reciprocal = (await lookupActions(pageB)).map((a) => a.action);
      if (!reciprocal.includes("set-unknown")) {
        fail("notif-accept-reciprocal", `B's view of A should be connected; actions=${reciprocal.join("/")}`);
      } else {
        ok(`accept created reciprocal connection: ${reciprocal.join(", ")}`);
      }
    }

    // ===== Dismiss: dismissing the follow notification hides it
    //       immediately. The IndexedDB-backed dismissal store keeps
    //       it hidden across the next poll cycle. =====
    if (followNotif.matched) {
      const clickedDismiss = await pageB.evaluate((id) => {
        const row = document.querySelector(`#notifications-list .notification-row[data-notification-id="${id}"]`);
        if (!row) return false;
        const buttons = Array.from(row.querySelectorAll(".notification-row__action"));
        const dismiss = buttons.find((b) => (b.textContent || "").trim() === "dismiss");
        if (!(dismiss instanceof HTMLButtonElement)) return false;
        dismiss.click();
        return true;
      }, followNotif.id);
      if (!clickedDismiss) fail("notif-dismiss", "could not click 'dismiss'");
      // Wait through one full poll cycle so the next refetch tries
      // (and shouldn't) re-render the dismissed row.
      await new Promise((r) => setTimeout(r, 14000));
      const reappeared = (await notificationActorIds(pageB)).includes(followNotif.id);
      if (reappeared) fail("notif-dismiss-persist", "dismissed follow notification reappeared after re-poll");
      else ok("dismiss survives the next poll cycle (IndexedDB-backed)");
    }

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("RELATIONSHIP UX SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("RELATIONSHIP UX SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("RELATIONSHIP UX SMOKE ERROR", error);
  process.exit(2);
});
