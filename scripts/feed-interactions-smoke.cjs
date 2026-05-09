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

    // ===== A creates two public posts (5s gap to clear rate limit) =====
    const bodyOne = `alpha post one ${Date.now()}`;
    const bodyTwo = `alpha post two ${Date.now()}`;
    const postOne = await postPublic(pageA, bodyOne);
    await new Promise((r) => setTimeout(r, 5500));
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
    // Wait 5s for rate limit to clear after B's repost feed post.
    await new Promise((r) => setTimeout(r, 5500));
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

    // Threaded UI: each reply has a ↳ marker, a timestamp using the
    // post timestamp formatter (HH:MM DD MMM, optional YY), and its
    // own ↩ button.
    const threadShape = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const item = article?.querySelector(".stream-post__reply-item");
      if (!item) return { ok: false, reason: "no reply item" };
      return {
        ok: true,
        arrow: item.querySelector(".stream-post__reply-arrow")?.textContent ?? "",
        time: item.querySelector(".stream-post__reply-time")?.textContent ?? "",
        hasReplyButton: item.querySelector(".stream-post__reply-action[data-reply-action='open-nested']") !== null
      };
    }, postOne);
    if (!threadShape.ok) fail("thread-shape", threadShape.reason);
    else if (threadShape.arrow !== "↳") fail("thread-shape", `expected ↳ marker, got '${threadShape.arrow}'`);
    else if (!/^\d{2}:\d{2} \d{2} [A-Z][a-z]{2}( \d{2})?$/.test(threadShape.time.trim())) {
      fail("thread-shape", `reply time format wrong: '${threadShape.time}'`);
    } else if (!threadShape.hasReplyButton) fail("thread-shape", "reply has no ↩ button");
    else ok(`reply: threaded shape (↳ + '${threadShape.time}' + per-reply ↩)`);

    // Composer should collapse after a successful submit. The replies
    // list stays visible so the user sees the reply they just posted.
    const composerAfterSubmit = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      return {
        hasInput: article?.querySelector(".stream-post__reply-input") !== null,
        hasForm: article?.querySelector(".stream-post__reply-form") !== null,
        hasList: article?.querySelector(".stream-post__reply-list") !== null,
        panelMode: article?.querySelector(".stream-post__replies")?.dataset.mode ?? ""
      };
    }, postOne);
    if (composerAfterSubmit.hasInput || composerAfterSubmit.hasForm) {
      fail("reply-collapse", `composer still visible after submit (mode='${composerAfterSubmit.panelMode}')`);
    } else if (!composerAfterSubmit.hasList) {
      fail("reply-collapse", "replies list disappeared after submit");
    } else ok("reply: composer collapses after submit; replies list remains");

    // Clicking ↩ again should reopen a fresh empty composer.
    await clickAction(pageB, postOne, ".stream-post__action[data-reaction='reply']");
    await new Promise((r) => setTimeout(r, 200));
    const reopened = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const input = article?.querySelector(".stream-post__reply-input");
      return {
        present: input !== null && input !== undefined,
        value: input?.value ?? "non-empty-fallback"
      };
    }, postOne);
    if (!reopened.present) fail("reply-reopen", "composer did not reopen after second click");
    else if (reopened.value !== "") fail("reply-reopen", `reopened composer not empty: '${reopened.value}'`);
    else ok("reply: composer reopens empty on second click");

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

    // ===== Directory-search add path =====
    // The lookup pane is one place to add a connection; the directory
    // search row's "+" button is another, and it has its own handler
    // (addChatTarget) that must also trigger the feed refresh. First
    // unblock A so adding works again, then exercise the search row.
    await pageB.evaluate(() => {
      const btn = document.querySelector("[data-relationship-action='set-unblock']");
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 300));

    // Re-trigger the directory search so the results populate (the
    // search runs on input). Clear the field first to force a re-fetch.
    await pageB.evaluate(() => {
      const input = document.getElementById("lookup-input");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pageB.type("#lookup-input", `@${handleA}`);
    await new Promise((r) => setTimeout(r, 600));
    let searchRowReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      searchRowReady = await pageB.evaluate(() =>
        document.querySelector("#search-results .search-result__add") !== null
      );
      if (searchRowReady) break;
    }
    if (!searchRowReady) fail("dir-search", "directory search did not surface A's row");
    // Click the search-result toggle ("+" → "added"). This calls
    // addChatTarget which now refreshes the personal feed.
    await pageB.evaluate(() => {
      const btn = document.querySelector("#search-results .search-result__add");
      btn?.click();
    });
    let bIdsViaSearch = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bIdsViaSearch = await feedPostIds(pageB);
      if (bIdsViaSearch.includes(postOne) && bIdsViaSearch.includes(postTwo)) break;
    }
    if (!bIdsViaSearch.includes(postOne) || !bIdsViaSearch.includes(postTwo)) {
      fail("dir-add-backfill", `directory-add did not backfill A's posts; visible=${bIdsViaSearch.join(", ")}`);
    } else ok("directory: '+' on search row backfills A's posts into B's feed");

    // The same search row toggles to "remove" once the
    // pending-added timer clears (2s after add). Wait for that label,
    // then click.
    let removeReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      removeReady = await pageB.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("#search-results .search-result__add"));
        return buttons.some((b) => b.textContent === "remove");
      });
      if (removeReady) break;
    }
    if (!removeReady) fail("dir-remove-button", "search row never showed 'remove' label after add");
    await pageB.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("#search-results .search-result__add"));
      const removeBtn = buttons.find((b) => b.textContent === "remove");
      removeBtn?.click();
    });
    let bIdsAfterDirRemove = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bIdsAfterDirRemove = await feedPostIds(pageB);
      if (!bIdsAfterDirRemove.includes(postOne) && !bIdsAfterDirRemove.includes(postTwo)) break;
    }
    if (bIdsAfterDirRemove.includes(postOne) || bIdsAfterDirRemove.includes(postTwo)) {
      fail("dir-remove-depopulate", `directory-remove did not drop A's posts; visible=${bIdsAfterDirRemove.join(", ")}`);
    } else ok("directory: 'remove' on search row depopulates A's posts from B's feed");

    // After directory-remove, the same row should re-show "+" (we
    // deleted the local contact so isAdded is false again). Re-adding
    // should backfill A's posts a second time without a page reload.
    let plusReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      plusReady = await pageB.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("#search-results .search-result__add"));
        return buttons.some((b) => b.textContent === "+");
      });
      if (plusReady) break;
    }
    if (!plusReady) fail("dir-readd-button", "search row did not return to '+' after remove");
    else ok("re-add: search row shows '+' again after remove");
    await pageB.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("#search-results .search-result__add"));
      const plusBtn = buttons.find((b) => b.textContent === "+");
      plusBtn?.click();
    });
    let bIdsReAdd = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bIdsReAdd = await feedPostIds(pageB);
      if (bIdsReAdd.includes(postOne) && bIdsReAdd.includes(postTwo)) break;
    }
    if (!bIdsReAdd.includes(postOne) || !bIdsReAdd.includes(postTwo)) {
      fail("re-add-backfill", `re-add did not backfill A's posts; visible=${bIdsReAdd.join(", ")}`);
    } else ok("re-add: B's personal feed shows A's posts again after re-add");

    // ===== Duplicate repost =====
    // B has already reposted postTwo earlier in the run. The repost
    // button should be in the already-reposted state, and the action
    // handler should refuse to create a second repost.
    const repostState = await pageB.evaluate((id) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      const btn = article?.querySelector(".stream-post__action--repost");
      return { already: btn?.dataset.alreadyReposted ?? "", title: btn?.title ?? "" };
    }, postTwo);
    if (repostState.already !== "true") fail("dup-repost-state", `repost button not flagged already (got '${repostState.already}')`);
    else ok("dup-repost: repost button flagged as already-reposted");

    // Direct API call: a second POST with kind=repost for the same
    // (author, original) must be rejected with duplicate_repost.
    const secondRepost = await fetch(`${BASE}/api/feeds/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author_canonical_id: canonicalB,
        author_handle: `@${handleB}`,
        visibility: "public",
        kind: "repost",
        repost_of: postTwo,
        public_metadata: { tags: [] },
        sequence: 1
      })
    });
    const secondBody = await secondRepost.json();
    if (secondRepost.status !== 409 || secondBody.error !== "duplicate_repost") {
      fail("dup-repost-api", `expected 409 duplicate_repost, got ${secondRepost.status} ${JSON.stringify(secondBody)}`);
    } else ok("dup-repost: API rejects second repost with duplicate_repost (409)");

    // ===== Rate limit =====
    // A fresh account so we don't have to wait for prior B/A waits to
    // clear. C posts once (succeeds), then immediately posts again
    // (rate_limited), then waits 5s and posts (succeeds).
    const handleC = "charlie" + Date.now().toString().slice(-6);
    const { page: pageC } = await newSignedInContext(browser, handleC);
    const ratePostOne = `charlie post one ${Date.now()}`;
    const ratePostTwo = `charlie post two ${Date.now()}`;
    await postPublic(pageC, ratePostOne);
    // Submit a second post immediately and read the inline error.
    await pageC.evaluate((b) => {
      const input = document.getElementById("feed-body");
      input.value = b;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("feed-composer")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, ratePostTwo);
    let rateState = "";
    let preservedText = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const probe = await pageC.evaluate(() => ({
        state: document.getElementById("feed-composer-state")?.textContent ?? "",
        text: document.getElementById("feed-body")?.value ?? ""
      }));
      if (probe.state.length > 0) {
        rateState = probe.state;
        preservedText = probe.text;
        break;
      }
    }
    if (!/wait/i.test(rateState)) fail("rate-limit-copy", `expected 'wait' message, got '${rateState}'`);
    else ok(`rate-limit: composer state shows '${rateState}'`);
    if (preservedText !== ratePostTwo) fail("rate-limit-preserve", `composer text not preserved: '${preservedText}'`);
    else ok("rate-limit: composer text preserved on rate_limited");
    // Wait 5s and re-submit; should succeed.
    await new Promise((r) => setTimeout(r, 5500));
    await pageC.evaluate(() => {
      document.getElementById("feed-composer")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    let secondLanded = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      secondLanded = await pageC.evaluate((needle) => {
        const articles = document.querySelectorAll("#stream-list .stream-post");
        return Array.from(articles).some((a) => (a.querySelector(".stream-post__body")?.textContent || "").includes(needle));
      }, ratePostTwo);
      if (secondLanded) break;
    }
    if (!secondLanded) fail("rate-limit-recover", "second post did not land after 5s wait");
    else ok("rate-limit: post succeeds after 5s wait");

    // ===== Nested reply (level 2 threading) =====
    // A replies to B's earlier reply on postOne, demonstrating that
    // reply-to-reply is supported and the descendants come back in one
    // listFeedPostReplies call. Re-open B's reply panel first so the
    // reply <li> is in the DOM (it gets removed when refreshFeedPosts
    // re-renders the feed).
    await pageB.evaluate((rootId) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
      article?.querySelector(".stream-post__action[data-reaction='reply']")?.click();
    }, postOne);
    let bReplyId = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      bReplyId = await pageB.evaluate((rootId) => {
        const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
        const item = article?.querySelector(".stream-post__reply-item");
        return item?.dataset.postId ?? null;
      }, postOne);
      if (typeof bReplyId === "string" && bReplyId.length > 0) break;
    }
    if (typeof bReplyId !== "string" || bReplyId.length === 0) {
      fail("nested-bootstrap", "could not find B's reply id");
    } else {
      // A waits for rate-limit to clear since A's last post was bodyTwo
      // (~30s ago by now after various waits — usually fine, but be safe).
      await new Promise((r) => setTimeout(r, 5500));
      // Open postOne in A's tab and reply to B's reply.
      await pageA.evaluate((rootId) => {
        const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
        article?.querySelector(".stream-post__action[data-reaction='reply']")?.click();
      }, postOne);
      // Wait for the replies list to populate so A's nested ↩ button exists.
      let aSeesBReply = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        aSeesBReply = await pageA.evaluate((rootId, replyId) => {
          const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
          return article?.querySelector(`.stream-post__reply-item[data-post-id="${replyId}"]`) !== null;
        }, postOne, bReplyId);
        if (aSeesBReply) break;
      }
      if (!aSeesBReply) {
        fail("nested-fetch", "A could not see B's reply in the threaded view");
      } else {
        // Click ↩ on B's reply, type a nested reply, submit.
        const nestedText = `agreed ${Date.now()}`;
        await pageA.evaluate((rootId, replyId) => {
          const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
          const item = article?.querySelector(`.stream-post__reply-item[data-post-id="${replyId}"]`);
          item?.querySelector(".stream-post__reply-action[data-reply-action='open-nested']")?.click();
        }, postOne, bReplyId);
        // Wait for the nested form to be inserted by the click handler.
        let nestedFormReady = false;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          nestedFormReady = await pageA.evaluate((rootId, replyId) => {
            const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
            const item = article?.querySelector(`.stream-post__reply-item[data-post-id="${replyId}"]`);
            return item?.querySelector(".stream-post__reply-form--nested .stream-post__reply-input") !== null;
          }, postOne, bReplyId);
          if (nestedFormReady) break;
        }
        if (!nestedFormReady) {
          fail("nested-form", "nested composer did not open after clicking ↩ on B's reply");
        }
        await pageA.evaluate((rootId, replyId, body) => {
          const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
          const item = article?.querySelector(`.stream-post__reply-item[data-post-id="${replyId}"]`);
          const input = item?.querySelector(".stream-post__reply-form--nested .stream-post__reply-input");
          input.value = body;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          item?.querySelector(".stream-post__reply-form--nested .stream-post__reply-submit")?.click();
        }, postOne, bReplyId, nestedText);
        let nestedLanded = false;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 200));
          nestedLanded = await pageA.evaluate((rootId, replyId, expected) => {
            const article = document.querySelector(`#stream-list .stream-post[data-post-id="${rootId}"]`);
            const parent = article?.querySelector(`.stream-post__reply-item[data-post-id="${replyId}"]`);
            const sublist = parent?.querySelector(".stream-post__reply-list--nested");
            return sublist?.textContent.includes(expected) ?? false;
          }, postOne, bReplyId, nestedText);
          if (nestedLanded) break;
        }
        if (!nestedLanded) fail("nested-render", `nested reply '${nestedText}' did not appear under B's reply`);
        else ok("nested-reply: A's reply to B's reply renders under the parent reply");
      }
    }
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
