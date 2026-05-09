#!/usr/bin/env node
// Regression coverage for the live-feed poller bugs that surfaced in
// real two-browser usage (B did not see A's post until reload):
//
//   1. Silent fingerprint advance: a poll that detected new content
//      while B was on Discover (or in a thread view) used to bump
//      lastFeedFingerprint without painting. The next poll matched
//      the bumped fingerprint, did nothing, and stranded the user
//      until reload. Switching back to Personal also did not refetch.
//
//   2. Unfocused-window path: visibilitychange does not fire when the
//      user clicks between two side-by-side browser windows, so the
//      poller had to wait for the next interval. The added `focus`
//      handler closes that gap.
//
// Pass 1 parks B on Discover when A posts, switches B back to
// Personal, asserts the new post lands without reload.
// Pass 2 blurs B's tab while A posts, focuses B again, asserts the
// focus path triggers a refresh.

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

// Wait until the page contains a stream-post with the given post_id,
// regardless of which pane is visible. Stricter than "feed has any
// posts" — protects against false positives when the backfill races
// the poll.
async function waitForPostId(page, postId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ids = await feedPostIds(page);
    if (ids.includes(postId)) return { matched: true, ids, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { matched: false, ids: await feedPostIds(page), elapsed: Date.now() - start };
}

async function followViaSearchPlus(page, handle) {
  await page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) input.value = "";
  });
  await page.type("#lookup-input", handle);
  await page.evaluate(() => {
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // Wait for the result row to render.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const ready = await page.evaluate((h) => {
      const rows = Array.from(document.querySelectorAll("#search-results .search-result"));
      return rows.some((row) => (row.querySelector(".search-result__handle")?.textContent ?? "").includes(h));
    }, handle);
    if (ready) break;
  }
  return page.evaluate((h) => {
    const rows = Array.from(document.querySelectorAll("#search-results .search-result"));
    const row = rows.find((r) => (r.querySelector(".search-result__handle")?.textContent ?? "").includes(h));
    if (!row) return false;
    const button = row.querySelector(".search-result__add");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }, handle);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    // ===== Pass 1: parked on Discover, switch back to Personal =====
    {
      console.log("\n----- Pass 1: B on Discover when A posts -----");
      const stamp = Date.now().toString().slice(-6);
      const handleA = "alphd" + stamp;
      const handleB = "bravd" + stamp;
      const { page: pageA, context: ctxA } = await newSignedInContext(browser, handleA);
      const { page: pageB, context: ctxB } = await newSignedInContext(browser, handleB);
      ok(`[discover] accounts created (@${handleA} / @${handleB})`);

      const postZero = await postPublic(pageA, `discover-regress P0 ${Date.now()}`);
      ok(`[discover] A posted P0`);

      if (!await followViaSearchPlus(pageB, `@${handleA}`)) {
        fail("discover-follow", "could not click '+' for A");
      }
      const backfill = await waitForPostId(pageB, postZero, 8000);
      if (!backfill.matched) {
        fail("discover-backfill", `B did not backfill A's post; visible=${backfill.ids.join(", ")}`);
        throw new Error("aborting");
      }
      ok(`[discover] B's Personal pane backfilled with A's existing post (${backfill.elapsed}ms)`);

      // Park B on Discover.
      await pageB.evaluate(() => {
        const btn = document.querySelector("[data-feed-tab='discover']");
        if (btn instanceof HTMLElement) btn.click();
      });
      const onDiscover = await pageB.evaluate(() => {
        const personal = document.querySelector("[data-feed-pane='personal']");
        const discover = document.querySelector("[data-feed-pane='discover']");
        return personal instanceof HTMLElement && personal.hidden === true
          && discover instanceof HTMLElement && discover.hidden === false;
      });
      if (!onDiscover) {
        fail("discover-switch", "B did not switch to Discover pane");
        throw new Error("aborting");
      }
      ok(`[discover] B parked on Discover`);

      // Honor the per-author rate limit, then A posts P1.
      await new Promise((r) => setTimeout(r, 6000));
      const postOne = await postPublic(pageA, `discover-regress P1 ${Date.now()}`);
      ok(`[discover] A posted P1 while B was on Discover`);

      // Wait long enough for at least one feed-poll cycle to elapse on
      // B (interval is 12s).
      await new Promise((r) => setTimeout(r, 14000));

      // Switch B back to Personal — must auto-refresh and pick up P1.
      await pageB.evaluate(() => {
        const btn = document.querySelector("[data-feed-tab='personal']");
        if (btn instanceof HTMLElement) btn.click();
      });
      const pickup = await waitForPostId(pageB, postOne, 8000);
      if (!pickup.matched) {
        fail("discover-switchback", `B did not refresh after returning to Personal; visible=${pickup.ids.join(", ")}`);
      } else {
        const finalIds = pickup.ids;
        if (!finalIds.includes(postZero)) {
          fail("discover-switchback", `Personal lost P0 after refresh; visible=${finalIds.join(", ")}`);
        } else {
          ok(`[discover] B saw P1 after switching back to Personal in ${pickup.elapsed}ms (no reload)`);
        }
      }

      await pageA.close().catch(() => null);
      await pageB.close().catch(() => null);
      await ctxA.close().catch(() => null);
      await ctxB.close().catch(() => null);
    }

    // ===== Pass 2: window focus path =====
    {
      console.log("\n----- Pass 2: focus path catches up unfocused B -----");
      const stamp = (Date.now() + 1).toString().slice(-6);
      const handleA = "echof" + stamp;
      const handleB = "foxtf" + stamp;
      const { page: pageA, context: ctxA } = await newSignedInContext(browser, handleA);
      const { page: pageB, context: ctxB } = await newSignedInContext(browser, handleB);
      ok(`[focus] accounts created (@${handleA} / @${handleB})`);

      const postZero = await postPublic(pageA, `focus-regress P0 ${Date.now()}`);
      ok(`[focus] A posted P0`);
      if (!await followViaSearchPlus(pageB, `@${handleA}`)) {
        fail("focus-follow", "could not click '+' for A");
      }
      const backfill = await waitForPostId(pageB, postZero, 8000);
      if (!backfill.matched) {
        fail("focus-backfill", `B did not backfill A's post; visible=${backfill.ids.join(", ")}`);
        throw new Error("aborting");
      }
      ok(`[focus] B's Personal pane backfilled with A's post (${backfill.elapsed}ms)`);

      // Bring A's tab to the foreground; in puppeteer's multi-page
      // model that blurs B.
      await pageA.bringToFront();
      await new Promise((r) => setTimeout(r, 500));

      // Honor rate limit, then A posts P1 while B is blurred.
      await new Promise((r) => setTimeout(r, 6000));
      const postOne = await postPublic(pageA, `focus-regress P1 ${Date.now()}`);
      ok(`[focus] A posted P1 while B was blurred`);

      // Refocus B's tab. We bring it to front AND dispatch a focus
      // event in the page — headless variants differ on which signal
      // their compositor raises, but the production path responds to
      // either. The new focus listener we added in main.ts pokes the
      // poller immediately so we don't wait for the 12s interval.
      await pageB.bringToFront();
      await pageB.evaluate(() => { window.dispatchEvent(new Event("focus")); });

      const pickup = await waitForPostId(pageB, postOne, 8000);
      if (!pickup.matched) {
        fail("focus-pickup", `B did not refresh on focus; visible=${pickup.ids.join(", ")}`);
      } else {
        ok(`[focus] B picked up P1 after window focus in ${pickup.elapsed}ms`);
      }

      await pageA.close().catch(() => null);
      await pageB.close().catch(() => null);
      await ctxA.close().catch(() => null);
      await ctxB.close().catch(() => null);
    }

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("FEED POLLER REGRESSION SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("FEED POLLER REGRESSION SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("FEED POLLER REGRESSION SMOKE ERROR", error);
  process.exit(2);
});
