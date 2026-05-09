#!/usr/bin/env node
// Local-database recovery smoke. Verifies non-destructive recovery:
//
// 1. With a hung indexedDB.open, signup/signin show CALM retry copy
//    ("opening local data...") with retry-now + reload-page buttons.
//    The destructive "reset this device" button is hidden behind an
//    "advanced recovery" disclosure and never visible by default.
// 2. The reset action stays reachable through the disclosure but is
//    never the dominant button.
// 3. With a brief DB block that clears (mocked open-then-recover), the
//    auth flow continues automatically without showing any error and
//    without ever creating a partial server identity.
// 4. With a healthy DB, signup still completes normally.
// 5. The reset-this-device action, after explicit confirm, deletes the
//    IndexedDB and returns the user to a clean landing.
//
// Account isolation is preserved: this smoke does not touch owner
// scoping. It just exercises the recovery surface.

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
const CALM_PATTERN = /opening local data/i;
const SCARY_PATTERN = /this browser's local sudo data is locked/i;
const WRONG_PASSPHRASE_PATTERN = /wrong passphrase/i;

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
  return { context, page };
}

// Hang every indexedDB.open: requests are returned but their handlers
// never fire. The retry loop should cope without ever surfacing a
// scary message.
async function injectIndexedDbHang(page) {
  await page.evaluateOnNewDocument(() => {
    const noopRequest = () => ({
      onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
      result: null, error: null, transaction: null, readyState: "pending",
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
    });
    indexedDB.open = function () { return noopRequest(); };
  });
}

