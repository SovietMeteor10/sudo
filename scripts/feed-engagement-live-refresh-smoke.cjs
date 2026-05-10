#!/usr/bin/env node
// Pins the live engagement-count refresh on visible feed cards.
//
// Today the feed poller's diff cache (computeFeedFingerprint) used
// post.post_id + post.updated_at only. Engagement counts (recommend,
// downrank, reply, repost) plus viewer reaction state were missing
// from the fingerprint, so a like/dislike/comment/repost on an
// already-visible card was silently dropped — the count never
// advanced until something else mutated the post itself. This smoke
// asserts that:
//
//   1. A's visible feed card for B's post starts at 0/0/0/0 counts.
//   2. C posts a reply on B's post (HTTP-direct fixture).
//   3. A's card's reply counter advances on the next poll.
//   4. C reacts (recommend) on B's post.
//   5. A's card's recommend counter advances on the next poll.
//   6. C reposts B's post.
//   7. A's card's repost counter advances on the next poll.
//   8. Repeated polls do not duplicate counts (idempotent fingerprint).
//
// Per-poll: the personal feed poller fires every ~5s in the existing
// implementation. We give each step ~10s of headroom.
//
// HTTP-direct posts/reactions fall back to the dev-only placeholder
// signature path (only fires when isLocalDevelopment), which is fine
// for local smoke runs. Production rejects unsigned posts with 400
// missing_signature; this smoke is intended for local dev.

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

async function browserSignup(browser, handle) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 980, height: 820 });
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
    if (a === "signed-in") return { ctx, page };
  }
  throw new Error(`signup hung for @${handle}`);
}

// Server-only fixture actor: registered identity, no password, no
// dev_account_access row. Uses scripts/lib/register-client-identity
// so this smoke does not contribute to the [legacy-signin] counter.
const { registerClientIdentity } = require("./lib/register-client-identity.cjs");
const devSignupServer = (handle) => registerClientIdentity(BASE, handle);

async function follow(actorCanonicalId, targetCanonicalId, targetHandle) {
  const resp = await fetch(`${BASE}/api/subscriptions`, {
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

async function postFeedPost(actorCanonicalId, actorHandle, body) {
  const now = new Date().toISOString();
  const resp = await fetch(`${BASE}/api/feeds/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: actorCanonicalId,
      author_handle: actorHandle,
      visibility: "public",
      body,
      public_metadata: { tags: [] },
      created_at: now, updated_at: now, deleted_at: null, sequence: 1
    })
  });
  if (!resp.ok) throw new Error(`postFeedPost -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).post;
}

async function postReply(actorCanonicalId, actorHandle, body, parentPostId) {
  const now = new Date().toISOString();
  const resp = await fetch(`${BASE}/api/feeds/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: actorCanonicalId,
      author_handle: actorHandle,
      visibility: "public",
      body,
      public_metadata: { tags: [] },
      created_at: now, updated_at: now, deleted_at: null, sequence: 1,
      kind: "reply", reply_to: parentPostId
    })
  });
  if (!resp.ok) throw new Error(`postReply -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).post;
}

async function postRepost(actorCanonicalId, actorHandle, originalPostId) {
  const now = new Date().toISOString();
  const resp = await fetch(`${BASE}/api/feeds/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      author_canonical_id: actorCanonicalId,
      author_handle: actorHandle,
      visibility: "public",
      body: "",
      public_metadata: { tags: [] },
      created_at: now, updated_at: now, deleted_at: null, sequence: 1,
      kind: "repost", repost_of: originalPostId
    })
  });
  if (!resp.ok) throw new Error(`postRepost -> ${resp.status} ${await resp.text()}`);
  return (await resp.json()).post;
}

async function postReaction(actorCanonicalId, actorHandle, postId, reaction) {
  const resp = await fetch(`${BASE}/api/discovery/reactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_id: postId, actor_canonical_id: actorCanonicalId, actor_handle: actorHandle, reaction })
  });
  if (!resp.ok) throw new Error(`postReaction -> ${resp.status} ${await resp.text()}`);
}

