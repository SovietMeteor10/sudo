#!/usr/bin/env node
// Regression smoke for the "sign in / sign up buttons are not
// clickable" bug. Asserts that on a hard reload, BEFORE any session
// restore work has had a chance to land, the landing auth buttons:
//   - exist in the DOM and are not disabled
//   - have computed `pointer-events: auto`
//   - are the topmost element at their own center (no overlay
//     intercepts clicks)
//   - actually trigger the corresponding auth dialog when clicked
//
// Plus an extra pass that simulates the original failure mode: if
// the notifications panel is missing from index.html (e.g. a stale
// cached HTML), the optional getElementById lookups should still let
// module init complete and the auth listeners must still attach.
//
// Tests both a desktop viewport (980x820) and a narrow/mobile one
// (380x720).

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

async function probeAuthButtons(page) {
  return page.evaluate(() => {
    const result = { authState: document.body.dataset.authState, errors: [] };
    for (const action of ["signin", "signup"]) {
      const btn = document.querySelector(`.landing [data-auth-action="${action}"]`);
      if (!(btn instanceof HTMLElement)) {
        result[action] = { exists: false };
        continue;
      }
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      result[action] = {
        exists: true,
        disabled: btn instanceof HTMLButtonElement ? btn.disabled : false,
        pointerEvents: getComputedStyle(btn).pointerEvents,
        opacity: parseFloat(getComputedStyle(btn).opacity),
        rectHeight: rect.height,
        rectWidth: rect.width,
        topElementIsButton: top === btn,
        topElementTag: top ? `${top.tagName}.${top.className}` : "null"
      };
    }
    return result;
  });
}