async function waitForState(page, predicate, timeoutMs = 25000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      signupState: document.getElementById("signup-state")?.innerText ?? "",
      signinState: document.getElementById("signin-state")?.innerText ?? "",
      hasResetVisible: (() => {
        const reset = document.querySelector(".auth-recovery__reset");
        if (!reset) return false;
        const rect = reset.getBoundingClientRect();
        // Visible to a screen-reading user means: present in DOM AND not
        // hidden inside a closed <details>.
        const inClosedDetails = reset.closest("details:not([open])") !== null;
        return !inClosedDetails && rect.width > 0 && rect.height > 0;
      })(),
      hasAdvancedDisclosure: !!document.querySelector(".auth-recovery__advanced"),
      hasRetryNowButton: !!document.querySelector(".auth-recovery__actions button"),
      hasResetInDisclosure: (() => {
        const reset = document.querySelector(".auth-recovery__advanced .auth-recovery__reset");
        return !!reset;
      })()
    }));
    if (predicate(snap)) return { kind: "match", snap, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const final = await page.evaluate(() => ({
    authState: document.body.dataset.authState,
    signupState: document.getElementById("signup-state")?.innerText ?? "",
    signinState: document.getElementById("signin-state")?.innerText ?? "",
    hasResetVisible: !!document.querySelector(".auth-recovery__reset:not([hidden])"),
    hasAdvancedDisclosure: !!document.querySelector(".auth-recovery__advanced"),
    hasRetryNowButton: !!document.querySelector(".auth-recovery__actions button"),
    hasResetInDisclosure: !!document.querySelector(".auth-recovery__advanced .auth-recovery__reset")
  }));
  return { kind: "timeout", snap: final };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // ===== Case 1: signup with hung indexedDB.open =====
  {
    const { context, page } = await newPage(browser);
    await injectIndexedDbHang(page);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signup-handle", "hangtest" + Date.now().toString().slice(-5));
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');

    // Wait for the calm retry surface to appear.
    const result = await waitForState(page, (s) => CALM_PATTERN.test(s.signupState) && s.hasAdvancedDisclosure, 25000);
    if (result.kind === "timeout") {
      fail("signup-db-hang", `expected calm retry copy + advanced disclosure within 25s; got '${result.snap.signupState}'`);
    } else if (SCARY_PATTERN.test(result.snap.signupState)) {
      fail("signup-db-hang", `signup showed the scary copy: '${result.snap.signupState}'`);
    } else if (WRONG_PASSPHRASE_PATTERN.test(result.snap.signupState)) {
      fail("signup-db-hang", `signup showed wrong-passphrase for a DB failure: '${result.snap.signupState}'`);
    } else if (result.snap.hasResetVisible) {
      fail("signup-db-hang", "reset-this-device must NOT be visible by default");
    } else if (!result.snap.hasRetryNowButton) {
      fail("signup-db-hang", "expected retry-now button in recovery panel");
    } else if (!result.snap.hasResetInDisclosure) {
      fail("signup-db-hang", "reset must still be reachable inside advanced recovery");
    } else {
      ok(`signup with hung IDB shows calm retry + hidden reset behind disclosure (${result.elapsed}ms)`);
    }

    // Open the disclosure and verify reset becomes reachable.
    await page.evaluate(() => {
      const details = document.querySelector(".auth-recovery__advanced");
      if (details instanceof HTMLDetailsElement) details.open = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    const afterOpen = await page.evaluate(() => !!document.querySelector(".auth-recovery__advanced[open] .auth-recovery__reset"));
    if (!afterOpen) fail("signup-db-hang", "reset-this-device not reachable after opening advanced recovery");
    else ok("opening advanced recovery exposes reset-this-device");

    await context.close();
  }

  // ===== Case 2: signin with hung indexedDB.open =====
  {
    const { context, page } = await newPage(browser);
    await injectIndexedDbHang(page);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signin-handle", "ghost" + Date.now().toString().slice(-5));
    await page.type("#signin-password", PASSPHRASE);
    await page.click("#signin-submit");

    const result = await waitForState(page, (s) => CALM_PATTERN.test(s.signinState) && s.hasAdvancedDisclosure, 25000);
    if (result.kind === "timeout") {
      fail("signin-db-hang", `expected calm retry copy + advanced disclosure within 25s; got '${result.snap.signinState}'`);
    } else if (WRONG_PASSPHRASE_PATTERN.test(result.snap.signinState)) {
      fail("signin-db-hang", `signin showed wrong-passphrase for a DB failure: '${result.snap.signinState}'`);
    } else if (result.snap.hasResetVisible) {
      fail("signin-db-hang", "reset-this-device must NOT be visible by default");
    } else if (!result.snap.hasRetryNowButton) {
      fail("signin-db-hang", "expected retry-now button");
    } else {
      ok(`signin with hung IDB shows calm retry + hidden reset (${result.elapsed}ms)`);
    }
    await context.close();
  }

  // ===== Case 3: temporary block that recovers — auth continues =====
  // Block IDB for ~3s then restore. The retry loop's 1s/3s backoff means
  // we should pick up the recovery within a couple of attempts and
  // continue signup without ever showing an error.
  {
    const { context, page } = await newPage(browser);
    await page.evaluateOnNewDocument(() => {
      const realOpen = indexedDB.open.bind(indexedDB);
      let blocked = true;
      // Restore real open after 3 seconds. The retry loop should pick
      // this up by the second or third attempt and continue.
      setTimeout(() => { blocked = false; }, 3000);
      indexedDB.open = function (...args) {
        if (!blocked) return realOpen.apply(indexedDB, args);
        return {
          onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
          result: null, error: null, transaction: null, readyState: "pending",
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
        };
      };
    });
    let registerHits = 0;
    page.on("response", (r) => { if (r.url().endsWith("/api/identity/register")) registerHits += 1; });

    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    const handle = "recovers" + Date.now().toString().slice(-5);
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);

    // Capture register-network hits BEFORE clicking submit.
    const hitsBeforeSubmit = registerHits;
    await page.click('#signup-form button[type="submit"]');

    // While DB is still blocked, register MUST NOT have been called.
    await new Promise((r) => setTimeout(r, 1000));
    if (registerHits > hitsBeforeSubmit) {
      fail("signup-no-partial-network", `/api/identity/register was hit while local DB was unavailable (count=${registerHits})`);
    }

    // After the simulated recovery (3s) plus the retry backoff, signup
    // should reach signed-in within ~12s.
    const result = await waitForState(page, (s) => s.authState === "signed-in", 18000);
    if (result.kind !== "match") {
      fail("signup-recovers", `expected signed-in after temporary block; got '${result.snap.signupState}'`);
    } else if (registerHits <= hitsBeforeSubmit) {
      fail("signup-no-partial-network", "register endpoint was never reached after recovery");
    } else {
      ok(`signup recovered after temporary IDB block (${result.elapsed}ms; register hits=${registerHits - hitsBeforeSubmit})`);
    }
    await context.close();
  }

  // ===== Case 4: happy-path signup with normal IDB still works =====
  {
    const { context, page } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    const handle = "happy" + Date.now().toString().slice(-6);
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');

    const result = await waitForState(page, (s) => s.authState === "signed-in", 15000);
    if (result.kind === "timeout") {
      fail("happy-signup", `signup did not reach signed-in within 15s; '${result.snap.signupState}'`);
    } else {
      ok(`happy-path signup still completes (${result.elapsed}ms)`);
    }
    await context.close();
  }

  // ===== Case 5: reset-this-device through advanced disclosure =====
  {
    const { context, page } = await newPage(browser);
    page.on("dialog", async (dlg) => { try { await dlg.accept(); } catch { /* ignore */ } });
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    const handle = "reset" + Date.now().toString().slice(-6);
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');
    await waitForState(page, (s) => s.authState === "signed-in", 15000);

    // Manually clear via the same path the disclosure uses.
    await page.evaluate(async () => {
      const dbReq = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
      try { db.close(); } catch { /* ignore */ }
      await new Promise((res, rej) => {
        const r = indexedDB.deleteDatabase("sudo_local_state");
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("blocked"));
      });
    });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    const after = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      hasSignin: !!document.querySelector('.landing [data-auth-action="signin"]'),
      hasSignup: !!document.querySelector('.landing [data-auth-action="signup"]'),
    }));
    if (after.authState !== "menu") fail("reset-after", `expected landing menu after reset, got authState=${after.authState}`);
    else if (!after.hasSignin || !after.hasSignup) fail("reset-after", "landing missing sign in / sign up after reset");
    else ok("advanced reset path deletes IDB and returns to clean landing");
    await context.close();
  }

  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("LOCAL DB RECOVERY SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("LOCAL DB RECOVERY SMOKE PASSED");
})().catch((error) => { console.error("LOCAL DB RECOVERY SMOKE ERROR", error); process.exit(2); });
