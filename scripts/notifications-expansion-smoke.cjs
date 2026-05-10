#!/usr/bin/env node
// Notifications expansion smoke. Verifies the five categories the
// notifications panel surfaces:
//   - follow             ("@A follows you")
//   - reaction_recommend ("@A liked your post")
//   - reaction_downrank  ("@A disliked your post")
//   - reply              ("@A replied to your post")
//   - repost             ("@A reposted your post")
//
// Plus the new clear-all + view actions. Uses /dev/signup to mint
// server-only actor identities directly, which keeps the smoke fast
// (only B drives a real browser). Per kind we assert: appearance,
// exact lead text, action set, no-self, no-duplicate-on-replay.
// Then click "view" on a reaction → thread view opens.
// Then click "clear all" → list empties + persists across the next
// poll cycle.

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

async function newSignedInBrowserContext(browser, handle) {
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

// Mint a server-only fixture actor. Uses the production
// register-only path (no password, no dev_account_access) so this
// smoke does not contribute to the [legacy-signin] counter.
const { registerClientIdentity } = require("./lib/register-client-identity.cjs");
const devSignupServerOnly = (handle) => registerClientIdentity(BASE, handle);

async function postFeedPost(authorCanonicalId, authorHandle, body) {
  const now = new Date().toISOString();
  const resp = await fetch(BASE + "/api/feeds/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: authorCanonicalId,
      author_handle: authorHandle,
      visibility: "public",
      body,
      public_metadata: { tags: [] },
      created_at: now,
      updated_at: now,
      deleted_at: null,
      sequence: 1
    })
  });
  if (!resp.ok) throw new Error(`postFeedPost -> ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  return json.post;
}

async function postReply(authorCanonicalId, authorHandle, body, parentPostId) {
  const now = new Date().toISOString();
  const resp = await fetch(BASE + "/api/feeds/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: authorCanonicalId,
      author_handle: authorHandle,
      visibility: "public",
      body,
      public_metadata: { tags: [] },
      created_at: now,
      updated_at: now,
      deleted_at: null,
      sequence: 1,
      kind: "reply",
      reply_to: parentPostId
    })
  });
  if (!resp.ok) throw new Error(`postReply -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).post;
}

async function postRepost(authorCanonicalId, authorHandle, originalPostId) {
  const now = new Date().toISOString();
  const resp = await fetch(BASE + "/api/feeds/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: authorCanonicalId,
      author_handle: authorHandle,
      visibility: "public",
      body: "",
      public_metadata: { tags: [] },
      created_at: now,
      updated_at: now,
      deleted_at: null,
      sequence: 1,
      kind: "repost",
      repost_of: originalPostId
    })
  });
  if (!resp.ok) throw new Error(`postRepost -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).post;
}

async function postReaction(actorCanonicalId, actorHandle, postId, reaction) {
  const resp = await fetch(BASE + "/api/discovery/reactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      post_id: postId,
      actor_canonical_id: actorCanonicalId,
      actor_handle: actorHandle,
      reaction
    })
  });
  if (!resp.ok) throw new Error(`postReaction(${reaction}) -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).reaction;
}

async function follow(actorCanonicalId, targetCanonicalId, targetHandle) {
  const resp = await fetch(BASE + "/api/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner_canonical_id: actorCanonicalId,
      author_canonical_id: targetCanonicalId,
      author_handle: targetHandle,
      include_public: true,
      include_connections: true,
      include_close: false,
      muted: false
    })
  });
  if (!resp.ok) throw new Error(`follow -> ${resp.status}`);
}

async function notificationRows(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("#notifications-list .notification-row")).map((row) => {
    const id = row.dataset.notificationId ?? "";
    const lead = row.querySelector(".notification-row__line")?.textContent?.trim() ?? "";
    const buttons = Array.from(row.querySelectorAll(".notification-row__action"))
      .map((b) => (b.textContent ?? "").trim())
      .filter((label) => label.length > 0);
    return { id, lead, buttons };
  }));
}

