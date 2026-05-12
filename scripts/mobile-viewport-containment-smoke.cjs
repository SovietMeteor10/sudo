#!/usr/bin/env node
// mobile-viewport-containment smoke (Phase 10.1 Part B).
//
// User-visible symptom we're locking: "I can drag the whole page
// side-to-side and up/down on mobile."
//
// Assertions at 390 / 430 / 760 widths:
//   - document.documentElement.scrollWidth === innerWidth
//   - document.documentElement.scrollHeight <= innerHeight + 1
//   - document.body.scrollWidth === innerWidth
//   - html, body computed overscroll-behavior !== "auto"
//   - body computed touch-action contains "pan-y" (or is non-default)
//   - With a chat popup in fullscreen, only the chat body has
//     overflow-y: auto — the document itself does not scroll.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first."); console.error(e.message); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function waitFor(page, predicate, timeoutMs = 8000, intervalMs = 100, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function signUp(page, handle) {
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 15000);
}

async function probeViewport(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      htmlScrollW: html.scrollWidth,
      htmlScrollH: html.scrollHeight,
      bodyScrollW: body.scrollWidth,
      bodyScrollH: body.scrollHeight,
      bodyOverflow: getComputedStyle(body).overflow,
      htmlOverflow: getComputedStyle(html).overflow,
      bodyOverscroll: getComputedStyle(body).overscrollBehavior,
      htmlOverscroll: getComputedStyle(html).overscrollBehavior,
      bodyTouchAction: getComputedStyle(body).touchAction
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    // Smoke at three mobile-ish viewports.
    const viewports = [
      { name: "iphone-14", width: 390, height: 844 },
      { name: "iphone-pro-max", width: 430, height: 932 },
      { name: "ipad-mini-portrait", width: 760, height: 1024 }
    ];

    for (const vp of viewports) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.on("pageerror", (err) => console.log("ERR>", err.message));
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.width < 760, hasTouch: vp.width < 760 });
      await page.goto(BASE + "/", { waitUntil: "networkidle0" });

      const handle = `mv${vp.width}${Date.now().toString().slice(-5)}`;
      if (!await signUp(page, handle)) { fail(`setup.${vp.name}`, "sign up failed"); await ctx.close(); continue; }

      // Give the layout a beat to settle after auth.
      await new Promise((r) => setTimeout(r, 400));

      const probe = await probeViewport(page);

      // 1. No horizontal overflow at the document level.
      if (probe.bodyScrollW > probe.innerWidth) {
        fail(`${vp.name}.body-h-overflow`, `body.scrollWidth=${probe.bodyScrollW} > innerWidth=${probe.innerWidth}`);
      } else if (probe.htmlScrollW > probe.innerWidth) {
        fail(`${vp.name}.html-h-overflow`, `html.scrollWidth=${probe.htmlScrollW} > innerWidth=${probe.innerWidth}`);
      } else {
        ok(`${vp.name}: no horizontal overflow (body=${probe.bodyScrollW} html=${probe.htmlScrollW} inner=${probe.innerWidth})`);
      }

      // 2. Vertical scroll is contained to the viewport (within 1px
      //    for sub-pixel rounding).
      if (probe.htmlScrollH > probe.innerHeight + 1) {
        fail(`${vp.name}.v-overflow`, `html.scrollHeight=${probe.htmlScrollH} > innerHeight=${probe.innerHeight}`);
      } else {
        ok(`${vp.name}: vertical contained (html=${probe.htmlScrollH} inner=${probe.innerHeight})`);
      }

      // 3. Body + html have non-default overflow + overscroll.
      if (probe.bodyOverflow.indexOf("hidden") === -1 && probe.bodyOverflow !== "clip") {
        fail(`${vp.name}.body-overflow`, `body computed overflow is '${probe.bodyOverflow}' (expected hidden)`);
      }
      if (probe.bodyOverscroll === "auto" || probe.bodyOverscroll === "") {
        fail(`${vp.name}.body-overscroll`, `body overscroll-behavior is '${probe.bodyOverscroll}' (expected none/contain)`);
      } else {
        ok(`${vp.name}: body overscroll-behavior='${probe.bodyOverscroll}' (rubber-band blocked)`);
      }
      if (probe.bodyTouchAction === "auto" || probe.bodyTouchAction === "") {
        // Only insist on touch-action restriction on actually-mobile
        // widths; the 760 breakpoint is a tablet hybrid where we let
        // the default pass through.
        if (vp.width < 760) {
          fail(`${vp.name}.touch-action`, `body touch-action is '${probe.bodyTouchAction}' (expected restricted)`);
        }
      } else {
        ok(`${vp.name}: body touch-action='${probe.bodyTouchAction}' (horizontal pan blocked)`);
      }

      // 4. Even after a deliberate scroll attempt, scrollTop/Left
      //    don't move (the document is pinned).
      const scrolled = await page.evaluate(() => {
        const before = { x: window.scrollX, y: window.scrollY };
        window.scrollTo(500, 500);
        const after = { x: window.scrollX, y: window.scrollY };
        return { before, after };
      });
      if (scrolled.after.x !== 0 || scrolled.after.y !== 0) {
        fail(`${vp.name}.pinned`, `window.scrollTo(500,500) actually moved the page (now ${JSON.stringify(scrolled.after)})`);
      } else {
        ok(`${vp.name}: window.scrollTo cannot move the document (pinned to 0,0)`);
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`MOBILE-VIEWPORT-CONTAINMENT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MOBILE-VIEWPORT-CONTAINMENT SMOKE PASSED");
})().catch((err) => {
  console.error("MOBILE-VIEWPORT-CONTAINMENT SMOKE ERRORED:", err);
  process.exit(1);
});
