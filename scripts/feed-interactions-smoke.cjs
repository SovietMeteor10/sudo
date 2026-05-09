#!/usr/bin/env node
// Feed interactions smoke. Drives a real browser through the four
// behaviors the feed UX overhaul promises:
//   A. Connection backfill: B subscribes to A and sees A's prior posts.
//      Removing the connection drops A's posts from B's personal feed.
//   B. Vote cycle: neutral → like → dislike → neutral via the single
//      vote control; net score updates correctly each step.
//   C. Repost: B reposts an A post; B's personal feed shows the repost
//      with A's body embedded; repost_count increments.
//   D. Reply: B replies to an A post; reply_count increments and the
//      reply is visible under the parent post.
//
// Each user lives in its own browser context so IndexedDB / crypto
// accounts don't bleed between accounts.

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

async function lookupCanonical(handle) {
  const response = await fetch(`${BASE}/api/identity/handles/${handle.replace(/^@/, "")}`);
  if (response.status !== 200) throw new Error(`identity lookup ${handle} -> ${response.status}`);
  return (await response.json()).canonical_id;
}

// Send a post via the composer and wait for the article that carries
// that body to land in the local stream. Returns the article's
// data-post-id so the rest of the smoke can address it directly.
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

async function feedPostIds(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("#stream-list .stream-post[data-post-id]"))
    .map((node) => node.dataset.postId));
}

async function clickAction(page, postId, selector) {
  await page.evaluate((id, sel) => {
    const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
    if (!article) throw new Error("post not visible: " + id);
    const button = article.querySelector(sel);
    if (!button) throw new Error("action not found: " + sel);
    button.click();
  }, postId, selector);
}

async function voteState(page, postId) {
  return page.evaluate((id) => {
    const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
    if (!article) return null;
    const vote = article.querySelector(".stream-post__action--vote");
    return vote ? {
      state: vote.dataset.voteState,
      count: vote.querySelector(".stream-post__action-count")?.textContent ?? ""
    } : null;
  }, postId);
}