async function waitForNotification(page, idPrefix, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await notificationRows(page);
    const match = rows.find((row) => row.id.startsWith(idPrefix));
    if (match !== undefined) return { matched: true, row: match, elapsed: Date.now() - start };
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
    const handleB = "owner" + stamp;
    const { page: pageB } = await newSignedInBrowserContext(browser, handleB);
    const ownerIdentity = await fetch(BASE + "/api/identity/handles/" + handleB).then((r) => r.json());
    const ownerCanonicalId = ownerIdentity.canonical_id;
    ok(`owner @${handleB} signed up (${ownerCanonicalId.slice(0, 24)}...)`);

    // B (recipient) posts a public post that all our actors will
    // react/reply/repost to.
    const ownerPost = await postFeedPost(ownerCanonicalId, `@${handleB}`, "look at me posting");
    ok(`B posted ${ownerPost.post_id.slice(0, 8)}`);

    // Actors. All server-only — no browser sessions for them.
    const handleC = "fan" + stamp;
    const handleD = "critic" + stamp;
    const handleE = "replier" + stamp;
    const handleF = "reposter" + stamp;
    const handleG = "follower" + stamp;
    const actorC = await devSignupServerOnly(handleC);
    const actorD = await devSignupServerOnly(handleD);
    const actorE = await devSignupServerOnly(handleE);
    const actorF = await devSignupServerOnly(handleF);
    const actorG = await devSignupServerOnly(handleG);
    ok(`actors created: @${handleC} @${handleD} @${handleE} @${handleF} @${handleG}`);

    // Trigger one of each kind.
    await postReaction(actorC.canonical_id, `@${handleC}`, ownerPost.post_id, "recommend");
    await postReaction(actorD.canonical_id, `@${handleD}`, ownerPost.post_id, "downrank");
    const replyPost = await postReply(actorE.canonical_id, `@${handleE}`, "great post", ownerPost.post_id);
    const repostPost = await postRepost(actorF.canonical_id, `@${handleF}`, ownerPost.post_id);
    await follow(actorG.canonical_id, ownerCanonicalId, `@${handleB}`);

    // Self-action: B reacts to its own post. Must not produce a
    // notification for B.
    await postReaction(ownerCanonicalId, `@${handleB}`, ownerPost.post_id, "recommend");

    // Wait for B's panel to surface all five.
    const followNotif = await waitForNotification(pageB, "follow:");
    const recNotif = await waitForNotification(pageB, "recommend:");
    const downNotif = await waitForNotification(pageB, "downrank:");
    const replyNotif = await waitForNotification(pageB, "reply:");
    const repostNotif = await waitForNotification(pageB, "repost:");

    if (!followNotif.matched) fail("notif-follow", "follow notification did not arrive");
    else ok(`notif-follow: '${followNotif.row.lead}' [${followNotif.row.buttons.join(", ")}]`);
    if (!recNotif.matched) fail("notif-recommend", "recommend notification did not arrive");
    else ok(`notif-recommend: '${recNotif.row.lead}' [${recNotif.row.buttons.join(", ")}]`);
    if (!downNotif.matched) fail("notif-downrank", "downrank notification did not arrive");
    else ok(`notif-downrank: '${downNotif.row.lead}' [${downNotif.row.buttons.join(", ")}]`);
    if (!replyNotif.matched) fail("notif-reply", "reply notification did not arrive");
    else ok(`notif-reply: '${replyNotif.row.lead}' [${replyNotif.row.buttons.join(", ")}]`);
    if (!repostNotif.matched) fail("notif-repost", "repost notification did not arrive");
    else ok(`notif-repost: '${repostNotif.row.lead}' [${repostNotif.row.buttons.join(", ")}]`);

    // Per-kind copy + actions.
    const expectShape = (label, row, leadRegex, actions) => {
      if (!leadRegex.test(row.lead)) fail(`${label}-text`, `lead='${row.lead}'`);
      const missing = actions.filter((a) => !row.buttons.includes(a));
      const extra = row.buttons.filter((a) => !actions.includes(a));
      if (missing.length > 0 || extra.length > 0) fail(`${label}-actions`, `expected exactly ${actions.join("/")}; got ${row.buttons.join("/")}`);
    };
    if (followNotif.matched) expectShape("notif-follow", followNotif.row, /^@\S+ follows you$/, ["follow back", "dismiss", "block"]);
    if (recNotif.matched)    expectShape("notif-recommend", recNotif.row, /^@\S+ liked your post$/, ["view", "dismiss"]);
    if (downNotif.matched)   expectShape("notif-downrank", downNotif.row, /^@\S+ disliked your post$/, ["view", "dismiss"]);
    if (replyNotif.matched)  expectShape("notif-reply", replyNotif.row, /^@\S+ replied to your post$/, ["view", "dismiss"]);
    if (repostNotif.matched) expectShape("notif-repost", repostNotif.row, /^@\S+ reposted your post$/, ["view", "dismiss"]);

    // No self-notifications. We sent a recommend from owner→owner
    // above; the panel must NOT carry an id of the form
    // recommend:<ownerId>:<postId>.
    const allRows = await notificationRows(pageB);
    const selfRow = allRows.find((row) => row.id.includes(ownerCanonicalId));
    if (selfRow !== undefined) fail("no-self-notifications", `self row: ${selfRow.id}`);
    else ok("no self-notifications surfaced");

    // No-duplicate guarantee. Two layers:
    //   - server: discovery_reactions has UNIQUE (post_id, actor,
    //     reaction). A second POST of the same reaction returns 409
    //     duplicate_reaction.
    //   - notifications: stable id `recommend:{actor}:{post}` means
    //     even if the server allowed multiples, the panel would only
    //     display one row. We assert exactly one recommend row from
    //     @fan and exactly one downrank row from @critic.
    const replayResp = await fetch(BASE + "/api/discovery/reactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        post_id: ownerPost.post_id,
        actor_canonical_id: actorC.canonical_id,
        actor_handle: `@${handleC}`,
        reaction: "recommend"
      })
    });
    if (replayResp.status !== 409) fail("dedup-server-409", `expected 409 duplicate_reaction; got ${replayResp.status}`);
    else ok("dedup-server: duplicate reaction rejected at the edge (409)");
    const allAfter = await notificationRows(pageB);
    const recCount = allAfter.filter((row) => row.id.startsWith(`recommend:${actorC.canonical_id}:`)).length;
    const downCount = allAfter.filter((row) => row.id.startsWith(`downrank:${actorD.canonical_id}:`)).length;
    if (recCount !== 1) fail("no-duplicate-recommend", `expected 1 recommend row, got ${recCount}`);
    else ok("no-duplicate: exactly one recommend row");
    if (downCount !== 1) fail("no-duplicate-downrank", `expected 1 downrank row, got ${downCount}`);
    else ok("no-duplicate: exactly one downrank row");

    // Click "view" on the reply notification → thread view opens.
    if (replyNotif.matched) {
      await pageB.evaluate((id) => {
        const row = document.querySelector(`#notifications-list .notification-row[data-notification-id="${id}"]`);
        const view = Array.from(row?.querySelectorAll(".notification-row__action") ?? [])
          .find((b) => (b.textContent || "").trim() === "view");
        if (view instanceof HTMLButtonElement) view.click();
      }, replyNotif.row.id);
      let opened = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        opened = await pageB.evaluate(() => document.querySelector(".thread-view__back") !== null);
        if (opened) break;
      }
      if (!opened) fail("notif-view", "thread view did not open after clicking view");
      else ok(`notif-view: thread view opened for reply ${replyPost.post_id.slice(0, 8)}`);
      // The opened thread MUST be rooted on B's original post, not on
      // the actor's reply object. (be6e3f3 + the reaction/repost
      // routing fix in this commit.)
      const openedRoot = await pageB.evaluate(() => {
        return document.querySelector(".thread-view .thread-view__parent .stream-post")?.getAttribute("data-post-id") ?? null;
      });
      if (openedRoot !== ownerPost.post_id) fail("notif-view-root", `reply view opened root=${(openedRoot || "(none)").slice(0, 8)}, expected ${ownerPost.post_id.slice(0, 8)}`);
      else ok(`notif-view: reply notification opened B's original post (not the reply)`);
      await pageB.evaluate(() => {
        const back = document.querySelector(".thread-view__back");
        if (back instanceof HTMLElement) back.click();
      });
      await new Promise((r) => setTimeout(r, 400));
    }

    // Click "view" on each of recommend / downrank / repost. Each
    // must open B's ORIGINAL post (not the actor's reaction or
    // repost object).
    for (const probe of [
      { label: "recommend", notif: recNotif },
      { label: "downrank", notif: downNotif },
      { label: "repost", notif: repostNotif }
    ]) {
      if (!probe.notif.matched) continue;
      await pageB.evaluate((id) => {
        const row = document.querySelector(`#notifications-list .notification-row[data-notification-id="${id}"]`);
        const view = Array.from(row?.querySelectorAll(".notification-row__action") ?? [])
          .find((b) => (b.textContent || "").trim() === "view");
        if (view instanceof HTMLButtonElement) view.click();
      }, probe.notif.row.id);
      let opened = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        opened = await pageB.evaluate(() => document.querySelector(".thread-view__back") !== null);
        if (opened) break;
      }
      if (!opened) {
        fail(`notif-view-${probe.label}`, `thread view did not open after clicking view on ${probe.label}`);
        continue;
      }
      const root = await pageB.evaluate(() => {
        return document.querySelector(".thread-view .thread-view__parent .stream-post")?.getAttribute("data-post-id") ?? null;
      });
      if (root !== ownerPost.post_id) {
        fail(`notif-view-${probe.label}-root`, `${probe.label} view opened root=${(root || "(none)").slice(0, 8)}, expected ${ownerPost.post_id.slice(0, 8)}`);
      } else {
        ok(`notif-view-${probe.label}: opened B's original post (${ownerPost.post_id.slice(0, 8)})`);
      }
      await pageB.evaluate(() => {
        const back = document.querySelector(".thread-view__back");
        if (back instanceof HTMLElement) back.click();
      });
      await new Promise((r) => setTimeout(r, 400));
    }

    // Click "clear all" → list empties.
    const clearButtonShown = await pageB.evaluate(() => {
      const btn = document.getElementById("notifications-clear-all");
      return btn instanceof HTMLButtonElement && !btn.hidden;
    });
    if (!clearButtonShown) fail("clear-all-visible", "clear-all button not visible while notifications present");
    else ok("clear-all button visible while notifications present");

    await pageB.evaluate(() => {
      const btn = document.getElementById("notifications-clear-all");
      if (btn instanceof HTMLButtonElement) btn.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    let afterClear = await notificationRows(pageB);
    if (afterClear.length !== 0) fail("clear-all-empty", `panel still has ${afterClear.length} rows after clear all`);
    else ok("clear-all empties the panel");

    const emptyVisible = await pageB.evaluate(() => {
      const empty = document.getElementById("notifications-empty");
      return empty instanceof HTMLElement && empty.offsetParent !== null;
    });
    if (!emptyVisible) fail("clear-all-empty-state", "empty state not visible after clear all");
    else ok("clear-all returns to 'no notifications' empty state");

    // Persistence: wait through one full poll cycle, ensure cleared
    // rows do NOT come back (every visible id was added to the
    // dismissed set).
    await new Promise((r) => setTimeout(r, 14000));
    afterClear = await notificationRows(pageB);
    if (afterClear.length !== 0) {
      fail("clear-all-persist", `${afterClear.length} rows reappeared after the next poll: ${afterClear.map((r) => r.id).join(", ")}`);
    } else {
      ok("clear-all persists across the next poll cycle");
    }

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("NOTIFICATIONS EXPANSION SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("NOTIFICATIONS EXPANSION SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("NOTIFICATIONS EXPANSION SMOKE ERROR", error);
  process.exit(2);
});