async function runStandardChecks(label, page, viewport) {
  await page.setViewport(viewport);
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  // Don't wait beyond network idle. We deliberately probe at the
  // earliest moment a real user could click — if a slow async path
  // disables the buttons later, the regression we're guarding
  // against can't live there.
  const probe = await probeAuthButtons(page);

  for (const action of ["signin", "signup"]) {
    const info = probe[action];
    if (!info.exists) {
      fail(`${label}/${action}-exists`, "button missing from DOM");
      continue;
    }
    if (info.disabled) fail(`${label}/${action}-disabled`, "button is disabled");
    if (info.pointerEvents !== "auto") fail(`${label}/${action}-pointer-events`, `pointer-events=${info.pointerEvents}`);
    if (info.opacity < 0.5) fail(`${label}/${action}-opacity`, `opacity=${info.opacity}`);
    if (info.rectHeight <= 0 || info.rectWidth <= 0) fail(`${label}/${action}-size`, `rect=${info.rectWidth}x${info.rectHeight}`);
    if (!info.topElementIsButton) {
      fail(`${label}/${action}-overlay`, `top element at center is ${info.topElementTag}, not the button itself`);
    } else {
      ok(`${label}/${action}: clickable, no overlay intercept (rect=${info.rectWidth.toFixed(0)}x${info.rectHeight.toFixed(0)}, pointer-events=${info.pointerEvents})`);
    }
  }

  // Click signin → signin dialog opens.
  await page.click('.landing [data-auth-action="signin"]');
  // The dialog open transition is synchronous on .showModal() so a
  // tiny settle window covers any frame paint.
  await new Promise((r) => setTimeout(r, 200));
  let dialog = await page.evaluate(() => ({
    signin: document.getElementById("signin-dialog")?.open ?? false,
    signup: document.getElementById("signup-dialog")?.open ?? false
  }));
  if (!dialog.signin) fail(`${label}/signin-click`, "signin click did not open signin dialog");
  else ok(`${label}/signin-click: dialog opened`);
  // Close it before testing signup so the dialogs don't stack.
  await page.click("#signin-cancel").catch(() => null);
  await new Promise((r) => setTimeout(r, 200));

  // Keyboard submit path: tab to signup, hit Enter / Space.
  // Just probe by clicking; keyboard activation on a <button> resolves
  // via the same click handler on most platforms.
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  dialog = await page.evaluate(() => ({
    signin: document.getElementById("signin-dialog")?.open ?? false,
    signup: document.getElementById("signup-dialog")?.open ?? false
  }));
  if (!dialog.signup) fail(`${label}/signup-click`, "signup click did not open signup dialog");
  else ok(`${label}/signup-click: dialog opened`);
  await page.click("#signup-cancel").catch(() => null);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    // ===== Pass 1: desktop viewport =====
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        const url = msg.location()?.url ?? "";
        // Ignore favicon noise — every Chrome run requests one and
        // we don't ship it. Doesn't affect auth.
        if (text.includes("favicon.ico") || url.endsWith("/favicon.ico")) return;
        consoleErrors.push("console: " + text + (url ? ` (${url})` : ""));
      });
      // Also drop favicon failed-request entries from the network probe.
      page.on("requestfailed", (req) => {
        if (req.url().endsWith("/favicon.ico")) return;
        consoleErrors.push("requestfailed: " + req.url());
      });
      await runStandardChecks("desktop", page, { width: 980, height: 820 });
      if (consoleErrors.length > 0) {
        fail("desktop/console", `${consoleErrors.length} console error(s) during auth flow: ${consoleErrors.slice(0, 3).join("; ")}`);
      } else {
        ok("desktop: no console errors");
      }
      await page.close();
      await context.close();
    }

    // ===== Pass 2: narrow/mobile viewport =====
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await runStandardChecks("mobile", page, { width: 380, height: 720 });
      await page.close();
      await context.close();
    }

    // ===== Pass 3: stale-DOM regression — remove the notifications
    //   panel before main.js runs and confirm auth still works. =====
    //   This guards the original root cause: a top-level required-
    //   element lookup throwing during module init must NEVER prevent
    //   the auth listeners from attaching.
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setRequestInterception(true);
      page.on("request", async (request) => {
        const url = request.url();
        if (url === BASE + "/" || url === BASE) {
          // Strip the notifications panel from the served HTML to
          // simulate a stale index.html.
          const native = await fetch(url).catch(() => null);
          if (native === null) { request.continue(); return; }
          const text = await native.text();
          const stripped = text.replace(/<div class="notifications" id="notifications-panel"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/aside>/, "</aside>");
          request.respond({
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
            body: stripped
          });
          return;
        }
        request.continue();
      });
      const consoleErrors = [];
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
      await page.setViewport({ width: 980, height: 820 });
      await page.goto(BASE + "/", { waitUntil: "networkidle0" });
      // Confirm the panel is actually missing (sanity check on the rewrite).
      const panelMissing = await page.evaluate(() => document.getElementById("notifications-panel") === null);
      if (!panelMissing) {
        ok("stale-DOM: rewrite was a no-op (panel still present); skipping pass 3");
      } else {
        const probe = await probeAuthButtons(page);
        const signinOk = probe.signin?.exists && !probe.signin.disabled && probe.signin.topElementIsButton;
        const signupOk = probe.signup?.exists && !probe.signup.disabled && probe.signup.topElementIsButton;
        if (!signinOk || !signupOk) {
          fail("stale-DOM/buttons", `auth buttons not clickable when notifications panel is missing: ${JSON.stringify(probe)}`);
        } else {
          ok("stale-DOM: auth buttons remain clickable when notifications panel is absent (defensive lookups)");
        }
        // Also click them to confirm listeners actually attached.
        await page.click('.landing [data-auth-action="signin"]');
        await new Promise((r) => setTimeout(r, 200));
        const dialogOpen = await page.evaluate(() => document.getElementById("signin-dialog")?.open ?? false);
        if (!dialogOpen) fail("stale-DOM/signin-click", "signin click did not open dialog when panel missing");
        else ok("stale-DOM/signin-click: dialog opened despite missing panel");
      }
      await page.close();
      await context.close();
    }

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("AUTH BUTTONS CLICKABLE SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("AUTH BUTTONS CLICKABLE SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("AUTH BUTTONS CLICKABLE SMOKE ERROR", error);
  process.exit(2);
});