async function postBody(page, postId) {
  return page.evaluate((id) => {
    const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
    return article?.textContent ?? "";
  }, postId);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
  });

  try {
    const handleA = "alpha" + Date.now().toString().slice(-6);
    const handleB = "bravo" + Date.now().toString().slice(-6);

    const { page: pageA } = await newSignedInContext(browser, handleA);
    const { page: pageB } = await newSignedInContext(browser, handleB);
    const canonicalA = await lookupCanonical(handleA);
    const canonicalB = await lookupCanonical(handleB);
    ok(`accounts created: @${handleA}, @${handleB}`);

    // ===== A creates two public posts =====
    const bodyOne = `alpha post one ${Date.now()}`;
    const bodyTwo = `alpha post two ${Date.now()}`;
    const postOne = await postPublic(pageA, bodyOne);
    const postTwo = await postPublic(pageA, bodyTwo);
    ok("A created two public posts");

    // ===== B's personal feed initially does NOT include A =====
    const bIds0 = await feedPostIds(pageB);
    if (bIds0.includes(postOne) || bIds0.includes(postTwo)) {
      fail("backfill-precondition", `B sees A's posts before connecting: ${bIds0.join(", ")}`);
    } else ok("backfill: B's personal feed does not show A initially");

    // ===== B connects to A as known via the lookup pane =====
    // Drive the UI through the lookup pane so the in-page handler
    // fires and refreshFeedPosts() runs naturally — that's the same
    // path real users take when they "set known" from the directory.
    await pageB.type("#lookup-input", `@${handleA}`);
    await pageB.evaluate(() => {
      const form = document.getElementById("lookup-form");
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    let lookupResolved = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      lookupResolved = await pageB.evaluate(() =>
        document.querySelector("[data-relationship-action]") !== null
      );
      if (lookupResolved) break;
    }
    if (!lookupResolved) fail("backfill-lookup", "lookup did not resolve A in B's directory");
    // Click "set known" — this calls upsertConnectionRelationship and
    // then refreshFeedPosts().
    await pageB.evaluate(() => {
      const btn = document.querySelector("[data-relationship-action='set-known']");
      btn?.click();
    });
    let bIds1 = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bIds1 = await feedPostIds(pageB);
      if (bIds1.includes(postOne) && bIds1.includes(postTwo)) break;
    }
    if (!bIds1.includes(postOne) || !bIds1.includes(postTwo)) {
      fail("backfill", `B did not backfill A's posts after connect; visible=${bIds1.join(", ")}`);
    } else ok("backfill: B's personal feed shows A's previous posts after connect");

    // ===== Vote cycle on B for postOne =====
    const v0 = await voteState(pageB, postOne);
    if (!v0 || v0.state !== "neutral" || v0.count !== "0") fail("vote-initial", `expected neutral 0, got ${JSON.stringify(v0)}`);
    else ok(`vote: initial state neutral 0`);

    await clickAction(pageB, postOne, ".stream-post__action--vote");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const v = await voteState(pageB, postOne);
      if (v && v.state === "liked" && v.count === "1") break;
    }
    const vLike = await voteState(pageB, postOne);
    if (!vLike || vLike.state !== "liked" || vLike.count !== "1") fail("vote-like", `expected liked 1, got ${JSON.stringify(vLike)}`);
    else ok(`vote: liked → △ 1`);

    await clickAction(pageB, postOne, ".stream-post__action--vote");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const v = await voteState(pageB, postOne);
      if (v && v.state === "disliked" && v.count === "-1") break;
    }
    const vDislike = await voteState(pageB, postOne);
    if (!vDislike || vDislike.state !== "disliked" || vDislike.count !== "-1") fail("vote-dislike", `expected disliked -1, got ${JSON.stringify(vDislike)}`);
    else ok(`vote: disliked → ▽ -1`);

    await clickAction(pageB, postOne, ".stream-post__action--vote");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const v = await voteState(pageB, postOne);
      if (v && v.state === "neutral" && v.count === "0") break;
    }
    const vClear = await voteState(pageB, postOne);
    if (!vClear || vClear.state !== "neutral" || vClear.count !== "0") fail("vote-clear", `expected neutral 0, got ${JSON.stringify(vClear)}`);
    else ok(`vote: cleared → ◇ 0`);

    // Duplicate-click idempotence: clicking twice in a row from neutral
    // shouldn't crash and should land on a defined state.
    await clickAction(pageB, postOne, ".stream-post__action--vote");
    await clickAction(pageB, postOne, ".stream-post__action--vote");
    await new Promise((r) => setTimeout(r, 600));
    const vDup = await voteState(pageB, postOne);
    if (!vDup) fail("vote-dup", "vote control disappeared after rapid clicks");
    else ok(`vote: rapid clicks settle to '${vDup.state}' ${vDup.count} (no crash)`);

    // ===== Repost =====
    await clickAction(pageB, postTwo, ".stream-post__action[data-reaction='repost']");
    let foundRepost = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      foundRepost = await pageB.evaluate((parentId) => {
        const articles = document.querySelectorAll("#stream-list .stream-post[data-post-kind='repost']");
        for (const a of articles) {
          if ((a.textContent || "").includes(parentId.slice(0, 0))) {} // noop placeholder
          if (a.querySelector(".stream-post__embed")) {
            return {
              postId: a.dataset.postId,
              kind: a.dataset.postKind,
              embed: a.querySelector(".stream-post__embed-body")?.textContent ?? "",
              handle: a.querySelector(".stream-post__handle")?.textContent ?? ""
            };
          }
        }
        return null;
      }, postTwo);
      if (foundRepost !== null) break;
    }
    if (foundRepost === null) fail("repost-render", "no repost article appeared in B's feed");
    else if (!foundRepost.embed.includes(bodyTwo)) fail("repost-render", `repost embed missing original body. got '${foundRepost.embed}'`);
    else if (!/reposted$/.test(foundRepost.handle)) fail("repost-render", `repost handle should end with 'reposted'. got '${foundRepost.handle}'`);
    else ok("repost: B's feed shows '@B reposted' card with A's original body embedded");

    // Repost count on the original should be at least 1 now.
    const repostCount = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const btn = article?.querySelector(".stream-post__action--repost .stream-post__action-count");
      return btn?.textContent ?? "";
    }, postTwo);
    if (repostCount !== "1") fail("repost-count", `expected repost count 1 on original, got '${repostCount}'`);
    else ok("repost: original post shows ↻ 1");

    // ===== Reply =====
    await clickAction(pageB, postOne, ".stream-post__action[data-reaction='reply']");
    await new Promise((r) => setTimeout(r, 200));
    const composerOpen = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const input = article?.querySelector(".stream-post__reply-input");
      return input !== null && input !== undefined;
    }, postOne);
    if (!composerOpen) fail("reply-composer", "reply composer did not open");
    else ok("reply: inline composer opens under the post");

    const replyText = `nice post ${Date.now()}`;
    await pageB.evaluate((id, body) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const input = article?.querySelector(".stream-post__reply-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      article.querySelector(".stream-post__reply-submit").click();
    }, postOne, replyText);
    let replyShown = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      replyShown = await pageB.evaluate((id, expected) => {
        const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
        const list = article?.querySelector(".stream-post__reply-list");
        return list?.textContent.includes(expected) ?? false;
      }, postOne, replyText);
      if (replyShown) break;
    }
    if (!replyShown) fail("reply-render", `reply '${replyText}' did not appear under post`);
    else ok("reply: reply text visible under parent post");

    // Reply count on the parent should reflect the new reply.
    const replyCount = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const btn = article?.querySelector(".stream-post__action[data-reaction='reply'] .stream-post__action-count");
      return btn?.textContent ?? "";
    }, postOne);
    if (replyCount !== "1") fail("reply-count", `expected reply count 1, got '${replyCount}'`);
    else ok("reply: parent shows ↩ 1");

    // ===== Removing/blocking the connection drops A's posts =====
    // The lookup card exposes "block" as the removal action — tier
    // "blocked" is filtered out of refreshFeedPosts and any cached
    // posts from that author are dropped at render time.
    await pageB.evaluate(() => {
      const btn = document.querySelector("[data-relationship-action='set-block']");
      btn?.click();
    });
    let bIdsAfter = await feedPostIds(pageB);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bIdsAfter = await feedPostIds(pageB);
      if (!bIdsAfter.includes(postOne) && !bIdsAfter.includes(postTwo)) break;
    }
    if (bIdsAfter.includes(postOne)) {
      fail("removal", `B still sees A's postOne after disconnect. visible=${bIdsAfter.join(", ")}`);
    } else ok("removal: B's personal feed no longer shows A's posts after disconnect");
  } finally {
    await browser.close();
  }

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log("  -", f);
    process.exit(1);
  } else {
    console.log("\nFEED INTERACTIONS SMOKE PASSED");
  }
})().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
