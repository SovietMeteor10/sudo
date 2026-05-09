#!/usr/bin/env node
// Live personal-feed refresh smoke. Drives two real browser contexts
// (A and B) and asserts that A's new posts land in B's stream
// automatically without B reloading the page or interacting with it.
//
// We deliberately exercise BOTH user-driven relationship paths so the
// smoke matches what real users actually do, not the dev-only lookup
// shortcut that the previous smoke leaned on:
//
//   Pass 1 — search-row "+":  user finds A in directory results and
//     clicks "+". This is the production "follow & connect" combo
//     (addChatTarget): server-canonical connection tier=known PLUS a
//     server-canonical subscription. Most likely real-user path.
//
//   Pass 2 — explicit follow:  user opens the lookup card for D and
//     clicks the "follow" button (no connection tier change). Tests
//     the subscription-only path so a follow without trust-tier still
//     produces auto-refresh.
//
// Both passes assert: backfill works, A's new posts reach B without
// reload, no duplicates after extra poll cycles, and reload was never
// required.

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

async function feedPostIds(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("#stream-list .stream-post[data-post-id]"))
    .map((node) => node.dataset.postId));
}

async function waitForFeedToContain(page, expectedIds, timeoutMs = 25000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await feedPostIds(page);
    if (expectedIds.every((id) => last.includes(id))) return { matched: true, ids: last, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { matched: false, ids: last, elapsed: Date.now() - start };
}

// Drive the search "+" row: real users add an author this way. The
// resulting button click goes through addChatTarget which writes BOTH
// a connection (tier=known) AND a feed subscription server-side.
async function addAuthorViaSearchPlus(page, handle) {
  await page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) input.value = "";
  });
  await page.type("#lookup-input", handle);
  await page.evaluate(() => {
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // Wait for the search results row to render the "+" button for the
  // searched handle.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const ready = await page.evaluate((needle) => {
      const rows = Array.from(document.querySelectorAll("#search-results .search-result"));
      return rows.some((row) => (row.querySelector(".search-result__handle")?.textContent ?? "").includes(needle));
    }, handle);
    if (ready) break;
  }
  const clicked = await page.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll("#search-results .search-result"));
    const row = rows.find((r) => (r.querySelector(".search-result__handle")?.textContent ?? "").includes(needle));
    if (!row) return false;
    const button = row.querySelector(".search-result__add");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }, handle);
  return clicked;
}

// Drive the lookup card "follow" button (data-relationship-action =
// set-subscribe). This adds a subscription only — no connection tier
// change — to verify the follow-only path also auto-refreshes.
async function followViaLookupCard(page, handle) {
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
    const resolved = await page.evaluate(() =>
      document.querySelector("[data-relationship-action='set-subscribe']") !== null
    );
    if (resolved) break;
  }
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector("[data-relationship-action='set-subscribe']");
    if (!btn) return false;
    btn.click();
    return true;
  });
  return clicked;
}

async function clearSearchInput(page) {
  await page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) input.value = "";
  });
}

async function runPass(label, browser, signupHandle, followFn) {
  const handleA = signupHandle.A;
  const handleB = signupHandle.B;
  console.log(`\n----- ${label} (A=@${handleA}, B=@${handleB}) -----`);
  const { page: pageA, context: ctxA } = await newSignedInContext(browser, handleA);
  const { page: pageB, context: ctxB } = await newSignedInContext(browser, handleB);
  ok(`[${label}] accounts created`);

  try {
    // A posts P0 BEFORE B follows.
    const bodyZero = `${label} P0 ${Date.now()}`;
    const postZero = await postPublic(pageA, bodyZero);
    ok(`[${label}] A posted P0`);

    const bIdsBefore = await feedPostIds(pageB);
    if (bIdsBefore.includes(postZero)) {
      fail(`${label}-precondition`, `B already sees A before following: ${bIdsBefore.join(", ")}`);
      return;
    }
    ok(`[${label}] precondition: B does not see A's post yet`);

    const followed = await followFn(pageB, `@${handleA}`);
    if (!followed) {
      fail(`${label}-follow`, "follow action did not click successfully");
      return;
    }

    const backfill = await waitForFeedToContain(pageB, [postZero], 8000);
    if (!backfill.matched) {
      fail(`${label}-backfill`, `B did not backfill A's post; visible=${backfill.ids.join(", ")}`);
      return;
    }
    ok(`[${label}] backfill: B sees A's existing post in ${backfill.elapsed}ms`);

    await clearSearchInput(pageB);
    // Honor the server's per-author 5s rate limit.
    await new Promise((r) => setTimeout(r, 6000));

    const bodyOne = `${label} P1 ${Date.now()}`;
    const postOne = await postPublic(pageA, bodyOne);
    ok(`[${label}] A posted P1 while B was idle`);

    const live = await waitForFeedToContain(pageB, [postZero, postOne], 25000);
    if (!live.matched) {
      fail(`${label}-live-refresh`, `B did not auto-refresh; visible=${live.ids.join(", ")}`);
      return;
    }
    ok(`[${label}] live-refresh: B picked up P1 in ${live.elapsed}ms without reload`);

    // Wait one more poll cycle and assert no duplicates.
    await new Promise((r) => setTimeout(r, 13000));
    const idsAfter = await feedPostIds(pageB);
    const seen = new Map();
    for (const id of idsAfter) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
    if (duplicates.length > 0) {
      fail(`${label}-no-duplicates`, `duplicate post_ids: ${duplicates.map(([id, n]) => `${id}×${n}`).join(", ")}`);
    } else {
      ok(`[${label}] no-duplicates: every post_id in B's feed is unique`);
    }
    const occurrences = idsAfter.filter((id) => id === postZero || id === postOne).length;
    if (occurrences !== 2) {
      fail(`${label}-idempotent`, `expected 2 of A's posts after extra poll, got ${occurrences}`);
    } else {
      ok(`[${label}] idempotent-poll: B's stream still has exactly 2 of A's posts`);
    }
  } finally {
    await pageA.close().catch(() => null);
    await pageB.close().catch(() => null);
    await ctxA.close().catch(() => null);
    await ctxB.close().catch(() => null);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);

    // Pass 1 — the most common production path: search "+" combines
    // connect (tier=known) and follow into one click.
    await runPass(
      "search-plus",
      browser,
      { A: "alpha" + stamp, B: "bravo" + stamp },
      addAuthorViaSearchPlus
    );

    // Small gap so handles are unique and rate limits reset.
    const stamp2 = (Date.now() + 1).toString().slice(-6);
    // Pass 2 — explicit follow-only via lookup card "follow" button.
    // No connection tier change, just a feed subscription.
    await runPass(
      "follow-only",
      browser,
      { A: "echo" + stamp2, B: "foxtrot" + stamp2 },
      followViaLookupCard
    );

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("LIVE FEED REFRESH SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("LIVE FEED REFRESH SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("LIVE FEED REFRESH SMOKE ERROR", error);
  process.exit(2);
});