// Snapshot the engagement-count digits on A's stream-list card for
// the given post. The action row renders a stream-post__action-count
// span next to each glyph. We map by data-reaction (reply / repost)
// and by class for vote (up / down).
// Reads the visible engagement digits off the card. The UI renders
// one vote button with a NET score (recommend - downrank), one reply
// button (↩), and one repost button (↻ — only when the viewer is not
// the author). All three carry a child .stream-post__action-count
// span we parse as an integer.
async function cardCounts(page, postId) {
  return page.evaluate((id) => {
    const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
    if (article === null) return null;
    function readCount(selector) {
      const node = article.querySelector(selector);
      if (node === null) return null;
      const counter = node.querySelector(".stream-post__action-count");
      if (counter === null) return null;
      const n = Number.parseInt((counter.textContent || "").trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    return {
      vote_net: readCount('.stream-post__action--vote'),
      reply: readCount('[data-reaction="reply"]'),
      repost: readCount('[data-reaction="repost"]')
    };
  }, postId);
}

async function waitForCardWithPost(page, postId, body, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const found = await page.evaluate((id, needle) => {
      const article = document.querySelector(`#stream-list .stream-post[data-post-id="${id}"]`);
      return article !== null && (article.textContent || "").includes(needle);
    }, postId, body);
    if (found) return true;
  }
  return false;
}

async function waitForCount(page, postId, axis, target, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const counts = await cardCounts(page, postId);
    if (counts && counts[axis] === target) return { reached: true, elapsed: Date.now() - deadline + timeoutMs, counts };
  }
  const counts = await cardCounts(page, postId);
  return { reached: false, elapsed: timeoutMs, counts };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);
    const handleA = `viewer${stamp}`;

    const { page: pageA } = await browserSignup(browser, handleA);
    const aIdResp = await fetch(`${BASE}/api/identity/handles/${handleA}`);
    const aIdentity = await aIdResp.json();
    const aCanonicalId = aIdentity.canonical_id;
    ok(`A=@${handleA} signed in; canonical=${aCanonicalId.slice(0, 24)}...`);

    const handleB = `author${stamp}`;
    const handleC = `actor${stamp}`;
    const handleD = `actor2${stamp}`;
    const handleE = `actor3${stamp}`;
    const actorB = await devSignupServer(handleB);
    const actorC = await devSignupServer(handleC);
    const actorD = await devSignupServer(handleD);
    const actorE = await devSignupServer(handleE);
    ok(`server-only actors created: @${handleB} @${handleC} @${handleD} @${handleE}`);

    // A subscribes to B so B's post lands in A's personal feed.
    await follow(aCanonicalId, actorB.canonical_id, `@${handleB}`);
    ok(`A follows B`);

    // B posts.
    const bPost = await postFeedPost(actorB.canonical_id, `@${handleB}`, "look at me");
    ok(`B posted ${bPost.post_id.slice(0, 8)}`);

    // Wait for A's feed to surface B's card via the live poll.
    const surfaced = await waitForCardWithPost(pageA, bPost.post_id, "look at me", 20000);
    if (!surfaced) { fail("a-sees-b", "A's feed never showed B's post"); throw new Error(); }
    ok(`A's feed surfaced B's post within 20s`);

    const initial = await cardCounts(pageA, bPost.post_id);
    if (initial === null) { fail("initial-counts", "could not read counts off the card"); throw new Error(); }
    if (initial.reply !== 0 || initial.repost !== 0 || initial.vote_net !== 0) {
      fail("initial-counts", `expected reply=0 repost=0 vote_net=0, got ${JSON.stringify(initial)}`);
    } else {
      ok(`initial counts on A's visible card: ${JSON.stringify(initial)}`);
    }

    // === Reply count ===
    await postReply(actorC.canonical_id, `@${handleC}`, "agreed", bPost.post_id);
    const replyResult = await waitForCount(pageA, bPost.post_id, "reply", 1, 14000);
    if (replyResult.reached) ok(`A's visible card reply count advanced to 1 (engagement-aware fingerprint live)`);
    else fail("reply-count-live", `reply count never advanced; final=${JSON.stringify(replyResult.counts)}`);

    // === Recommend / vote_net advances by 1. ===
    // The vote button shows recommend - downrank. After C recommends,
    // net should be 1.
    await postReaction(actorD.canonical_id, `@${handleD}`, bPost.post_id, "recommend");
    const voteResult = await waitForCount(pageA, bPost.post_id, "vote_net", 1, 14000);
    if (voteResult.reached) ok(`A's visible card vote_net advanced to 1 after a recommend`);
    else fail("vote-net-live", `vote_net never advanced; final=${JSON.stringify(voteResult.counts)}`);

    // === Repost count ===
    await postRepost(actorE.canonical_id, `@${handleE}`, bPost.post_id);
    const repostResult = await waitForCount(pageA, bPost.post_id, "repost", 1, 14000);
    if (repostResult.reached) ok(`A's visible card repost count advanced to 1`);
    else fail("repost-count-live", `repost count never advanced; final=${JSON.stringify(repostResult.counts)}`);

    // === Idempotent poll: another tick must NOT inflate any counter. ===
    await new Promise((r) => setTimeout(r, 12000));
    const after = await cardCounts(pageA, bPost.post_id);
    if (after === null) {
      fail("idempotent", "card disappeared during quiet poll cycles");
    } else if (after.reply === 1 && after.vote_net === 1 && after.repost === 1) {
      ok(`counts steady across quiet poll cycles: ${JSON.stringify(after)}`);
    } else {
      fail("idempotent", `counts drifted on quiet polls: ${JSON.stringify(after)}`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`FEED-ENGAGEMENT-LIVE-REFRESH SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("FEED-ENGAGEMENT-LIVE-REFRESH SMOKE PASSED");
})();
